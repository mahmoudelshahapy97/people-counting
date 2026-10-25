"""Integration tests against a live Postgres.

Skipped automatically when no database is reachable, so ``pytest`` stays green
without one. To run them, point the usual DB_* variables at a server that has
``database/schema.sql`` applied - for example the compose stack::

    DB_HOST=localhost DB_PORT=5437 pytest tests/test_integration.py

No model weights are needed: the worker test swaps in a fake detector, and the
analytics tests write samples directly.
"""

import csv
import io
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import List

import asyncpg
import numpy as np
import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.security import create_access_token
from app.services import retention
from app.services.alert_service import alert_service
from app.services.analytics_service import analytics_service
from app.services.camera_service import camera_service
from app.services.count_service import count_service
from app.services.filters import CountFilters
from app.services.object_store import camera_prefix, object_store
from app.services.people_counter import GREATER_THAN, LESS_THAN, Person, Violation
from app.services.stream_manager import CameraWorker
from app.services.user_service import user_service
from app.services.workspace_service import DEFAULT_WORKSPACE_ID, workspace_service

pytestmark = pytest.mark.asyncio

# A fixed past week, so day and hour buckets are deterministic: Monday
# 2025-03-03 .. Sunday 2025-03-09.
WEEK_START = date(2025, 3, 3)
WEEK_END = date(2025, 3, 9)


@pytest.fixture(scope="module")
async def database():
    """Connect once for the module, or skip the whole file."""
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")

    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")

    await run_migrations()
    yield
    await close_db_pool()


_CAMERAS: List[uuid.UUID] = []


async def _camera(**fields):
    created = await camera_service.create_camera(
        name=fields.pop("name", f"test-cam-{uuid.uuid4().hex[:8]}"),
        rtsp_url=fields.pop("rtsp_url", "rtsp://example.invalid:8554/test"),
        enabled=fields.pop("enabled", False),
        **fields,
    )
    _CAMERAS.append(created["camera_id"])
    return created


@pytest.fixture(autouse=True)
async def cleanup_cameras(database):
    """Deleting a camera cascades to its samples, violations and alerts."""
    yield
    for camera_id in _CAMERAS:
        await camera_service.delete_camera(camera_id)
        await object_store.remove_prefix(camera_prefix(camera_id))
    _CAMERAS.clear()


@pytest.fixture
async def camera(database):
    return await _camera(location="test-suite", count_threshold_greater=3, count_threshold_less=1)


@pytest.fixture
async def admin(database):
    suffix = uuid.uuid4().hex[:8]
    user = await user_service.create_user(
        f"it-admin-{suffix}", f"it-admin-{suffix}@example.com", "Valid1Password!", "admin"
    )
    token = create_access_token(user["user_id"], user["role"], user["token_version"])
    yield {"Authorization": f"Bearer {token}"}
    await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (user["user_id"],))


def _filters(**kw) -> CountFilters:
    return CountFilters(workspace_id=DEFAULT_WORKSPACE_ID, **kw)


async def _sample(camera_id, at: datetime, count: int, violation: Violation = None):
    await count_service.record_sample(camera_id, count, at, violation)


# ------------------------------------------------------------------- cameras
async def test_camera_crud_with_location_and_limits(database):
    created = await _camera(
        roi=[[0, 0], [100, 0], [100, 100]],
        settings={"confidence": 0.6},
        building="HQ",
        floor_level="2",
        zone="Lobby",
        count_threshold_greater=20,
        count_threshold_less=2,
    )
    assert (created["building"], created["floor_level"], created["zone"]) == ("HQ", "2", "Lobby")
    assert (created["count_threshold_greater"], created["count_threshold_less"]) == (20, 2)
    assert created["alert_enabled"] is True
    assert camera_service.parse_settings(created)["confidence"] == 0.6
    assert created["workspace_id"] == DEFAULT_WORKSPACE_ID

    updated = await camera_service.update_camera(
        created["camera_id"], rtsp_url="rtsp://example.invalid/b", count_threshold_less=None, zone=None
    )
    assert updated["rtsp_url"] == "rtsp://example.invalid/b"
    # None clears a nullable column...
    assert updated["count_threshold_less"] is None
    assert updated["zone"] is None
    # ...and leaves the others alone.
    updated = await camera_service.update_camera(created["camera_id"], name=None, enabled=None)
    assert updated["name"] == created["name"]
    assert updated["count_threshold_greater"] == 20


