-- ---------------------------------------------------------------------------
-- InsightEye — People Counting : queries
--
-- A reference, not a script. Each block is annotated with the endpoint or the
-- service function that issues it, so a statement can be pasted into psql and
-- run in isolation while working out why the API returned what it did.
--
-- Parameters use asyncpg's $1, $2 style, matching the source. Substitute real
-- values before running a block by hand.
--
--   psql -h 127.0.0.1 -p 5437 -U peoplecount -d peoplecount_db
--
-- Sections:
--   1. workspaces    2. cameras       3. samples and history
--   4. alerts        5. analytics     6. retention
--
-- Workspaces: the api adds "AND <table>.workspace_id = $n" to every list and
-- aggregate for the caller's active workspace (X-Workspace-Id), and answers
-- 404 for a row by id whose workspace_id is another one. The blocks in 3–5
-- keep that filter, since every index leads with workspace_id.
--
-- Date filters: start_date / end_date are calendar days in the viewer's
-- timezone ($tz, e.g. 'Africa/Cairo'), turned into instants by Postgres:
--   s.captured_at >= ($start::date)::timestamp AT TIME ZONE $tz
--   s.captured_at <  ($end::date + 1)::timestamp AT TIME ZONE $tz
-- With neither given, the window is the last 7 days ending today.
-- (app/services/filters.py:scope)
-- ---------------------------------------------------------------------------


-- ==========================================================================
-- 1. WORKSPACES
-- ==========================================================================

-- :name workspace_owner_of
-- app/services/workspace_service.py:owner_of - the check behind every by-id route.
SELECT workspace_id FROM camera WHERE camera_id = $1;
SELECT workspace_id FROM count_alert WHERE alert_id = $1;

-- :name workspaces_for_member
-- GET /api/v1/workspaces/mine for a non-admin: active workspaces they belong
-- to, Default first. Admins get every workspace.
SELECT w.*
FROM workspace w
JOIN workspace_member mine ON mine.workspace_id = w.workspace_id AND mine.user_id = $1
WHERE w.is_active
ORDER BY (w.workspace_id = '00000000-0000-0000-0000-000000000001') DESC, lower(w.name);


-- ==========================================================================
-- 2. CAMERAS
-- ==========================================================================
-- app/services/camera_service.py.

-- :name create_camera
-- POST /api/v1/cameras. A blank limit is NULL (that side open), not 0; the
-- table's camera_threshold_order check refuses min >= max.
INSERT INTO camera (name, rtsp_url, location, enabled, roi, settings, workspace_id,
                    building, floor_level, zone, area,
                    count_threshold_greater, count_threshold_less, alert_enabled)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
        COALESCE($7, '00000000-0000-0000-0000-000000000001'::uuid),
        $8, $9, $10, $11, $12, $13, $14)
RETURNING *;

-- :name list_cameras_enabled_only
-- What the stream manager starts at boot and its supervisor re-checks.
-- Served by idx_camera_enabled.
SELECT * FROM camera WHERE enabled ORDER BY created_at;

-- :name update_camera_limits
-- PUT /api/v1/cameras/{id}/thresholds (operator). PATCH /api/v1/cameras/{id}
-- builds the same shape from whichever fields were sent.
UPDATE camera
SET count_threshold_greater = $1, count_threshold_less = $2, alert_enabled = $3,
    updated_at = NOW()
WHERE camera_id = $4
RETURNING *;

-- :name delete_camera
-- Cascades to the camera's samples, violations and alerts.
DELETE FROM camera WHERE camera_id = $1;

-- :name location_options
-- GET /api/v1/counts/locations - the filter menus.
SELECT
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT building    ORDER BY building),    NULL) AS buildings,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT floor_level ORDER BY floor_level), NULL) AS floors,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT zone        ORDER BY zone),        NULL) AS zones,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT area        ORDER BY area),        NULL) AS areas
FROM camera WHERE workspace_id = $1;


-- ==========================================================================
-- 3. SAMPLES AND HISTORY
-- ==========================================================================
-- app/services/count_service.py.

