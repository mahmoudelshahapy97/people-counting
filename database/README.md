# Database

Postgres 17 (`postgres:17-alpine`). Four tables carry the feature itself. A **camera** is
watched, its worker stores a head-count **sample** every few seconds, a sample outside the
camera's limits is also a **threshold violation**, and a violation raised to the operators is an
**alert**.

```
workspace ──< camera ──< count_sample
                    ├──< threshold_violation    (same captured_at as its sample)
                    └──< count_alert            (at most one per camera per cooldown)
```

`count_sample` is the big one: one row per camera every `SAMPLE_INTERVAL_S`, about 8,600 a day
at the default 10 s. Every chart in the console is an aggregate over it.

The rest carry the console's accounts and workspaces: `app_user` (username, email, Argon2
password hash, role, `token_version`), `refresh_session` (one row per logged-in device, keyed by
the refresh token's `jti`), `password_otp` (emailed reset codes, HMAC only), `workspace` and
`workspace_member`. No account is seeded. The first admin is created by the API at startup if
`app_user` is empty (see `backend/app/services/user_service.py:ensure_bootstrap_admin`).

## Layout

| Path | Runs when | Contents |
| --- | --- | --- |
| `schema.sql` | first boot of an empty volume, automatic | every table, constraint, index and trigger |
| `migrations/NNN_*.sql` | API startup, once each | versioned changes for existing volumes (none yet) |
| `seed.sql` | on demand | demo cameras and 14 days of history |
| `queries.sql` | never | reference queries, annotated with the endpoint that issues each |

`schema.sql` is bind-mounted into `/docker-entrypoint-initdb.d/` by `docker-compose.yml` (and
`backend/docker-compose.yml`), which Postgres executes **once**, on the first boot of an empty
data volume. Editing it does nothing to a database that already exists; see *Migrations* and
*Resetting* below.

`queries.sql` is documentation, not migration. Each statement is annotated with the endpoint or
service function that issues it, so a query can be pasted into `psql` and run in isolation while
debugging. Parameters use asyncpg's `$1, $2` style.

## Applying the schema

The compose stack does it for you:

```bash
docker compose up -d postgres
```

Against a database that already exists, or one you manage elsewhere:

```bash
docker compose exec -T postgres psql -U peoplecount -d peoplecount_db < database/schema.sql
```

Every statement is `IF NOT EXISTS` or `CREATE OR REPLACE`, so re-applying is a no-op.

## Migrations

`schema.sql` is always the full, current schema for a fresh volume. Postgres runs it only once,
so every later change to it **also** goes into a new numbered file in `migrations/`. This is the
same idea as the main InsightEye repo's `versions/` + `migrations.txt`.

- **Applied:** the API mounts `migrations/` at `/app/migrations` (`MIGRATIONS_DIR`). At startup,
  `app/core/migrations.py` applies each file not yet in `schema_migration`, in name order, each
  in its own transaction, under an advisory lock.
- **Recorded:** each applied file is stored by name with its sha256.
- **Idempotent:** use `IF NOT EXISTS` and `DO $$ … $$` guards. On a fresh volume every file runs
  against a schema that already has the change, and must be a no-op there.
- **Never edit an applied file.** It is not re-run; the API only logs a checksum warning. Add the
  next number instead.

```bash
docker compose exec api python -m app.core.migrations --list   # applied / pending
docker compose exec api python -m app.core.migrations          # apply now, without a restart
```

The directory is empty: `schema.sql` is still the first release.

## Workspaces

Each camera belongs to a workspace, and its samples, violations and alerts follow it. The
triggers `trg_sample_workspace`, `trg_violation_workspace` and `trg_alert_workspace` copy the
camera's `workspace_id` when an insert leaves it out, so the workers never deal with workspaces
and the two can never disagree. Camera names are unique per workspace.

The **Default** workspace has the fixed id `00000000-0000-0000-0000-000000000001`. Hand-written
inserts into `camera` (seed.sql, tools) land there, and the API never deletes it. Deleting any
other workspace cascades to everything in it.

## Seeding

The seed is deliberately **not** mounted into the init directory, so a fresh stack comes up
empty. Load it when you want the console to have something to render:

```bash
docker compose exec -T postgres psql -U peoplecount -d peoplecount_db < database/seed.sql
```

| Camera | Stream | Limits | Enabled |
| --- | --- | --- | --- |
| Main Entrance | `rtsp://mediamtx:8554/people` | max 15 | yes: its worker counts the crowd clip for real |
| Food Court | `rtsp://mediamtx:8554/cctv1` | max 25 | no |
| Open Office East | `rtsp://mediamtx:8554/cctv3` | max 12 | no |
| Security Desk | `rtsp://mediamtx:8554/cctv20` | min 1, max 4 | no |

Each camera gets 14 days of samples with a daily curve, the violations they imply, and alerts in
all four statuses: open in the last day, acknowledged the day before, older ones resolved or
marked false positives. Seeded alerts have no snapshot; the ones Main Entrance raises live do.
Cameras carry fixed UUIDs (`ON CONFLICT DO NOTHING`), and history is only generated for a camera
that has none, so the seed is safe to run repeatedly.

## Resetting

Init scripts only run against an empty volume. To start over:

```bash
docker compose down -v          # -v drops pgdata (and miniodata), and with them all data
docker compose up -d
```

## Connecting

| From | Command |
| --- | --- |
| Host | `psql postgresql://peoplecount:peoplecount_pass@localhost:5437/peoplecount_db` |
| Container | `docker compose exec postgres psql -U peoplecount -d peoplecount_db` |
| API container | `DB_HOST=postgres`, `DB_PORT=5432` (compose network) |

The host port is `POSTGRES_HOST_PORT` in the root `.env` (default 5437).

## Notes on the schema

- **Every index leads with `workspace_id` or `camera_id`, then time.** `idx_sample_workspace_time`
  serves the dashboard and every analytics query (one workspace over a window);
  `idx_sample_camera_time` serves a single camera's history.
- **A violation joins its sample on `(camera_id, captured_at)`.** The worker writes both with the
  same timestamp, which is how the history shows the limit each sample broke without a foreign
  key between two high-volume tables.
- **`camera_threshold_order`** refuses `count_threshold_less >= count_threshold_greater`: a band
  that admits no count would alert on every sample. A `NULL` limit leaves that side open, and
  0 is a real limit.
- **The latest `count_alert` per camera is the cooldown state** (InsightEye's
  `people_count_alert_state`), so the cooldown survives an API restart without a table of its
  own.
- **Snapshots live in MinIO** under `count_alert.frame_key`. `frame_jpeg` (`BYTEA`) is only the
  fallback for when MinIO is unreachable.
- **Retention** (`backend/app/services/retention.py`) deletes samples and violations older than
  `SAMPLE_RETENTION_DAYS` and alerts older than `ALERT_RETENTION_DAYS`, with their snapshots, in
  batches, every six hours.
- **Timestamps are `TIMESTAMPTZ`** (UTC on disk). The analytics cut days, hours and weekdays in
  the viewer's timezone (`?tz=`), not a fixed one.
