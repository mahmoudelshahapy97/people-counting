# People Counting — FastAPI Computer Vision Backend

InsightEye's people counting, on the lost-found platform. Each enabled camera has a worker that
reads its RTSP stream, runs InsightEye's single-class people detector (`models/people.pt`) and
counts the people in view. The count is stored every few seconds, checked against the camera's
occupancy limits, and turned into an alert, with an annotated snapshot and an email, when it is
out of range. Everything the console charts is an aggregate over those stored samples.

---

## From a frame to an alert

```
frame ── every FRAME_SKIP-th, up to TARGET_PROCESS_FPS
  ↓
detect   people.pt, class 0, confidence >= PEOPLE_CONFIDENCE
  ↓
count    boxes whose bottom-centre is inside the camera's roi (the whole frame without one)
  ├──>  live count + annotated MJPEG view, every processed frame
  ↓
sample   every sample_interval_s → count_sample
  ↓
limits   count > count_threshold_greater  → greater_than violation
         count < count_threshold_less     → less_than violation      → threshold_violation
  ↓
alert    alert_enabled, and no alert for this camera in alert_cooldown_s
         → count_alert + annotated frame in MinIO + email to the workspace's operators and admins
```

There is no tracking, as in InsightEye: a count is a snapshot of one frame. Over the maximum
wins when both limits are broken. Limits are checked even when a camera's alerts are off, so
the analytics report every violation; `alert_enabled` only decides whether an alert is raised.
The counting rules are pure Python in
[app/services/people_counter.py](app/services/people_counter.py), tested without a model or a
camera in [tests/test_people_counter.py](tests/test_people_counter.py).

The counting values are global in `.env` and can be overridden per camera in `camera.settings`.
An absent key inherits the global value:

```json
{ "confidence": 0.6, "sample_interval_s": 30, "alert_cooldown_s": 300 }
```

---

## Layout

```
app/
├── api/routes/     auth, user, workspace, camera, count, alert, analytics, system
├── core/           config.py (pydantic-settings), database.py (asyncpg), migrations.py,
│                   security.py, logging_config.py
├── schemas/        pydantic request/response models
├── services/       model_registry, rtsp_reader, people_counter, stream_manager (workers and
│                   supervisor), camera, count, alert (+ mail), analytics, filters,
│                   media_service / object_store (MinIO), retention, auth, user, workspace, otp
├── utils/          geometry, image annotation, mailer, response
└── main.py         app factory, lifespan, /health

models/people.pt    InsightEye's people detector (see models/README.md)
videos/             test clips that mediamtx serves as RTSP streams

../database/        schema, migrations, seed and reference queries (see database/README.md)
```

---

## Running with Docker

The full stack (console, MinIO, everything) is `../docker-compose.yml`; see the root README.
This directory's `docker-compose.yml` is the **backend-only** stack, for working on counting
without the web container: Postgres, the API and mediamtx.

```bash
cp .env.example .env               # then set SECRET_KEY
docker compose up -d --build
```

| service | what it is | host port |
|---|---|---|
| `postgres` | Postgres 17, `../database/schema.sql` applied on first boot | 5437 |
| `api` | this FastAPI app, on the GPU | 8004 |
| `mediamtx` | the clips in `videos/` served over RTSP | 8557 |

Docs at <http://localhost:8004/docs>.

Both compose files declare the project name `people-counting`, so they share one `pgdata`
volume and one API image. The cost is that `docker compose up` here reports the full stack's
containers as orphans. That is harmless, and much better than a second API running against a
second, empty database. Do not pass `--remove-orphans`.

Without MinIO (this stack has none, unless `MINIO_ENDPOINT` points at one), alert snapshots are
stored in Postgres (`count_alert.frame_jpeg`).

