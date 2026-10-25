# app/services/analytics_service.py
"""Occupancy analytics: the people-counting reports of InsightEye's
analytics_router, over ``count_sample`` and ``threshold_violation``.

Every report takes the same CountFilters (workspace, days, cameras, location)
and keeps InsightEye's field names (``avg_person_count``, ``sample_size``,
``weekday_name`` ...), so its charts port over unchanged. Two things differ:
hours and weekdays are cut in the viewer's timezone rather than a fixed
Africa/Cairo, and averages are rounded to 2 places in SQL.

The SQL is also in database/queries.sql, section 3.
"""

import logging
from dataclasses import replace
from datetime import timedelta
from typing import Any, Dict, List, Optional

from app.core.database import db_manager
from app.services.filters import DEFAULT_DAYS, CountFilters, Sql, scope

logger = logging.getLogger(__name__)

_AGG = """
    ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
    MAX(s.person_count)                           AS max_person_count,
    MIN(s.person_count)                           AS min_person_count,
    COUNT(*)                                      AS sample_size
"""

_SAMPLES = "FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id"


def _local(sql: Sql, f: CountFilters, column: str = "s.captured_at") -> str:
    """``column`` as wall-clock time in the viewer's timezone."""
    return f"({column} AT TIME ZONE {sql.p(f.tz)})"


def _pct(part: int, whole: int) -> Optional[float]:
    return round(100.0 * part / whole, 2) if whole else None


