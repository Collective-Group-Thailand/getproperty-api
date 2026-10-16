-- getproperty-api 0001 — application schemas (schema-design v2 §1.4, §7.2).
-- Runs after `asset-core migrate` (@collective/asset-core): the `core` schema, the extensions, the uuidv7()
-- guard, the gp_* roles and the core.* helper/trigger functions already exist. This repository never creates
-- or alters a core.* object (D-153). TimescaleDB is NOT created here (D-162: telemetry uses native monthly
-- partitions + rollup tables; an optional Timescale conversion ships separately in B3.2).

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS smart;
CREATE SCHEMA IF NOT EXISTS bridge;
CREATE SCHEMA IF NOT EXISTS juristic;

COMMENT ON SCHEMA platform IS 'Settings & flags, utility tariffs, identity sessions/roles, audit, events, outbox, idempotency, notifications, privacy, compliance, calendar (getproperty-api).';
COMMENT ON SCHEMA ops IS 'Group A operations: workflow engine, document numbering; leases, billing, payments (B2–B5).';
COMMENT ON SCHEMA smart IS 'Group C + A3 hardware: devices, telemetry, meter readings (B3). Empty in B1.2.';
COMMENT ON SCHEMA bridge IS 'Integration events with getbuild / getpack (D-153).';
COMMENT ON SCHEMA juristic IS 'Group B (condo juristic). Empty until Phase 2/3.';

GRANT USAGE ON SCHEMA platform, ops, smart, bridge, juristic TO gp_app, gp_platform, gp_reporting;

-- Objects created later by the migrating role get the same privileges as the explicit grants in 0009.
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ops, smart, bridge, juristic
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gp_app, gp_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ops, smart, bridge, juristic
  GRANT SELECT ON TABLES TO gp_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ops, smart, bridge, juristic
  GRANT EXECUTE ON FUNCTIONS TO gp_app, gp_platform, gp_reporting;
