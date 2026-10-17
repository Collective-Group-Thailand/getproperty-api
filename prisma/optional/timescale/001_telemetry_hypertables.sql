-- OPTIONAL — NOT part of `prisma migrate deploy` (prisma/migrations does not include this folder). D-162 / D-184.
-- UNVERIFIED against a live TimescaleDB: no CI job runs it (the embedded PostgreSQL 18 of the suites has no
-- timescaledb extension). Apply by hand, in a maintenance window, only where O-005 resolves to "TimescaleDB is
-- available" (self-managed PostgreSQL with the extension, or Timescale Cloud) and only after a restore drill.
--
-- What it does: converts the two monthly-partitioned raw tables (smart.telemetry_point, smart.device_health_sample)
-- into hypertables with 7-day chunks, compression after 30 days and retention by policy instead of the worker's
-- partition drop. The rollup tables (telemetry_15m / _1h / _1d) and the worker job that maintains them stay as they
-- are — every API read keeps going through them, so nothing above the database changes. After applying, set the
-- platform setting `telemetry.retention.raw` to the same horizon as the policy below (the worker's partition drop
-- finds no partitions and does nothing).
BEGIN;

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. raw telemetry -----------------------------------------------------------------------------------------------
ALTER TABLE smart.telemetry_point RENAME TO telemetry_point_partitioned;
CREATE TABLE smart.telemetry_point (LIKE smart.telemetry_point_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE smart.telemetry_point ADD PRIMARY KEY (device_id, seq, time);
SELECT create_hypertable('smart.telemetry_point', by_range('time', INTERVAL '7 days'));
CREATE INDEX telemetry_point_asset_item_id_time_idx ON smart.telemetry_point (asset_item_id, time DESC);
CREATE INDEX telemetry_point_tenant_id_building_id_time_idx ON smart.telemetry_point (tenant_id, building_id, time DESC);
INSERT INTO smart.telemetry_point SELECT * FROM smart.telemetry_point_partitioned;
ALTER TABLE smart.telemetry_point SET (timescaledb.compress, timescaledb.compress_segmentby = 'asset_item_id',
                                       timescaledb.compress_orderby = 'time DESC, seq DESC');
SELECT add_compression_policy('smart.telemetry_point', INTERVAL '30 days');
SELECT add_retention_policy('smart.telemetry_point', INTERVAL '24 months');
CREATE INDEX telemetry_point_received_at_idx ON smart.telemetry_point (received_at);
SELECT platform.apply_rls('smart.telemetry_point', 'building', 'smart.metering');
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.telemetry_point TO gp_platform;
DROP TABLE smart.telemetry_point_partitioned;

-- 2. gateway health samples --------------------------------------------------------------------------------------
ALTER TABLE smart.device_health_sample RENAME TO device_health_sample_partitioned;
CREATE TABLE smart.device_health_sample (LIKE smart.device_health_sample_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE smart.device_health_sample ADD PRIMARY KEY (gateway_device_id, time);
SELECT create_hypertable('smart.device_health_sample', by_range('time', INTERVAL '7 days'));
INSERT INTO smart.device_health_sample SELECT * FROM smart.device_health_sample_partitioned;
SELECT add_retention_policy('smart.device_health_sample', INTERVAL '6 months');
SELECT platform.apply_rls('smart.device_health_sample', 'building', 'smart.metering');
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.device_health_sample TO gp_platform;
DROP TABLE smart.device_health_sample_partitioned;

-- 3. the partition helpers become no-ops (the ingest pipeline and the worker keep calling them) --------------------
CREATE OR REPLACE FUNCTION smart.ensure_month_partition(parent regclass, at timestamptz) RETURNS text
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT 'hypertable'::text $$;
CREATE OR REPLACE FUNCTION smart.drop_month_partitions_before(parent regclass, cutoff timestamptz) RETURNS text[]
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT '{}'::text[] $$;

COMMIT;
