-- getproperty-api 0039 — telemetry storage for the platform's volumes (D-234; blueprint T-12, T-13, T-14; O-014
-- resolved → D-241; ADR-0014).
--   * T-14: at 15-minute polling smart.telemetry_15m held one row per raw point (a full duplicate of
--     smart.telemetry_point, ≈ 280 B per point, kept 5 years). It is dropped: 15-minute series are computed from the raw
--     points on read by smart.telemetry_15m_series() (SECURITY DEFINER, tenant check = the read policy of the former
--     table) and smart.telemetry_15m_rows() (gp_platform only, cross-tenant jobs). 15-minute data therefore lives exactly
--     as long as raw points (telemetry.retention.raw, 24 months — O-014); the hourly rollup is folded from raw points
--     directly; _1h / _1d keep RLS and their 5-year retention. Nothing is lost: every dropped row is recomputable from
--     telemetry_point (raw retention ≥ any 15-minute row's age on every database migrated so far).
--   * T-12 (baseline part): smart.telemetry_point stays platform-only — written by ingest and read by the rollup job
--     and the functions above as gp_platform; gp_app / gp_reporting have no privilege on it (asserted here). The
--     TimescaleDB step prisma/optional/timescale/002_telemetry_compression.sql then drops its RLS and compresses it.
--   * T-13: smart.device_health_sample no longer stores meters[] (≈ 18 KB per sample at 300 meters every 60 s): the
--     per-meter state lives in smart.device_health_latest.meters, and each change of a meter's status is one
--     smart.device_event of the new type meter_status_changed.
-- Deviation (schema-design §7.5 row 104).

ALTER TYPE smart.device_event_type ADD VALUE IF NOT EXISTS 'meter_status_changed';

-- T-13
ALTER TABLE smart.device_health_sample DROP COLUMN meters;
COMMENT ON TABLE smart.device_health_sample IS 'Gateway heartbeats and LWTs (D-034), ≈ 150 B per sample: per-meter state only in device_health_latest.meters, changes as device_event meter_status_changed (T-13).';

-- T-12 (baseline): raw points are platform-only
REVOKE ALL ON smart.telemetry_point FROM gp_app, gp_reporting;
COMMENT ON TABLE smart.telemetry_point IS 'Every accepted interval reading (insight only, D-030). Platform-only (gp_platform: ingest, rollup job, the 15-minute series functions); tenants read 15-minute series through smart.telemetry_15m_series() and hourly / daily rollups under RLS (D-234, ADR-0014).';

-- T-14
DROP TABLE smart.telemetry_15m;
-- The two functions read the platform-only raw table (FORCE RLS) and must run as gp_platform (BYPASSRLS), like
-- asset-core's definer helpers. Handing them to gp_platform needs its CREATE right on the schema for this statement
-- only (the migrator owns `smart`; granted and revoked inside this transaction).
GRANT CREATE ON SCHEMA smart TO gp_platform;

CREATE FUNCTION smart.telemetry_15m_rows(p_asset_item_ids uuid[], p_from timestamptz, p_to timestamptz)
  RETURNS TABLE (asset_item_id uuid, bucket timestamptz, tenant_id uuid, building_id uuid, unit smart.meter_unit,
                 first_time timestamptz, last_time timestamptz, first_register numeric, last_register numeric,
                 min_register numeric, max_register numeric, points integer, usage numeric, avg_power_w numeric,
                 avg_flow_lpm numeric)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH b AS (
    SELECT p.asset_item_id,
           to_timestamp(floor(extract(epoch FROM p.time) / 900) * 900) AS bucket,
           (array_agg(p.tenant_id))[1] AS tenant_id,
           (array_agg(p.building_id))[1] AS building_id,
           (array_agg(p.unit))[1] AS unit,
           min(p.time) AS first_time,
           max(p.time) AS last_time,
           (array_agg(p.register ORDER BY p.time ASC, p.seq ASC))[1] AS first_register,
           (array_agg(p.register ORDER BY p.time DESC, p.seq DESC))[1] AS last_register,
           min(p.register) AS min_register,
           max(p.register) AS max_register,
           count(*)::integer AS points,
           avg((p.extra ->> 'powerW')::numeric) AS avg_power_w,
           avg((p.extra ->> 'flowLpm')::numeric) AS avg_flow_lpm
      FROM smart.telemetry_point p
     WHERE p.asset_item_id = ANY (p_asset_item_ids)
       AND p.time >= p_from - interval '2 days' AND p.time < p_to
     GROUP BY p.asset_item_id, 2),
  s AS (
    SELECT b.*, lag(b.last_register) OVER (PARTITION BY b.asset_item_id ORDER BY b.bucket) AS prev FROM b),
  ro AS (
    SELECT a.asset_item_id, coalesce(max(a.rollover_at), 99999.999) AS top
      FROM core.meter_assignment a WHERE a.asset_item_id = ANY (p_asset_item_ids) GROUP BY a.asset_item_id)
  SELECT s.asset_item_id, s.bucket, s.tenant_id, s.building_id, s.unit, s.first_time, s.last_time,
         s.first_register, s.last_register, s.min_register, s.max_register, s.points,
         (CASE
            WHEN s.prev IS NULL THEN s.last_register - s.first_register
            WHEN s.last_register >= s.prev THEN s.last_register - s.prev
            WHEN s.prev >= coalesce(ro.top, 99999.999) * 0.9 AND s.last_register <= coalesce(ro.top, 99999.999) * 0.1
              THEN coalesce(ro.top, 99999.999) + 0.001 - s.prev + s.last_register
            ELSE 0
          END)::numeric(12,3) AS usage,
         s.avg_power_w::numeric(12,2), s.avg_flow_lpm::numeric(12,3)
    FROM s LEFT JOIN ro ON ro.asset_item_id = s.asset_item_id
   WHERE s.bucket >= p_from
   ORDER BY s.asset_item_id, s.bucket
$$;
COMMENT ON FUNCTION smart.telemetry_15m_rows(uuid[], timestamptz, timestamptz) IS 'T-14 (ADR-0014): 15-minute buckets of meters computed from raw points (usage = last register − last register of the previous bucket, rollover-aware, as the former telemetry_15m). No tenant check: gp_platform only (cross-tenant jobs, the resident usage read after its own access check).';
ALTER FUNCTION smart.telemetry_15m_rows(uuid[], timestamptz, timestamptz) OWNER TO gp_platform;
REVOKE ALL ON FUNCTION smart.telemetry_15m_rows(uuid[], timestamptz, timestamptz) FROM PUBLIC, gp_app, gp_reporting;
GRANT EXECUTE ON FUNCTION smart.telemetry_15m_rows(uuid[], timestamptz, timestamptz) TO gp_platform;

CREATE FUNCTION smart.telemetry_15m_series(p_asset_item_ids uuid[], p_from timestamptz, p_to timestamptz)
  RETURNS TABLE (asset_item_id uuid, bucket timestamptz, tenant_id uuid, building_id uuid, unit smart.meter_unit,
                 first_time timestamptz, last_time timestamptz, first_register numeric, last_register numeric,
                 min_register numeric, max_register numeric, points integer, usage numeric, avg_power_w numeric,
                 avg_flow_lpm numeric)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT r.*
    FROM smart.telemetry_15m_rows(p_asset_item_ids, p_from, p_to) r
   WHERE r.tenant_id = (SELECT core.current_tenant_id())
      OR r.building_id = ANY ((SELECT core.accessible_building_ids('smart.metering'))::uuid[])
$$;
COMMENT ON FUNCTION smart.telemetry_15m_series(uuid[], timestamptz, timestamptz) IS 'T-14 (ADR-0014): the tenant-safe 15-minute read path — the same visibility as the former telemetry_15m read policy (the row''s tenant, or a building granted for smart.metering); rows of other tenants are simply absent.';
ALTER FUNCTION smart.telemetry_15m_series(uuid[], timestamptz, timestamptz) OWNER TO gp_platform;
REVOKE ALL ON FUNCTION smart.telemetry_15m_series(uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION smart.telemetry_15m_series(uuid[], timestamptz, timestamptz) TO gp_app, gp_platform, gp_reporting;

REVOKE CREATE ON SCHEMA smart FROM gp_platform;
