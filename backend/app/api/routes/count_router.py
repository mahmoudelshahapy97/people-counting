# app/api/routes/count_router.py
import logging
from datetime import datetime, timezone
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.api.deps import get_count_filters, get_workspace_id, require_role
from app.services.camera_service import camera_service
from app.services.count_service import count_service
from app.services.filters import CountFilters
from app.services.people_counter import Thresholds
from app.services.stream_manager import stream_manager
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["counts"], prefix="/counts", dependencies=[Depends(require_role("viewer"))]
)


@router.get("")
async def count_history(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
    filters: CountFilters = Depends(get_count_filters),
) -> Dict[str, Any]:
    """Stored samples, newest first, each with the limit it broke (if any)."""
    try:
        return await count_service.history(filters, page=page, per_page=per_page)
    except Exception as e:
        logger.error("Error listing count history: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list counts."
        )


@router.get(
    "/export.csv",
    responses={200: {"content": {"text/csv": {}}, "description": "Filtered samples"}},
)
async def export_counts(filters: CountFilters = Depends(get_count_filters)) -> StreamingResponse:
    """The filtered history as CSV, oldest first (InsightEye's Excel export)."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        count_service.export_csv(filters),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="people-counts-{stamp}.csv"'},
    )


@router.get("/live")
async def live_counts(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """Every camera's current head count against its limits.

    From the running worker when there is one; otherwise the camera's last
    stored sample (within a day), flagged ``live: false``.
    """
    cameras = await camera_service.list_cameras(workspace_id=workspace_id)
    stored = await count_service.latest_by_camera(workspace_id)
    rows = []
    for camera in cameras:
        camera_id = camera["camera_id"]
        thresholds = Thresholds.from_camera(camera)
        worker = stream_manager.get_worker(camera_id)
        count = worker.current_count if worker and worker.connected else None
        live = count is not None
        at = worker.status()["last_frame_at"] if live else None
        if not live and camera_id in stored:
            count = stored[camera_id]["person_count"]
            at = stored[camera_id]["captured_at"]
        violation = thresholds.evaluate(count) if count is not None else None
        rows.append(
            {
                "camera_id": camera_id,
                "camera_name": camera["name"],
                "location": camera["location"],
                "building": camera["building"],
                "floor_level": camera["floor_level"],
                "zone": camera["zone"],
                "area": camera["area"],
                "enabled": camera["enabled"],
                "state": worker.state if worker else "stopped",
                "live": live,
                "person_count": count,
                "at": at,
                "count_threshold_greater": thresholds.greater_than,
                "count_threshold_less": thresholds.less_than,
                "alert_enabled": thresholds.enabled,
                "violation": violation.threshold_type if violation else None,
            }
        )
    occupancy = sum(r["person_count"] for r in rows if r["live"] and r["person_count"] is not None)
    return create_response(
        True,
        f"{len(rows)} camera(s).",
        {
            "occupancy": occupancy,
            "cameras_live": sum(1 for r in rows if r["live"]),
            "cameras_in_violation": sum(1 for r in rows if r["violation"]),
            "cameras": rows,
        },
    )


@router.get("/locations")
async def location_options(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """The buildings, floors, zones and areas in use, for filter menus."""
    return create_response(
        True, "Location options.", await count_service.location_options(workspace_id)
    )
