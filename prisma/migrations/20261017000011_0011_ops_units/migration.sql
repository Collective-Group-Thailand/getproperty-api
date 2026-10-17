-- getproperty-api 0011 — A1 units: unit profiles (room types), the operational 1:1 extension of core.unit and the
-- building's utility accounts (B2.1; schema-design v2 §3.3.2, §7.3). Requires @collective/asset-core >= 0.3.0.
-- Forward references (inspection templates B2.4, leases B2.3) are nullable columns without FK until their
-- deliverable adds the constraint (§7.3).

CREATE TABLE ops.unit_profile (
  id                          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL,
  building_id                 uuid NOT NULL,
  name                        text NOT NULL,
  area_sqm                    numeric(9,2),
  default_rent                numeric(14,2) NOT NULL,
  default_deposit_months      numeric(3,1) NOT NULL DEFAULT 1,
  default_advance_rent_months numeric(3,1) NOT NULL DEFAULT 1,
  default_lease_lines         jsonb NOT NULL DEFAULT '[]',
  inspection_template_id      uuid,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                  uuid,
  deleted_at                  timestamptz(6),
  deleted_by                  uuid,
  version                     integer NOT NULL DEFAULT 1,
  CONSTRAINT unit_profile_pkey PRIMARY KEY (id),
  CONSTRAINT unit_profile_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_profile_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_profile_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT unit_profile_area_check CHECK (area_sqm IS NULL OR area_sqm > 0),
  CONSTRAINT unit_profile_rent_check CHECK (default_rent >= 0 AND default_rent = round(default_rent, 2)),
  CONSTRAINT unit_profile_months_check CHECK (default_deposit_months >= 0 AND default_advance_rent_months >= 0),
  CONSTRAINT unit_profile_lines_check CHECK (jsonb_typeof(default_lease_lines) = 'array'),
  CONSTRAINT unit_profile_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.unit_profile IS 'Room types (v1): defaults for a group of units — size, rent, deposit/advance months, lease lines, inspection template (B2.1).';
COMMENT ON COLUMN ops.unit_profile.default_advance_rent_months IS 'Months of advance rent proposed on new leases; deposit + advance is capped by compliance.deposit_cap (D-023).';
CREATE UNIQUE INDEX unit_profile_building_id_name_key ON ops.unit_profile (building_id, name) WHERE (deleted_at IS NULL);
CREATE INDEX unit_profile_tenant_id_building_id_idx ON ops.unit_profile (tenant_id, building_id);

CREATE TABLE ops.unit_detail (
  unit_id          uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  unit_profile_id  uuid,
  current_lease_id uuid,
  status_reason    text,
  notes            text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT unit_detail_pkey PRIMARY KEY (unit_id),
  CONSTRAINT unit_detail_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_detail_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_detail_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_detail_unit_profile_id_fkey FOREIGN KEY (unit_profile_id) REFERENCES ops.unit_profile (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT unit_detail_status_reason_check CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  CONSTRAINT unit_detail_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.unit_detail IS '1:1 operational extension of core.unit (getproperty-only columns): profile, current lease (FK in B2.3), reason of the last manual status change.';
CREATE INDEX unit_detail_tenant_id_building_id_idx ON ops.unit_detail (tenant_id, building_id);
CREATE INDEX unit_detail_unit_profile_id_idx ON ops.unit_detail (unit_profile_id);

CREATE TABLE ops.utility_account (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  building_id uuid NOT NULL,
  utility     core.utility NOT NULL,
  provider    platform.utility_provider NOT NULL,
  customer_no text NOT NULL,
  meter_no    text,
  label       text NOT NULL,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT utility_account_pkey PRIMARY KEY (id),
  CONSTRAINT utility_account_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_account_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_account_provider_check CHECK ((utility = 'electric' AND provider IN ('mea', 'pea')) OR (utility = 'water' AND provider IN ('mwa', 'pwa'))),
  CONSTRAINT utility_account_customer_no_check CHECK (customer_no ~ '^[0-9A-Za-z-]{4,30}$'),
  CONSTRAINT utility_account_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 100)
);
COMMENT ON TABLE ops.utility_account IS 'The building''s customer accounts with MEA/PEA/MWA/PWA; utility invoices (B3.4) attach to them for the loss report (D-032).';
CREATE UNIQUE INDEX utility_account_building_id_utility_customer_no_key ON ops.utility_account (building_id, utility, customer_no);
CREATE INDEX utility_account_tenant_id_building_id_idx ON ops.utility_account (tenant_id, building_id);

CREATE TRIGGER unit_profile_set_updated_at BEFORE UPDATE ON ops.unit_profile FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER unit_detail_set_updated_at BEFORE UPDATE ON ops.unit_detail FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER utility_account_set_updated_at BEFORE UPDATE ON ops.utility_account FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Row-level security (schema-design §4.5): profiles are asset data, unit details follow lease visibility (a
-- landlord with a unit grant for ops.lease sees its unit's detail), utility accounts are billing data.
SELECT platform.apply_rls('ops.unit_profile', 'building', 'core.asset');
SELECT platform.apply_rls('ops.unit_detail', 'unit', 'ops.lease');
SELECT platform.apply_rls('ops.utility_account', 'building', 'ops.billing');

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.unit_profile, ops.unit_detail, ops.utility_account TO gp_app, gp_platform;
GRANT SELECT ON ops.unit_profile, ops.unit_detail, ops.utility_account TO gp_reporting;
