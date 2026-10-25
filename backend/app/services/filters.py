# app/services/filters.py
"""The filter every count query shares: workspace, date range, cameras and
the location hierarchy (InsightEye's build_location_filters).

Dates are whole days in the viewer's timezone, both ends inclusive, as in
InsightEye's start_date / end_date. Leaving both out means the last
``DEFAULT_DAYS`` days, today included.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any, List, Optional, Sequence
from uuid import UUID

DEFAULT_DAYS = 7
MAX_DAYS = 366

# filter attribute -> camera column
LOCATION_COLUMNS = {
    "buildings": "building",
    "floors": "floor_level",
    "zones": "zone",
    "areas": "area",
}


def split_values(values: Optional[Sequence[str]]) -> Optional[List[str]]:
    """Accept both ?zone=a&zone=b and InsightEye's comma-joined ?zones=a,b."""
    if not values:
        return None
    out = [part.strip() for value in values for part in str(value).split(",") if part.strip()]
    return out or None


@dataclass
class CountFilters:
    workspace_id: UUID
    tz: str = "UTC"
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    camera_ids: Optional[List[UUID]] = None
    buildings: Optional[List[str]] = None
    floors: Optional[List[str]] = None
    zones: Optional[List[str]] = None
    areas: Optional[List[str]] = None

    def applied(self) -> dict:
        """Echoed back as ``filters_applied``, as InsightEye's analytics do."""
        return {
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "tz": self.tz,
            "camera_ids": [str(c) for c in self.camera_ids] if self.camera_ids else None,
            **{name: getattr(self, name) for name in LOCATION_COLUMNS},
        }

    def validate(self) -> None:
        if self.start_date and self.end_date:
            if self.start_date > self.end_date:
                raise ValueError("start_date must not be after end_date.")
            if (self.end_date - self.start_date).days >= MAX_DAYS:
                raise ValueError(f"The date range is limited to {MAX_DAYS} days.")


@dataclass
class Sql:
    """Positional parameters for one query: ``sql.p(value)`` returns "$n"."""

    params: List[Any] = field(default_factory=list)

    def p(self, value: Any) -> str:
        self.params.append(value)
        return f"${len(self.params)}"

    @property
    def args(self) -> tuple:
        return tuple(self.params)


def scope(
    f: CountFilters,
    sql: Sql,
    time_column: str,
    row: str = "s",
    camera: str = "c",
    dated: bool = True,
) -> str:
    """The WHERE body for a table joined to ``camera``.

    ``time_column`` is the row's TIMESTAMPTZ column. The day bounds are
    turned into instants in ``f.tz`` by Postgres, so its tz database decides
    DST and offsets, not the client's.
    """
    conditions = [f"{row}.workspace_id = {sql.p(f.workspace_id)}"]
    if dated:
        tz = sql.p(f.tz)
        if f.start_date or f.end_date:
            if f.start_date:
                conditions.append(
                    f"{row}.{time_column} >= ({sql.p(f.start_date)}::date)::timestamp AT TIME ZONE {tz}"
                )
            if f.end_date:
                conditions.append(
                    f"{row}.{time_column} < ({sql.p(f.end_date)}::date + 1)::timestamp AT TIME ZONE {tz}"
                )
        else:
            conditions.append(
                f"{row}.{time_column} >= (date_trunc('day', NOW() AT TIME ZONE {tz})"
                f" - {sql.p(DEFAULT_DAYS - 1)} * INTERVAL '1 day') AT TIME ZONE {tz}"
            )
    if f.camera_ids:
        conditions.append(f"{row}.camera_id = ANY({sql.p(list(f.camera_ids))}::uuid[])")
    for name, column in LOCATION_COLUMNS.items():
        values = getattr(f, name)
        if values:
            conditions.append(f"{camera}.{column} = ANY({sql.p(list(values))}::text[])")
    return " AND ".join(conditions)