async def test_database_refuses_a_band_that_admits_no_count(database):
    with pytest.raises(asyncpg.CheckViolationError):
        await _camera(count_threshold_greater=5, count_threshold_less=5)
    created = await _camera(count_threshold_greater=5)
    with pytest.raises(asyncpg.CheckViolationError):
        await camera_service.update_camera(created["camera_id"], count_threshold_less=9)


# -------------------------------------------------------------------- counts
async def test_sample_and_violation_take_the_camera_workspace(camera):
    at = datetime.now(timezone.utc)
    await _sample(camera["camera_id"], at, 7, Violation(GREATER_THAN, 3, 7))
    sample = await db_manager.execute_query(
        "SELECT workspace_id, person_count FROM count_sample WHERE camera_id = $1",
        (camera["camera_id"],),
        fetch_one=True,
    )
    violation = await db_manager.execute_query(
        "SELECT workspace_id, threshold_type, threshold_value, captured_at FROM threshold_violation "
        "WHERE camera_id = $1",
        (camera["camera_id"],),
        fetch_one=True,
    )
    assert sample == {"workspace_id": DEFAULT_WORKSPACE_ID, "person_count": 7}
    assert violation["threshold_type"] == GREATER_THAN and violation["threshold_value"] == 3
    assert violation["captured_at"] == at


class FakeDetector:
    def __init__(self, counts):
        self.counts = list(counts)

    def detect(self, frame):
        n = self.counts.pop(0)
        return [Person((10.0 * i, 10.0, 10.0 * i + 8, 60.0), 0.9) for i in range(n)]


async def _run(worker: CameraWorker, counts, frame) -> None:
    worker.detector = FakeDetector(counts)
    for _ in counts:
        worker._next_sample_at = 0.0  # every frame is a sample, for the test
        await worker._process(frame)


async def test_worker_stores_samples_and_raises_one_alert_per_cooldown(camera):
    worker = CameraWorker(camera)  # limits: less 1, greater 3
    frame = np.full((120, 160, 3), 90, dtype=np.uint8)

    await _run(worker, [2, 5, 6, 0], frame)

    assert worker.current_count == 0
    assert worker.samples_stored == 4
    assert worker.violations == 3  # 5 and 6 above, 0 below
    assert worker.alerts_raised == 1  # the cooldown holds back the rest
    status = worker.status()
    assert status["in_violation"] and status["violation"] == LESS_THAN
    assert status["cooldown_remaining_s"] > 0

    rows = await db_manager.execute_query(
        "SELECT person_count FROM count_sample WHERE camera_id = $1 ORDER BY sample_id",
        (camera["camera_id"],),
        fetch_all=True,
    )
    assert [r["person_count"] for r in rows] == [2, 5, 6, 0]
    alerts = await alert_service.list_alerts(DEFAULT_WORKSPACE_ID, camera_id=camera["camera_id"])
    assert alerts["total"] == 1
    alert = alerts["alerts"][0]
    assert (alert["person_count"], alert["threshold_type"], alert["threshold_value"]) == (5, GREATER_THAN, 3)
    assert alert["has_frame"]
    assert (await alert_service.get_frame(alert["alert_id"]))[:2] == b"\xff\xd8"

    # A fresh worker for the same camera inherits the cooldown from the DB.
    again = CameraWorker(camera)
    last = await alert_service.last_alert_at(camera["camera_id"])
    again.cooldown.mark(last.timestamp())
    await _run(again, [9], frame)
    assert again.alerts_raised == 0


async def test_disabled_alerts_still_record_violations(database):
    cam = await _camera(count_threshold_greater=0, alert_enabled=False)
    worker = CameraWorker(cam)
    await _run(worker, [2], np.zeros((60, 80, 3), dtype=np.uint8))
    assert worker.violations == 1
    assert worker.alerts_raised == 0