class AnalyticsService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def resolve(self, f: CountFilters) -> CountFilters:
        """Fill in missing dates: the last DEFAULT_DAYS days up to today in
        ``f.tz`` (Postgres decides what "today" is there)."""
        if f.start_date and f.end_date:
            return f
        row = await self.db_manager.execute_query(
            "SELECT (NOW() AT TIME ZONE $1)::date AS today", (f.tz,), fetch_one=True
        )
        end = f.end_date or row["today"]
        start = f.start_date or end - timedelta(days=DEFAULT_DAYS - 1)
        return replace(f, start_date=start, end_date=end)

    @staticmethod
    def bucket_for(f: CountFilters) -> str:
        """Hourly buckets for up to two days, daily beyond."""
        return "hour" if (f.end_date - f.start_date).days < 2 else "day"

    # ---------------------------------------------------------------- summary
    async def summary(self, f: CountFilters) -> Dict[str, Any]:
        """KPIs, the occupancy series and the weekday x hour heatmap."""
        f = await self.resolve(f)
        bucket = self.bucket_for(f)

        sql = Sql()
        where = scope(f, sql, "captured_at")
        totals = await self.db_manager.execute_query(
            f"""
            SELECT {_AGG},
                   COUNT(DISTINCT s.camera_id) AS cameras_reporting
            {_SAMPLES}
            WHERE {where}
            """,
            sql.args,
            fetch_one=True,
        )

        sql = Sql()
        where = scope(f, sql, "captured_at")
        peak = await self.db_manager.execute_query(
            f"""
            SELECT s.person_count, s.captured_at, c.name AS camera_name, s.camera_id
            {_SAMPLES}
            WHERE {where}
            ORDER BY s.person_count DESC, s.captured_at DESC
            LIMIT 1
            """,
            sql.args,
            fetch_one=True,
        )

        sql = Sql()
        where = scope(f, sql, "captured_at", row="v")
        violations = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE v.threshold_type = 'greater_than') AS above_max,
                   COUNT(*) FILTER (WHERE v.threshold_type = 'less_than')    AS below_min
            FROM threshold_violation v JOIN camera c ON c.camera_id = v.camera_id
            WHERE {where}
            """,
            sql.args,
            fetch_one=True,
        )

        sql = Sql()
        where = scope(f, sql, "triggered_at", row="a")
        alerts = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE a.status = 'OPEN')           AS open,
                   COUNT(*) FILTER (WHERE a.status = 'FALSE_POSITIVE') AS false_positives
            FROM count_alert a JOIN camera c ON c.camera_id = a.camera_id
            WHERE {where}
            """,
            sql.args,
            fetch_one=True,
        )

        return {
            "window": {**f.applied(), "bucket": bucket},
            "kpis": {
                "samples": totals["sample_size"],
                "avg_person_count": totals["avg_person_count"],
                "max_person_count": totals["max_person_count"],
                "cameras_reporting": totals["cameras_reporting"],
                "peak": peak,
                "violations": violations["total"],
                "above_max": violations["above_max"],
                "below_min": violations["below_min"],
                "violation_rate": _pct(violations["total"], totals["sample_size"]),
                "alerts": alerts["total"],
                "open_alerts": alerts["open"],
                "false_positive_alerts": alerts["false_positives"],
            },
            "series": await self.series(f, bucket),
            "heatmap": await self.heatmap(f),
        }

    async def series(self, f: CountFilters, bucket: str) -> List[Dict[str, Any]]:
        """Average and peak per bucket over the whole window, empty buckets
        included (generate_series supplies the ones a GROUP BY would drop)."""
        sql = Sql()
        where = scope(f, sql, "captured_at")
        step = "1 hour" if bucket == "hour" else "1 day"
        start, end = sql.p(f.start_date), sql.p(f.end_date)
        rows = await self.db_manager.execute_query(
            f"""
            WITH buckets AS (
                SELECT generate_series(
                    {start}::date::timestamp,
                    ({end}::date + 1)::timestamp - INTERVAL '{step}',
                    INTERVAL '{step}'
                ) AS bucket_start
            ),
            samples AS (
                SELECT date_trunc('{bucket}', {_local(sql, f)}) AS bucket_start, s.person_count
                {_SAMPLES}
                WHERE {where}
            )
            SELECT b.bucket_start,
                   ROUND(AVG(x.person_count)::numeric, 2)::float AS avg_person_count,
                   MAX(x.person_count)                           AS max_person_count,
                   COUNT(x.person_count)                         AS sample_size
            FROM buckets b
            LEFT JOIN samples x ON x.bucket_start = b.bucket_start
            GROUP BY b.bucket_start
            ORDER BY b.bucket_start
            """,
            sql.args,
            fetch_all=True,
        )
        # Naive local timestamps: they are wall-clock times in ``tz``.
        return [{**row, "bucket_start": row["bucket_start"].isoformat()} for row in rows]

    async def heatmap(self, f: CountFilters) -> List[Dict[str, Any]]:
        """Average count per weekday (0 = Sunday) and hour."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        local = _local(sql, f)
        return await self.db_manager.execute_query(
            f"""
            SELECT EXTRACT(DOW  FROM {local})::int AS weekday,
                   EXTRACT(HOUR FROM {local})::int AS hour,
                   {_AGG}
            {_SAMPLES}
            WHERE {where}
            GROUP BY weekday, hour
            ORDER BY weekday, hour
            """,
            sql.args,
            fetch_all=True,
        )

    # ------------------------------------------------- InsightEye's reports
    async def cameras_average(self, f: CountFilters) -> List[Dict[str, Any]]:
        """/analytics/cameras/average-people: average, peak and low per camera."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        return await self.db_manager.execute_query(
            f"""
            SELECT s.camera_id, c.name AS camera_name, c.location, c.building,
                   c.floor_level, c.zone, c.area,
                   {_AGG}
            {_SAMPLES}
            WHERE {where}
            GROUP BY s.camera_id, c.name, c.location, c.building, c.floor_level, c.zone, c.area
            ORDER BY avg_person_count DESC, camera_name
            """,
            sql.args,
            fetch_all=True,
        )

    async def busiest_hours_by_weekday(self, f: CountFilters) -> List[Dict[str, Any]]:
        """/analytics/busiest-hours/by-weekday: each weekday's busiest hour."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        local = _local(sql, f)
        return await self.db_manager.execute_query(
            f"""
            WITH hourly AS (
                SELECT TO_CHAR({local}, 'FMDay')        AS weekday_name,
                       EXTRACT(DOW  FROM {local})::int  AS weekday_num,
                       EXTRACT(HOUR FROM {local})::int  AS hour,
                       ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
                       COUNT(*)                         AS sample_size
                {_SAMPLES}
                WHERE {where}
                GROUP BY weekday_name, weekday_num, hour
            ),
            ranked AS (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY weekday_num ORDER BY avg_person_count DESC, hour
                ) AS rn
                FROM hourly
            )
            SELECT weekday_name, weekday_num, hour, avg_person_count, sample_size
            FROM ranked WHERE rn = 1
            ORDER BY weekday_num
            """,
            sql.args,
            fetch_all=True,
        )

    async def floors_average(self, f: CountFilters) -> List[Dict[str, Any]]:
        """/analytics/floors/average-people."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        return await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(c.floor_level, 'Unknown') AS floor_level, {_AGG}
            {_SAMPLES}
            WHERE {where}
            GROUP BY 1
            ORDER BY 1
            """,
            sql.args,
            fetch_all=True,
        )

    async def floors_by_weekday(self, f: CountFilters) -> List[Dict[str, Any]]:
        """/analytics/floors/people-by-weekday."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        local = _local(sql, f)
        return await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(c.floor_level, 'Unknown') AS floor_level,
                   TO_CHAR({local}, 'FMDay')         AS weekday_name,
                   EXTRACT(DOW FROM {local})::int    AS weekday_num,
                   ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
                   COUNT(*)                          AS sample_size
            {_SAMPLES}
            WHERE {where}
            GROUP BY 1, 2, 3
            ORDER BY weekday_num, floor_level
            """,
            sql.args,
            fetch_all=True,
        )

    async def floors_by_hour(self, f: CountFilters) -> List[Dict[str, Any]]:
        """/analytics/floors/people-by-hour."""
        f = await self.resolve(f)
        sql = Sql()
        where = scope(f, sql, "captured_at")
        local = _local(sql, f)
        return await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(c.floor_level, 'Unknown') AS floor_level,
                   EXTRACT(HOUR FROM {local})::int   AS hour,
                   ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
                   COUNT(*)                          AS sample_size
            {_SAMPLES}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY floor_level, hour
            """,
            sql.args,
            fetch_all=True,
        )

    async def timeseries(self, f: CountFilters) -> Dict[str, Any]:
        """/analytics/timeseries: per camera, average and peak per bucket.

        InsightEye returns the raw samples (up to 5000 per camera); bucketing
        keeps a 90-day chart to ~90 points per line.
        """
        f = await self.resolve(f)
        days = (f.end_date - f.start_date).days + 1
        interval = "5 minutes" if days == 1 else "1 hour" if days <= 7 else "1 day"
        sql = Sql()
        where = scope(f, sql, "captured_at")
        origin = sql.p(f.start_date)
        rows = await self.db_manager.execute_query(
            f"""
            SELECT s.camera_id, c.name AS camera_name,
                   date_bin(INTERVAL '{interval}', {_local(sql, f)}, {origin}::date::timestamp)
                       AS bucket_start,
                   ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
                   MAX(s.person_count) AS max_person_count
            {_SAMPLES}
            WHERE {where}
            GROUP BY s.camera_id, c.name, bucket_start
            ORDER BY c.name, s.camera_id, bucket_start
            """,
            sql.args,
            fetch_all=True,
        )
        cameras: Dict[Any, Dict[str, Any]] = {}
        for row in rows:
            camera = cameras.setdefault(
                row["camera_id"],
                {"camera_id": row["camera_id"], "camera_name": row["camera_name"], "datapoints": []},
            )
            camera["datapoints"].append(
                {
                    "timestamp": row["bucket_start"].isoformat(),
                    "avg_person_count": row["avg_person_count"],
                    "max_person_count": row["max_person_count"],
                }
            )
        return {"interval": interval, "cameras": list(cameras.values())}

    async def threshold_violations_by_camera(
        self, f: CountFilters, include_zero_violations: bool = False
    ) -> Dict[str, Any]:
        """/analytics/threshold-violations-by-camera (InsightEye's
        /analytics/fire/threshold-violations-by-camera, which is about people).

        Every camera with a limit set, its violations either way and the share
        of its samples that broke a limit.
        """
        f = await self.resolve(f)
        sql = Sql()
        v_where = scope(f, sql, "captured_at", row="v")
        s_where = scope(f, sql, "captured_at")
        a_where = scope(f, sql, "triggered_at", row="a")
        zero = "" if include_zero_violations else "WHERE COALESCE(v.above_max_count, 0) + COALESCE(v.below_min_count, 0) > 0"
        rows = await self.db_manager.execute_query(
            f"""
            WITH violations AS (
                SELECT v.camera_id,
                       COUNT(*) FILTER (WHERE v.threshold_type = 'greater_than') AS above_max_count,
                       COUNT(*) FILTER (WHERE v.threshold_type = 'less_than')    AS below_min_count,
                       MAX(v.captured_at) FILTER (WHERE v.threshold_type = 'greater_than')
                                                                                 AS last_above_max_time,
                       MAX(v.captured_at) FILTER (WHERE v.threshold_type = 'less_than')
                                                                                 AS last_below_min_time
                FROM threshold_violation v JOIN camera c ON c.camera_id = v.camera_id
                WHERE {v_where}
                GROUP BY v.camera_id
            ),
            checks AS (
                SELECT s.camera_id, {_AGG}
                {_SAMPLES}
                WHERE {s_where}
                GROUP BY s.camera_id
            ),
            alerts AS (
                SELECT a.camera_id, COUNT(*) AS alerts
                FROM count_alert a JOIN camera c ON c.camera_id = a.camera_id
                WHERE {a_where}
                GROUP BY a.camera_id
            ),
            limited AS (
                SELECT c.* FROM camera c
                WHERE c.workspace_id = {sql.p(f.workspace_id)}
                  AND (c.count_threshold_greater IS NOT NULL OR c.count_threshold_less IS NOT NULL)
            )
            SELECT c.camera_id, c.name AS camera_name, c.location, c.building, c.floor_level,
                   c.zone, c.area,
                   c.count_threshold_greater AS max_threshold,
                   c.count_threshold_less    AS min_threshold,
                   c.alert_enabled,
                   COALESCE(v.above_max_count, 0) AS above_max_count,
                   COALESCE(v.below_min_count, 0) AS below_min_count,
                   COALESCE(v.above_max_count, 0) + COALESCE(v.below_min_count, 0) AS total_violations,
                   COALESCE(k.sample_size, 0) AS total_checks,
                   k.avg_person_count, k.max_person_count, k.min_person_count,
                   v.last_above_max_time, v.last_below_min_time,
                   COALESCE(a.alerts, 0) AS alerts
            FROM limited c
            LEFT JOIN violations v ON v.camera_id = c.camera_id
            LEFT JOIN checks k     ON k.camera_id = c.camera_id
            LEFT JOIN alerts a     ON a.camera_id = c.camera_id
            {zero}
            ORDER BY total_violations DESC, camera_name
            """,
            sql.args,
            fetch_all=True,
        )
        # The camera filters apply to the per-camera rows too.
        if f.camera_ids:
            wanted = set(f.camera_ids)
            rows = [r for r in rows if r["camera_id"] in wanted]
        for name, column in (("buildings", "building"), ("floors", "floor_level"),
                             ("zones", "zone"), ("areas", "area")):
            values = getattr(f, name)
            if values:
                rows = [r for r in rows if r[column] in values]

        data = [{**row, "violation_rate": _pct(row["total_violations"], row["total_checks"])} for row in rows]
        return {
            "data": data,
            "summary": {
                "cameras_monitored": len(data),
                "cameras_with_violations": sum(1 for r in data if r["total_violations"]),
                "cameras_with_above_max": sum(1 for r in data if r["above_max_count"]),
                "cameras_with_below_min": sum(1 for r in data if r["below_min_count"]),
                "total_above_max_violations": sum(r["above_max_count"] for r in data),
                "total_below_min_violations": sum(r["below_min_count"] for r in data),
                "total_violations": sum(r["total_violations"] for r in data),
            },
        }


analytics_service = AnalyticsService()
