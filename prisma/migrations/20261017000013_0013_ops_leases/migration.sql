-- getproperty-api 0013 — A1 leases: the สคบ. standard contract templates, leases, lease parties, fixed lease lines,
-- e-signatures and the lease history (B2.3; schema-design v2 §3.3.3, §7.3; D-020, D-023, D-062). Adds the FKs
-- that waited for ops.lease (platform.invitation.lease_id, ops.unit_detail.current_lease_id).

CREATE TYPE ops.lease_status AS ENUM ('draft', 'pending_signature', 'active', 'notice_given', 'ending', 'ended', 'terminated', 'cancelled');
CREATE TYPE ops.utility_billing_mode AS ENUM ('metered', 'included');
CREATE TYPE ops.notice_party AS ENUM ('lessee', 'lessor');
CREATE TYPE ops.lease_party_role AS ENUM ('lessee', 'co_tenant', 'guarantor', 'occupant');
CREATE TYPE ops.lease_line_kind AS ENUM ('internet', 'parking', 'cleaning', 'furniture', 'common_fee', 'water_minimum', 'other_fixed');
CREATE TYPE ops.line_recurrence AS ENUM ('monthly', 'once');
CREATE TYPE ops.signer_role AS ENUM ('lessee', 'co_tenant', 'lessor', 'witness');
CREATE TYPE ops.signature_method AS ENUM ('draw_liff', 'draw_web', 'scan_upload');

CREATE TABLE ops.lease_template (
  id         uuid NOT NULL DEFAULT uuidv7(),
  tenant_id  uuid,
  key        text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT lease_template_pkey PRIMARY KEY (id),
  CONSTRAINT lease_template_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_template_key_check CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$')
);
COMMENT ON TABLE ops.lease_template IS 'Contract templates; tenant_id NULL = the platform สคบ. 2568 standard residential contract (D-020).';
CREATE UNIQUE INDEX lease_template_tenant_id_key_key ON ops.lease_template (tenant_id, key) NULLS NOT DISTINCT;

