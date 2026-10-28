-- ---------------------------------------------------------------------------
-- InsightEye — People Counting : schema
--
-- The source of truth for this feature's schema. Bind-mounted into
-- /docker-entrypoint-initdb.d/ by docker-compose.yml, so Postgres applies it
-- once on the first boot of an empty data volume. There is no Alembic here —
-- what this file says is what the database is.
--
-- Apply it by hand to a database that already exists:
--
--   psql -h 127.0.0.1 -p 5437 -U peoplecount -d peoplecount_db -f schema.sql
--
-- Safe to re-run: every object is created IF NOT EXISTS.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older servers; on PG13+ it is built
-- in. Creating it anyway keeps this file portable across both.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- workspace — a partition of the data: its cameras and everything they count
--
-- Users see the workspaces they are members of (workspace_member, below);
-- admins see all of them. The account roles stay global. "Default" has a
-- fixed id so seed data and tools can name it; the api never deletes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace (
    workspace_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID,                     -- app_user; FK added after that table
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name ON workspace (lower(name));

INSERT INTO workspace (workspace_id, name, description)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default',
        'The workspace every camera starts in.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- camera — one watched RTSP source and its occupancy limits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera (
    camera_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Defaults to Default for hand-written inserts; the api always names it.
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- rtsp:// URL, or a local video file path when exercising the pipeline
    -- without hardware.
    rtsp_url    TEXT NOT NULL,
    location    TEXT,
    -- Where the camera hangs, coarse to fine. Free text; the analytics group
    -- by floor and filter by any of them.
    building    TEXT,
    floor_level TEXT,
    zone        TEXT,
    area        TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Optional counting region: [[x, y], ...] in pixel coordinates. Only people
    -- standing inside it (by the bottom-centre of their box) are counted.
    roi         JSONB,

    -- Per-camera overrides of the .env counting values, e.g.
    -- {"confidence": 0.6, "sample_interval_s": 30}. An absent key means
    -- "inherit the global value", which is a different thing from 0.
    settings    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Occupancy limits (InsightEye video_stream.count_threshold_*). A count
    -- above count_threshold_greater or below count_threshold_less is a
    -- violation; NULL leaves that side open.
    count_threshold_greater INTEGER CHECK (count_threshold_greater >= 0),
    count_threshold_less    INTEGER CHECK (count_threshold_less >= 0),
    alert_enabled           BOOLEAN NOT NULL DEFAULT TRUE,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Names are unique within a workspace.
    CONSTRAINT camera_workspace_name_key UNIQUE (workspace_id, name),
    -- A band that admits no count at all would alert on every sample.
    CONSTRAINT camera_threshold_order CHECK (
        count_threshold_less IS NULL OR count_threshold_greater IS NULL
        OR count_threshold_less < count_threshold_greater
    )
);

-- Partial index: startup only ever asks for the enabled rows.
CREATE INDEX IF NOT EXISTS idx_camera_enabled ON camera (enabled) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_camera_workspace ON camera (workspace_id);