## Running without Docker

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# point at a Postgres that has ../database/schema.sql applied
sed -i 's/^DB_HOST=.*/DB_HOST="localhost"/' .env
uvicorn app.main:app --reload
```

---

## Auth

Every route below `/api/v1` requires a bearer token except `GET /health` and the public auth
routes. There is no public signup: the first admin is created automatically at startup from
`BOOTSTRAP_ADMIN_USERNAME` / `_EMAIL` / `_PASSWORD` in `.env` (default `admin` /
`ChangeMe!123`; change it immediately after first login). Every other account is created by an
admin through `POST /users`.

| method | path | purpose |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → access + refresh token, sets the image-auth cookie. `username` may also be the account's email (any case) |
| POST | `/auth/refresh` | `{refresh_token}` → a new pair; rotates the refresh token |
| POST | `/auth/logout` | revoke this session |
| POST | `/auth/logout-all` | revoke every session for the account |
| GET | `/auth/me` | the calling user |
| POST | `/auth/change-password` | verifies the current password, then logs the account out everywhere |
| GET | `/auth/options` | public: `{password_reset}`, whether the login page offers "Forgot your password?" |
| POST | `/auth/forgot-password` | public: `{email}` → mails a 6-digit code; same answer whether or not the account exists |
| POST | `/auth/reset-password` | public: `{email, code, new_password}` → checks the code and sets the password in one step, logs out everywhere |

Password reset by email is off until `SMTP_HOST` is set (see `.env.example`); the two public
routes answer 503 until then. A code expires after `OTP_TTL_SECONDS`, only one can be sent per
`OTP_RESEND_SECONDS`, and `OTP_MAX_ATTEMPTS` wrong guesses burn it. Only its HMAC is stored, in
`password_otp`.

Three roles, each a superset of the one before it:

| role | may |
|---|---|
| `viewer` | read everything: dashboard, cameras, alerts, history, analytics, workers |
| `operator` | also triage alerts, change a camera's limits, start and stop workers |
| `admin` | also register, edit and delete cameras, manage accounts and workspaces |

The floor for each route is enforced in `app/api/deps.py` (`require_role`) on each router.

### Workspaces

Data is partitioned into workspaces, as in InsightEye. A camera belongs to one, and its samples,
violations and alerts follow it. Members see the workspaces they are in; admins see every
workspace. The roles are account-wide, so an operator is an operator in each of their
workspaces.

- **Choosing a workspace.** Every data route works in the workspace named by the
  `X-Workspace-Id` header. Without it, the caller's first workspace is used (Default for
  admins).
- **Hidden workspaces.** A workspace the caller cannot see, or a camera or alert in another
  workspace, answers **404**, the same as a missing one.
- **Media routes.** Cookie-authenticated images cannot send the header, so they are checked
  against the workspace of the camera or alert itself.
- **Alert mail** goes to every admin, and to the operators who are members of the camera's
  workspace. Viewers are never mailed.

| method | path | purpose |
|---|---|---|
| GET | `/workspaces/mine` | the caller's workspaces (all of them for admins), Default first |
| GET · POST | `/workspaces` | admin: list, or create `{name, description?, member_ids?}` |
| GET · PATCH · DELETE | `/workspaces/{id}` | admin: read, edit `{name?, description?, is_active?, member_ids?}`, delete. Delete cascades to cameras, samples and alerts and stops their workers. Default cannot be deleted or deactivated |
| GET · POST | `/workspaces/{id}/members` | admin: list, add `{user_id}` |
| DELETE | `/workspaces/{id}/members/{user_id}` | admin: remove a member |

`POST /users` and `PATCH /users/{id}` take `workspace_ids`. A new account with none joins
Default. User responses list each account's `workspaces`.

The image routes (`/cameras/{id}/snapshot`, `/cameras/{id}/stream`, `/alerts/{id}/frame`) also
accept the httpOnly cookie `/auth/login` sets, since a plain `<img src>` cannot attach an
`Authorization` header. No other route accepts the cookie; see the comment on
`get_image_viewer` in `app/api/deps.py` for why that boundary matters.

---

## API

Base prefix `/api/v1`. Every route needs `-H "Authorization: Bearer $TOKEN"`; see Auth above.

### Cameras
| method | path | role | purpose |
|---|---|---|---|
| POST | `/cameras` | admin | register a camera, with its location (`building`, `floor_level`, `zone`, `area`), limits and overrides; starts its worker if `enabled` |
| GET | `/cameras` · `/cameras/{id}` | viewer | list, read |
| PATCH | `/cameras/{id}` | admin | update; a running worker restarts with the new settings. `null` clears a limit |
| GET · PUT | `/cameras/{id}/thresholds` | viewer · operator | read, or set `{count_threshold_greater, count_threshold_less, alert_enabled}`; a limit left out or `null` is removed. A running worker restarts so the new limits apply to the next frame |
| DELETE | `/cameras/{id}` | admin | delete the camera and, by cascade, its samples and alerts (and their snapshots) |
| POST | `/cameras/{id}/start` · `/stop` | operator | control the worker; also sets or clears `enabled` |
| GET | `/cameras/{id}/status` | viewer | worker state, the current count and violation, cooldown |
| GET | `/cameras/{id}/snapshot` | viewer | the latest annotated frame as JPEG |
| GET | `/cameras/{id}/stream` | viewer | the annotated live view as MJPEG (at most `MAX_MJPEG_CLIENTS` at once) |

### Counts
| method | path | purpose |
|---|---|---|
| GET | `/counts/live` | every camera's current count against its limits: from its worker, or its last stored sample (`live: false`) |
| GET | `/counts` | stored samples, newest first, each with the limit it broke; paginated |
| GET | `/counts/export.csv` | the same rows as CSV |
| GET | `/counts/locations` | the buildings, floors, zones and areas in use, for filter menus |

`/counts`, the CSV and every analytics route take the same filters: `start_date` / `end_date`
(calendar days, inclusive, default the last 7), `tz` (an IANA zone; days, hours and weekdays
are cut in it, default UTC), `camera_id` (repeatable), and `buildings`, `floors`, `zones`,
`areas` (repeatable or comma-joined).

### Alerts
| method | path | role | purpose |
|---|---|---|---|
| GET | `/alerts` | viewer | filter by `status`, `threshold_type`, `camera_id`; paginated |
| GET | `/alerts/stats` | viewer | totals, open, last 24 h, above max / below min |
| GET | `/alerts/{id}` | viewer | one alert (`include_frame=true` embeds the snapshot as base64) |
| GET | `/alerts/{id}/frame` | viewer | the annotated snapshot |
| PATCH | `/alerts/{id}/status` | operator | `{status, action_taken?, description?}`: acknowledge, resolve or mark a false positive. Stamps acknowledged/resolved time and who closed it |

### Analytics
| method | path | purpose |
|---|---|---|
| GET | `/analytics/summary` | KPIs (average, peak, violations, violation rate, alerts) and the occupancy series: hourly for one day, daily otherwise |
| GET | `/analytics/timeseries` | average and peak per camera over time; the bucket widens with the window |
| GET | `/analytics/heatmap` | average count per weekday × hour |
| GET | `/analytics/cameras/average-people` | per camera, busiest first |
| GET | `/analytics/busiest-hours/by-weekday` | each weekday's busiest hour |
| GET | `/analytics/floors/average-people` · `/people-by-weekday` · `/people-by-hour` | per floor |
| GET | `/analytics/threshold-violations-by-camera` | every camera with a limit: violations above and below, samples checked, rate, alerts |

### System
`GET /health`, `GET /api/v1/system/workers` (state, frames, samples, alerts, reconnects and
restarts per worker), `GET /api/v1/system/config` (the counting values actually in force: the
first place to look when an alert fires later than expected).

---

## Walkthrough

```bash
# 0. log in once - every call below carries this
TOKEN=$(curl -s -X POST localhost:8004/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe!123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"

# 1. register the simulated camera: a crowd clip, at most 15 people
CAM=$(curl -s -X POST localhost:8004/api/v1/cameras \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Lobby","rtsp_url":"rtsp://mediamtx:8554/people","building":"HQ","floor_level":"G","count_threshold_greater":15}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["camera_id"])')

# 2. watch it count
curl -s localhost:8004/api/v1/cameras/$CAM/status -H "$AUTH" | python3 -m json.tool
curl -s localhost:8004/api/v1/cameras/$CAM/snapshot -H "$AUTH" -o snapshot.jpg

# 3. the stored samples, and the alert the crowd raised
curl -s "localhost:8004/api/v1/counts?camera_id=$CAM&per_page=5" -H "$AUTH" | python3 -m json.tool
curl -s "localhost:8004/api/v1/alerts?camera_id=$CAM" -H "$AUTH" | python3 -m json.tool
curl -s localhost:8004/api/v1/alerts/<alert_id>/frame -H "$AUTH" -o alert.jpg

# 4. raise the limit without touching the rest of the camera (operator)
curl -s -X PUT localhost:8004/api/v1/cameras/$CAM/thresholds -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"count_threshold_greater":50,"count_threshold_less":null,"alert_enabled":true}'

# 5. today's occupancy, hour by hour, in Cairo time
curl -s -G localhost:8004/api/v1/analytics/summary -H "$AUTH" \
  --data-urlencode "start_date=$(date +%F)" --data-urlencode "end_date=$(date +%F)" \
  --data-urlencode "tz=Africa/Cairo" | python3 -m json.tool
```

---

## Tests

```bash
pytest                    # unit tests always run; DB-backed tests skip without a database
```

| file | covers | needs |
|---|---|---|
| [test_people_counter.py](tests/test_people_counter.py) | the limits (open sides, zero as a real limit), the cooldown, counting inside a region, per-camera overrides, filter parsing, the alert mail's wording | nothing |
| [test_supervisor.py](tests/test_supervisor.py) | worker supervision: restarting dead, errored and stalled workers, backoff, starting enabled cameras | nothing |
| [test_utils.py](tests/test_utils.py) | geometry and frame annotation | nothing |
| [test_auth.py](tests/test_auth.py) | password rules, JWT lifecycle, the role ladder; refresh rotation and revocation with a database | partly Postgres |
| [test_integration.py](tests/test_integration.py) | camera CRUD and limits, a worker storing samples and raising one alert per cooldown, snapshots in MinIO or Postgres, triage, alert recipients, history, every analytics query and route, retention | Postgres |
| [test_workspaces.py](tests/test_workspaces.py) | a member of one workspace never sees another's cameras, counts or alerts, by list, id or media URL | Postgres |
| [test_otp.py](tests/test_otp.py) | login by email, password reset by emailed code (mail is faked) | Postgres |
| [test_migrations.py](tests/test_migrations.py) | the migration runner, in a throwaway schema | Postgres |

No test needs the model weights or a camera. The DB-backed ones skip themselves unless a database
is reachable and the schema is applied:

```bash
DB_HOST=localhost DB_PORT=5437 pytest      # against the compose stack
```

Each test cleans up after itself, so the suite is repeatable against a persistent database.

---

## Tuning notes

- `FRAME_SKIP` / `TARGET_PROCESS_FPS` set how much video reaches the detector, and so how
  lively the live count and view are. The stored samples come every `SAMPLE_INTERVAL_S`
  whatever the frame rate.
- `PEOPLE_CONFIDENCE` (0.5): raise it if posters or reflections are counted, lower it for
  small, distant people. `PEOPLE_INPUT_SIZE` (640) trades speed for small-person recall.
- A counting region (`roi`) restricts the count to part of the frame, by the bottom-centre of
  each box, so people standing in the area are counted and people merely overlapping it are not.
- `SAMPLE_INTERVAL_S` (10 s) is about 8,600 rows per camera per day. A longer interval means
  less history to store and coarser charts.
- `ALERT_COOLDOWN_SECONDS` (600, InsightEye's 10 minutes): a crowd that stays over the limit is
  one alert per cooldown, not one per sample. Every violating sample is still recorded.
- `MODEL_DEVICE=cuda` runs the detector in FP16 (`PEOPLE_HALF`) and falls back to CPU if CUDA
  is unavailable.
- The detector itself, where it came from and how to swap it, is described in
  [models/README.md](models/README.md).
