-- OPTIONAL step 2 (D-234, blueprint T-12, ADR-0014) — applied by the image's migrate command right after step 1
-- (001_telemetry_hypertables) where TimescaleDB is usable; recorded in public._optional_migrations. Requires step 1.
--
-- UNVERIFIED against a live TimescaleDB (no timescaledb build in the sandbox): the first UAT deploy applies it
-- (LAUNCH-CHECKLIST §3) and measures the compression ratio (planning value 10:1).
--
-- What it does: TimescaleDB native compression cannot be enabled on a hypertable with row-level security, so the raw
-- table becomes platform-only *without* RLS — which changes nothing for tenants: gp_app / gp_reporting have no
-- privilege on it (0016, re-asserted by 0039); ingest writes and the rollup job reads it as gp_platform (BYPASSRLS);
-- the API reads 15-minute series only through smart.telemetry_15m_series(), which applies the tenant check itself
-- (0039), and hourly / daily data from smart.telemetry_1h / _1d, which keep their RLS. Then: compress chunks older
-- than 30 days, segment by asset_item_id (the per-meter reads stay cheap), order by time DESC.
BEGIN;

DROP POLICY IF EXISTS telemetry_point_rls_read ON smart.telemetry_point;
DROP POLICY IF EXISTS telemetry_point_rls_write ON smart.telemetry_point;
ALTER TABLE smart.telemetry_point NO FORCE ROW LEVEL SECURITY;
ALTER TABLE smart.telemetry_point DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON smart.telemetry_point FROM gp_app, gp_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.telemetry_point TO gp_platform;

ALTER TABLE smart.telemetry_point SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'asset_item_id',
  timescaledb.compress_orderby = 'time DESC, seq DESC'
);
SELECT add_compression_policy('smart.telemetry_point', INTERVAL '30 days');

COMMIT;
