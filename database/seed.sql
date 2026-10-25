-- ---------------------------------------------------------------------------
-- InsightEye — People Counting : demo data
--
-- Development only. Deliberately NOT mounted into docker-entrypoint-initdb.d,
-- so a fresh stack comes up empty and nobody ships fabricated history to a
-- real deployment. Load it when you want a populated console to work against:
--
--   docker compose exec -T postgres psql -U peoplecount -d peoplecount_db < database/seed.sql
--
-- Re-runnable: cameras carry fixed UUIDs (ON CONFLICT DO NOTHING) and the
-- history is only generated for a camera that has none yet.
-- ---------------------------------------------------------------------------

BEGIN;

-- =============================================================================
-- CAMERAS
-- =============================================================================
-- All four read from the mediamtx sidecar in docker-compose.yml. Only the
-- first is enabled, so one worker runs; the others carry history and limits
-- so every chart has more than one line.
INSERT INTO camera (camera_id, name, rtsp_url, location, building, floor_level, zone, area,
                    enabled, count_threshold_greater, count_threshold_less, alert_enabled, settings)
VALUES
    ('22222222-2222-4222-8222-000000000001', 'Main Entrance', 'rtsp://mediamtx:8554/people',
     'HQ lobby doors', 'HQ', 'G', 'Entrance', 'Lobby',
     TRUE, 15, NULL, TRUE, '{}'::jsonb),

    ('22222222-2222-4222-8222-000000000002', 'Food Court', 'rtsp://mediamtx:8554/cctv1',
     'First-floor seating', 'HQ', '1', 'Food Court', 'Seating',
     FALSE, 25, NULL, TRUE, '{"sample_interval_s": 30}'::jsonb),

    ('22222222-2222-4222-8222-000000000003', 'Open Office East', 'rtsp://mediamtx:8554/cctv3',
     'Second-floor desks', 'HQ', '2', 'Office', 'East Wing',
     FALSE, 12, NULL, TRUE, '{}'::jsonb),

    -- A desk that must stay staffed: one person minimum, at most four.
    ('22222222-2222-4222-8222-000000000004', 'Security Desk', 'rtsp://mediamtx:8554/cctv20',
     'Reception', 'HQ', 'G', 'Entrance', 'Reception',
     FALSE, 4, 1, TRUE, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SAMPLES — 14 days, one every 5 minutes per camera
-- =============================================================================
-- A working-day shape: quiet at night, a morning arrival, a lunch peak and an
-- evening exit, lighter at weekends. setseed() keeps the noise the same on
-- every load. The desk is staffed by 1-2 people around the clock with the odd
-- gap, which is what its minimum is for.
SELECT setseed(0.42);

WITH profile AS (
    SELECT * FROM (VALUES
        ('22222222-2222-4222-8222-000000000001'::uuid, 18.0),
        ('22222222-2222-4222-8222-000000000002'::uuid, 30.0),
        ('22222222-2222-4222-8222-000000000003'::uuid, 13.0)
    ) AS p (camera_id, capacity)
    WHERE NOT EXISTS (SELECT 1 FROM count_sample s WHERE s.camera_id = p.camera_id)
),
ticks AS (
    SELECT t
    FROM generate_series(
        date_trunc('hour', NOW()) - INTERVAL '14 days',
        NOW() - INTERVAL '5 minutes',
        INTERVAL '5 minutes'
    ) AS t
),
shaped AS (
    SELECT p.camera_id, t,
           p.capacity
           * CASE
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 0 AND 5   THEN 0.03
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 6 AND 7   THEN 0.25
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 8 AND 9   THEN 0.75
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 10 AND 11 THEN 0.55
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 12 AND 13 THEN 0.95
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 14 AND 16 THEN 0.6
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 18 THEN 0.8
                 WHEN EXTRACT(HOUR FROM t) BETWEEN 19 AND 21 THEN 0.3
                 ELSE 0.1
             END
           * CASE WHEN EXTRACT(ISODOW FROM t) >= 6 THEN 0.4 ELSE 1.0 END
           * (0.75 + random() * 0.5) AS expected
    FROM profile p CROSS JOIN ticks
)
INSERT INTO count_sample (camera_id, captured_at, person_count)
SELECT camera_id, t, GREATEST(0, ROUND(expected))::int FROM shaped;

INSERT INTO count_sample (camera_id, captured_at, person_count)
SELECT '22222222-2222-4222-8222-000000000004', t,
       CASE WHEN random() < 0.03 THEN 0
            WHEN random() < 0.02 THEN 5
            WHEN random() < 0.5  THEN 1
            ELSE 2 END
FROM generate_series(
    date_trunc('hour', NOW()) - INTERVAL '14 days',
    NOW() - INTERVAL '5 minutes',
    INTERVAL '5 minutes'
) AS t
WHERE NOT EXISTS (
    SELECT 1 FROM count_sample s WHERE s.camera_id = '22222222-2222-4222-8222-000000000004'
);

-- =============================================================================
-- VIOLATIONS — every seeded sample outside its camera's limits
-- =============================================================================
INSERT INTO threshold_violation (camera_id, captured_at, person_count, threshold_type, threshold_value)
SELECT s.camera_id, s.captured_at, s.person_count,
       CASE WHEN s.person_count > c.count_threshold_greater THEN 'greater_than' ELSE 'less_than' END,
       CASE WHEN s.person_count > c.count_threshold_greater THEN c.count_threshold_greater
            ELSE c.count_threshold_less END
FROM count_sample s
JOIN camera c ON c.camera_id = s.camera_id
WHERE c.camera_id::text LIKE '22222222-2222-4222-8222-%'
  AND (s.person_count > c.count_threshold_greater OR s.person_count < c.count_threshold_less)
  AND NOT EXISTS (
      SELECT 1 FROM threshold_violation v
      WHERE v.camera_id = s.camera_id AND v.captured_at = s.captured_at
  );

-- =============================================================================
-- ALERTS — the first violation of each camera in each hour
-- =============================================================================
-- Roughly what the 10-minute cooldown lets through. Older alerts are closed
-- out the way operators would; the last day's are still open.
INSERT INTO count_alert (camera_id, triggered_at, person_count, threshold_type, threshold_value,
                         status, action_taken, description, acknowledged_at, resolved_at)
SELECT v.camera_id, v.captured_at, v.person_count, v.threshold_type, v.threshold_value,
       st.status,
       CASE st.status
           WHEN 'RESOLVED' THEN CASE WHEN v.threshold_type = 'greater_than'
                                     THEN 'Opened the overflow area' ELSE 'Desk re-staffed' END
           WHEN 'FALSE_POSITIVE' THEN 'Reflection counted as people'
       END,
       NULL,
       CASE WHEN st.status <> 'OPEN' THEN v.captured_at + INTERVAL '4 minutes' END,
       CASE WHEN st.status IN ('RESOLVED', 'FALSE_POSITIVE') THEN v.captured_at + INTERVAL '20 minutes' END
FROM (
    SELECT DISTINCT ON (camera_id, date_trunc('hour', captured_at)) *
    FROM threshold_violation
    WHERE camera_id::text LIKE '22222222-2222-4222-8222-%'
    ORDER BY camera_id, date_trunc('hour', captured_at), captured_at
) v
CROSS JOIN LATERAL (
    SELECT CASE
               WHEN v.captured_at > NOW() - INTERVAL '1 day' THEN 'OPEN'
               WHEN v.captured_at > NOW() - INTERVAL '2 days' THEN 'ACKNOWLEDGED'
               WHEN EXTRACT(MINUTE FROM v.captured_at)::int = 35 THEN 'FALSE_POSITIVE'
               ELSE 'RESOLVED'
           END AS status
) st
WHERE NOT EXISTS (
    SELECT 1 FROM count_alert a WHERE a.camera_id = v.camera_id AND a.triggered_at = v.captured_at
);

COMMIT;
