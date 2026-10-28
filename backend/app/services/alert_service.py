# app/services/alert_service.py
"""Occupancy alerts: a violation raised to the operators.

InsightEye writes a ``notifications`` row, pushes it over the websocket to the
workspace's members and mails the camera owner, then records the time in
``people_count_alert_state`` for its 10-minute cooldown. Here the alert row is
all three: the console polls it, its snapshot is the evidence, and the latest
row per camera is the cooldown state. Operators acknowledge and resolve it
as they do any other alert.
"""

import asyncio
import html
import logging
from datetime import datetime
from email.message import EmailMessage
from typing import Any, Dict, List, Optional
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.services.inbox_service import inbox_service
from app.services import media_service
from app.services.object_store import alert_key
from app.services.people_counter import GREATER_THAN, Violation
from app.utils.image_utils import bytes_to_base64
from app.utils.mailer import send_blocking

logger = logging.getLogger(__name__)

_SELECT = """
    SELECT a.alert_id, a.camera_id, c.name AS camera_name, c.location,
           c.building, c.floor_level, c.zone, c.area,
           a.triggered_at, a.person_count, a.threshold_type, a.threshold_value,
           a.status, a.action_taken, a.description, a.acknowledged_at, a.resolved_at,
           u.username AS resolved_by_username,
           (a.frame_key IS NOT NULL OR a.frame_jpeg IS NOT NULL) AS has_frame
    FROM count_alert a
    LEFT JOIN camera c ON c.camera_id = a.camera_id
    LEFT JOIN app_user u ON u.user_id = a.resolved_by
"""


def location_text(camera: Dict[str, Any]) -> str:
    """"Building - Floor 2 - Zone - Area", as InsightEye phrases it."""
    parts = [
        camera.get("building"),
        f"Floor {camera['floor_level']}" if camera.get("floor_level") else None,
        camera.get("zone"),
        camera.get("area"),
    ]
    text = " - ".join(p for p in parts if p)
    return text or camera.get("location") or ""


