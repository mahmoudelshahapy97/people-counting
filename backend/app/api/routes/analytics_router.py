# app/api/routes/analytics_router.py
"""The people-counting reports of InsightEye's analytics_router.

Each returns ``{success, count, filters_applied, data}`` like InsightEye's,
and takes the shared filters: start_date / end_date (whole days in ``tz``),
camera_id, buildings, floors, zones, areas. No dates = the last 7 days.
"""

import logging
from typing import Any, Awaitable, Callable, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import get_count_filters, require_role
from app.services.analytics_service import analytics_service
from app.services.filters import CountFilters
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["analytics"], prefix="/analytics", dependencies=[Depends(require_role("viewer"))]
)


async def _report(
    name: str, f: CountFilters, run: Callable[[CountFilters], Awaitable[List[Dict[str, Any]]]]
) -> Dict[str, Any]:
    try:
        resolved = await analytics_service.resolve(f)
        data = await run(resolved)
    except Exception as e:
        logger.error("Error computing %s: %s", name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Could not compute {name}."
        )
    return {
        "success": True,
        "count": len(data),
        "filters_applied": resolved.applied(),
        "data": data,
    }


@router.get("/summary")
async def analytics_summary(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    """KPIs (average, peak, violations, alerts), the occupancy series (hourly
    up to two days, daily beyond) and the weekday x hour heatmap."""
    try:
        data = await analytics_service.summary(f)
    except Exception as e:
        logger.error("Error computing analytics: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not compute analytics."
        )
    return create_response(True, "Analytics summary.", data)


@router.get("/cameras/average-people")
async def average_people_by_camera(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    """Average, peak and lowest count per camera, busiest first."""
    return await _report("average people per camera", f, analytics_service.cameras_average)


@router.get("/busiest-hours/by-weekday")
async def busiest_hours_by_weekday(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    """For each weekday, the hour with the highest average count."""
    return await _report("busiest hours", f, analytics_service.busiest_hours_by_weekday)


@router.get("/floors/average-people")
async def average_people_by_floor(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    return await _report("average people per floor", f, analytics_service.floors_average)


@router.get("/floors/people-by-weekday")
async def people_by_floor_and_weekday(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    return await _report("people per floor and weekday", f, analytics_service.floors_by_weekday)


@router.get("/floors/people-by-hour")
async def people_by_floor_and_hour(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    return await _report("people per floor and hour", f, analytics_service.floors_by_hour)


@router.get("/heatmap")
async def weekday_hour_heatmap(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    """Average count per weekday (0 = Sunday) and hour of day."""
    return await _report("the heatmap", f, analytics_service.heatmap)


@router.get("/timeseries")
async def camera_timeseries(f: CountFilters = Depends(get_count_filters)) -> Dict[str, Any]:
    """Per camera, average and peak per bucket: 5 minutes for one day, hourly
    up to a week, daily beyond."""
    try:
        resolved = await analytics_service.resolve(f)
        data = await analytics_service.timeseries(resolved)
    except Exception as e:
        logger.error("Error computing the time series: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not compute the time series."
        )
    return {
        "success": True,
        "count": len(data["cameras"]),
        "filters_applied": resolved.applied(),
        "interval": data["interval"],
        "data": data["cameras"],
    }


@router.get("/threshold-violations-by-camera")
async def threshold_violations_by_camera(
    include_zero_violations: bool = Query(
        False, description="Also list cameras with limits that were never broken"
    ),
    f: CountFilters = Depends(get_count_filters),
) -> Dict[str, Any]:
    """Above-max and below-min violations per camera, with its violation rate
    (violating samples / samples) and a workspace summary."""
    try:
        resolved = await analytics_service.resolve(f)
        result = await analytics_service.threshold_violations_by_camera(
            resolved, include_zero_violations=include_zero_violations
        )
    except Exception as e:
        logger.error("Error computing threshold violations: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not compute threshold violations.",
        )
    return {
        "success": True,
        "count": len(result["data"]),
        "filters_applied": resolved.applied(),
        "summary": result["summary"],
        "data": result["data"],
    }