-- ---------------------------------------------------------------------------
-- count_sample — the head count of one analysed frame (InsightEye
-- stream_results.person_count)
--
-- Workers keep counting every processed frame for the live view but store
-- one sample every SAMPLE_INTERVAL_S, so a camera writes ~8,600 rows a day at
-- the default 10 s. Every chart is an aggregate over this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS count_sample (
    sample_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    camera_id     UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    -- Always the camera's: set by trg_sample_workspace when left out.
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_count  INTEGER NOT NULL CHECK (person_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sample_workspace_time ON count_sample (workspace_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_sample_camera_time    ON count_sample (camera_id, captured_at);

-- ---------------------------------------------------------------------------
-- threshold_violation — a stored sample outside its camera's limits
--
-- One row per violating sample, whether or not it raised an alert, so the
-- violation rate is violations / samples over any window.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS threshold_violation (
    violation_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    camera_id       UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_count    INTEGER NOT NULL CHECK (person_count >= 0),
    threshold_type  TEXT NOT NULL CHECK (threshold_type IN ('greater_than', 'less_than')),
    threshold_value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_violation_workspace_time
    ON threshold_violation (workspace_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_violation_camera_time
    ON threshold_violation (camera_id, captured_at);

-- ---------------------------------------------------------------------------
-- count_alert — a violation that was raised to the operators
--
-- At most one per camera per ALERT_COOLDOWN_SECONDS: a crowd that stays over
-- the limit is one alert, not one every sample. The latest row per camera is
-- also the cooldown state (InsightEye's people_count_alert_state).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS count_alert (
    alert_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id       UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_count    INTEGER NOT NULL CHECK (person_count >= 0),
    threshold_type  TEXT NOT NULL CHECK (threshold_type IN ('greater_than', 'less_than')),
    threshold_value INTEGER NOT NULL,
    frame_jpeg      BYTEA,                   -- annotated frame (fallback when MinIO is down)
    frame_key       TEXT,                    -- the frame in MinIO: alerts/<camera>/<alert>.jpg
    status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE')),
    -- How the alert was closed out: what the operator did and their notes.
    action_taken    TEXT,
    description     TEXT,
    acknowledged_at TIMESTAMPTZ,            -- first left OPEN
    resolved_at     TIMESTAMPTZ,            -- RESOLVED or FALSE_POSITIVE
    resolved_by     UUID,                   -- app_user; FK added after that table
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_camera_time ON count_alert (camera_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_status ON count_alert (status);
CREATE INDEX IF NOT EXISTS idx_alert_workspace_time ON count_alert (workspace_id, triggered_at DESC);

-- ---------------------------------------------------------------------------
-- app_user — an operator console account
--
-- Three roles, in ascending order of what they may do:
--   viewer    read everything: dashboard, alerts, history, analytics
--   operator  the daily work: triage alerts, set occupancy limits, start and
--             stop camera workers
--   admin     register and delete cameras, and manage accounts
--
-- There is no public signup. The API creates the first admin at startup from
-- BOOTSTRAP_ADMIN_* if this table is empty; every later account is made by an
-- admin. The hash lives on the row rather than in a side table because there is
-- only ever one credential per account here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT,

    -- Argon2, produced by passlib in app/core/security.py. Never a plain digest.
    password_hash TEXT NOT NULL,

    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'operator', 'viewer')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Bumped on "log out everywhere", password change and deactivation. Every
    -- access token carries the value it was minted with, and a mismatch is a
    -- 401. That makes revocation instant without a per-request blacklist
    -- lookup: the row is already being read to check role and is_active.
    token_version INTEGER NOT NULL DEFAULT 1,

    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_user_active ON app_user (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- refresh_session — one row per logged-in device
--
-- Keyed by the refresh token's jti, never by the token string itself, so a
-- lookup is an indexed UUID equality test rather than a scan over TEXT.
--
-- Refresh rotates: spending a refresh token revokes its row and issues a new
-- one. A revoked jti presented again means the token was captured, and the
-- attempt is refused rather than silently honoured.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_session (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    jti         UUID NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,

    -- Context for the account's session list, so a stolen session is
    -- recognisable before it is revoked.
    user_agent  TEXT,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_session (user_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- password_otp — a "forgot your password?" code mailed to the account
--
-- At most one live code per account. Only an HMAC of the code is stored; it
-- expires after OTP_TTL_SECONDS and dies after OTP_MAX_ATTEMPTS wrong guesses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_otp (
    user_id       UUID PRIMARY KEY REFERENCES app_user (user_id) ON DELETE CASCADE,
    otp_hash      TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- workspace_member — who may see a workspace
--
-- Admins see every workspace without a row here. A new account joins the
-- workspaces it is created with, or Default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member (user_id);

ALTER TABLE workspace DROP CONSTRAINT IF EXISTS workspace_created_by_fkey;
ALTER TABLE workspace
    ADD CONSTRAINT workspace_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES app_user (user_id) ON DELETE SET NULL;

-- Samples, violations and alerts take their camera's workspace, so the workers
-- never have to know about workspaces and the two can never disagree.
CREATE OR REPLACE FUNCTION pc_inherit_workspace() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT c.workspace_id INTO NEW.workspace_id FROM camera c WHERE c.camera_id = NEW.camera_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_sample_workspace
    BEFORE INSERT ON count_sample
    FOR EACH ROW EXECUTE FUNCTION pc_inherit_workspace();
CREATE OR REPLACE TRIGGER trg_violation_workspace
    BEFORE INSERT ON threshold_violation
    FOR EACH ROW EXECUTE FUNCTION pc_inherit_workspace();
CREATE OR REPLACE TRIGGER trg_alert_workspace
    BEFORE INSERT ON count_alert
    FOR EACH ROW EXECUTE FUNCTION pc_inherit_workspace();

-- count_alert is created before app_user, so its reference to the operator
-- who closed it out is added here.
ALTER TABLE count_alert DROP CONSTRAINT IF EXISTS count_alert_resolved_by_fkey;
ALTER TABLE count_alert
    ADD CONSTRAINT count_alert_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES app_user (user_id) ON DELETE SET NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- Notes
--
-- Every change made here after the first release also goes into a numbered
-- file in database/migrations/, which the api applies at startup.
--
-- Alert snapshots live in MinIO (frame_key). frame_jpeg is the fallback the
-- api writes when MinIO is unreachable.
--
-- Timestamps are TIMESTAMPTZ (UTC on disk). The analytics cut hours and
-- weekdays in the viewer's timezone, not a fixed one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Platform parity (also migration 001_platform_parity.sql): refresh sessions remember the
-- token_version they were issued under; notification inbox; audit log.
-- ---------------------------------------------------------------------------
-- Whether new alerts are emailed to the account; its own switch (PATCH /auth/me).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;

-- A refresh session carries the account's token_version from when it was
-- issued, so a password change or reset retires it even if nobody revoked it.
ALTER TABLE refresh_session ADD COLUMN IF NOT EXISTS token_version INTEGER;

-- One row per account per notification: the bell, the Notifications page and
-- the socket that pushes new ones (backend/app/services/inbox_service.py).
CREATE TABLE IF NOT EXISTS notification (
    notification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    workspace_id     UUID REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'info'
                     CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    title            TEXT NOT NULL,
    message          TEXT NOT NULL DEFAULT '',
    link             TEXT,
    camera_id        UUID REFERENCES camera (camera_id) ON DELETE SET NULL,
    camera_name      TEXT,
    -- What it is about (an event, a lost report, ...), so one thing never
    -- notifies the same account twice.
    ref_id           UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_ref ON notification (user_id, kind, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_user_time ON notification (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_created ON notification (created_at);

-- Who did what, when and from where (backend/app/services/audit_service.py).
-- actor is kept as text so the row survives the account being deleted.
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id       UUID REFERENCES app_user (user_id) ON DELETE SET NULL,
    actor         TEXT,
    workspace_id  UUID REFERENCES workspace (workspace_id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failure')),
    target_type   TEXT,
    target_id     TEXT,
    target_label  TEXT,
    ip            TEXT,
    user_agent    TEXT,
    request_id    TEXT,
    data          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
