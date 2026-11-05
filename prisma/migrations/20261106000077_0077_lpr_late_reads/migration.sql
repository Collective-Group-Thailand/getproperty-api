-- getproperty-api 0077 — late LPR reads are history, never live (edge CR-017, D-330). schema-design §7.5 row 248
-- (smart.plate_detection).
--   * smart.plate_detection_state + historical: a `plate.detected` whose read time (`data.at`) is older than
--     gate.lpr.max_event_age_seconds when it reaches the cloud (queued on the edge during an outage) is stored as a
--     past read only: no visit is entered, no `gate.open` is sent, the guard sees it in the recent reads.
-- DDL only.

ALTER TYPE smart.plate_detection_state ADD VALUE IF NOT EXISTS 'historical';
