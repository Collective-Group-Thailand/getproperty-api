-- getproperty-api 0058 — storage quota, legal hold, storage packages and reclaim (pack G step G1; D-285, D-286,
-- refining D-276 / D-279). schema-design §7.5 rows 142–148 (drafts G1-a … G1-g).
--   * platform.storage_usage: the current counters per tenant × category, maintained by the API in the same
--     transaction as each document write / derivative / purge (no trigger on core.document: core is the package).
--   * platform.document_storage: one row per counted core.document (category, bytes incl. thumbnails / renditions,
--     objects, derivative keys) — the ledger behind the counters, so a purge decrements exactly and the nightly
--     reconciliation can map S3 keys to documents.
--   * platform.storage_reconciliation: the nightly S3 ListObjectsV2 comparison per tenant prefix (append-only).
--   * platform.document_legal_hold: documents the law requires to keep (D-286) — counted, never deletable before
--     retain_until (NULL = open-ended until the basis event, e.g. the end of the lease). The API refuses deletes with
--     storage.legal_hold; this table's trigger refuses deleting a hold, releasing it early or shortening it.
--   * platform.storage_package: purchased storage packages (definitions are price-plan add-ons, prices O-022).
--   * platform invoices may be purchases without a subscription (subscriptions are off, D-250).
-- New enum values are not used in this transaction (ALTER TYPE … ADD VALUE): the CHECK compares text.

ALTER TYPE platform.platform_invoice_kind ADD VALUE IF NOT EXISTS 'purchase';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'boost';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'success_fee';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'co_broke_fee';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'media_service';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'messaging_addon';
ALTER TYPE platform.platform_line_kind ADD VALUE IF NOT EXISTS 'sponsored_broadcast';
ALTER TYPE platform.plan_billing_unit ADD VALUE IF NOT EXISTS 'per_package';
ALTER TYPE platform.plan_billing_unit ADD VALUE IF NOT EXISTS 'per_listing';
ALTER TYPE platform.plan_billing_unit ADD VALUE IF NOT EXISTS 'per_recipient';
ALTER TYPE platform.plan_billing_unit ADD VALUE IF NOT EXISTS 'per_deal';
ALTER TYPE platform.plan_billing_unit ADD VALUE IF NOT EXISTS 'percent_of_amount';

-- a purchase (storage package, later boosts / fees) is invoiced without a subscription; every other kind keeps one
ALTER TABLE platform.platform_invoice ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE platform.platform_invoice ADD CONSTRAINT platform_invoice_subscription_check
  CHECK (subscription_id IS NOT NULL OR kind::text = 'purchase');

CREATE TYPE platform.storage_category AS ENUM ('listing_media', 'attachment', 'system_legal', 'system_other');
CREATE TYPE platform.storage_package_state AS ENUM ('pending_payment', 'active', 'expired', 'cancelled');
CREATE TYPE platform.storage_package_period AS ENUM ('month', 'year');

CREATE TABLE platform.storage_usage (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  category    platform.storage_category NOT NULL,
  bytes       bigint NOT NULL DEFAULT 0,
  objects     integer NOT NULL DEFAULT 0,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT storage_usage_pkey PRIMARY KEY (id),
  CONSTRAINT storage_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_usage_counts_check CHECK (bytes >= 0 AND objects >= 0)
);
COMMENT ON TABLE platform.storage_usage IS 'G1 / D-286: current stored bytes and objects per tenant and category, updated in the transaction of each document write, derivative and purge; corrected by the nightly reconciliation. storage_usage_daily stays the history.';
CREATE UNIQUE INDEX storage_usage_tenant_id_category_key ON platform.storage_usage (tenant_id, category);

