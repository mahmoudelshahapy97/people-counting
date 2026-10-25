# People Counting

Per-camera head counts, occupancy limits and footfall analytics, ported from InsightEye's
people-counting feature onto the lost-found platform: RTSP cameras, InsightEye's single-class
people detector on the GPU, a sample stored every few seconds, an alert (with an annotated
snapshot and an email) when a camera goes above its maximum or below its minimum, and analytics
by camera, floor, weekday and hour.

```
RTSP camera → people detector → count ─┬─> live view (MJPEG) and live count
                                       └─> sample every SAMPLE_INTERVAL_S ─> limits? ─> alert
                                                                                        │
browser ──same origin──> web (nginx) ──proxy──> api ──> postgres (samples, alerts)      │
                                                  └───> minio (alert snapshots) <───────┘
```

| Tier | Directory | Stack |
|---|---|---|
| Console | [`frontend/`](frontend) | React 18, Vite, React Router, MUI, Chart.js |
| API + counting | [`backend/`](backend) | FastAPI, asyncpg, Ultralytics, OpenCV |
| Database | [`database/`](database) | PostgreSQL 17: schema, seed, reference queries |
| End-to-end tests | [`e2e/`](e2e) | Playwright, run against the live stack |

Each directory has its own README with the detail.

Screenshots of every page, and a video of the console in use, are in [`artifacts/`](artifacts).

---

## Run the whole thing

```bash
cp .env.example .env                   # then set MINIO_ROOT_PASSWORD
cp backend/.env.example backend/.env   # then set SECRET_KEY (see the comment in the file)
docker compose up -d --build
docker compose exec -T postgres psql -U peoplecount -d peoplecount_db < database/seed.sql   # optional demo data
```

| Service | URL | Notes |
|---|---|---|
| Console | http://localhost:8083 | nginx serving the built SPA and proxying the API |
| API | http://localhost:8004 | `/docs` for Swagger |
| Postgres | localhost:5437 | `peoplecount` / `peoplecount_pass` / `peoplecount_db` |
| RTSP test server | rtsp://localhost:8557 | mediamtx, see below |
| MinIO | http://localhost:9002 (S3), http://localhost:9003 (console) | |

Sign in as the bootstrap admin from `backend/.env` (`admin` / `ChangeMe!123` by default) and
change the password.

The ports sit next to lost-found's (5436/8003/8082/8556/9000/9001), so both stacks can run on
one machine. Override them in the root `.env` (`WEB_HOST_PORT`, `API_HOST_PORT`,
`POSTGRES_HOST_PORT`, `RTSP_HOST_PORT`, `MINIO_API_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`).

The API needs an NVIDIA GPU (`MODEL_DEVICE=cuda`, reserved in `docker-compose.yml`). It runs on
CPU with `MODEL_DEVICE=cpu` and the GPU reservation removed, at a lower frame rate.

The schema is `database/schema.sql`, applied by Postgres on the first boot of an empty volume.
Later changes go into numbered files in `database/migrations/`, which the API applies at
startup. The detector is InsightEye's own checkpoint, `backend/models/people.pt`. It is not an
Ultralytics release, so it cannot be downloaded and has to be in place before the first start.

## Demo data and a test camera without hardware

`mediamtx` starts with the stack and serves each clip in `backend/videos/` as an RTSP path,
looping on demand:

| Path | Clip |
|---|---|
| `rtsp://mediamtx:8554/people` | `sample.mp4`, a crowd seen from above |
| `rtsp://mediamtx:8554/cctv1` | `cctv_video1.mp4` |
| `rtsp://mediamtx:8554/cctv3` | `cctv_video3.mp4` |
| `rtsp://mediamtx:8554/cctv20` | `cctv_video20.mp4` |

Those URLs are resolved inside the API container. From the host, use
`rtsp://localhost:8557/<path>`.

`database/seed.sql` registers four cameras in the Default workspace with 14 days of synthetic
history: samples, violations and alerts in every status. Only **Main Entrance** is enabled. It
reads `/people` with a maximum of 15. The real detector counts mostly 30 to 45 people there,
so within seconds of starting, the camera is over its limit and raising real alerts.

## How a count becomes an alert

Each enabled camera has a worker in the API process. It reads the stream, runs the detector on
every `FRAME_SKIP`th frame (up to `TARGET_PROCESS_FPS`), and counts the people whose box stands
inside the camera's counting region (the whole frame when none is drawn). The live count and the
annotated MJPEG view (`GET /api/v1/cameras/{id}/stream`) update on every processed frame.

Every `SAMPLE_INTERVAL_S` (10 s) the worker stores the count in `count_sample`. When the count
is above `count_threshold_greater` or below `count_threshold_less`, it also writes a
`threshold_violation` row. When the camera has alerts on and is out of its cooldown
(`ALERT_COOLDOWN_SECONDS`, 10 min), it raises a `count_alert` with the annotated frame. With
`ALERT_EMAIL_ENABLED` and SMTP configured, the alert is also mailed to every admin and to the
operators of the camera's workspace.

Operators triage alerts (Acknowledge, Resolve, False positive, with the action taken and
notes). They can also retune a camera's limits from its page without the full edit form, which
is admin-only.

## Cameras stay running

A camera's `enabled` flag is the operator's intent. **Start** sets it and **Stop** clears it,
so a camera comes back after an API restart exactly as it was left. While the API runs, a
supervisor checks every worker every `WORKER_SUPERVISION_INTERVAL_S`. It restarts any worker
that died, errored (for example, a failed model load) or stopped analysing frames, with
exponential backoff, and it starts any enabled camera that has no worker. Per-worker state,
reconnects and restarts are shown on the camera page, on **Workers & config**, and at
`GET /api/v1/system/workers`.

## Object storage (MinIO)

The `minio` service is S3-compatible storage for alert snapshots. On first start, `minio-init`
creates the bucket (`MINIO_BUCKET`, default `peoplecount`) and exits.

| | Address |
|---|---|
| S3 API, from other containers | `http://minio:9000` |
| S3 API, from the host | `http://localhost:9002` (`MINIO_API_HOST_PORT`) |
| Web console | `http://localhost:9003` (`MINIO_CONSOLE_HOST_PORT`) |

Log in with `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from the root `.env`. The api container
receives the same values as `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`,
`MINIO_BUCKET` and `MINIO_SECURE`. Data lives in the `miniodata` volume.

| Object | Key | Postgres column |
|---|---|---|
| Alert snapshot | `alerts/<camera_id>/<alert_id>.jpg` | `count_alert.frame_key` |

If MinIO is unreachable when an alert is raised, the snapshot goes into Postgres instead
(`count_alert.frame_jpeg`). Reads try MinIO first and then that fallback. The retention pass
deletes samples and violations older than `SAMPLE_RETENTION_DAYS`, and alerts older than
`ALERT_RETENTION_DAYS` together with their snapshots (90 days each by default).

MinIO no longer publishes community images, so the service runs Chainguard's build of MinIO,
pinned by digest in `docker-compose.yml`.

## Tests

```bash
./e2e/run.sh        # Playwright against the running stack: see e2e/README.md

# Backend unit and integration tests. The integration tests use the stack's
# Postgres, and remove the rows they create.
docker compose run --rm --no-deps -v ./backend/tests:/app/tests -v ./backend/pytest.ini:/app/pytest.ini \
  -e MODEL_DEVICE=cpu api python -m pytest -q
```
