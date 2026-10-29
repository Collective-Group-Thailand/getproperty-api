-- getproperty-api 0059 — G2 (pack G module E5): agency mandates, co-broke agreements, deals and fee accruals
-- (D-284, D-287, D-293; schema-design §7.5 rows 149–155). Needs collective-asset-core 0.7.0 (tenant type `agency`,
-- grant reason `listing_mandate`, module key `ops.listing`, core.document.legal_hold / legal_hold_until).
--   * ops.listing_mandate: an owner (the tenant holding the unit, or the building's owner / operator) mandates an
--     agency tenant for one unit; backed by one unit-scope core.asset_access_grant (reason listing_mandate). Visible
--     to both tenants. At most one accepted / active exclusive mandate per unit (partial unique index; the service
--     also refuses any other mandate next to an exclusive one).
--   * ops.co_broke_agreement: the listing agency shares a listing with a co-agency at a split of its commission.
--   * ops.deal: a lease of a listed / mandated unit that closed through the platform (activated, e-signed, first
--     payment confirmed) — once per lease; commissions are recorded only, money moves outside (ADR-0008).
--   * ops.fee_accrual: success / co-broke fee owed by an agency per the price plan (invoiced by G5, never deducted
--     from rent — O-020 note).
--   * ops.listing.mandate_id: an agency's listing of a mandated unit (the agency owns the listing row, D-293).
--   * platform.document_legal_hold is mirrored into core.document.legal_hold / legal_hold_until (the asset-core 0.7.0
--     guard then refuses deleting a held document at the database, D-286).
--   * storage.free_gb / storage.price_per_gb_month learn the `agency` key (a new platform version when seeded).

CREATE TYPE ops.mandate_scope AS ENUM ('list', 'list_and_lease', 'manage');
CREATE TYPE ops.mandate_state AS ENUM ('invited', 'accepted', 'active', 'ended', 'revoked');
CREATE TYPE ops.co_broke_state AS ENUM ('proposed', 'signed', 'ended', 'cancelled');
CREATE TYPE ops.fee_accrual_kind AS ENUM ('success_fee', 'co_broke_fee');

CREATE TABLE ops.listing_mandate (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  owner_tenant_id    uuid NOT NULL,
  owner_party_id     uuid,
  unit_id            uuid NOT NULL,
  building_id        uuid NOT NULL,
  scope              ops.mandate_scope NOT NULL DEFAULT 'list',
  exclusive          boolean NOT NULL DEFAULT false,
  commission_terms   text,
  commission_percent numeric(7,4),
  commission_amount  numeric(14,2),
  valid_from         date NOT NULL,
  valid_to           date,
  state              ops.mandate_state NOT NULL DEFAULT 'invited',
  grant_id           uuid,
  accepted_at        timestamptz(6),
  accepted_by        uuid,
  activated_at       timestamptz(6),
  ended_at           timestamptz(6),
  revoked_at         timestamptz(6),
  revoked_by         uuid,
  end_reason         text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT listing_mandate_pkey PRIMARY KEY (id),
  CONSTRAINT listing_mandate_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_owner_tenant_id_fkey FOREIGN KEY (owner_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES core.asset_access_grant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_mandate_pair_check CHECK (tenant_id <> owner_tenant_id),
  CONSTRAINT listing_mandate_range_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT listing_mandate_terms_check CHECK (commission_terms IS NULL OR length(commission_terms) <= 2000),
  CONSTRAINT listing_mandate_percent_check CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)),
  CONSTRAINT listing_mandate_amount_check CHECK (commission_amount IS NULL OR commission_amount >= 0),
  CONSTRAINT listing_mandate_grant_check CHECK (state NOT IN ('accepted', 'active') OR grant_id IS NOT NULL),
  CONSTRAINT listing_mandate_end_reason_check CHECK (end_reason IS NULL OR length(end_reason) <= 500)
);
COMMENT ON TABLE ops.listing_mandate IS 'D-293 (G2): an owner mandates an agency tenant (tenant_id) to list / lease / manage one unit; backed by a unit-scope core.asset_access_grant (listing_mandate). Visible to the agency and the owner tenant.';
CREATE UNIQUE INDEX listing_mandate_exclusive_key ON ops.listing_mandate (unit_id) WHERE exclusive AND state IN ('accepted', 'active');
CREATE INDEX listing_mandate_owner_tenant_id_state_idx ON ops.listing_mandate (owner_tenant_id, state);
CREATE INDEX listing_mandate_tenant_id_state_idx ON ops.listing_mandate (tenant_id, state);
CREATE INDEX listing_mandate_unit_id_state_idx ON ops.listing_mandate (unit_id, state);
CREATE INDEX listing_mandate_grant_id_idx ON ops.listing_mandate (grant_id);
CREATE INDEX listing_mandate_building_id_idx ON ops.listing_mandate (building_id);
CREATE INDEX listing_mandate_owner_party_id_idx ON ops.listing_mandate (owner_party_id);
CREATE TRIGGER listing_mandate_set_updated_at BEFORE UPDATE ON ops.listing_mandate FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE ops.listing ADD COLUMN mandate_id uuid;
ALTER TABLE ops.listing ADD CONSTRAINT listing_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES ops.listing_mandate (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX listing_mandate_id_idx ON ops.listing (mandate_id);
COMMENT ON COLUMN ops.listing.mandate_id IS 'D-293: the mandate under which an agency lists another tenant''s unit (the agency owns the listing row).';

CREATE TABLE ops.co_broke_agreement (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  co_agency_tenant_id uuid NOT NULL,
  listing_id          uuid NOT NULL,
  unit_id             uuid NOT NULL,
  mandate_id          uuid,
  split_percent       numeric(7,4) NOT NULL,
  valid_from          date NOT NULL,
  valid_to            date,
  state               ops.co_broke_state NOT NULL DEFAULT 'proposed',
  note                text,
  signed_at           timestamptz(6),
  signed_by           uuid,
  ended_at            timestamptz(6),
  cancelled_at        timestamptz(6),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT co_broke_agreement_pkey PRIMARY KEY (id),
  CONSTRAINT co_broke_agreement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT co_broke_agreement_co_agency_tenant_id_fkey FOREIGN KEY (co_agency_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT co_broke_agreement_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT co_broke_agreement_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT co_broke_agreement_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES ops.listing_mandate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT co_broke_agreement_pair_check CHECK (tenant_id <> co_agency_tenant_id),
  CONSTRAINT co_broke_agreement_split_check CHECK (split_percent > 0 AND split_percent < 100),
  CONSTRAINT co_broke_agreement_range_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT co_broke_agreement_note_check CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT co_broke_agreement_signed_check CHECK (state NOT IN ('signed', 'ended') OR signed_at IS NOT NULL)
);
COMMENT ON TABLE ops.co_broke_agreement IS 'D-293 (G2): the listing agency (tenant_id) shares a listing with a co-agency at split_percent of its commission; signed by the co-agency (in-app acceptance; the G3 e-signed contract attaches later). Visible to both agencies.';
CREATE UNIQUE INDEX co_broke_agreement_live_key ON ops.co_broke_agreement (listing_id, co_agency_tenant_id) WHERE state IN ('proposed', 'signed');
CREATE INDEX co_broke_agreement_listing_id_idx ON ops.co_broke_agreement (listing_id);
CREATE INDEX co_broke_agreement_co_agency_tenant_id_state_idx ON ops.co_broke_agreement (co_agency_tenant_id, state);
CREATE INDEX co_broke_agreement_tenant_id_state_idx ON ops.co_broke_agreement (tenant_id, state);
CREATE INDEX co_broke_agreement_unit_id_idx ON ops.co_broke_agreement (unit_id);
CREATE INDEX co_broke_agreement_mandate_id_idx ON ops.co_broke_agreement (mandate_id);
CREATE TRIGGER co_broke_agreement_set_updated_at BEFORE UPDATE ON ops.co_broke_agreement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.deal (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  lease_id                 uuid NOT NULL,
  unit_id                  uuid NOT NULL,
  building_id              uuid NOT NULL,
  listing_id               uuid,
  mandate_id               uuid,
  co_broke_agreement_id    uuid,
  listing_agency_tenant_id uuid,
  co_agency_tenant_id      uuid,
  monthly_rent             numeric(14,2) NOT NULL,
  commission_amount        numeric(14,2),
  co_broke_amount          numeric(14,2),
  first_payment_id         uuid,
  closed_at                timestamptz(6) NOT NULL,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT deal_pkey PRIMARY KEY (id),
  CONSTRAINT deal_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES ops.listing_mandate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_co_broke_agreement_id_fkey FOREIGN KEY (co_broke_agreement_id) REFERENCES ops.co_broke_agreement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_listing_agency_tenant_id_fkey FOREIGN KEY (listing_agency_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_co_agency_tenant_id_fkey FOREIGN KEY (co_agency_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_first_payment_id_fkey FOREIGN KEY (first_payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deal_amounts_check CHECK ((commission_amount IS NULL OR commission_amount >= 0) AND (co_broke_amount IS NULL OR co_broke_amount >= 0))
);
COMMENT ON TABLE ops.deal IS 'D-293 (G2): a lease of a listed or mandated unit closed through the platform (activated, e-signed, first payment confirmed) — once per lease; commissions recorded, paid outside the platform (ADR-0008). Owner tenant + named agencies read.';
CREATE UNIQUE INDEX deal_lease_id_key ON ops.deal (lease_id);
CREATE INDEX deal_tenant_id_closed_at_idx ON ops.deal (tenant_id, closed_at DESC);
CREATE INDEX deal_listing_agency_tenant_id_idx ON ops.deal (listing_agency_tenant_id);
CREATE INDEX deal_co_agency_tenant_id_idx ON ops.deal (co_agency_tenant_id);
CREATE INDEX deal_listing_id_idx ON ops.deal (listing_id);
CREATE INDEX deal_mandate_id_idx ON ops.deal (mandate_id);
CREATE INDEX deal_co_broke_agreement_id_idx ON ops.deal (co_broke_agreement_id);
CREATE INDEX deal_unit_id_idx ON ops.deal (unit_id);
CREATE INDEX deal_building_id_idx ON ops.deal (building_id);
CREATE INDEX deal_first_payment_id_idx ON ops.deal (first_payment_id);
CREATE TRIGGER deal_append_only BEFORE UPDATE OR DELETE ON ops.deal FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

CREATE TABLE ops.fee_accrual (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  deal_id                  uuid NOT NULL,
  kind                     ops.fee_accrual_kind NOT NULL,
  price_plan_version_id    uuid NOT NULL,
  billing_unit             text NOT NULL,
  rate                     numeric(14,4) NOT NULL,
  base_amount              numeric(14,2),
  amount                   numeric(14,2) NOT NULL,
  capped                   boolean NOT NULL DEFAULT false,
  accrued_on               date NOT NULL,
  platform_invoice_line_id uuid,
  credit_note_id           uuid,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT fee_accrual_pkey PRIMARY KEY (id),
  CONSTRAINT fee_accrual_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fee_accrual_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES ops.deal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fee_accrual_price_plan_version_id_fkey FOREIGN KEY (price_plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fee_accrual_amount_check CHECK (amount >= 0 AND rate >= 0),
  CONSTRAINT fee_accrual_billing_unit_check CHECK (billing_unit IN ('percent_of_amount', 'per_deal'))
);
COMMENT ON TABLE ops.fee_accrual IS 'D-287 / D-293 (G2): a success or co-broke fee an agency (tenant_id) owes for a deal, priced by the published price-plan version of the close day; invoiced by G5 on a platform invoice (never deducted from rent, O-020 note). Append-only except the invoice / credit-note references.';
CREATE UNIQUE INDEX fee_accrual_deal_id_kind_tenant_id_key ON ops.fee_accrual (deal_id, kind, tenant_id);
CREATE INDEX fee_accrual_tenant_id_accrued_on_idx ON ops.fee_accrual (tenant_id, accrued_on);
CREATE INDEX fee_accrual_price_plan_version_id_idx ON ops.fee_accrual (price_plan_version_id);

CREATE OR REPLACE FUNCTION ops.fee_accrual_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (to_jsonb(OLD) - 'platform_invoice_line_id' - 'credit_note_id') <> (to_jsonb(NEW) - 'platform_invoice_line_id' - 'credit_note_id') THEN
    RAISE EXCEPTION 'core.append_only: ops.fee_accrual is append-only (% refused)', TG_OP USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fee_accrual_guard BEFORE UPDATE OR DELETE ON ops.fee_accrual FOR EACH ROW EXECUTE FUNCTION ops.fee_accrual_guard();

-- RLS: mandates and co-broke agreements are shared by their two tenants; deals are read by the owner tenant and the
-- agencies named on them and written by the worker (gp_platform); accruals belong to the payer agency.
ALTER TABLE ops.listing_mandate ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.listing_mandate FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_mandate_rls_pair ON ops.listing_mandate FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()) OR owner_tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR owner_tenant_id = (SELECT core.current_tenant_id()));
ALTER TABLE ops.co_broke_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.co_broke_agreement FORCE ROW LEVEL SECURITY;
CREATE POLICY co_broke_agreement_rls_pair ON ops.co_broke_agreement FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()) OR co_agency_tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR co_agency_tenant_id = (SELECT core.current_tenant_id()));
ALTER TABLE ops.deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.deal FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_rls_read ON ops.deal FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR listing_agency_tenant_id = (SELECT core.current_tenant_id())
         OR co_agency_tenant_id = (SELECT core.current_tenant_id()));
SELECT platform.apply_rls('ops.fee_accrual', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.listing_mandate, ops.co_broke_agreement TO gp_app, gp_platform;
GRANT SELECT ON ops.deal, ops.fee_accrual TO gp_app;
GRANT SELECT, INSERT ON ops.deal TO gp_platform;
GRANT SELECT, INSERT, UPDATE ON ops.fee_accrual TO gp_platform;
GRANT SELECT ON ops.listing_mandate, ops.co_broke_agreement, ops.deal, ops.fee_accrual TO gp_reporting;

-- Legal holds → core.document (asset-core 0.7.0 guard). retain_until is a Bangkok date: the hold ends at its start.
CREATE OR REPLACE FUNCTION platform.document_legal_hold_mirror() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE core.document
     SET legal_hold = (NEW.released_at IS NULL),
         legal_hold_until = CASE WHEN NEW.released_at IS NULL AND NEW.retain_until IS NOT NULL
                                 THEN (NEW.retain_until::timestamp AT TIME ZONE 'Asia/Bangkok') END
   WHERE id = NEW.document_id;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION platform.document_legal_hold_mirror() IS 'D-286 / G2: keeps core.document.legal_hold / legal_hold_until in step with the hold record (asset-core 0.7.0 refuses deleting a held document).';
CREATE TRIGGER document_legal_hold_mirror AFTER INSERT OR UPDATE OF retain_until, released_at ON platform.document_legal_hold
  FOR EACH ROW EXECUTE FUNCTION platform.document_legal_hold_mirror();

-- Data backfills run as gp_platform (BYPASSRLS; the migrating login is a member, asset-core 0001): under FORCE RLS
-- the owner login of a deployed database would see no rows here and may not write the platform catalogue.
SET ROLE gp_platform;
UPDATE core.document d
   SET legal_hold = (h.released_at IS NULL),
       legal_hold_until = CASE WHEN h.released_at IS NULL AND h.retain_until IS NOT NULL
                               THEN (h.retain_until::timestamp AT TIME ZONE 'Asia/Bangkok') END
  FROM platform.document_legal_hold h
 WHERE h.document_id = d.id;

-- storage settings per tenant type learn `agency` (D-284 / D-285: 5 GB free for every type, overage not sold); a
-- fresh database gets the value from the seed catalogue instead (no setting row exists yet here).
INSERT INTO platform.setting_version (setting_id, value, effective_from, reason)
SELECT v.setting_id, v.value || jsonb_build_object('agency', CASE WHEN s.key = 'storage.free_gb' THEN to_jsonb('5'::text) ELSE 'null'::jsonb END),
       now(), 'G2 (D-284, D-285): tenant type agency'
  FROM platform.setting s
  JOIN platform.setting_version v ON v.setting_id = s.id AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now())
 WHERE s.key IN ('storage.free_gb', 'storage.price_per_gb_month')
   AND jsonb_typeof(v.value) = 'object' AND NOT v.value ? 'agency';
RESET ROLE;