async def test_alert_snapshot_goes_to_minio_or_falls_back_to_postgres(camera, monkeypatch):
    violation = Violation(GREATER_THAN, 3, 4)
    stored = await alert_service.create_alert(camera, violation, datetime.now(timezone.utc), b"\xff\xd8one")
    row = await db_manager.execute_query(
        "SELECT frame_key, frame_jpeg FROM count_alert WHERE alert_id = $1", (stored["alert_id"],), fetch_one=True
    )
    if object_store.enabled:
        assert row["frame_key"] == f"alerts/{camera['camera_id']}/{stored['alert_id']}.jpg"
        assert row["frame_jpeg"] is None
    else:
        assert bytes(row["frame_jpeg"]) == b"\xff\xd8one"

    async def down(*args, **kwargs):
        return False

    monkeypatch.setattr(object_store, "put_bytes", down)
    fallback = await alert_service.create_alert(camera, violation, datetime.now(timezone.utc), b"\xff\xd8two")
    row = await db_manager.execute_query(
        "SELECT frame_key, frame_jpeg FROM count_alert WHERE alert_id = $1", (fallback["alert_id"],), fetch_one=True
    )
    assert row["frame_key"] is None and bytes(row["frame_jpeg"]) == b"\xff\xd8two"
    assert await alert_service.get_frame(fallback["alert_id"]) == b"\xff\xd8two"


async def test_alert_status_workflow_keeps_notes_and_timestamps(camera):
    stored = await alert_service.create_alert(
        camera, Violation(LESS_THAN, 1, 0), datetime.now(timezone.utc), None
    )
    alert_id = stored["alert_id"]

    acked = await alert_service.update_status(alert_id, "ACKNOWLEDGED", action_taken="Sent staff")
    assert acked["acknowledged_at"] is not None and acked["resolved_at"] is None

    resolved = await alert_service.update_status(alert_id, "RESOLVED", description="Shift change")
    assert resolved["action_taken"] == "Sent staff"  # kept
    assert resolved["description"] == "Shift change"
    assert resolved["resolved_at"] is not None
    assert resolved["acknowledged_at"] == acked["acknowledged_at"]

    stats = await alert_service.stats(DEFAULT_WORKSPACE_ID, camera["camera_id"])
    assert (stats["total"], stats["open"], stats["below_min"]) == (1, 0, 1)


async def test_alert_mail_goes_to_the_workspace_operators_and_admins(camera):
    suffix = uuid.uuid4().hex[:8]
    made = []
    for role, member in (("admin", False), ("operator", True), ("operator", False), ("viewer", True)):
        user = await user_service.create_user(
            f"mail-{role}-{member}-{suffix}", f"mail-{role}-{member}-{suffix}@example.com", "Valid1Password!", role
        )
        made.append(user)
        await db_manager.execute_query("DELETE FROM workspace_member WHERE user_id = $1", (user["user_id"],))
        if member:
            await workspace_service.add_member(DEFAULT_WORKSPACE_ID, user["user_id"])
    try:
        to = await alert_service.recipients(DEFAULT_WORKSPACE_ID)
        mine = {address for address in to if suffix in address}
        # Admins see every workspace; operators only the ones they are in; viewers never.
        assert mine == {made[0]["email"], made[1]["email"]}
    finally:
        for user in made:
            await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (user["user_id"],))


