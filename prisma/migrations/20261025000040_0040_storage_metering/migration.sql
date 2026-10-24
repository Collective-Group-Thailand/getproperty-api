-- getproperty-api 0040 — storage metering per tenant (D-276; @collective/documents sql/storage-metering.sql adapted to
-- schema-design v2: uuidv7 ids, tenant FK, RLS:T, the platform schema).
--   * Files count at their stored size (core.document, live rows); records count at a fixed size per record type
--     (setting storage.record_bytes), so the number is predictable and auditable.
--   * platform.storage_usage_daily: one snapshot per tenant and Bangkok day (job `storage-metering`), the input of the
--     monthly GB-month charge; written by gp_platform only, read by the tenant (usage bar) under RLS.
--   * platform.storage_notice: the 80 % / 100 % notices already sent, so each is sent once per crossing; cleared when
--     the tenant falls back below the threshold.
--   * platform_line_kind gains `storage` for the line on the monthly platform invoice next to the payment fee (D-250).
-- Deviation from §3.2.10 (new tables): schema-design §7.5 row 105.

ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'storage';

CREATE TABLE platform.storage_usage_daily (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  day             date NOT NULL,
  file_bytes      bigint NOT NULL,
  record_counts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  counted_bytes   bigint NOT NULL,
  allowance_bytes bigint,
  policy_version  text NOT NULL,
  computed_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT storage_usage_daily_pkey PRIMARY KEY (id),
  CONSTRAINT storage_usage_daily_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_usage_daily_bytes_check CHECK (file_bytes >= 0 AND counted_bytes >= file_bytes AND (allowance_bytes IS NULL OR allowance_bytes >= 0))
);
COMMENT ON TABLE platform.storage_usage_daily IS 'Daily storage snapshot per tenant (D-276): file bytes, record counts per type, counted bytes under the policy in force that day (policy_version = the setting versions used), allowance (null = metering not active for the tenant type). Append-only.';
CREATE UNIQUE INDEX storage_usage_daily_tenant_id_day_key ON platform.storage_usage_daily (tenant_id, day);
CREATE TRIGGER storage_usage_daily_append_only BEFORE UPDATE OR DELETE ON platform.storage_usage_daily FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

CREATE TABLE platform.storage_notice (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  threshold_pct  integer NOT NULL,
  crossed_on     date NOT NULL,
  used_bytes     bigint NOT NULL,
  allowance_bytes bigint NOT NULL,
  sent_at        timestamptz(6) NOT NULL DEFAULT now(),
  cleared_at     timestamptz(6),
  CONSTRAINT storage_notice_pkey PRIMARY KEY (id),
  CONSTRAINT storage_notice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_notice_threshold_check CHECK (threshold_pct > 0 AND threshold_pct <= 1000)
);
COMMENT ON TABLE platform.storage_notice IS 'Storage notices sent to a tenant (D-276: LINE + in-app at 80 % and 100 % of the allowance), one open row per threshold; cleared_at when usage falls back below it.';
CREATE INDEX storage_notice_tenant_id_threshold_pct_idx ON platform.storage_notice (tenant_id, threshold_pct);
CREATE UNIQUE INDEX storage_notice_open_key ON platform.storage_notice (tenant_id, threshold_pct) WHERE cleared_at IS NULL;

SELECT platform.apply_rls('platform.storage_usage_daily', 'tenant');
SELECT platform.apply_rls('platform.storage_notice', 'tenant');
GRANT SELECT ON platform.storage_usage_daily, platform.storage_notice TO gp_app, gp_reporting;
GRANT SELECT, INSERT ON platform.storage_usage_daily TO gp_platform;
GRANT SELECT, INSERT, UPDATE ON platform.storage_notice TO gp_platform;
