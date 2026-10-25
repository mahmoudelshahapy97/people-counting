"""Workspaces partition the data: a member of one never sees another's cameras,
counts or alerts, whether by list, by id or by media URL.

Driven through the API (conftest.api) against a live Postgres; skipped when
none is reachable, like test_integration.py.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.security import create_access_token
from app.services.user_service import user_service
from app.services.workspace_service import DEFAULT_WORKSPACE_ID, workspace_service

PASSWORD = "Valid1Password!"


@pytest.fixture(scope="module")
async def database():
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


def _bearer(user) -> dict:
    token = create_access_token(user["user_id"], user["role"], user["token_version"])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def world(database):
    """Workspaces A and B; an admin, an operator in A only, and a camera with
    a sample, a violation and an alert in B. Everything is removed afterwards."""
    suffix = uuid.uuid4().hex[:8]
    ws_a = await workspace_service.create(f"A-{suffix}", None, None)
    ws_b = await workspace_service.create(f"B-{suffix}", None, None)

    async def account(name, role):
        return await user_service.create_user(
            f"ws-{name}-{suffix}", f"ws-{name}-{suffix}@example.com", PASSWORD, role
        )

    admin = await account("admin", "admin")
    operator = await account("op", "operator")
    await workspace_service.add_member(ws_a["workspace_id"], operator["user_id"])

    camera_b = await db_manager.execute_query(
        "INSERT INTO camera (name, rtsp_url, enabled, workspace_id, count_threshold_greater) "
        "VALUES ($1, 'rtsp://x/b', FALSE, $2, 5) RETURNING *",
        (f"cam-b-{suffix}", ws_b["workspace_id"]),
        fetch_one=True,
    )
    sample_b = await db_manager.execute_query(
        "INSERT INTO count_sample (camera_id, person_count) VALUES ($1, 9) RETURNING workspace_id",
        (camera_b["camera_id"],),
        fetch_one=True,
    )
    violation_b = await db_manager.execute_query(
        "INSERT INTO threshold_violation (camera_id, person_count, threshold_type, threshold_value) "
        "VALUES ($1, 9, 'greater_than', 5) RETURNING workspace_id",
        (camera_b["camera_id"],),
        fetch_one=True,
    )
    # A stored picture, so the media route has something to refuse.
    alert_b = await db_manager.execute_query(
        """
        INSERT INTO count_alert (camera_id, person_count, threshold_type, threshold_value, frame_jpeg)
        VALUES ($1, 9, 'greater_than', 5, $2)
        RETURNING alert_id, workspace_id
        """,
        (camera_b["camera_id"], b"\xff\xd8frame"),
        fetch_one=True,
    )
    yield {
        "a": ws_a["workspace_id"],
        "b": ws_b["workspace_id"],
        "admin": admin,
        "operator": operator,
        "camera_b": camera_b["camera_id"],
        "sample_b": sample_b,
        "violation_b": violation_b,
        "alert_b": alert_b,
    }
    for workspace_id in (ws_a["workspace_id"], ws_b["workspace_id"]):
        await db_manager.execute_query("DELETE FROM workspace WHERE workspace_id = $1", (workspace_id,))
    for user in (admin, operator):
        await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (user["user_id"],))


async def test_triggers_put_counts_and_alerts_in_the_camera_workspace(world):
    assert world["sample_b"]["workspace_id"] == world["b"]
    assert world["violation_b"]["workspace_id"] == world["b"]
    assert world["alert_b"]["workspace_id"] == world["b"]


async def test_member_lists_only_their_workspaces(world, api):
    mine = await api.get("/workspaces/mine", headers=_bearer(world["operator"]))
    assert [w["workspace_id"] for w in mine.json()] == [str(world["a"])]

    everything = await api.get("/workspaces/mine", headers=_bearer(world["admin"]))
    ids = [w["workspace_id"] for w in everything.json()]
    assert ids[0] == str(DEFAULT_WORKSPACE_ID)
    assert {str(world["a"]), str(world["b"])} <= set(ids)


async def test_other_workspace_is_invisible_to_a_member(world, api):
    op = _bearer(world["operator"])
    alert_id = world["alert_b"]["alert_id"]

    # Lists default to the member's own workspace and leave B's rows out.
    cameras = await api.get("/cameras", headers=op)
    assert str(world["camera_b"]) not in [c["camera_id"] for c in cameras.json()]
    alerts = (await api.get("/alerts", headers=op)).json()
    assert str(alert_id) not in [a["alert_id"] for a in alerts["alerts"]]
    history = (await api.get("/counts", headers=op)).json()
    assert str(world["camera_b"]) not in [s["camera_id"] for s in history["samples"]]
    live = (await api.get("/counts/live", headers=op)).json()
    assert str(world["camera_b"]) not in [c["camera_id"] for c in live["data"]["cameras"]]

    # Naming B in the header is refused like an unknown workspace.
    assert (await api.get("/cameras", headers={**op, "X-Workspace-Id": str(world["b"])})).status_code == 404
    assert (await api.get("/counts", headers={**op, "X-Workspace-Id": str(world["b"])})).status_code == 404

    # By id, and through the media routes, B's things do not exist.
    for path in (
        f"/cameras/{world['camera_b']}",
        f"/cameras/{world['camera_b']}/status",
        f"/cameras/{world['camera_b']}/thresholds",
        f"/cameras/{world['camera_b']}/snapshot",
        f"/alerts/{alert_id}",
        f"/alerts/{alert_id}/frame",
    ):
        response = await api.get(path, headers=op)
        assert response.status_code == 404, path

    writes = [
        api.patch(f"/alerts/{alert_id}/status", json={"status": "RESOLVED"}, headers=op),
        api.put(f"/cameras/{world['camera_b']}/thresholds", json={"count_threshold_greater": 50}, headers=op),
        api.post(f"/cameras/{world['camera_b']}/start", headers=op),
    ]
    for request in writes:
        assert (await request).status_code == 404
    row = await db_manager.execute_query(
        "SELECT a.status, c.count_threshold_greater FROM count_alert a JOIN camera c USING (camera_id) "
        "WHERE a.alert_id = $1",
        (alert_id,),
        fetch_one=True,
    )
    assert row["status"] == "OPEN"
    assert row["count_threshold_greater"] == 5


async def test_media_follows_the_resource_workspace(world, api):
    """<img> cannot send the workspace header, so media is checked against the
    workspace the picture belongs to."""
    path = f"/alerts/{world['alert_b']['alert_id']}/frame"
    assert (await api.get(path, headers=_bearer(world["admin"]))).status_code == 200
    assert (await api.get(path, headers=_bearer(world["operator"]))).status_code == 404
    # A member of B gets it with no header at all.
    await workspace_service.add_member(world["b"], world["operator"]["user_id"])
    assert (await api.get(path, headers=_bearer(world["operator"]))).status_code == 200


async def test_admin_reaches_any_workspace_by_header(world, api):
    admin = {**_bearer(world["admin"]), "X-Workspace-Id": str(world["b"])}
    cameras = await api.get("/cameras", headers=admin)
    assert [c["camera_id"] for c in cameras.json()] == [str(world["camera_b"])]
    assert (await api.get(f"/alerts/{world['alert_b']['alert_id']}", headers=admin)).status_code == 200

    # The header names the workspace; B's camera is not in Default.
    default = await api.get(f"/cameras/{world['camera_b']}", headers=_bearer(world["admin"]))
    assert default.status_code == 404
    unknown = await api.get("/cameras", headers={**_bearer(world["admin"]), "X-Workspace-Id": str(uuid.uuid4())})
    assert unknown.status_code == 404


async def test_writes_land_in_the_active_workspace(world, api):
    admin = {**_bearer(world["admin"]), "X-Workspace-Id": str(world["a"])}
    camera = await api.post(
        "/cameras", json={"name": "same-name", "rtsp_url": "rtsp://x/a", "enabled": False}, headers=admin
    )
    assert camera.status_code == 201, camera.text
    assert camera.json()["workspace_id"] == str(world["a"])
    # Names are unique per workspace, not across them.
    in_b = await api.post(
        "/cameras",
        json={"name": "same-name", "rtsp_url": "rtsp://x/b2", "enabled": False},
        headers={**admin, "X-Workspace-Id": str(world["b"])},
    )
    assert in_b.status_code == 201
    again = await api.post(
        "/cameras", json={"name": "same-name", "rtsp_url": "rtsp://x/a2", "enabled": False}, headers=admin
    )
    assert again.status_code == 409


async def test_analytics_count_only_the_active_workspace(world, api):
    admin = _bearer(world["admin"])
    in_b = await api.get("/analytics/summary", headers={**admin, "X-Workspace-Id": str(world["b"])})
    in_a = await api.get("/analytics/summary", headers={**admin, "X-Workspace-Id": str(world["a"])})
    assert in_b.json()["data"]["kpis"]["samples"] == 1
    assert in_b.json()["data"]["kpis"]["violations"] == 1
    assert in_b.json()["data"]["kpis"]["alerts"] == 1
    assert in_a.json()["data"]["kpis"]["samples"] == 0
    assert in_a.json()["data"]["kpis"]["alerts"] == 0
    per_camera = await api.get(
        "/analytics/cameras/average-people", headers={**admin, "X-Workspace-Id": str(world["a"])}
    )
    assert per_camera.json()["data"] == []


async def test_deactivated_workspace_disappears_for_members(world, api):
    op = _bearer(world["operator"])
    await workspace_service.update(world["a"], is_active=False)
    assert (await api.get("/workspaces/mine", headers=op)).json() == []
    assert (await api.get("/cameras", headers={**op, "X-Workspace-Id": str(world["a"])})).status_code == 404
    # No workspace left at all: the fallback says so instead of guessing.
    assert (await api.get("/cameras", headers=op)).status_code == 403


async def test_workspace_admin_routes(world, api):
    admin = _bearer(world["admin"])
    op = _bearer(world["operator"])
    assert (await api.get("/workspaces", headers=op)).status_code == 403

    created = await api.post(
        "/workspaces", json={"name": f"C-{uuid.uuid4().hex[:6]}", "member_ids": [str(world["operator"]["user_id"])]},
        headers=admin,
    )
    assert created.status_code == 201, created.text
    ws_c = created.json()["workspace_id"]
    assert created.json()["member_count"] == 1
    duplicate = await api.post("/workspaces", json={"name": created.json()["name"].upper()}, headers=admin)
    assert duplicate.status_code == 409

    members = await api.get(f"/workspaces/{ws_c}/members", headers=admin)
    assert [m["user_id"] for m in members.json()] == [str(world["operator"]["user_id"])]
    patched = await api.patch(f"/workspaces/{ws_c}", json={"member_ids": []}, headers=admin)
    assert patched.json()["member_count"] == 0

    assert (await api.delete(f"/workspaces/{DEFAULT_WORKSPACE_ID}", headers=admin)).status_code == 409
    assert (
        await api.patch(f"/workspaces/{DEFAULT_WORKSPACE_ID}", json={"is_active": False}, headers=admin)
    ).status_code == 409

    # Deleting B takes its camera, counts and alert with it.
    assert (await api.delete(f"/workspaces/{world['b']}", headers=admin)).status_code == 200
    assert await workspace_service.owner_of("camera", world["camera_b"]) is None
    assert await workspace_service.owner_of("alert", world["alert_b"]["alert_id"]) is None
    left = await db_manager.execute_query(
        "SELECT COUNT(*) AS n FROM count_sample WHERE workspace_id = $1", (world["b"],), fetch_one=True
    )
    assert left["n"] == 0
    await api.delete(f"/workspaces/{ws_c}", headers=admin)


async def test_new_account_joins_default_or_the_given_workspaces(world, api):
    admin = _bearer(world["admin"])
    suffix = uuid.uuid4().hex[:8]
    plain = await api.post(
        "/users",
        json={"username": f"ws-new-{suffix}", "email": f"ws-new-{suffix}@example.com", "password": PASSWORD},
        headers=admin,
    )
    placed = await api.post(
        "/users",
        json={
            "username": f"ws-placed-{suffix}",
            "email": f"ws-placed-{suffix}@example.com",
            "password": PASSWORD,
            "workspace_ids": [str(world["a"]), str(world["b"])],
        },
        headers=admin,
    )
    try:
        assert plain.status_code == placed.status_code == 201, (plain.text, placed.text)
        assert [w["workspace_id"] for w in plain.json()["workspaces"]] == [str(DEFAULT_WORKSPACE_ID)]
        assert {w["workspace_id"] for w in placed.json()["workspaces"]} == {str(world["a"]), str(world["b"])}

        moved = await api.patch(
            f"/users/{placed.json()['user_id']}", json={"workspace_ids": [str(world["b"])]}, headers=admin
        )
        assert [w["workspace_id"] for w in moved.json()["workspaces"]] == [str(world["b"])]

        # Email addresses also log in, so they must differ in more than case.
        clash = await api.post(
            "/users",
            json={"username": f"ws-clash-{suffix}", "email": f"WS-NEW-{suffix}@example.com", "password": PASSWORD},
            headers=admin,
        )
        assert clash.status_code == 409
    finally:
        for response in (plain, placed):
            if response.status_code == 201:
                await db_manager.execute_query(
                    "DELETE FROM app_user WHERE user_id = $1", (uuid.UUID(response.json()["user_id"]),)
                )