# ------------------------------------------------------------------- history
async def test_history_filters_and_joins_violations(database):
    a = await _camera(building="HQ", floor_level="1", count_threshold_greater=4)
    b = await _camera(building="Annex", floor_level="2")
    base = datetime(2025, 3, 4, 12, tzinfo=timezone.utc)
    await _sample(a["camera_id"], base, 3)
    await _sample(a["camera_id"], base + timedelta(minutes=1), 6, Violation(GREATER_THAN, 4, 6))
    await _sample(b["camera_id"], base, 1)
    await _sample(b["camera_id"], base + timedelta(days=3), 2)

    window = dict(start_date=WEEK_START, end_date=date(2025, 3, 5))
    hq = await count_service.history(_filters(buildings=["HQ"], **window))
    assert hq["total"] == 2
    assert [(s["person_count"], s["violation"]) for s in hq["samples"]] == [(6, GREATER_THAN), (3, None)]

    both = await count_service.history(_filters(camera_ids=[a["camera_id"], b["camera_id"]], **window))
    assert both["total"] == 3  # b's second sample is outside the window
    paged = await count_service.history(
        _filters(camera_ids=[a["camera_id"], b["camera_id"]], **window), page=2, per_page=2
    )
    assert len(paged["samples"]) == 1 and paged["num_of_pages"] == 2

    chunks = [chunk async for chunk in count_service.export_csv(_filters(floors=["1"], **window))]
    rows = list(csv.reader(io.StringIO("".join(chunks))))
    assert rows[0][0] == "captured_at" and len(rows) == 3
    assert rows[2][rows[0].index("violation")] == GREATER_THAN


async def test_location_options_list_what_cameras_use(database):
    await _camera(building="HQ", zone="Lobby")
    options = await count_service.location_options(DEFAULT_WORKSPACE_ID)
    assert "HQ" in options["buildings"] and "Lobby" in options["zones"]


# ----------------------------------------------------------------- analytics
@pytest.fixture
async def week(database):
    """Two cameras on two floors with a known week of samples.

    Ground floor: 2 people every hour, 10 at 09:00 on Monday. First floor:
    4 people on Tuesday 14:00 and 15:00 only. Limit on the ground floor: 5.
    """
    ground = await _camera(floor_level="G", count_threshold_greater=5)
    first = await _camera(floor_level="1", count_threshold_less=1)
    for day in range(7):
        for hour in range(24):
            at = datetime(2025, 3, 3 + day, hour, tzinfo=timezone.utc)
            peak = day == 0 and hour == 9
            count = 10 if peak else 2
            await _sample(
                ground["camera_id"], at, count, Violation(GREATER_THAN, 5, count) if peak else None
            )
    for hour in (14, 15):
        await _sample(first["camera_id"], datetime(2025, 3, 4, hour, tzinfo=timezone.utc), 4)
    return {"ground": ground, "first": first}


def _week(**kw) -> CountFilters:
    return _filters(start_date=WEEK_START, end_date=WEEK_END, **kw)


async def test_average_people_per_camera_and_floor(week):
    ground, first = week["ground"]["camera_id"], week["first"]["camera_id"]
    rows = await analytics_service.cameras_average(_week(camera_ids=[ground, first]))
    by_id = {r["camera_id"]: r for r in rows}
    # 167 samples of 2 and one of 10.
    assert by_id[ground]["avg_person_count"] == round((167 * 2 + 10) / 168, 2)
    assert (by_id[ground]["max_person_count"], by_id[ground]["sample_size"]) == (10, 168)
    assert by_id[first]["avg_person_count"] == 4.0
    assert rows[0]["camera_id"] == first  # busiest first

    floors = await analytics_service.floors_average(_week(camera_ids=[ground, first]))
    assert {r["floor_level"]: r["sample_size"] for r in floors} == {"1": 2, "G": 168}


async def test_busiest_hour_per_weekday(week):
    rows = await analytics_service.busiest_hours_by_weekday(_week(camera_ids=[week["ground"]["camera_id"]]))
    assert len(rows) == 7
    monday = next(r for r in rows if r["weekday_name"] == "Monday")
    assert (monday["weekday_num"], monday["hour"], monday["avg_person_count"]) == (1, 9, 10.0)
    # Every other day is flat, so its first hour wins the tie.
    assert next(r for r in rows if r["weekday_name"] == "Friday")["hour"] == 0


async def test_hours_and_weekdays_follow_the_viewer_timezone(week):
    cam = [week["ground"]["camera_id"]]
    cairo = await analytics_service.busiest_hours_by_weekday(_week(camera_ids=cam, tz="Africa/Cairo"))
    # 09:00 UTC is 11:00 in Cairo (UTC+2 in March 2025).
    assert next(r for r in cairo if r["weekday_name"] == "Monday")["hour"] == 11


