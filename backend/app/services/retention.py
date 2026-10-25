# app/services/retention.py
"""Bounded storage for counts and alerts.

A camera stores a sample every SAMPLE_INTERVAL_S, forever unless something
deletes them: ~3 million rows a year per camera at the default 10 s. Each pass
deletes samples and violations older than SAMPLE_RETENTION_DAYS, and alerts
older than ALERT_RETENTION_DAYS together with their snapshots in MinIO.
Deletes go in batches, so a first pass over a large backlog never holds one
long lock against the workers' inserts.

Turn it off with RETENTION_ENABLED=false where an external archiver owns the data.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from app.core.config import config
from app.core.database import db_manager
from app.services.object_store import object_store

logger = logging.getLogger(__name__)

BATCH = 10_000

_task: Optional[asyncio.Task] = None


@dataclass
class PurgeReport:
    samples_deleted: int = 0
    violations_deleted: int = 0
    alerts_deleted: int = 0
    snapshots_deleted: int = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)

    @property
    def anything(self) -> bool:
        return any(self.__dict__.values())


async def _delete_batched(table: str, key: str, time_column: str, days: int) -> int:
    total = 0
    while True:
        deleted = await db_manager.execute_query(
            f"""
            DELETE FROM {table} WHERE {key} IN (
                SELECT {key} FROM {table}
                WHERE {time_column} < NOW() - make_interval(days => $1)
                LIMIT $2
            )
            """,
            (days, BATCH),
            return_rowcount=True,
        )
        total += deleted
        if deleted < BATCH:
            return total


async def _purge_alerts(report: PurgeReport) -> None:
    while True:
        rows = await db_manager.execute_query(
            """
            DELETE FROM count_alert WHERE alert_id IN (
                SELECT alert_id FROM count_alert
                WHERE triggered_at < NOW() - make_interval(days => $1)
                LIMIT $2
            )
            RETURNING frame_key
            """,
            (config.alert_retention_days, BATCH),
            fetch_all=True,
        )
        report.alerts_deleted += len(rows)
        keys = [row["frame_key"] for row in rows if row["frame_key"]]
        if keys:
            report.snapshots_deleted += len(await object_store.remove(keys))
        if len(rows) < BATCH:
            return


async def purge_expired() -> PurgeReport:
    """Run one retention pass. Never raises -- a purge failure is not fatal."""
    report = PurgeReport()
    try:
        report.samples_deleted = await _delete_batched(
            "count_sample", "sample_id", "captured_at", config.sample_retention_days
        )
        report.violations_deleted = await _delete_batched(
            "threshold_violation", "violation_id", "captured_at", config.sample_retention_days
        )
        await _purge_alerts(report)
    except Exception:
        logger.exception("Retention pass failed")
    if report.anything:
        logger.info("Retention pass: %s", report.as_dict())
    return report


async def _loop() -> None:
    interval = max(60.0, config.retention_interval_s)
    while True:
        await purge_expired()
        await asyncio.sleep(interval)


def start() -> None:
    global _task
    if not config.retention_enabled or _task is not None:
        return
    _task = asyncio.create_task(_loop(), name="retention")


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None
