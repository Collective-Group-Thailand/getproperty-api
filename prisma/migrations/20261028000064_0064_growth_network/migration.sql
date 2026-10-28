-- getproperty-api 0064 — getbuild rental handoff, employer housing, relocation network (pack G step G8, modules E9–E11;
-- D-289 (2) (4) (5), D-299). schema-design §7.5 rows 181–188.
--   * ops.rental_handoff: a getbuild buyer with rental intent (`unit.transferred`, asset-core contract) invited to the
--     landlord tier — once per transfer; platform-only until a landlord tenant claims it (tenant_id NULL before).
--   * ops.listing.campaign_tag: the developer campaign a handed-off listing came from.
--   * ops.employer_agreement / ops.employer_worker + ops.lease.employer_agreement_id / payer_party_id: an employer pays
--     the leases of its workers (worker / employer housing B2B); statements and payroll-deduction exports.
--   * ops.relocation_offer: listings in a leaving resident's destination area — only with consent `resident.relocation`
--     (PDPA); platform-only (the landlord never sees where the resident moves).
-- No core.* change (asset-core 0.7.0 already carries `unit.transferred` with `rentalIntent`).

CREATE TYPE ops.rental_handoff_state AS ENUM ('invited', 'accepted', 'listed', 'declined', 'expired');
CREATE TYPE ops.employer_split_rule AS ENUM ('per_occupant', 'per_unit');
CREATE TYPE ops.employer_agreement_state AS ENUM ('active', 'ended');
CREATE TYPE ops.relocation_offer_state AS ENUM ('open', 'dismissed', 'withdrawn', 'closed');
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'payroll_deduction';

