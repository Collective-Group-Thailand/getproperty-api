-- getproperty-api 0016 (B3.2) — MQTT ingest storage, portable per D-162 (no TimescaleDB): native monthly range
-- partitions for smart.telemetry_point and smart.device_health_sample (created ahead by the worker and on demand by
-- the ingest process through smart.ensure_month_partition, dropped for retention by
-- smart.drop_month_partitions_before), plain rollup tables smart.telemetry_15m / _1h / _1d maintained by the
-- telemetry-rollup job (the API reads only these, never raw points), the D-143 dedup window, gateway health, device
-- events, ingest dead letters (admin replay) and the rollup cursor. An optional, separate conversion to hypertables
-- lives in prisma/optional/timescale/ (never applied by `db:migrate`). Deviations: schema-design §7.5 rows 36–40.

CREATE TYPE smart.meter_unit AS ENUM ('kwh', 'm3');
CREATE TYPE smart.reading_quality AS ENUM ('good', 'estimated_by_gateway', 'clock_suspect', 'overflow_corrected', 'register_decrease');
CREATE TYPE smart.link_type AS ENUM ('ethernet', 'wifi', 'lte');
CREATE TYPE smart.device_event_type AS ENUM ('meter_offline', 'pulse_overflow', 'config_applied', 'config_rejected', 'ota_started',
  'ota_applied', 'ota_rolled_back', 'ota_failed', 'tamper', 'power_loss', 'restart', 'seq_gap', 'invalid_payload', 'batch_too_large',
  'unbound_meter', 'config_drift', 'battery_low', 'gateway_online', 'gateway_offline');
CREATE TYPE smart.device_event_severity AS ENUM ('info', 'warning', 'critical');
CREATE TYPE smart.ingest_failure AS ENUM ('malformed_json', 'invalid_payload', 'gateway_mismatch', 'unknown_gateway', 'batch_too_large', 'unknown_topic', 'processing_error');

-- ---------------------------------------------------------------------------------------- telemetry (partitioned)
CREATE TABLE smart.telemetry_point (
  time              timestamptz(6) NOT NULL,
  received_at       timestamptz(6) NOT NULL DEFAULT now(),
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  asset_item_id     uuid NOT NULL,
  device_id         uuid NOT NULL,
  gateway_device_id uuid NOT NULL,
  seq               bigint NOT NULL,
  register          numeric(12,3) NOT NULL,
  unit              smart.meter_unit NOT NULL,
  quality           smart.reading_quality NOT NULL,
  config_version    integer,
  extra             jsonb,
  CONSTRAINT telemetry_point_pkey PRIMARY KEY (device_id, seq, time),
  CONSTRAINT telemetry_point_register_check CHECK (register >= 0)
) PARTITION BY RANGE (time);
COMMENT ON TABLE smart.telemetry_point IS 'Every accepted interval reading (insight only, D-030; never read by billing). Monthly range partitions (D-162); dedup (device_id, seq) per D-143; no FKs on the write path.';
CREATE INDEX telemetry_point_tenant_id_building_id_time_idx ON smart.telemetry_point (tenant_id, building_id, time DESC);
CREATE INDEX telemetry_point_asset_item_id_time_idx ON smart.telemetry_point (asset_item_id, time DESC);
CREATE INDEX telemetry_point_received_at_idx ON smart.telemetry_point (received_at);

CREATE TABLE smart.device_health_sample (
  time              timestamptz(6) NOT NULL,
  gateway_device_id uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  agent_version     text,
  config_version    integer,
  uptime_s          integer,
  buffered_readings integer,
  disk_free_mb      integer,
  cpu_pct           smallint,
  mem_pct           smallint,
  link              smart.link_type,
  rssi              smallint,
  meters            jsonb,
  is_lwt            boolean NOT NULL DEFAULT false,
  CONSTRAINT device_health_sample_pkey PRIMARY KEY (gateway_device_id, time)
) PARTITION BY RANGE (time);
COMMENT ON TABLE smart.device_health_sample IS 'Gateway heartbeats every 60 s and broker LWTs (D-034); monthly range partitions, 6 months retention (D-162).';
CREATE INDEX device_health_sample_tenant_id_building_id_time_idx ON smart.device_health_sample (tenant_id, building_id, time DESC);

