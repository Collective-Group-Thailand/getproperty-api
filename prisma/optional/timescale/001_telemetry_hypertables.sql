-- OPTIONAL — not part of `prisma/migrations` (so `prisma migrate deploy` never runs it). D-162 / D-184 / D-230.
-- Applied by the image's migrate command (`node dist/src/migrate.js`, src/database/migrations/deploy-migrations.ts)
-- right after the app migrations when TimescaleDB is usable — installed, or available and preloaded, as on the
-- Collective platform's `timescale/timescaledb-ha:pg18` (TIMESCALEDB_MIGRATION=auto, the default; `off` skips it,
-- `on` requires it). Recorded once in public._optional_migrations. Where the extension is absent (embedded PostgreSQL
-- of the test suites, plain postgres images) nothing happens and the native monthly partitions stay.
-- Still hand-runnable with psql (own BEGIN/COMMIT), but then record it in public._optional_migrations yourself.
--
-- UNVERIFIED against a live TimescaleDB: the sandbox has no timescaledb build; the first UAT deploy applies it
-- (LAUNCH-CHECKLIST §3). Run a restore drill before applying it to a production database that already holds data.
--
-- What it does: converts the two monthly-partitioned raw tables (smart.telemetry_point, smart.device_health_sample)
-- into hypertables with 7-day chunks and retention by policy instead of the worker's partition drop. The rollup tables
-- (telemetry_15m / _1h / _1d) and the worker job that maintains them stay — every API read keeps going through them,
-- so nothing above the database changes. Compression is NOT enabled: these tables carry row-level security, which
-- TimescaleDB does not support together with compression. smart.access_event stays natively partitioned. After it,
-- set the platform setting `telemetry.retention.raw` to the policy's horizon (the worker's partition drop is a no-op
-- for hypertables).
BEGIN;

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. raw telemetry -----------------------------------------------------------------------------------------------
ALTER TABLE smart.telemetry_point RENAME TO telemetry_point_partitioned;
CREATE TABLE smart.telemetry_point (LIKE smart.telemetry_point_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING COMMENTS);
SELECT create_hypertable('smart.telemetry_point', by_range('time', INTERVAL '7 days'));
INSERT INTO smart.telemetry_point SELECT * FROM smart.telemetry_point_partitioned;
-- dropping the partitioned parent drops its partitions and frees the index / constraint names
DROP TABLE smart.telemetry_point_partitioned;
ALTER TABLE smart.telemetry_point ADD CONSTRAINT telemetry_point_pkey PRIMARY KEY (device_id, seq, time);
CREATE INDEX telemetry_point_tenant_id_building_id_time_idx ON smart.telemetry_point (tenant_id, building_id, time DESC);
CREATE INDEX telemetry_point_asset_item_id_time_idx ON smart.telemetry_point (asset_item_id, time DESC);
CREATE INDEX telemetry_point_received_at_idx ON smart.telemetry_point (received_at);
SELECT add_retention_policy('smart.telemetry_point', INTERVAL '24 months');
SELECT platform.apply_rls('smart.telemetry_point', 'building', 'smart.metering');
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.telemetry_point TO gp_platform;

-- 2. gateway health samples --------------------------------------------------------------------------------------
ALTER TABLE smart.device_health_sample RENAME TO device_health_sample_partitioned;
CREATE TABLE smart.device_health_sample (LIKE smart.device_health_sample_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING COMMENTS);
SELECT create_hypertable('smart.device_health_sample', by_range('time', INTERVAL '7 days'));
INSERT INTO smart.device_health_sample SELECT * FROM smart.device_health_sample_partitioned;
DROP TABLE smart.device_health_sample_partitioned;
ALTER TABLE smart.device_health_sample ADD CONSTRAINT device_health_sample_pkey PRIMARY KEY (gateway_device_id, time);
CREATE INDEX device_health_sample_tenant_id_building_id_time_idx ON smart.device_health_sample (tenant_id, building_id, time DESC);
SELECT add_retention_policy('smart.device_health_sample', INTERVAL '6 months');
SELECT platform.apply_rls('smart.device_health_sample', 'building', 'smart.metering');
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.device_health_sample TO gp_platform;

-- 3. the partition helpers (0016, extended by 0028 for smart.access_event) keep their contract: a hypertable
--    (relkind 'r', not a partitioned parent) answers 'hypertable' / no drops; smart.access_event is unchanged ------
CREATE OR REPLACE FUNCTION smart.ensure_month_partition(parent regclass, at timestamptz) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  first_day date := date_trunc('month', at AT TIME ZONE 'UTC')::date;
  part text;
BEGIN
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass, 'smart.access_event'::regclass) THEN
    RAISE EXCEPTION 'ensure_month_partition: % is not a partitioned smart table', parent;
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = parent) <> 'p' THEN
    RETURN 'hypertable';
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
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass, 'smart.access_event'::regclass) THEN
    RAISE EXCEPTION 'drop_month_partitions_before: % is not a partitioned smart table', parent;
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = parent) <> 'p' THEN
    RETURN dropped; -- a hypertable: the retention policy drops chunks
  END IF;
  base := (SELECT relname FROM pg_class WHERE oid = parent);
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = parent AND c.relname ~ ('^' || base || '_\d{6}$')
  LOOP
    IF (to_date(right(r.relname, 6), 'YYYYMM') + interval '1 month')::timestamp AT TIME ZONE 'UTC' <= cutoff THEN
      EXECUTE format('DROP TABLE smart.%I', r.relname);
      dropped := dropped || r.relname;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;

COMMIT;