async def test_floor_breakdowns_by_weekday_and_hour(week):
    cams = [week["ground"]["camera_id"], week["first"]["camera_id"]]
    by_day = await analytics_service.floors_by_weekday(_week(camera_ids=cams))
    first_floor = [r for r in by_day if r["floor_level"] == "1"]
    assert [(r["weekday_name"], r["avg_person_count"]) for r in first_floor] == [("Tuesday", 4.0)]

    by_hour = await analytics_service.floors_by_hour(_week(camera_ids=cams))
    assert [(r["hour"], r["sample_size"]) for r in by_hour if r["floor_level"] == "1"] == [(14, 1), (15, 1)]
    assert len([r for r in by_hour if r["floor_level"] == "G"]) == 24


async def test_summary_series_and_heatmap(week):
    cams = [week["ground"]["camera_id"], week["first"]["camera_id"]]
    summary = await analytics_service.summary(_week(camera_ids=cams))
    kpis = summary["kpis"]
    assert (kpis["samples"], kpis["max_person_count"], kpis["violations"]) == (170, 10, 1)
    assert kpis["peak"]["camera_id"] == cams[0]
    assert kpis["violation_rate"] == round(100 / 170, 2)

    # Seven daily buckets, zero-filled, wall-clock in the viewer's timezone.
    assert summary["window"]["bucket"] == "day"
    assert [p["bucket_start"][:10] for p in summary["series"]][0] == "2025-03-03"
    assert len(summary["series"]) == 7
    assert sum(cell["sample_size"] for cell in summary["heatmap"]) == 170

    one_day = await analytics_service.summary(
        _filters(start_date=WEEK_START, end_date=WEEK_START, camera_ids=cams)
    )
    assert one_day["window"]["bucket"] == "hour" and len(one_day["series"]) == 24
    assert one_day["series"][9]["max_person_count"] == 10


async def test_timeseries_buckets_per_camera(week):
    data = await analytics_service.timeseries(_week(camera_ids=[week["first"]["camera_id"]]))
    assert data["interval"] == "1 hour"
    (camera,) = data["cameras"]
    assert [p["timestamp"] for p in camera["datapoints"]] == ["2025-03-04T14:00:00", "2025-03-04T15:00:00"]


async def test_threshold_violations_by_camera(week):
    cams = [week["ground"]["camera_id"], week["first"]["camera_id"]]
    hits = await analytics_service.threshold_violations_by_camera(_week(camera_ids=cams))
    assert [r["camera_id"] for r in hits["data"]] == [cams[0]]
    row = hits["data"][0]
    assert (row["max_threshold"], row["above_max_count"], row["below_min_count"]) == (5, 1, 0)
    assert row["total_checks"] == 168
    assert row["violation_rate"] == round(100 / 168, 2)
    assert row["last_above_max_time"] == datetime(2025, 3, 3, 9, tzinfo=timezone.utc)

    everyone = await analytics_service.threshold_violations_by_camera(
        _week(camera_ids=cams), include_zero_violations=True
    )
    assert {r["camera_id"] for r in everyone["data"]} == set(cams)
    assert everyone["summary"]["cameras_monitored"] == 2
    assert everyone["summary"]["cameras_with_violations"] == 1


# ---------------------------------------------------------------------- API
async def test_threshold_routes_validate_the_band(camera, admin, api):
    path = f"/cameras/{camera['camera_id']}/thresholds"
    got = await api.get(path, headers=admin)
    assert got.json()["data"]["thresholds"] == {
        "count_threshold_greater": 3, "count_threshold_less": 1, "alert_enabled": True,
    }
    bad = await api.put(path, json={"count_threshold_greater": 2, "count_threshold_less": 2}, headers=admin)
    assert bad.status_code == 422
    ok = await api.put(path, json={"count_threshold_greater": 40}, headers=admin)
    assert ok.status_code == 200
    stored = await camera_service.get_camera(camera["camera_id"])
    # PUT replaces: the minimum left out is removed.
    assert (stored["count_threshold_greater"], stored["count_threshold_less"]) == (40, None)

    # PATCH one side against the other one stored: the DB check, as a 400.
    clash = await api.patch(
        f"/cameras/{camera['camera_id']}", json={"count_threshold_less": 50}, headers=admin
    )
    assert clash.status_code == 400


