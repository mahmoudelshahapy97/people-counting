# app/api/routes/alert_router.py
import logging
from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.api.deps import (
    ensure_in_workspace,
    ensure_visible_resource,
    get_image_viewer,
    get_workspace_id,
    require_role,
)
from app.schemas.alert_schemas import (
    AlertListResponse,
    AlertResponse,
    AlertStatus,
    AlertStatusUpdate,
    ThresholdType,
)
from app.services.alert_service import alert_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["alerts"], prefix="/alerts")

_NOT_FOUND = "Alert not found."


@router.get("", response_model=AlertListResponse)
async def list_alerts(
    camera_id: Optional[UUID] = Query(None),
    status_filter: Optional[AlertStatus] = Query(None, alias="status"),
    threshold_type: Optional[ThresholdType] = Query(
        None, description="greater_than (over the maximum) | less_than (under the minimum)"
    ),
    start: Optional[datetime] = Query(None, description="ISO8601 lower bound on triggered_at"),
    end: Optional[datetime] = Query(None, description="ISO8601 upper bound on triggered_at"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Occupancy alerts in the active workspace, newest first."""
    try:
        return await alert_service.list_alerts(
            workspace_id=workspace_id,
            camera_id=camera_id,
            status=status_filter.value if status_filter else None,
            threshold_type=threshold_type.value if threshold_type else None,
            start=start,
            end=end,
            page=page,
            per_page=per_page,
        )
    except Exception as e:
        logger.error("Error listing alerts: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list alerts."
        )


@router.get("/stats")
async def alert_stats(
    camera_id: Optional[UUID] = Query(None),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Totals used by dashboards: all-time, currently open, and last 24 hours."""
    try:
        return create_response(
            True, "Alert statistics.", await alert_service.stats(workspace_id, camera_id)
        )
    except Exception as e:
        logger.error("Error computing alert stats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not compute stats."
        )


@router.get("/{alert_id}", response_model=AlertResponse)
async def get_alert(
    alert_id: UUID,
    include_frame: bool = Query(False, description="Embed the snapshot as base64"),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    await ensure_in_workspace("alert", alert_id, workspace_id, _NOT_FOUND)
    alert = await alert_service.get_alert(alert_id, include_frame=include_frame)
    if not alert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return alert


@router.get(
    "/{alert_id}/frame",
    responses={200: {"content": {"image/jpeg": {}}, "description": "Annotated alert frame"}},
)
async def get_alert_frame(
    alert_id: UUID, current_user: Dict[str, Any] = Depends(get_image_viewer)
) -> Response:
    """The annotated frame of the sample that raised the alert."""
    await ensure_visible_resource(current_user, "alert", alert_id)
    jpeg = await alert_service.get_frame(alert_id)
    if not jpeg:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No frame stored for this alert."
        )
    return Response(content=jpeg, media_type="image/jpeg")


@router.patch("/{alert_id}/status")
async def update_alert_status(
    alert_id: UUID,
    payload: AlertStatusUpdate,
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Acknowledge, resolve, or dismiss an alert as a false positive.

    Optional `action_taken` / `description` record how it was handled.
    """
    await ensure_in_workspace("alert", alert_id, workspace_id, _NOT_FOUND)
    updated = await alert_service.update_status(
        alert_id,
        payload.status.value,
        action_taken=(payload.action_taken or "").strip() or None,
        description=(payload.description or "").strip() or None,
        user_id=current_user["user_id"],
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return create_response(True, "Alert status updated.", updated)