-- Monthly partitions in UTC (`<table>_YYYYMM`), created by the table owner on behalf of gp_platform. Every
-- partition gets RLS enabled + forced without policies: rows are read only through the parent (its policies).
CREATE OR REPLACE FUNCTION smart.ensure_month_partition(parent regclass, at timestamptz) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  first_day date := date_trunc('month', at AT TIME ZONE 'UTC')::date;
  part text;
BEGIN
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass) THEN
    RAISE EXCEPTION 'ensure_month_partition: % is not a partitioned smart table', parent;
  END IF;
  part := (SELECT relname FROM pg_class WHERE oid = parent) || '_' || to_char(first_day, 'YYYYMM');
  IF to_regclass('smart.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE smart.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', part, parent,
                   (first_day::timestamp AT TIME ZONE 'UTC'), ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
    EXECUTE format('ALTER TABLE smart.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE smart.%I FORCE ROW LEVEL SECURITY', part);
  END IF;
  RETURN part;
END
$$;
COMMENT ON FUNCTION smart.ensure_month_partition(regclass, timestamptz) IS 'Creates the monthly (UTC) partition of smart.telemetry_point / smart.device_health_sample containing `at` when missing (D-162).';

CREATE OR REPLACE FUNCTION smart.drop_month_partitions_before(parent regclass, cutoff timestamptz) RETURNS text[]
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  base text;
  r record;
  dropped text[] := '{}';
BEGIN
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass) THEN
    RAISE EXCEPTION 'drop_month_partitions_before: % is not a partitioned smart table', parent;
  END IF;
  base := (SELECT relname FROM pg_class WHERE oid = parent);
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = parent AND c.relname ~ ('^' || base || '_\d{6}$')
  LOOP
    -- a partition is dropped once its whole month ends before the cutoff
    IF (to_date(right(r.relname, 6), 'YYYYMM') + interval '1 month')::timestamp AT TIME ZONE 'UTC' <= cutoff THEN
      EXECUTE format('DROP TABLE smart.%I', r.relname);
      dropped := dropped || r.relname;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;
COMMENT ON FUNCTION smart.drop_month_partitions_before(regclass, timestamptz) IS 'Retention by partition drop (D-162): drops the monthly partitions that end before the cutoff; returns their names.';