async def test_count_routes(camera, admin, api):
    await _sample(camera["camera_id"], datetime.now(timezone.utc), 5, Violation(GREATER_THAN, 3, 5))

    live = (await api.get("/counts/live", headers=admin)).json()["data"]
    mine = next(c for c in live["cameras"] if c["camera_id"] == str(camera["camera_id"]))
    # No worker: the last stored sample stands in, marked not live.
    assert (mine["person_count"], mine["live"], mine["violation"]) == (5, False, GREATER_THAN)

    history = await api.get("/counts", params={"camera_id": str(camera["camera_id"])}, headers=admin)
    assert history.status_code == 200 and history.json()["total"] == 1

    export = await api.get("/counts/export.csv", params={"camera_id": str(camera["camera_id"])}, headers=admin)
    assert export.headers["content-type"].startswith("text/csv")
    assert len(export.text.strip().splitlines()) == 2

    bad_tz = await api.get("/counts", params={"tz": "Not/AZone"}, headers=admin)
    assert bad_tz.status_code == 422
    reversed_range = await api.get(
        "/analytics/summary", params={"start_date": "2025-03-09", "end_date": "2025-03-01"}, headers=admin
    )
    assert reversed_range.status_code == 422


async def test_analytics_routes_answer_in_insighteye_shape(week, admin, api):
    params = {
        "start_date": WEEK_START.isoformat(),
        "end_date": WEEK_END.isoformat(),
        "camera_id": [str(week["ground"]["camera_id"])],
    }
    for path in (
        "/analytics/cameras/average-people",
        "/analytics/busiest-hours/by-weekday",
        "/analytics/floors/average-people",
        "/analytics/floors/people-by-weekday",
        "/analytics/floors/people-by-hour",
        "/analytics/heatmap",
        "/analytics/timeseries",
        "/analytics/threshold-violations-by-camera",
    ):
        response = await api.get(path, params=params, headers=admin)
        assert response.status_code == 200, (path, response.text)
        body = response.json()
        assert body["success"] and body["count"] == len(body["data"]) > 0, path
        assert body["filters_applied"]["start_date"] == "2025-03-03"


async def test_alert_routes(camera, admin, api):
    stored = await alert_service.create_alert(
        camera, Violation(GREATER_THAN, 3, 8), datetime.now(timezone.utc), b"\xff\xd8x"
    )
    listed = (await api.get("/alerts", params={"status": "OPEN"}, headers=admin)).json()
    assert str(stored["alert_id"]) in [a["alert_id"] for a in listed["alerts"]]
    detail = await api.get(f"/alerts/{stored['alert_id']}", params={"include_frame": True}, headers=admin)
    assert detail.json()["frame_base64"]
    frame = await api.get(f"/alerts/{stored['alert_id']}/frame", headers=admin)
    assert frame.content == b"\xff\xd8x"
    patched = await api.patch(
        f"/alerts/{stored['alert_id']}/status", json={"status": "FALSE_POSITIVE"}, headers=admin
    )
    assert patched.json()["data"]["status"] == "FALSE_POSITIVE"


# ----------------------------------------------------------------- retention
async def test_retention_drops_old_counts_and_alerts(camera, monkeypatch):
    old = datetime.now(timezone.utc) - timedelta(days=200)
    await _sample(camera["camera_id"], old, 9, Violation(GREATER_THAN, 3, 9))
    await _sample(camera["camera_id"], datetime.now(timezone.utc), 2)
    await alert_service.create_alert(camera, Violation(GREATER_THAN, 3, 9), old, None)

    report = await retention.purge_expired()
    assert report.samples_deleted >= 1 and report.violations_deleted >= 1 and report.alerts_deleted >= 1

    left = await db_manager.execute_query(
        "SELECT COUNT(*) AS n FROM count_sample WHERE camera_id = $1", (camera["camera_id"],), fetch_one=True
    )
    assert left["n"] == 1
