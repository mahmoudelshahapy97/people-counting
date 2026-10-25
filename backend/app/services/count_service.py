# app/services/count_service.py
"""Stored head counts: the sample a worker writes every SAMPLE_INTERVAL_S,
the violation row for a sample outside its camera's limits, and the
history / export reads over them.

InsightEye batches samples through Redis into ``stream_results`` and flushes
every 5 minutes; here a sample is one small INSERT, so the charts are never
minutes behind the cameras.
"""

import csv
import io
import logging
from datetime import datetime
from typing import Any, AsyncIterator, Dict, List, Optional
from uuid import UUID

from app.core.database import db_manager
from app.services.filters import CountFilters, Sql, scope
from app.services.people_counter import Violation

logger = logging.getLogger(__name__)

EXPORT_BATCH = 5000
EXPORT_COLUMNS = [
    "captured_at",
    "camera_name",
    "location",
    "building",
    "floor_level",
    "zone",
    "area",
    "person_count",
    "violation",
    "threshold_value",
]


class CountService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # -------------------------------------------------------------- ingestion
    async def record_sample(
        self,
        camera_id: UUID,
        person_count: int,
        captured_at: datetime,
        violation: Optional[Violation] = None,
    ) -> None:
        """One sample, plus its violation row when it broke a limit.

        Both carry the same ``captured_at``, which is how history joins them.
        """
        await self.db_manager.execute_query(
            "INSERT INTO count_sample (camera_id, person_count, captured_at) VALUES ($1, $2, $3)",
            (camera_id, person_count, captured_at),
        )
        if violation:
            await self.db_manager.execute_query(
                """
                INSERT INTO threshold_violation
                    (camera_id, person_count, threshold_type, threshold_value, captured_at)
                VALUES ($1, $2, $3, $4, $5)
                """,
                (
                    camera_id,
                    person_count,
                    violation.threshold_type,
                    violation.threshold_value,
                    captured_at,
                ),
            )

    # ---------------------------------------------------------------- history
    @staticmethod
    def _history_query(f: CountFilters, sql: Sql) -> str:
        where = scope(f, sql, "captured_at")
        return f"""
            FROM count_sample s
            JOIN camera c ON c.camera_id = s.camera_id
            LEFT JOIN threshold_violation v
                   ON v.camera_id = s.camera_id AND v.captured_at = s.captured_at
            WHERE {where}
        """

    async def history(self, f: CountFilters, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """Stored samples, newest first: InsightEye's Frames Search, without the
        frames (a sample has no picture; alerts do)."""
        sql = Sql()
        body = self._history_query(f, sql)
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS total {body}", sql.args, fetch_one=True
        )
        limit, offset = sql.p(per_page), sql.p((page - 1) * per_page)
        rows = await self.db_manager.execute_query(
            f"""
            SELECT s.sample_id, s.captured_at, s.camera_id, c.name AS camera_name,
                   c.location, c.building, c.floor_level, c.zone, c.area,
                   s.person_count, v.threshold_type AS violation, v.threshold_value
            {body}
            ORDER BY s.captured_at DESC, s.sample_id DESC
            LIMIT {limit} OFFSET {offset}
            """,
            sql.args,
            fetch_all=True,
        )
        count = total["total"] if total else 0
        return {
            "total": count,
            "page": page,
            "per_page": per_page,
            "num_of_pages": (count + per_page - 1) // per_page,
            "filters_applied": f.applied(),
            "samples": rows,
        }

    async def export_csv(self, f: CountFilters) -> AsyncIterator[str]:
        """The filtered history as CSV, oldest first, in batches so a 90-day
        export never sits in memory at once."""
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(EXPORT_COLUMNS)
        yield buffer.getvalue()

        last_id = 0
        while True:
            sql = Sql()
            body = self._history_query(f, sql)
            after, limit = sql.p(last_id), sql.p(EXPORT_BATCH)
            rows: List[Dict[str, Any]] = await self.db_manager.execute_query(
                f"""
                SELECT s.sample_id, s.captured_at, c.name AS camera_name, c.location,
                       c.building, c.floor_level, c.zone, c.area, s.person_count,
                       v.threshold_type AS violation, v.threshold_value
                {body} AND s.sample_id > {after}
                ORDER BY s.sample_id
                LIMIT {limit}
                """,
                sql.args,
                fetch_all=True,
            )
            if not rows:
                return
            buffer.seek(0)
            buffer.truncate()
            for row in rows:
                writer.writerow(
                    [
                        row["captured_at"].isoformat(),
                        *(row[c] if row[c] is not None else "" for c in EXPORT_COLUMNS[1:]),
                    ]
                )
            yield buffer.getvalue()
            last_id = rows[-1]["sample_id"]

    async def latest_by_camera(self, workspace_id: UUID) -> Dict[UUID, Dict[str, Any]]:
        """Each camera's newest stored sample: the dashboard's fallback when a
        camera has no running worker."""
        rows = await self.db_manager.execute_query(
            """
            SELECT DISTINCT ON (s.camera_id) s.camera_id, s.person_count, s.captured_at
            FROM count_sample s
            WHERE s.workspace_id = $1
              AND s.captured_at > NOW() - INTERVAL '1 day'
            ORDER BY s.camera_id, s.captured_at DESC
            """,
            (workspace_id,),
            fetch_all=True,
        )
        return {row["camera_id"]: row for row in rows}

    async def location_options(self, workspace_id: UUID) -> Dict[str, List[str]]:
        """Distinct building / floor / zone / area values, for the filter menus
        (InsightEye has lookup tables for these; here they are camera fields)."""
        row = await self.db_manager.execute_query(
            """
            SELECT
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT building    ORDER BY building),    NULL) AS buildings,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT floor_level ORDER BY floor_level), NULL) AS floors,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT zone        ORDER BY zone),        NULL) AS zones,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT area        ORDER BY area),        NULL) AS areas
            FROM camera WHERE workspace_id = $1
            """,
            (workspace_id,),
            fetch_one=True,
        )
        return {key: list(row[key] or []) for key in ("buildings", "floors", "zones", "areas")}


count_service = CountService()