-- :name record_sample
-- Written by a camera's worker every sample_interval_s. workspace_id is filled
-- in by trg_sample_workspace / trg_violation_workspace from the camera.
INSERT INTO count_sample (camera_id, person_count, captured_at) VALUES ($1, $2, $3);
-- ...and, when the count broke a limit, with the same captured_at:
INSERT INTO threshold_violation
    (camera_id, person_count, threshold_type, threshold_value, captured_at)
VALUES ($1, $2, $3, $4, $5);

-- :name count_history
-- GET /api/v1/counts. A sample joins its violation on (camera_id, captured_at).
SELECT s.sample_id, s.captured_at, s.camera_id, c.name AS camera_name,
       c.location, c.building, c.floor_level, c.zone, c.area,
       s.person_count, v.threshold_type AS violation, v.threshold_value
FROM count_sample s
JOIN camera c ON c.camera_id = s.camera_id
LEFT JOIN threshold_violation v
       ON v.camera_id = s.camera_id AND v.captured_at = s.captured_at
WHERE s.workspace_id = $1
  AND s.captured_at >= NOW() - INTERVAL '7 days'
ORDER BY s.captured_at DESC, s.sample_id DESC
LIMIT 50 OFFSET 0;
-- GET /api/v1/counts/export.csv runs the same join keyset-paged on sample_id
-- (AND s.sample_id > $after ORDER BY s.sample_id LIMIT 5000), so a long export
-- never holds one huge result.

-- :name latest_by_camera
-- GET /api/v1/counts/live for a camera with no running worker: its last
-- stored count, if it is less than a day old.
SELECT DISTINCT ON (s.camera_id) s.camera_id, s.person_count, s.captured_at
FROM count_sample s
WHERE s.workspace_id = $1
  AND s.captured_at > NOW() - INTERVAL '1 day'
ORDER BY s.camera_id, s.captured_at DESC;


-- ==========================================================================
-- 4. ALERTS
-- ==========================================================================
-- app/services/alert_service.py.

-- :name last_alert_at
-- The worker's cooldown: no new alert until alert_cooldown_s after this.
SELECT MAX(triggered_at) AS at FROM count_alert WHERE camera_id = $1;