class AlertService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # -------------------------------------------------------------- ingestion
    async def create_alert(
        self,
        camera: Dict[str, Any],
        violation: Violation,
        triggered_at: datetime,
        frame_jpeg: Optional[bytes],
    ) -> Optional[Dict[str, Any]]:
        row = await self.db_manager.execute_query(
            """
            INSERT INTO count_alert
                (camera_id, person_count, threshold_type, threshold_value, triggered_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING alert_id, camera_id, workspace_id, triggered_at, person_count,
                      threshold_type, threshold_value, status
            """,
            (
                camera["camera_id"],
                violation.count,
                violation.threshold_type,
                violation.threshold_value,
                triggered_at,
            ),
            fetch_one=True,
        )
        if not row:
            return None
        await media_service.save_image(
            media_service.ALERT_FRAME,
            row["alert_id"],
            alert_key(camera["camera_id"], row["alert_id"]),
            frame_jpeg,
        )
        logger.warning(
            "PEOPLE COUNT ALERT: %s people on camera %s (%s) - alert %s",
            violation.count,
            camera.get("name"),
            violation.describe,
            row["alert_id"],
        )
        task = asyncio.create_task(self._to_inbox(camera, violation, row))
        _mail_tasks.add(task)
        task.add_done_callback(_mail_tasks.discard)
        if config.alert_email_active:
            # Mail goes out on its own task: a slow SMTP server must not hold
            # up the worker that raised the alert.
            task = asyncio.create_task(self._mail(camera, violation, triggered_at))
            _mail_tasks.add(task)
            task.add_done_callback(_mail_tasks.discard)
        return row

    async def last_alert_at(self, camera_id: UUID) -> Optional[datetime]:
        """When the camera last raised an alert, for the worker's cooldown."""
        row = await self.db_manager.execute_query(
            "SELECT MAX(triggered_at) AS at FROM count_alert WHERE camera_id = $1",
            (camera_id,),
            fetch_one=True,
        )
        return row["at"] if row else None

    # ---------------------------------------------------------------- queries
    async def list_alerts(
        self,
        workspace_id: UUID,
        camera_id: Optional[UUID] = None,
        status: Optional[str] = None,
        threshold_type: Optional[str] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        page: int = 1,
        per_page: int = 20,
    ) -> Dict[str, Any]:
        conditions: List[str] = []
        params: List[Any] = []

        def add(condition: str, value: Any) -> None:
            params.append(value)
            conditions.append(condition.format(n=len(params)))

        add("a.workspace_id = ${n}", workspace_id)
        if camera_id:
            add("a.camera_id = ${n}", camera_id)
        if status:
            add("a.status = ${n}", status)
        if threshold_type:
            add("a.threshold_type = ${n}", threshold_type)
        if start:
            add("a.triggered_at >= ${n}", start)
        if end:
            add("a.triggered_at <= ${n}", end)
        where = f"WHERE {' AND '.join(conditions)}"

        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS total FROM count_alert a {where}", tuple(params), fetch_one=True
        )
        params.extend([per_page, (page - 1) * per_page])
        rows = await self.db_manager.execute_query(
            f"""
            {_SELECT}
            {where}
            ORDER BY a.triggered_at DESC
            LIMIT ${len(params) - 1} OFFSET ${len(params)}
            """,
            tuple(params),
            fetch_all=True,
        )
        return {
            "total": total["total"] if total else 0,
            "page": page,
            "per_page": per_page,
            "alerts": rows,
        }

    async def get_alert(self, alert_id: UUID, include_frame: bool = False) -> Optional[Dict[str, Any]]:
        row = await self.db_manager.execute_query(
            f"{_SELECT} WHERE a.alert_id = $1", (alert_id,), fetch_one=True
        )
        if not row:
            return None
        alert = dict(row)
        if include_frame:
            alert["frame_base64"] = bytes_to_base64(await self.get_frame(alert_id))
        return alert

    async def get_frame(self, alert_id: UUID) -> Optional[bytes]:
        return await media_service.load_image(media_service.ALERT_FRAME, alert_id)

    async def update_status(
        self,
        alert_id: UUID,
        status: str,
        action_taken: Optional[str] = None,
        description: Optional[str] = None,
        user_id: Optional[UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """Acknowledge, resolve or dismiss an alert, keeping how it was handled.

        Notes left empty keep what was there. Leaving OPEN stamps acknowledged_at
        once; RESOLVED / FALSE_POSITIVE stamp resolved_at and resolved_by.
        """
        return await self.db_manager.execute_query(
            """
            UPDATE count_alert
            SET status          = $1::text,
                action_taken    = COALESCE($3, action_taken),
                description     = COALESCE($4, description),
                acknowledged_at = CASE WHEN $1::text <> 'OPEN'
                                       THEN COALESCE(acknowledged_at, NOW()) END,
                resolved_at     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                                       THEN COALESCE(resolved_at, NOW()) END,
                resolved_by     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                                       THEN COALESCE($5::uuid, resolved_by) END
            WHERE alert_id = $2
            RETURNING alert_id, status, action_taken, description,
                      acknowledged_at, resolved_at, resolved_by
            """,
            (status, alert_id, action_taken, description, user_id),
            fetch_one=True,
        )

    async def stats(self, workspace_id: UUID, camera_id: Optional[UUID] = None) -> Dict[str, Any]:
        """Totals used by the dashboard: all-time, open, and the last 24 hours."""
        params: List[Any] = [workspace_id]
        camera = ""
        if camera_id:
            params.append(camera_id)
            camera = " AND camera_id = $2"
        row = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
                   COUNT(*) FILTER (WHERE triggered_at > NOW() - INTERVAL '24 hours') AS last_24h,
                   COUNT(*) FILTER (WHERE threshold_type = 'greater_than') AS above_max,
                   COUNT(*) FILTER (WHERE threshold_type = 'less_than') AS below_min,
                   MAX(triggered_at) AS last_alert_at
            FROM count_alert
            WHERE workspace_id = $1{camera}
            """,
            tuple(params),
            fetch_one=True,
        )
        return row or {}

    # ------------------------------------------------------------------- mail
    async def _to_inbox(self, camera: Dict[str, Any], violation: Violation, alert: Dict[str, Any]) -> None:
        """The bell's half of an alert: everyone who can see the workspace."""
        high = violation.threshold_type == GREATER_THAN
        name = camera.get("name") or str(camera["camera_id"])
        await inbox_service.notify_workspace(
            alert["workspace_id"],
            kind="alert",
            severity="high" if high else "medium",
            title=f"{'High' if high else 'Low'} occupancy on {name}",
            message=f"{violation.count} people counted ({violation.describe}).",
            link=f"/alerts/{alert['alert_id']}",
            camera_id=camera["camera_id"],
            camera_name=name,
            ref_id=alert["alert_id"],
        )

    async def recipients(self, workspace_id: UUID) -> List[str]:
        """Active operators and admins of the camera's workspace.

        InsightEye mails only the camera's owner; cameras have no owner here,
        so the people who can act on an alert get it.
        """
        rows = await self.db_manager.execute_query(
            """
            SELECT DISTINCT u.email
            FROM app_user u
            LEFT JOIN workspace_member m ON m.user_id = u.user_id AND m.workspace_id = $1
            WHERE u.is_active AND u.notify_email AND u.email <> ''
              AND (u.role = 'admin' OR (u.role = 'operator' AND m.user_id IS NOT NULL))
            ORDER BY u.email
            """,
            (workspace_id,),
            fetch_all=True,
        )
        return [row["email"] for row in rows]

    @staticmethod
    def _message(
        camera: Dict[str, Any], violation: Violation, triggered_at: datetime, to: List[str]
    ) -> EmailMessage:
        """InsightEye's send_people_count_alert_email, in plain text and HTML."""
        high = violation.threshold_type == GREATER_THAN
        kind = "HIGH OCCUPANCY" if high else "LOW OCCUPANCY"
        name = camera.get("name") or str(camera["camera_id"])
        where = location_text(camera) or "-"
        when = triggered_at.strftime("%Y-%m-%d %H:%M:%S %Z")
        limit = f"{'more than' if high else 'fewer than'} {violation.threshold_value}"
        color = "#dc3545" if high else "#fd7e14"

        message = EmailMessage()
        message["Subject"] = f"{kind} ALERT - {name}"
        message["From"] = config.smtp_from
        message["To"] = ", ".join(to)
        message.set_content(
            f"{kind} ALERT\n\n"
            f"Camera:    {name}\n"
            f"Location:  {where}\n"
            f"People:    {violation.count}\n"
            f"Limit:     {limit}\n"
            f"Time:      {when}\n\n"
            "The people count has crossed this camera's configured limit. "
            "Review the alert in the console.\n"
        )
        message.add_alternative(
            f"<h2 style=\"color:{color};margin:0 0 12px\">{kind} ALERT</h2>"
            "<table cellpadding=\"4\">"
            f"<tr><td><b>Camera</b></td><td>{html.escape(name)}</td></tr>"
            f"<tr><td><b>Location</b></td><td>{html.escape(where)}</td></tr>"
            f"<tr><td><b>People</b></td><td style=\"color:{color};font-size:18px\"><b>{violation.count}</b></td></tr>"
            f"<tr><td><b>Limit</b></td><td>{limit}</td></tr>"
            f"<tr><td><b>Time</b></td><td>{html.escape(when)}</td></tr>"
            "</table>"
            "<p>The people count has crossed this camera's configured limit. "
            "Review the alert in the console.</p>",
            subtype="html",
        )
        return message

    async def _mail(self, camera: Dict[str, Any], violation: Violation, triggered_at: datetime) -> None:
        try:
            to = await self.recipients(camera["workspace_id"])
            if not to:
                return
            # One message per person: a shared To: line would hand every
            # recipient the whole list of addresses.
            sent = 0
            for address in to:
                try:
                    await asyncio.to_thread(send_blocking, self._message(camera, violation, triggered_at, [address]))
                    sent += 1
                except Exception as e:
                    logger.error("Alert mail for camera %s to one recipient failed: %s", camera.get("name"), e)
            logger.info("Alert mail for camera %s sent to %s of %s recipient(s).", camera.get("name"), sent, len(to))
        except Exception as e:
            logger.error("Could not mail the alert for camera %s: %s", camera.get("name"), e)


# Mail tasks outlive the call that started them; asyncio keeps only weak
# references to tasks, so this set holds them until they finish.
_mail_tasks: set = set()

alert_service = AlertService()