CREATE TABLE ops.lease_template_version (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  template_id            uuid NOT NULL,
  tenant_id              uuid,
  version                integer NOT NULL,
  language               char(2) NOT NULL DEFAULT 'th',
  body_html              text NOT NULL,
  clause_schema          jsonb NOT NULL DEFAULT '{}',
  forbidden_clause_types text[] NOT NULL DEFAULT '{}',
  legal_ref              text NOT NULL,
  state                  platform.template_version_state NOT NULL DEFAULT 'draft',
  effective_from         date NOT NULL,
  published_by           uuid,
  published_at           timestamptz(6),
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT lease_template_version_pkey PRIMARY KEY (id),
  CONSTRAINT lease_template_version_template_id_fkey FOREIGN KEY (template_id) REFERENCES ops.lease_template (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT lease_template_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_template_version_version_check CHECK (version >= 1),
  CONSTRAINT lease_template_version_language_check CHECK (language ~ '^[a-z]{2}$'),
  CONSTRAINT lease_template_version_published_check CHECK (state = 'draft' OR published_at IS NOT NULL)
);
COMMENT ON TABLE ops.lease_template_version IS 'Versioned Handlebars contract text; published versions are immutable (a change = a new version).';
CREATE UNIQUE INDEX lease_template_version_template_id_language_version_key ON ops.lease_template_version (template_id, language, version);
CREATE INDEX lease_template_version_tenant_id_idx ON ops.lease_template_version (tenant_id);

CREATE TABLE ops.lease (
  id                                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                          uuid NOT NULL,
  building_id                        uuid NOT NULL,
  unit_id                            uuid NOT NULL,
  lessee_party_id                    uuid NOT NULL,
  template_version_id                uuid NOT NULL,
  number                             citext,
  status                             ops.lease_status NOT NULL DEFAULT 'draft',
  start_date                         date NOT NULL,
  end_date                           date NOT NULL,
  months                             smallint NOT NULL,
  move_in_at                         timestamptz(6),
  move_out_at                        timestamptz(6),
  rent                               numeric(14,2) NOT NULL,
  deposit_amount                     numeric(14,2) NOT NULL DEFAULT 0,
  advance_rent_amount                numeric(14,2) NOT NULL DEFAULT 0,
  advance_rent_months                numeric(3,1) NOT NULL DEFAULT 0,
  billing_day                        smallint,
  utility_billing_mode               ops.utility_billing_mode NOT NULL DEFAULT 'metered',
  power_rate_plan_id                 uuid,
  water_rate_plan_id                 uuid,
  keys_count                         smallint NOT NULL DEFAULT 0,
  parking_slots                      smallint NOT NULL DEFAULT 0,
  terms                              jsonb NOT NULL DEFAULT '{}',
  addendum                           jsonb,
  rent_increase_recorded             jsonb,
  sent_for_signature_at              timestamptz(6),
  activated_at                       timestamptz(6),
  notice_given_at                    timestamptz(6),
  notice_by                          ops.notice_party,
  notice_reason_code                 text,
  notice_effective_date              date,
  notice_evidence_document_ids       uuid[] NOT NULL DEFAULT '{}',
  ended_at                           timestamptz(6),
  terminated_at                      timestamptz(6),
  termination_reason_code            text,
  termination_notes                  text,
  termination_evidence_document_ids  uuid[] NOT NULL DEFAULT '{}',
  cancelled_at                       timestamptz(6),
  cancel_reason                      text,
  renewed_from_lease_id              uuid,
  contract_document_id               uuid,
  signed_document_id                 uuid,
  contract_sha256                    bytea,
  compliance_snapshot                jsonb NOT NULL DEFAULT '{}',
  created_at                         timestamptz(6) NOT NULL DEFAULT now(),
  created_by                         uuid,
  updated_at                         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                         uuid,
  version                            integer NOT NULL DEFAULT 1,
  CONSTRAINT lease_pkey PRIMARY KEY (id),
  CONSTRAINT lease_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_lessee_party_id_fkey FOREIGN KEY (lessee_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_template_version_id_fkey FOREIGN KEY (template_version_id) REFERENCES ops.lease_template_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewed_from_lease_id_fkey FOREIGN KEY (renewed_from_lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_contract_document_id_fkey FOREIGN KEY (contract_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signed_document_id_fkey FOREIGN KEY (signed_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_dates_check CHECK (end_date >= start_date),
  CONSTRAINT lease_months_check CHECK (months BETWEEN 1 AND 360),
  CONSTRAINT lease_money_check CHECK (rent > 0 AND deposit_amount >= 0 AND advance_rent_amount >= 0
                                      AND rent = round(rent, 2) AND deposit_amount = round(deposit_amount, 2)
                                      AND advance_rent_amount = round(advance_rent_amount, 2)),
  CONSTRAINT lease_billing_day_check CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 28),
  CONSTRAINT lease_counts_check CHECK (keys_count >= 0 AND parking_slots >= 0),
  CONSTRAINT lease_number_check CHECK (status IN ('draft', 'cancelled') OR number IS NOT NULL),
  CONSTRAINT lease_notice_check CHECK ((notice_given_at IS NULL) = (notice_by IS NULL)),
  CONSTRAINT lease_sha_check CHECK (contract_sha256 IS NULL OR length(contract_sha256) = 32),
  CONSTRAINT lease_no_overlap EXCLUDE USING gist (unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('active', 'notice_given', 'ending'))
);
COMMENT ON TABLE ops.lease IS 'A rental contract on a unit (D-020). Immutable after it is sent for signature, except lifecycle columns; no two active leases overlap on one unit (exclusion constraint).';
COMMENT ON COLUMN ops.lease.rent_increase_recorded IS 'Rent changes agreed at signing ([{effectiveFrom, rent}]); the only lawful mid-term increase (D-020, compliance.no_midterm_increase).';
CREATE UNIQUE INDEX lease_tenant_id_number_key ON ops.lease (tenant_id, number);
CREATE INDEX lease_tenant_id_building_id_status_idx ON ops.lease (tenant_id, building_id, status);
CREATE INDEX lease_unit_id_status_idx ON ops.lease (unit_id, status);
CREATE INDEX lease_lessee_party_id_idx ON ops.lease (lessee_party_id);
CREATE INDEX lease_tenant_id_end_date_idx ON ops.lease (tenant_id, end_date) WHERE (status IN ('active', 'notice_given', 'ending'));
CREATE INDEX lease_renewed_from_lease_id_idx ON ops.lease (renewed_from_lease_id);

CREATE TABLE ops.lease_party (
  id         uuid NOT NULL DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  lease_id   uuid NOT NULL,
  party_id   uuid NOT NULL,
  role       ops.lease_party_role NOT NULL,
  is_signer  boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT lease_party_pkey PRIMARY KEY (id),
  CONSTRAINT lease_party_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_party_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT lease_party_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_party_signer_check CHECK (NOT is_signer OR role IN ('lessee', 'co_tenant'))
);
CREATE UNIQUE INDEX lease_party_lease_id_party_id_key ON ops.lease_party (lease_id, party_id);
CREATE INDEX lease_party_party_id_idx ON ops.lease_party (party_id);

CREATE TABLE ops.lease_line (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  lease_id       uuid NOT NULL,
  kind           ops.lease_line_kind NOT NULL,
  description    text NOT NULL,
  amount         numeric(14,2) NOT NULL,
  recurrence     ops.line_recurrence NOT NULL DEFAULT 'monthly',
  effective_from date NOT NULL,
  effective_to   date,
  sort_order     smallint NOT NULL DEFAULT 0,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT lease_line_pkey PRIMARY KEY (id),
  CONSTRAINT lease_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_line_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT lease_line_amount_check CHECK (amount >= 0 AND amount = round(amount, 2)),
  CONSTRAINT lease_line_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
COMMENT ON TABLE ops.lease_line IS 'Fixed monthly (or one-off) items agreed in the lease (D-041); utilities are never fixed lines (D-022).';
CREATE INDEX lease_line_lease_id_idx ON ops.lease_line (lease_id);

CREATE TABLE ops.lease_signature (
  id                          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL,
  lease_id                    uuid NOT NULL,
  signer_role                 ops.signer_role NOT NULL,
  party_id                    uuid,
  user_id                     uuid,
  method                      ops.signature_method NOT NULL,
  otp_challenge_id            uuid,
  line_user_id                text,
  signature_image_document_id uuid NOT NULL,
  signed_pdf_document_id      uuid,
  pdf_sha256                  bytea NOT NULL,
  signed_at                   timestamptz(6) NOT NULL,
  ip                          inet,
  user_agent                  text,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                  uuid,
  CONSTRAINT lease_signature_pkey PRIMARY KEY (id),
  CONSTRAINT lease_signature_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_otp_challenge_id_fkey FOREIGN KEY (otp_challenge_id) REFERENCES platform.otp_challenge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_image_fkey FOREIGN KEY (signature_image_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_pdf_fkey FOREIGN KEY (signed_pdf_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_signature_sha_check CHECK (length(pdf_sha256) = 32),
  CONSTRAINT lease_signature_signer_check CHECK (party_id IS NOT NULL OR user_id IS NOT NULL),
  CONSTRAINT lease_signature_resident_check CHECK (signer_role = 'lessor' OR method <> 'draw_liff' OR (otp_challenge_id IS NOT NULL AND party_id IS NOT NULL))
);
COMMENT ON TABLE ops.lease_signature IS 'E-signature evidence (D-062): signer, OTP challenge, LINE user id, drawn signature image, sha256 of the PDF signed, time, IP, user agent.';
CREATE UNIQUE INDEX lease_signature_lease_id_signer_role_party_id_user_id_key ON ops.lease_signature (lease_id, signer_role, party_id, user_id) NULLS NOT DISTINCT;
CREATE INDEX lease_signature_tenant_id_idx ON ops.lease_signature (tenant_id);

CREATE TABLE ops.lease_event (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  lease_id        uuid NOT NULL,
  type            text NOT NULL,
  occurred_at     timestamptz(6) NOT NULL DEFAULT now(),
  actor           jsonb NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  domain_event_id uuid,
  CONSTRAINT lease_event_pkey PRIMARY KEY (id),
  CONSTRAINT lease_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_event_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_event_type_check CHECK (type ~ '^[a-z][a-z_]*$')
);
COMMENT ON TABLE ops.lease_event IS 'Append-only lease history (drafted, sent, signed, countersigned, activated, notice, move-out, ended …).';
CREATE INDEX lease_event_lease_id_occurred_at_idx ON ops.lease_event (lease_id, occurred_at);
CREATE INDEX lease_event_tenant_id_idx ON ops.lease_event (tenant_id);

-- Forward references of earlier deliverables (§7.3).
ALTER TABLE platform.invitation
  ADD CONSTRAINT invitation_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE platform.invitation VALIDATE CONSTRAINT invitation_lease_id_fkey;
ALTER TABLE ops.unit_detail
  ADD CONSTRAINT unit_detail_current_lease_id_fkey FOREIGN KEY (current_lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.unit_detail VALIDATE CONSTRAINT unit_detail_current_lease_id_fkey;
CREATE INDEX unit_detail_current_lease_id_idx ON ops.unit_detail (current_lease_id);

CREATE TRIGGER lease_template_set_updated_at BEFORE UPDATE ON ops.lease_template FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_template_version_set_updated_at BEFORE UPDATE ON ops.lease_template_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_set_updated_at BEFORE UPDATE ON ops.lease FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_party_set_updated_at BEFORE UPDATE ON ops.lease_party FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_line_set_updated_at BEFORE UPDATE ON ops.lease_line FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_signature_set_updated_at BEFORE UPDATE ON ops.lease_signature FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER lease_event_append_only BEFORE UPDATE OR DELETE ON ops.lease_event FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER lease_event_no_truncate BEFORE TRUNCATE ON ops.lease_event FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();

-- Published template versions are immutable except their retirement (§4.1: a change is a new version).
CREATE OR REPLACE FUNCTION ops.lease_template_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.state = 'published' AND NOT (NEW.state = 'retired'
       AND (to_jsonb(NEW) - 'state' - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'state' - 'updated_at' - 'updated_by')) THEN
    RAISE EXCEPTION 'core.append_only: a published lease template version cannot change (create a new version)' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state = 'retired' THEN
    RAISE EXCEPTION 'core.append_only: a retired lease template version cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lease_template_version_guard BEFORE UPDATE ON ops.lease_template_version FOR EACH ROW EXECUTE FUNCTION ops.lease_template_version_guard();

-- Row-level security (schema-design §4.5).
SELECT platform.apply_rls('ops.lease_template', 'tenant_or_shared');
SELECT platform.apply_rls('ops.lease_template_version', 'tenant_or_shared');
SELECT platform.apply_rls('ops.lease', 'unit', 'ops.lease');
-- Children of a lease inherit its visibility ("via lease"); writes stay with the lease's tenant.
DO $children$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lease_party', 'lease_line', 'lease_signature', 'lease_event'] LOOP
    EXECUTE format('SELECT platform.apply_rls(%L, %L)', 'ops.' || t, 'platform_only');
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR SELECT USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.lease l WHERE l.id = lease_id))',
                   t || '_rls_read', t);
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR ALL USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()))',
                   t || '_rls_write', t);
  END LOOP;
END
$children$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.lease_template, ops.lease_template_version, ops.lease, ops.lease_party,
  ops.lease_line, ops.lease_signature, ops.lease_event TO gp_app, gp_platform;
GRANT SELECT ON ops.lease_template, ops.lease_template_version, ops.lease, ops.lease_party, ops.lease_line,
  ops.lease_signature, ops.lease_event TO gp_reporting;
-- Templates are platform content: the app reads them; tenant templates are written by the tenant (RLS).
GRANT EXECUTE ON FUNCTION ops.lease_template_version_guard() TO gp_app, gp_platform;