CREATE TABLE platform.document_storage (
  document_id      uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  category         platform.storage_category NOT NULL,
  bytes            bigint NOT NULL,
  objects          integer NOT NULL,
  derivative_keys  text[] NOT NULL DEFAULT '{}',
  counted          boolean NOT NULL DEFAULT true,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT document_storage_pkey PRIMARY KEY (document_id),
  CONSTRAINT document_storage_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT document_storage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT document_storage_counts_check CHECK (bytes >= 0 AND objects >= 0)
);
COMMENT ON TABLE platform.document_storage IS 'G1: what one document occupies in object storage (the file + thumbnails / renditions) and its quota category; counted = false once purged. Ledger behind platform.storage_usage.';
CREATE INDEX document_storage_tenant_id_category_idx ON platform.document_storage (tenant_id, category) WHERE counted;
CREATE INDEX document_storage_tenant_id_bytes_idx ON platform.document_storage (tenant_id, bytes DESC) WHERE counted;
CREATE TRIGGER document_storage_set_updated_at BEFORE UPDATE ON platform.document_storage FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE platform.storage_reconciliation (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  ran_at      timestamptz(6) NOT NULL DEFAULT now(),
  s3_bytes    bigint NOT NULL,
  s3_objects  bigint NOT NULL,
  db_bytes    bigint NOT NULL,
  db_objects  bigint NOT NULL,
  drift_bytes bigint NOT NULL,
  corrected   boolean NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT storage_reconciliation_pkey PRIMARY KEY (id),
  CONSTRAINT storage_reconciliation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.storage_reconciliation IS 'G1: nightly comparison of a tenant''s object-storage prefix (ListObjectsV2) with its counters: drift, orphan and missing keys (at most 100 each), whether the counters were corrected. Append-only; kept 13 months.';
CREATE INDEX storage_reconciliation_tenant_id_ran_at_idx ON platform.storage_reconciliation (tenant_id, ran_at DESC);
CREATE TRIGGER storage_reconciliation_append_only BEFORE UPDATE OR DELETE ON platform.storage_reconciliation FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

CREATE TABLE platform.document_legal_hold (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  document_id         uuid NOT NULL,
  document_kind       text NOT NULL,
  retention_policy_id uuid,
  retain_until        date,
  source_type         text,
  source_id           uuid,
  released_at         timestamptz(6),
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT document_legal_hold_pkey PRIMARY KEY (id),
  CONSTRAINT document_legal_hold_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT document_legal_hold_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT document_legal_hold_retention_policy_id_fkey FOREIGN KEY (retention_policy_id) REFERENCES platform.retention_policy (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT document_legal_hold_kind_check CHECK (length(document_kind) BETWEEN 1 AND 60)
);
COMMENT ON TABLE platform.document_legal_hold IS 'D-286: a document the law requires to keep (receipt, tax invoice, debit / credit note, signed lease, slip, deposit settlement, TM30 export) — counted in the quota and never deletable before retain_until (NULL = until the basis event, e.g. lease end, sets it). Periods from platform.retention_policy (⚖ O-025).';
CREATE UNIQUE INDEX document_legal_hold_document_id_key ON platform.document_legal_hold (document_id);
CREATE INDEX document_legal_hold_tenant_id_retain_until_idx ON platform.document_legal_hold (tenant_id, retain_until);
CREATE TRIGGER document_legal_hold_set_updated_at BEFORE UPDATE ON platform.document_legal_hold FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE OR REPLACE FUNCTION platform.document_legal_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage.legal_hold: the legal hold of document % is never deleted', OLD.document_id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'storage.legal_hold: the document of a legal hold is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until < OLD.retain_until) THEN
    RAISE EXCEPTION 'storage.legal_hold: the retention date of document % cannot be shortened', OLD.document_id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'storage.legal_hold: a released hold is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL
     AND (NEW.retain_until IS NULL OR NEW.retain_until > (now() AT TIME ZONE 'Asia/Bangkok')::date) THEN
    RAISE EXCEPTION 'storage.legal_hold: document % is held until %', OLD.document_id, coalesce(NEW.retain_until::text, 'its basis event') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_legal_hold_guard BEFORE UPDATE OR DELETE ON platform.document_legal_hold FOR EACH ROW EXECUTE FUNCTION platform.document_legal_hold_guard();

CREATE TABLE platform.storage_package (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  price_plan_version_id uuid NOT NULL,
  size_bytes            bigint NOT NULL,
  price                 numeric(14,2) NOT NULL,
  period                platform.storage_package_period NOT NULL,
  state                 platform.storage_package_state NOT NULL DEFAULT 'pending_payment',
  platform_invoice_id   uuid,
  starts_on             date,
  ends_on               date,
  auto_renew            boolean NOT NULL DEFAULT false,
  renewal_of_id         uuid,
  renewal_issued_at     timestamptz(6),
  activated_at          timestamptz(6),
  cancelled_at          timestamptz(6),
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT storage_package_pkey PRIMARY KEY (id),
  CONSTRAINT storage_package_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_package_price_plan_version_id_fkey FOREIGN KEY (price_plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_package_platform_invoice_id_fkey FOREIGN KEY (platform_invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_package_renewal_of_id_fkey FOREIGN KEY (renewal_of_id) REFERENCES platform.storage_package (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT storage_package_size_check CHECK (size_bytes > 0),
  CONSTRAINT storage_package_price_check CHECK (price >= 0),
  CONSTRAINT storage_package_active_check CHECK (state NOT IN ('active', 'expired') OR (starts_on IS NOT NULL AND ends_on IS NOT NULL AND ends_on >= starts_on AND activated_at IS NOT NULL)),
  CONSTRAINT storage_package_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
COMMENT ON TABLE platform.storage_package IS 'D-285: a storage package a tenant bought (size and price snapshotted from the price-plan add-on version); active once its purchase invoice is paid, raising the quota until ends_on; expiry never deletes data (D-276, D-286).';
CREATE INDEX storage_package_tenant_id_state_ends_on_idx ON platform.storage_package (tenant_id, state, ends_on);
CREATE INDEX storage_package_active_idx ON platform.storage_package (ends_on) WHERE state = 'active';
CREATE INDEX storage_package_platform_invoice_id_idx ON platform.storage_package (platform_invoice_id);
CREATE INDEX storage_package_price_plan_version_id_idx ON platform.storage_package (price_plan_version_id);
CREATE UNIQUE INDEX storage_package_renewal_of_id_key ON platform.storage_package (renewal_of_id) WHERE renewal_of_id IS NOT NULL AND state <> 'cancelled';
CREATE TRIGGER storage_package_set_updated_at BEFORE UPDATE ON platform.storage_package FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('platform.storage_usage', 'tenant');
SELECT platform.apply_rls('platform.document_storage', 'tenant');
SELECT platform.apply_rls('platform.storage_reconciliation', 'tenant');
SELECT platform.apply_rls('platform.document_legal_hold', 'tenant');
SELECT platform.apply_rls('platform.storage_package', 'tenant');
-- counters, ledger and holds are written in the tenant's own transactions (document writes) and by the platform
GRANT SELECT, INSERT, UPDATE ON platform.storage_usage, platform.document_storage, platform.document_legal_hold TO gp_app, gp_platform;
GRANT SELECT ON platform.storage_reconciliation, platform.storage_package TO gp_app;
GRANT SELECT, INSERT ON platform.storage_reconciliation TO gp_platform;
GRANT SELECT, INSERT, UPDATE ON platform.storage_package TO gp_platform;
GRANT SELECT ON platform.storage_usage, platform.document_storage, platform.document_legal_hold,
  platform.storage_reconciliation, platform.storage_package TO gp_reporting;

-- backfill: every live file is counted at its stored size (derivative sizes are learnt by the first reconciliation)
INSERT INTO platform.document_storage (document_id, tenant_id, category, bytes, objects, derivative_keys)
SELECT d.id, d.tenant_id,
       (CASE
          WHEN d.kind = 'listing_photo' THEN 'listing_media'
          WHEN d.kind IN ('pdf_invoice', 'pdf_receipt', 'pdf_tax_invoice', 'pdf_note', 'slip', 'signature')
            OR (d.kind = 'contract' AND d.upload_state = 'verified' AND d.scan_status = 'skipped') THEN 'system_legal'
          WHEN d.scan_status = 'skipped' THEN 'system_other'
          ELSE 'attachment'
        END)::platform.storage_category,
       d.size_bytes,
       1 + (CASE WHEN d.thumbnail_key IS NULL THEN 0 ELSE 1 END),
       CASE WHEN d.thumbnail_key IS NULL THEN '{}'::text[] ELSE ARRAY[d.thumbnail_key] END
  FROM core.document d
 WHERE d.tenant_id IS NOT NULL AND d.upload_state IN ('uploaded', 'verified');

INSERT INTO platform.storage_usage (tenant_id, category, bytes, objects)
SELECT tenant_id, category, sum(bytes), sum(objects)
  FROM platform.document_storage WHERE counted GROUP BY tenant_id, category;