-- :name create_alert
-- The annotated frame then goes to MinIO under alerts/<camera>/<alert>.jpg
-- (frame_key), or into frame_jpeg when MinIO is unreachable.
INSERT INTO count_alert
    (camera_id, person_count, threshold_type, threshold_value, triggered_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING alert_id, camera_id, workspace_id, triggered_at, person_count,
          threshold_type, threshold_value, status;

-- :name alert_recipients
-- Who the alert mail goes to: every active admin, plus the operators who are
-- members of the camera's workspace. Viewers are never mailed.
SELECT DISTINCT u.email
FROM app_user u
LEFT JOIN workspace_member m ON m.user_id = u.user_id AND m.workspace_id = $1
WHERE u.is_active AND u.email <> ''
  AND (u.role = 'admin' OR (u.role = 'operator' AND m.user_id IS NOT NULL))
ORDER BY u.email;

-- :name list_alerts
-- GET /api/v1/alerts?status=&threshold_type=&camera_id=
SELECT a.alert_id, a.camera_id, c.name AS camera_name, c.location,
       c.building, c.floor_level, c.zone, c.area,
       a.triggered_at, a.person_count, a.threshold_type, a.threshold_value,
       a.status, a.action_taken, a.description, a.acknowledged_at, a.resolved_at,
       u.username AS resolved_by_username,
       (a.frame_key IS NOT NULL OR a.frame_jpeg IS NOT NULL) AS has_frame
FROM count_alert a
LEFT JOIN camera c ON c.camera_id = a.camera_id
LEFT JOIN app_user u ON u.user_id = a.resolved_by
WHERE a.workspace_id = $1 AND a.status = 'OPEN'
ORDER BY a.triggered_at DESC
LIMIT 20 OFFSET 0;

-- :name update_alert_status
-- PATCH /api/v1/alerts/{id}/status. Notes left out keep the stored ones; the
-- first move off OPEN stamps acknowledged_at, closing stamps resolved_at/by.
UPDATE count_alert
SET status          = $1::text,
    action_taken    = COALESCE($3, action_taken),
    description     = COALESCE($4, description),
    acknowledged_at = CASE WHEN $1::text <> 'OPEN'
                           THEN COALESCE(acknowledged_at, NOW()) END,
    resolved_at     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                           THEN COALESCE(resolved_at, NOW()) END,
    resolved_by     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                           THEN COALESCE($5::uuid, resolved_by) END
WHERE alert_id = $2
RETURNING alert_id, status, action_taken, description,
          acknowledged_at, resolved_at, resolved_by;

-- :name alert_stats
-- GET /api/v1/alerts/stats - the dashboard's open-alerts card.
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
       COUNT(*) FILTER (WHERE triggered_at > NOW() - INTERVAL '24 hours') AS last_24h,
       COUNT(*) FILTER (WHERE threshold_type = 'greater_than') AS above_max,
       COUNT(*) FILTER (WHERE threshold_type = 'less_than') AS below_min,
       MAX(triggered_at) AS last_alert_at
FROM count_alert
WHERE workspace_id = $1;


-- ==========================================================================
-- 5. ANALYTICS
-- ==========================================================================
-- app/services/analytics_service.py. Every chart is an aggregate over
-- count_sample s JOIN camera c, with hours and weekdays cut in the viewer's
-- timezone: (s.captured_at AT TIME ZONE $tz).

-- :name summary_kpis
-- GET /api/v1/analytics/summary - the KPI row. The violation rate is
-- violations / samples over the same window.
SELECT ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
       MAX(s.person_count) AS max_person_count,
       MIN(s.person_count) AS min_person_count,
       COUNT(*)            AS sample_size,
       COUNT(DISTINCT s.camera_id) AS cameras_reporting
FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days';

-- :name summary_series
-- The occupancy chart: one row per bucket even when nothing was counted.
-- An hour per bucket for a one-day window, a day otherwise.
WITH buckets AS (
    SELECT generate_series(
        '2026-10-19'::date::timestamp,
        ('2026-10-25'::date + 1)::timestamp - INTERVAL '1 day',
        INTERVAL '1 day'
    ) AS bucket_start
),
samples AS (
    SELECT date_trunc('day', s.captured_at AT TIME ZONE 'Africa/Cairo') AS bucket_start,
           s.person_count
    FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
    WHERE s.workspace_id = $1
      AND s.captured_at >= ('2026-10-19'::date)::timestamp AT TIME ZONE 'Africa/Cairo'
      AND s.captured_at <  ('2026-10-25'::date + 1)::timestamp AT TIME ZONE 'Africa/Cairo'
)
SELECT b.bucket_start,
       ROUND(AVG(x.person_count)::numeric, 2)::float AS avg_person_count,
       MAX(x.person_count)                           AS max_person_count,
       COUNT(x.person_count)                         AS sample_size
FROM buckets b
LEFT JOIN samples x ON x.bucket_start = b.bucket_start
GROUP BY b.bucket_start
ORDER BY b.bucket_start;

-- :name heatmap
-- GET /api/v1/analytics/heatmap - "When it is busy".
SELECT EXTRACT(DOW  FROM s.captured_at AT TIME ZONE $2)::int AS weekday,
       EXTRACT(HOUR FROM s.captured_at AT TIME ZONE $2)::int AS hour,
       ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
       COUNT(*) AS sample_size
FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days'
GROUP BY weekday, hour
ORDER BY weekday, hour;

-- :name busiest_hour_by_weekday
-- GET /api/v1/analytics/busiest-hours/by-weekday: each day's top hour by average.
WITH hourly AS (
    SELECT TO_CHAR(s.captured_at AT TIME ZONE $2, 'FMDay')       AS weekday_name,
           EXTRACT(DOW  FROM s.captured_at AT TIME ZONE $2)::int AS weekday_num,
           EXTRACT(HOUR FROM s.captured_at AT TIME ZONE $2)::int AS hour,
           ROUND(AVG(s.person_count)::numeric, 2)::float         AS avg_person_count,
           COUNT(*)                                              AS sample_size
    FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
    WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days'
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
ORDER BY weekday_num;

-- :name floors_average
-- GET /api/v1/analytics/floors/average-people. /floors/people-by-weekday and
-- /floors/people-by-hour add the weekday or hour to the GROUP BY.
SELECT COALESCE(c.floor_level, 'Unknown') AS floor_level,
       ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
       COUNT(*) AS sample_size
FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;

-- :name timeseries_by_camera
-- GET /api/v1/analytics/timeseries - one line per camera, binned from the
-- window's first day so buckets line up across cameras.
SELECT s.camera_id, c.name AS camera_name,
       date_bin(INTERVAL '1 hour', s.captured_at AT TIME ZONE $2, '2026-10-19'::date::timestamp)
           AS bucket_start,
       ROUND(AVG(s.person_count)::numeric, 2)::float AS avg_person_count,
       MAX(s.person_count) AS max_person_count
FROM count_sample s JOIN camera c ON c.camera_id = s.camera_id
WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days'
GROUP BY s.camera_id, c.name, bucket_start
ORDER BY c.name, s.camera_id, bucket_start;

-- :name violations_by_camera
-- GET /api/v1/analytics/threshold-violations-by-camera - every camera with a limit, its
-- violations, samples checked and alerts, zero-filled.
WITH violations AS (
    SELECT v.camera_id,
           COUNT(*) FILTER (WHERE v.threshold_type = 'greater_than') AS above_max_count,
           COUNT(*) FILTER (WHERE v.threshold_type = 'less_than')    AS below_min_count,
           MAX(v.captured_at) FILTER (WHERE v.threshold_type = 'greater_than') AS last_above_max_time,
           MAX(v.captured_at) FILTER (WHERE v.threshold_type = 'less_than')    AS last_below_min_time
    FROM threshold_violation v
    WHERE v.workspace_id = $1 AND v.captured_at >= NOW() - INTERVAL '7 days'
    GROUP BY v.camera_id
),
checks AS (
    SELECT s.camera_id, COUNT(*) AS sample_size
    FROM count_sample s
    WHERE s.workspace_id = $1 AND s.captured_at >= NOW() - INTERVAL '7 days'
    GROUP BY s.camera_id
)
SELECT c.name AS camera_name,
       c.count_threshold_less AS min_threshold, c.count_threshold_greater AS max_threshold,
       COALESCE(v.above_max_count, 0) AS above_max_count,
       COALESCE(v.below_min_count, 0) AS below_min_count,
       COALESCE(k.sample_size, 0)     AS total_checks
FROM camera c
LEFT JOIN violations v ON v.camera_id = c.camera_id
LEFT JOIN checks k     ON k.camera_id = c.camera_id
WHERE c.workspace_id = $1
  AND (c.count_threshold_greater IS NOT NULL OR c.count_threshold_less IS NOT NULL)
ORDER BY above_max_count + below_min_count DESC, camera_name;


-- ==========================================================================
-- 6. RETENTION
-- ==========================================================================
-- app/services/retention.py, every RETENTION_INTERVAL_S (6 h; RETENTION_ENABLED
-- turns it off). Batched so a large purge never holds a long lock.
-- $1 is SAMPLE_RETENTION_DAYS or ALERT_RETENTION_DAYS (90 by default).

-- :name purge_samples
-- Same shape for threshold_violation (violation_id, captured_at).
DELETE FROM count_sample WHERE sample_id IN (
    SELECT sample_id FROM count_sample
    WHERE captured_at < NOW() - make_interval(days => $1)
    LIMIT $2
);

-- :name purge_alerts
-- Returns the MinIO keys, so the snapshots go with their alerts.
DELETE FROM count_alert WHERE alert_id IN (
    SELECT alert_id FROM count_alert
    WHERE triggered_at < NOW() - make_interval(days => $1)
    LIMIT $2
)
RETURNING frame_key;
