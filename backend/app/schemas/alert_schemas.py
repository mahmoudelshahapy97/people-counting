from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class AlertStatus(str, Enum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"
    FALSE_POSITIVE = "FALSE_POSITIVE"


class ThresholdType(str, Enum):
    GREATER_THAN = "greater_than"
    LESS_THAN = "less_than"


class AlertStatusUpdate(BaseModel):
    status: AlertStatus
    # Optional notes on how it was handled; left out, the stored ones are kept.
    action_taken: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)


class AlertResponse(BaseModel):
    alert_id: UUID
    camera_id: Optional[UUID] = None
    camera_name: Optional[str] = None
    location: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    area: Optional[str] = None
    triggered_at: datetime
    person_count: int
    threshold_type: ThresholdType
    threshold_value: int
    status: AlertStatus
    action_taken: Optional[str] = None
    description: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    resolved_by_username: Optional[str] = None
    has_frame: bool = False
    frame_base64: Optional[str] = None


class AlertListResponse(BaseModel):
    total: int
    page: int
    per_page: int
    alerts: List[AlertResponse]