-- getbuild rental handoff ----------------------------------------------------------------------------------------------
CREATE TABLE ops.rental_handoff (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid,
  integration_event_id uuid NOT NULL,
  developer_ref        text NOT NULL,
  building_ref         text NOT NULL,
  unit_ref             text NOT NULL,
  transfer_date        date NOT NULL,
  buyer_ref            text NOT NULL,
  buyer_display_name   text NOT NULL,
  buyer_language       char(2),
  buyer_line_hash      bytea,
  campaign_tag         text NOT NULL,
  facts                jsonb NOT NULL DEFAULT '{}',
  state                ops.rental_handoff_state NOT NULL DEFAULT 'invited',
  token_hash           bytea,
  delivered_at         timestamptz(6),
  delivery_attempts    smallint NOT NULL DEFAULT 0,
  last_delivery_error  text,
  expires_at           timestamptz(6) NOT NULL,
  unit_id              uuid,
  listing_id           uuid,
  claimed_by           uuid,
  accepted_at          timestamptz(6),
  listed_at            timestamptz(6),
  declined_at          timestamptz(6),
  expired_at           timestamptz(6),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT rental_handoff_pkey PRIMARY KEY (id),
  CONSTRAINT rental_handoff_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rental_handoff_integration_event_id_fkey FOREIGN KEY (integration_event_id) REFERENCES bridge.integration_event (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rental_handoff_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rental_handoff_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT rental_handoff_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rental_handoff_refs_check CHECK (length(developer_ref) BETWEEN 1 AND 100 AND length(building_ref) BETWEEN 1 AND 100 AND length(unit_ref) BETWEEN 1 AND 100 AND length(buyer_ref) BETWEEN 1 AND 100),
  CONSTRAINT rental_handoff_name_check CHECK (length(buyer_display_name) BETWEEN 1 AND 300),
  CONSTRAINT rental_handoff_campaign_tag_check CHECK (length(campaign_tag) BETWEEN 1 AND 100),
  CONSTRAINT rental_handoff_line_hash_check CHECK (buyer_line_hash IS NULL OR length(buyer_line_hash) = 32),
  CONSTRAINT rental_handoff_token_hash_check CHECK (token_hash IS NULL OR length(token_hash) = 32),
  CONSTRAINT rental_handoff_delivered_check CHECK (delivered_at IS NULL OR token_hash IS NOT NULL),
  CONSTRAINT rental_handoff_error_check CHECK (last_delivery_error IS NULL OR length(last_delivery_error) <= 500),
  CONSTRAINT rental_handoff_claimed_check CHECK ((state IN ('accepted', 'listed')) = (tenant_id IS NOT NULL AND unit_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT rental_handoff_listed_check CHECK ((state = 'listed') = (listed_at IS NOT NULL)),
  CONSTRAINT rental_handoff_declined_check CHECK ((state = 'declined') = (declined_at IS NOT NULL)),
  CONSTRAINT rental_handoff_expired_check CHECK ((state = 'expired') = (expired_at IS NOT NULL))
);
COMMENT ON TABLE ops.rental_handoff IS 'D-289 (5) / D-299 (G8): a getbuild buyer with rental intent invited to the landlord tier — once per transfer (UQ event and developer × unit × transfer date); platform-only until a landlord tenant claims it; the invitation token is single-use (sha256 only); buyer phone / e-mail are not stored (minimisation).';
CREATE UNIQUE INDEX rental_handoff_integration_event_id_key ON ops.rental_handoff (integration_event_id);
CREATE UNIQUE INDEX rental_handoff_transfer_key ON ops.rental_handoff (developer_ref, unit_ref, transfer_date);
CREATE UNIQUE INDEX rental_handoff_token_hash_key ON ops.rental_handoff (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX rental_handoff_state_idx ON ops.rental_handoff (state, expires_at);
CREATE INDEX rental_handoff_tenant_id_idx ON ops.rental_handoff (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX rental_handoff_unit_id_idx ON ops.rental_handoff (unit_id);
CREATE INDEX rental_handoff_listing_id_idx ON ops.rental_handoff (listing_id);
CREATE INDEX rental_handoff_claimed_by_idx ON ops.rental_handoff (claimed_by);
CREATE TRIGGER rental_handoff_set_updated_at BEFORE UPDATE ON ops.rental_handoff FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.rental_handoff', 'tenant');
GRANT SELECT ON ops.rental_handoff TO gp_app;
GRANT SELECT, INSERT, UPDATE ON ops.rental_handoff TO gp_platform;
GRANT SELECT ON ops.rental_handoff TO gp_reporting;

ALTER TABLE ops.listing ADD COLUMN campaign_tag text,
  ADD CONSTRAINT listing_campaign_tag_check CHECK (campaign_tag IS NULL OR length(campaign_tag) BETWEEN 1 AND 100);
COMMENT ON COLUMN ops.listing.campaign_tag IS 'D-299 (G8): the developer campaign of a getbuild rental handoff the listing was drafted from.';

-- Employer housing -----------------------------------------------------------------------------------------------------
CREATE TABLE ops.employer_agreement (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  employer_party_id     uuid NOT NULL,
  building_id           uuid,
  reference             text,
  split_rule            ops.employer_split_rule NOT NULL DEFAULT 'per_occupant',
  deduct_percent        numeric(5,2) NOT NULL DEFAULT 100,
  payroll_export_format text NOT NULL DEFAULT 'generic_csv',
  valid_from            date NOT NULL,
  valid_to              date,
  state                 ops.employer_agreement_state NOT NULL DEFAULT 'active',
  ended_at              timestamptz(6),
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT employer_agreement_pkey PRIMARY KEY (id),
  CONSTRAINT employer_agreement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT employer_agreement_employer_party_id_fkey FOREIGN KEY (employer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT employer_agreement_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT employer_agreement_reference_check CHECK (reference IS NULL OR length(reference) <= 100),
  CONSTRAINT employer_agreement_deduct_percent_check CHECK (deduct_percent >= 0 AND deduct_percent <= 100),
  CONSTRAINT employer_agreement_format_check CHECK (payroll_export_format IN ('generic_csv')),
  CONSTRAINT employer_agreement_dates_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employer_agreement_ended_check CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);
COMMENT ON TABLE ops.employer_agreement IS 'D-289 (4) / D-299 (G8): an employer pays the leases of its workers — invoices addressed to the employer party, statement split per occupant / per unit, payroll-deduction export (deduct_percent of each worker''s share).';
CREATE INDEX employer_agreement_tenant_id_state_idx ON ops.employer_agreement (tenant_id, state);
CREATE INDEX employer_agreement_employer_party_id_idx ON ops.employer_agreement (employer_party_id);
CREATE INDEX employer_agreement_building_id_idx ON ops.employer_agreement (building_id);
CREATE TRIGGER employer_agreement_set_updated_at BEFORE UPDATE ON ops.employer_agreement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.employer_agreement', 'tenant');

CREATE TABLE ops.employer_worker (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  agreement_id uuid NOT NULL,
  party_id     uuid NOT NULL,
  employee_no  text NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT employer_worker_pkey PRIMARY KEY (id),
  CONSTRAINT employer_worker_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT employer_worker_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES ops.employer_agreement (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT employer_worker_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT employer_worker_employee_no_check CHECK (length(employee_no) BETWEEN 1 AND 50)
);
COMMENT ON TABLE ops.employer_worker IS 'D-299 (G8): the employer''s payroll number of a worker (party) under an employer agreement — used by the payroll-deduction export.';
CREATE UNIQUE INDEX employer_worker_agreement_id_party_id_key ON ops.employer_worker (agreement_id, party_id);
CREATE INDEX employer_worker_tenant_id_idx ON ops.employer_worker (tenant_id);
CREATE INDEX employer_worker_party_id_idx ON ops.employer_worker (party_id);
CREATE TRIGGER employer_worker_set_updated_at BEFORE UPDATE ON ops.employer_worker FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.employer_worker', 'tenant');

GRANT SELECT, INSERT, UPDATE ON ops.employer_agreement TO gp_app, gp_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.employer_worker TO gp_app, gp_platform;
GRANT SELECT ON ops.employer_agreement, ops.employer_worker TO gp_reporting;

ALTER TABLE ops.lease
  ADD COLUMN employer_agreement_id uuid,
  ADD COLUMN payer_party_id uuid,
  ADD CONSTRAINT lease_employer_agreement_id_fkey FOREIGN KEY (employer_agreement_id) REFERENCES ops.employer_agreement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT lease_payer_party_id_fkey FOREIGN KEY (payer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT lease_payer_check CHECK ((employer_agreement_id IS NULL) = (payer_party_id IS NULL));
COMMENT ON COLUMN ops.lease.payer_party_id IS 'D-299 (G8): the party the lease''s invoices are addressed to (the employer of an employer agreement); NULL = the lessee.';
CREATE INDEX lease_employer_agreement_id_idx ON ops.lease (employer_agreement_id) WHERE employer_agreement_id IS NOT NULL;
CREATE INDEX lease_payer_party_id_idx ON ops.lease (payer_party_id) WHERE payer_party_id IS NOT NULL;

-- Relocation network ---------------------------------------------------------------------------------------------------
CREATE TABLE ops.relocation_offer (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  lease_id            uuid NOT NULL,
  user_id             uuid NOT NULL,
  consent_id          uuid NOT NULL,
  move_out_date       date,
  area_slug           text,
  province            text,
  district            text,
  max_rent            numeric(14,2),
  state               ops.relocation_offer_state NOT NULL DEFAULT 'open',
  clicked_listing_ids uuid[] NOT NULL DEFAULT '{}',
  notified_at         timestamptz(6),
  closed_at           timestamptz(6),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT relocation_offer_pkey PRIMARY KEY (id),
  CONSTRAINT relocation_offer_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT relocation_offer_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT relocation_offer_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT relocation_offer_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES platform.consent (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT relocation_offer_area_check CHECK (area_slug IS NULL OR length(area_slug) BETWEEN 1 AND 100),
  CONSTRAINT relocation_offer_place_check CHECK ((province IS NULL OR length(province) BETWEEN 1 AND 100) AND (district IS NULL OR (province IS NOT NULL AND length(district) BETWEEN 1 AND 100))),
  CONSTRAINT relocation_offer_max_rent_check CHECK (max_rent IS NULL OR max_rent > 0),
  CONSTRAINT relocation_offer_clicks_check CHECK (cardinality(clicked_listing_ids) <= 50),
  CONSTRAINT relocation_offer_withdrawn_check CHECK (state <> 'withdrawn' OR (area_slug IS NULL AND province IS NULL AND district IS NULL AND max_rent IS NULL)),
  CONSTRAINT relocation_offer_closed_check CHECK ((state = 'open') = (closed_at IS NULL))
);
COMMENT ON TABLE ops.relocation_offer IS 'D-289 (2) / D-299 (G8): listings in the destination of a resident under notice — created only with consent resident.relocation, erased on withdrawal; platform-only (the landlord never sees it).';
CREATE UNIQUE INDEX relocation_offer_lease_id_user_id_key ON ops.relocation_offer (lease_id, user_id);
CREATE INDEX relocation_offer_user_id_state_idx ON ops.relocation_offer (user_id, state);
CREATE INDEX relocation_offer_tenant_id_idx ON ops.relocation_offer (tenant_id);
CREATE INDEX relocation_offer_consent_id_idx ON ops.relocation_offer (consent_id);
CREATE TRIGGER relocation_offer_set_updated_at BEFORE UPDATE ON ops.relocation_offer FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.relocation_offer', 'platform_only');
GRANT SELECT, INSERT, UPDATE ON ops.relocation_offer TO gp_platform;
GRANT SELECT ON ops.relocation_offer TO gp_reporting;
