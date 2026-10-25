from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

_SETTINGS_HELP = (
    "Per-camera overrides of the .env counting values: confidence, input_size, "
    "sample_interval_s, alert_cooldown_s, e.g. {'confidence': 0.6}"
)


def _check_roi(value: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
    if value is None:
        return None
    if len(value) < 3:
        raise ValueError("roi needs at least 3 points")
    if any(len(point) != 2 for point in value):
        raise ValueError("each roi point must be [x, y]")
    return value


def _check_order(greater: Optional[int], less: Optional[int]) -> None:
    # InsightEye's validate_alert_thresholds_trigger: a band that admits no
    # count would alert on every sample.
    if greater is not None and less is not None and less >= greater:
        raise ValueError(
            "count_threshold_less (minimum) must be lower than count_threshold_greater (maximum)."
        )


class LocationFields(BaseModel):
    location: Optional[str] = Field(None, max_length=200)
    building: Optional[str] = Field(None, max_length=100)
    floor_level: Optional[str] = Field(None, max_length=40)
    zone: Optional[str] = Field(None, max_length=120)
    area: Optional[str] = Field(None, max_length=120)

    @field_validator("location", "building", "floor_level", "zone", "area")
    @classmethod
    def blank_is_none(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ThresholdSettings(BaseModel):
    """A camera's occupancy limits (InsightEye ThresholdSettings)."""

    count_threshold_greater: Optional[int] = Field(
        None, ge=0, description="Alert when more people than this are counted"
    )
    count_threshold_less: Optional[int] = Field(
        None, ge=0, description="Alert when fewer people than this are counted"
    )
    alert_enabled: bool = True

    @model_validator(mode="after")
    def check_order(self) -> "ThresholdSettings":
        _check_order(self.count_threshold_greater, self.count_threshold_less)
        return self


class CameraCreate(LocationFields):
    name: str = Field(..., min_length=1, max_length=120)
    rtsp_url: str = Field(..., description="rtsp://user:pass@host:554/stream, or a local video file path")
    enabled: bool = True
    roi: Optional[List[List[float]]] = Field(
        None, description="Optional polygon [[x,y], ...]: only people standing inside it count"
    )
    settings: Optional[Dict[str, Any]] = Field(None, description=_SETTINGS_HELP)
    count_threshold_greater: Optional[int] = Field(None, ge=0)
    count_threshold_less: Optional[int] = Field(None, ge=0)
    alert_enabled: bool = True

    @field_validator("roi")
    @classmethod
    def validate_roi(cls, value: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
        return _check_roi(value)

    @model_validator(mode="after")
    def check_order(self) -> "CameraCreate":
        _check_order(self.count_threshold_greater, self.count_threshold_less)
        return self


class CameraUpdate(LocationFields):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    rtsp_url: Optional[str] = None
    enabled: Optional[bool] = None
    roi: Optional[List[List[float]]] = None
    settings: Optional[Dict[str, Any]] = None
    count_threshold_greater: Optional[int] = Field(None, ge=0)
    count_threshold_less: Optional[int] = Field(None, ge=0)
    alert_enabled: Optional[bool] = None

    @field_validator("roi")
    @classmethod
    def validate_roi(cls, value: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
        return _check_roi(value)

    @model_validator(mode="after")
    def check_order(self) -> "CameraUpdate":
        _check_order(self.count_threshold_greater, self.count_threshold_less)
        return self


class CameraResponse(BaseModel):
    camera_id: UUID
    workspace_id: Optional[UUID] = None
    name: str
    rtsp_url: str
    location: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    area: Optional[str] = None
    enabled: bool
    roi: Optional[Any] = None
    settings: Optional[Any] = None
    count_threshold_greater: Optional[int] = None
    count_threshold_less: Optional[int] = None
    alert_enabled: bool = True
    created_at: datetime
    updated_at: Optional[datetime] = None