REVOKE ALL ON FUNCTION smart.ensure_month_partition(regclass, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION smart.drop_month_partitions_before(regclass, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION smart.ensure_month_partition(regclass, timestamptz) TO gp_platform;
GRANT EXECUTE ON FUNCTION smart.drop_month_partitions_before(regclass, timestamptz) TO gp_platform;

-- The current month and the next three exist from the start; the worker keeps three months ahead.
SELECT smart.ensure_month_partition('smart.telemetry_point', now() + make_interval(months => m)) FROM generate_series(0, 3) m;
SELECT smart.ensure_month_partition('smart.device_health_sample', now() + make_interval(months => m)) FROM generate_series(0, 3) m;

-- ---------------------------------------------------------------------------------------- rollups (plain tables)
CREATE TABLE smart.telemetry_15m (
  asset_item_id  uuid NOT NULL,
  bucket         timestamptz(6) NOT NULL,
  tenant_id      uuid NOT NULL,
  building_id    uuid NOT NULL,
  unit           smart.meter_unit NOT NULL,
  first_time     timestamptz(6) NOT NULL,
  last_time      timestamptz(6) NOT NULL,
  first_register numeric(12,3) NOT NULL,
  last_register  numeric(12,3) NOT NULL,
  min_register   numeric(12,3) NOT NULL,
  max_register   numeric(12,3) NOT NULL,
  points         integer NOT NULL,
  usage          numeric(12,3),
  avg_power_w    numeric(12,2),
  avg_flow_lpm   numeric(12,3),
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT telemetry_15m_pkey PRIMARY KEY (asset_item_id, bucket),
  CONSTRAINT telemetry_15m_points_check CHECK (points > 0)
);
CREATE INDEX telemetry_15m_tenant_id_building_id_bucket_idx ON smart.telemetry_15m (tenant_id, building_id, bucket);
CREATE TABLE smart.telemetry_1h (LIKE smart.telemetry_15m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE smart.telemetry_1h ADD CONSTRAINT telemetry_1h_pkey PRIMARY KEY (asset_item_id, bucket);
ALTER TABLE smart.telemetry_1h RENAME CONSTRAINT telemetry_15m_points_check TO telemetry_1h_points_check;
CREATE INDEX telemetry_1h_tenant_id_building_id_bucket_idx ON smart.telemetry_1h (tenant_id, building_id, bucket);
CREATE TABLE smart.telemetry_1d (LIKE smart.telemetry_15m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE smart.telemetry_1d ADD CONSTRAINT telemetry_1d_pkey PRIMARY KEY (asset_item_id, bucket);
ALTER TABLE smart.telemetry_1d RENAME CONSTRAINT telemetry_15m_points_check TO telemetry_1d_points_check;
CREATE INDEX telemetry_1d_tenant_id_building_id_bucket_idx ON smart.telemetry_1d (tenant_id, building_id, bucket);
COMMENT ON TABLE smart.telemetry_15m IS 'Rollup of smart.telemetry_point per meter asset item and 15 minutes (D-162): registers, points, usage since the previous bucket (rollover-aware), average power / flow. Read by series endpoints and loss suspects.';
COMMENT ON TABLE smart.telemetry_1h IS 'Hourly rollup of smart.telemetry_15m (D-162).';
COMMENT ON TABLE smart.telemetry_1d IS 'Daily rollup (Asia/Bangkok days) of smart.telemetry_1h (D-162); kept 5 years.';

CREATE TABLE smart.rollup_cursor (
  name            text NOT NULL,
  processed_until timestamptz(6) NOT NULL,
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT rollup_cursor_pkey PRIMARY KEY (name)
);
COMMENT ON TABLE smart.rollup_cursor IS 'High-water mark (received_at) of the telemetry-rollup job.';

-- ---------------------------------------------------------------------------------------- dedup, health, events
CREATE TABLE smart.ingest_seq_mark (
  device_id   uuid NOT NULL,
  seq         bigint NOT NULL,
  received_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT ingest_seq_mark_pkey PRIMARY KEY (device_id, seq)
);
COMMENT ON TABLE smart.ingest_seq_mark IS 'D-143 dedup window of (meter device, seq): purged after 90 days; smart.device.last_seq is the watermark behind it.';
CREATE INDEX ingest_seq_mark_received_at_idx ON smart.ingest_seq_mark (received_at);

CREATE TABLE smart.device_health_latest (
  gateway_device_id uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  last_heartbeat_at timestamptz(6),
  agent_version     text,
  config_version    integer,
  uptime_s          integer,
  buffered_readings integer,
  disk_free_mb      integer,
  cpu_pct           smallint,
  mem_pct           smallint,
  link              smart.link_type,
  rssi              smallint,
  meters            jsonb,
  is_lwt            boolean NOT NULL DEFAULT false,
  missed_heartbeats smallint NOT NULL DEFAULT 0,
  computed_status   smart.device_status NOT NULL,
  ingest_lag_ms     integer,
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT device_health_latest_pkey PRIMARY KEY (gateway_device_id),
  CONSTRAINT device_health_latest_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_health_latest_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_health_latest_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE smart.device_health_latest IS 'Last heartbeat of each gateway with the computed status (online / degraded / offline after 5 missed heartbeats, D-034) and the last ingest lag.';
CREATE INDEX device_health_latest_tenant_id_building_id_idx ON smart.device_health_latest (tenant_id, building_id);

CREATE TABLE smart.device_event (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  event_id           uuid NOT NULL,
  tenant_id          uuid,
  building_id        uuid,
  gateway_device_id  uuid NOT NULL,
  device_id          uuid,
  type               smart.device_event_type NOT NULL,
  severity           smart.device_event_severity NOT NULL,
  occurred_at        timestamptz(6) NOT NULL,
  received_at        timestamptz(6) NOT NULL DEFAULT now(),
  config_version     text,
  message            text,
  data               jsonb,
  acknowledged_at    timestamptz(6),
  acknowledged_by    uuid,
  service_request_id uuid,
  CONSTRAINT device_event_pkey PRIMARY KEY (id),
  CONSTRAINT device_event_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_event_message_check CHECK (message IS NULL OR length(message) <= 500)
);
COMMENT ON TABLE smart.device_event IS 'Operational events from gateways (device protocol §2) and from the cloud (invalid payloads, unbound meters, config drift, …); plain table, 24 months (D-147).';
CREATE UNIQUE INDEX device_event_event_id_key ON smart.device_event (event_id);
CREATE INDEX device_event_tenant_id_building_id_occurred_at_idx ON smart.device_event (tenant_id, building_id, occurred_at DESC);
CREATE INDEX device_event_gateway_device_id_type_occurred_at_idx ON smart.device_event (gateway_device_id, type, occurred_at DESC);

CREATE TABLE smart.ingest_dead_letter (
  id                uuid NOT NULL DEFAULT uuidv7(),
  received_at       timestamptz(6) NOT NULL DEFAULT now(),
  topic             text NOT NULL,
  channel           text NOT NULL DEFAULT 'mqtt',
  gateway_device_id uuid,
  reason            smart.ingest_failure NOT NULL,
  detail            text,
  payload           bytea NOT NULL,
  replayed_at       timestamptz(6),
  replayed_by       uuid,
  replay_outcome    text,
  CONSTRAINT ingest_dead_letter_pkey PRIMARY KEY (id),
  CONSTRAINT ingest_dead_letter_channel_check CHECK (channel IN ('mqtt', 'https_batch')),
  CONSTRAINT ingest_dead_letter_payload_check CHECK (octet_length(payload) <= 1048576)
);
COMMENT ON TABLE smart.ingest_dead_letter IS 'Payloads the ingest pipeline could not accept (device protocol §5), kept for the platform admin to inspect and replay.';
CREATE INDEX ingest_dead_letter_received_at_idx ON smart.ingest_dead_letter (received_at DESC);
CREATE INDEX ingest_dead_letter_gateway_device_id_idx ON smart.ingest_dead_letter (gateway_device_id);

CREATE TRIGGER device_health_latest_set_updated_at BEFORE UPDATE ON smart.device_health_latest FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Row-level security (schema-design §4.5; §7.4 Q5: native partitions keep the parent's policies).
SELECT platform.apply_rls('smart.telemetry_point', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.device_health_sample', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.telemetry_15m', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.telemetry_1h', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.telemetry_1d', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.device_health_latest', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.device_event', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.ingest_seq_mark', 'platform_only');
SELECT platform.apply_rls('smart.ingest_dead_letter', 'platform_only');
SELECT platform.apply_rls('smart.rollup_cursor', 'platform_only');

GRANT SELECT, INSERT, UPDATE, DELETE ON smart.telemetry_point, smart.device_health_sample, smart.telemetry_15m, smart.telemetry_1h,
  smart.telemetry_1d, smart.device_health_latest, smart.device_event, smart.ingest_seq_mark, smart.ingest_dead_letter,
  smart.rollup_cursor TO gp_platform;
-- The application role reads rollups, health and events (RLS); raw points are written and read by gp_platform only.
GRANT SELECT ON smart.telemetry_15m, smart.telemetry_1h, smart.telemetry_1d, smart.device_health_latest, smart.device_event TO gp_app, gp_reporting;
GRANT UPDATE (acknowledged_at, acknowledged_by) ON smart.device_event TO gp_app;
