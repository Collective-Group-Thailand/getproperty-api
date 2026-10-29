-- getproperty-api 0060 — G3 (pack G module E14): contract library, signable documents and renewal offers
-- (D-290, D-294; schema-design §7.5 rows 156–164). Legal review of every draft stays open (O-025, O-030).
--   * ops.lease_template.kind / lease_template_version legal-review columns + derived_from_version_id: the library
--     is the existing template store; published versions stay immutable except retirement and their legal-review
--     columns (counsel signs a published text off without a new version).
--   * ops.contract_document + ops.contract_signature: e-signed documents of the non-lease kinds (reservation,
--     brokerage mandate, co-broke, addendum); leases keep ops.lease / ops.lease_signature.
--   * ops.lease_renewal_offer: the renewal workflow on top of the B7.5 `renewal_offer` letter.
--   * ops.lease.renewal_reminded_days, ops.co_broke_agreement / ops.listing_mandate.contract_document_id,
--     platform.otp_purpose `contract_signature`.

ALTER TYPE platform.otp_purpose ADD VALUE IF NOT EXISTS 'contract_signature';

CREATE TYPE ops.contract_kind AS ENUM ('lease_apartment_ocpb', 'lease_condo_private', 'lease_house', 'lease_room',
  'reservation', 'brokerage_mandate', 'co_broke', 'addendum', 'notice_termination', 'notice_renewal');
CREATE TYPE ops.legal_review_state AS ENUM ('pending_legal_verification', 'reviewed');
CREATE TYPE ops.contract_document_state AS ENUM ('draft', 'pending_signature', 'signed', 'cancelled');
CREATE TYPE ops.contract_signer_role AS ENUM ('lessor', 'lessee', 'co_tenant', 'prospect', 'owner', 'agency', 'co_agency');
CREATE TYPE ops.renewal_offer_state AS ENUM ('offered', 'accepted', 'declined', 'expired', 'withdrawn');
CREATE TYPE ops.renewal_rent_source AS ENUM ('benchmark', 'comparables', 'current_rent');

-- Library columns ------------------------------------------------------------------------------------------------
ALTER TABLE ops.lease_template ADD COLUMN kind ops.contract_kind NOT NULL DEFAULT 'lease_apartment_ocpb';
-- Platform templates (tenant_id NULL) are not writable through RLS: run as gp_platform (BYPASSRLS), as in 0059.
SET ROLE gp_platform;
UPDATE ops.lease_template SET kind = 'lease_condo_private' WHERE tenant_id IS NULL AND key = 'landlord_condo_unit';
UPDATE ops.lease_template SET kind = 'lease_house' WHERE tenant_id IS NULL AND key = 'landlord_house';
UPDATE ops.lease_template SET kind = 'lease_room' WHERE tenant_id IS NULL AND key = 'landlord_room';
RESET ROLE;
CREATE INDEX lease_template_kind_idx ON ops.lease_template (kind);
COMMENT ON COLUMN ops.lease_template.kind IS 'D-290 / D-294: contract library kind (lease kinds sign through ops.lease, others through ops.contract_document, notices are B7.5 letters).';

ALTER TABLE ops.lease_template_version
  ADD COLUMN legal_review_state ops.legal_review_state NOT NULL DEFAULT 'pending_legal_verification',
  ADD COLUMN legal_reviewed_at timestamptz(6),
  ADD COLUMN legal_reviewed_by uuid,
  ADD COLUMN legal_review_note text,
  ADD COLUMN derived_from_version_id uuid,
  ADD CONSTRAINT lease_template_version_derived_from_fkey FOREIGN KEY (derived_from_version_id) REFERENCES ops.lease_template_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT lease_template_version_legal_reviewed_by_fkey FOREIGN KEY (legal_reviewed_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT lease_template_version_review_check CHECK (legal_review_state = 'pending_legal_verification' OR legal_reviewed_at IS NOT NULL),
  ADD CONSTRAINT lease_template_version_review_note_check CHECK (legal_review_note IS NULL OR length(legal_review_note) <= 1000);
CREATE INDEX lease_template_version_derived_from_version_id_idx ON ops.lease_template_version (derived_from_version_id);
CREATE INDEX lease_template_version_legal_reviewed_by_idx ON ops.lease_template_version (legal_reviewed_by);
COMMENT ON COLUMN ops.lease_template_version.legal_review_state IS 'O-025 / D-294: every draft is pending legal verification until counsel signs this version off; never shown as lawyer-approved before.';

-- Published versions are immutable except their retirement and their legal-review columns (D-294).
CREATE OR REPLACE FUNCTION ops.lease_template_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  meta constant text[] := ARRAY['state', 'updated_at', 'updated_by', 'legal_review_state', 'legal_reviewed_at',
                                'legal_reviewed_by', 'legal_review_note'];
BEGIN
  IF OLD.state = 'published' AND NOT (
       (NEW.state = OLD.state OR NEW.state = 'retired')
       AND (to_jsonb(NEW) - meta) = (to_jsonb(OLD) - meta)) THEN
    RAISE EXCEPTION 'core.append_only: a published lease template version cannot change (create a new version)' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state = 'retired' AND (to_jsonb(NEW) - meta) <> (to_jsonb(OLD) - meta) THEN
    RAISE EXCEPTION 'core.append_only: a retired lease template version cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state = 'retired' AND NEW.state <> 'retired' THEN
    RAISE EXCEPTION 'core.append_only: a retired lease template version cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- Signable documents ---------------------------------------------------------------------------------------------
CREATE TABLE ops.contract_document (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  kind                   ops.contract_kind NOT NULL,
  template_version_id    uuid NOT NULL,
  language               char(2) NOT NULL DEFAULT 'th',
  title                  text NOT NULL,
  building_id            uuid,
  unit_id                uuid,
  lease_id               uuid,
  co_broke_agreement_id  uuid,
  mandate_id             uuid,
  counterparty_tenant_id uuid,
  signers                jsonb NOT NULL DEFAULT '[]',
  variables              jsonb NOT NULL DEFAULT '{}',
  number                 citext,
  state                  ops.contract_document_state NOT NULL DEFAULT 'draft',
  document_id            uuid,
  signed_document_id     uuid,
  sha256                 bytea,
  content_sha256         text,
  sent_at                timestamptz(6),
  signed_at              timestamptz(6),
  cancelled_at           timestamptz(6),
  cancel_reason          text,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT contract_document_pkey PRIMARY KEY (id),
  CONSTRAINT contract_document_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_template_version_id_fkey FOREIGN KEY (template_version_id) REFERENCES ops.lease_template_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_co_broke_agreement_id_fkey FOREIGN KEY (co_broke_agreement_id) REFERENCES ops.co_broke_agreement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES ops.listing_mandate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_counterparty_tenant_id_fkey FOREIGN KEY (counterparty_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_signed_document_id_fkey FOREIGN KEY (signed_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_document_kind_check CHECK (kind IN ('reservation', 'brokerage_mandate', 'co_broke', 'addendum')),
  CONSTRAINT contract_document_language_check CHECK (language ~ '^[a-z]{2}$'),
  CONSTRAINT contract_document_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT contract_document_pair_check CHECK (counterparty_tenant_id IS NULL OR counterparty_tenant_id <> tenant_id),
  CONSTRAINT contract_document_signers_check CHECK (jsonb_typeof(signers) = 'array'),
  CONSTRAINT contract_document_variables_check CHECK (jsonb_typeof(variables) = 'object'),
  CONSTRAINT contract_document_sent_check CHECK (state IN ('draft', 'cancelled') OR (number IS NOT NULL AND document_id IS NOT NULL AND sha256 IS NOT NULL AND sent_at IS NOT NULL)),
  CONSTRAINT contract_document_signed_check CHECK (state <> 'signed' OR (signed_document_id IS NOT NULL AND signed_at IS NOT NULL)),
  CONSTRAINT contract_document_cancel_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT contract_document_cancel_reason_check CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500)
);
COMMENT ON TABLE ops.contract_document IS 'D-294 (G3): an e-signed document of a non-lease contract-library kind; template version pinned; the signed PDF is held (D-286). Visible to its tenant and the counterparty tenant (agency ↔ owner / co-agency).';
CREATE UNIQUE INDEX contract_document_tenant_id_number_key ON ops.contract_document (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX contract_document_tenant_id_kind_state_idx ON ops.contract_document (tenant_id, kind, state);
CREATE INDEX contract_document_counterparty_tenant_id_state_idx ON ops.contract_document (counterparty_tenant_id, state);
CREATE INDEX contract_document_template_version_id_idx ON ops.contract_document (template_version_id);
CREATE INDEX contract_document_building_id_idx ON ops.contract_document (building_id);
CREATE INDEX contract_document_unit_id_idx ON ops.contract_document (unit_id);
CREATE INDEX contract_document_lease_id_idx ON ops.contract_document (lease_id);
CREATE INDEX contract_document_co_broke_agreement_id_idx ON ops.contract_document (co_broke_agreement_id);
CREATE INDEX contract_document_mandate_id_idx ON ops.contract_document (mandate_id);
CREATE INDEX contract_document_document_id_idx ON ops.contract_document (document_id);
CREATE INDEX contract_document_signed_document_id_idx ON ops.contract_document (signed_document_id);
CREATE TRIGGER contract_document_set_updated_at BEFORE UPDATE ON ops.contract_document FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.contract_signature (
  id                           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                    uuid NOT NULL,
  contract_document_id         uuid NOT NULL,
  signer_index                 smallint NOT NULL,
  signer_role                  ops.contract_signer_role NOT NULL,
  party_id                     uuid,
  signer_tenant_id             uuid,
  user_id                      uuid NOT NULL,
  method                       ops.signature_method NOT NULL,
  otp_challenge_id             uuid,
  line_user_id                 text,
  signature_image_document_id  uuid NOT NULL,
  pdf_sha256                   bytea NOT NULL,
  signed_at                    timestamptz(6) NOT NULL,
  ip                           inet,
  user_agent                   text,
  created_at                   timestamptz(6) NOT NULL DEFAULT now(),
  created_by                   uuid,
  CONSTRAINT contract_signature_pkey PRIMARY KEY (id),
  CONSTRAINT contract_signature_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_contract_document_id_fkey FOREIGN KEY (contract_document_id) REFERENCES ops.contract_document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_signer_tenant_id_fkey FOREIGN KEY (signer_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_otp_challenge_id_fkey FOREIGN KEY (otp_challenge_id) REFERENCES platform.otp_challenge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_image_fkey FOREIGN KEY (signature_image_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contract_signature_signer_check CHECK ((party_id IS NULL) <> (signer_tenant_id IS NULL)),
  CONSTRAINT contract_signature_index_check CHECK (signer_index BETWEEN 0 AND 19)
);
COMMENT ON TABLE ops.contract_signature IS 'D-294 / D-062: append-only e-signature evidence of a contract document (OTP challenge + LINE user for parties, drawn signature, PDF sha256, time, IP, UA).';
CREATE UNIQUE INDEX contract_signature_contract_document_id_signer_index_key ON ops.contract_signature (contract_document_id, signer_index);
CREATE INDEX contract_signature_tenant_id_idx ON ops.contract_signature (tenant_id);
CREATE INDEX contract_signature_party_id_idx ON ops.contract_signature (party_id);
CREATE INDEX contract_signature_signer_tenant_id_idx ON ops.contract_signature (signer_tenant_id);
CREATE INDEX contract_signature_user_id_idx ON ops.contract_signature (user_id);
CREATE INDEX contract_signature_otp_challenge_id_idx ON ops.contract_signature (otp_challenge_id);
CREATE INDEX contract_signature_image_idx ON ops.contract_signature (signature_image_document_id);
CREATE TRIGGER contract_signature_append_only BEFORE UPDATE OR DELETE ON ops.contract_signature FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER contract_signature_no_truncate BEFORE TRUNCATE ON ops.contract_signature FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();

-- Renewal offers -------------------------------------------------------------------------------------------------
CREATE TABLE ops.lease_renewal_offer (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  lease_id             uuid NOT NULL,
  building_id          uuid NOT NULL,
  unit_id              uuid NOT NULL,
  notice_id            uuid,
  current_rent         numeric(14,2) NOT NULL,
  suggested_rent       numeric(14,2),
  suggestion_source    ops.renewal_rent_source NOT NULL,
  offered_rent         numeric(14,2) NOT NULL,
  months               smallint NOT NULL,
  start_date           date NOT NULL,
  respond_by           date NOT NULL,
  state                ops.renewal_offer_state NOT NULL DEFAULT 'offered',
  message              text,
  new_lease_id         uuid,
  decided_at           timestamptz(6),
  decided_by_party_id  uuid,
  decided_by_user_id   uuid,
  decline_reason       text,
  withdrawn_at         timestamptz(6),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT lease_renewal_offer_pkey PRIMARY KEY (id),
  CONSTRAINT lease_renewal_offer_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES ops.lease_notice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_new_lease_id_fkey FOREIGN KEY (new_lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_decided_by_party_id_fkey FOREIGN KEY (decided_by_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_renewal_offer_rent_check CHECK (current_rent > 0 AND offered_rent > 0 AND (suggested_rent IS NULL OR suggested_rent > 0)),
  CONSTRAINT lease_renewal_offer_months_check CHECK (months BETWEEN 1 AND 120),
  CONSTRAINT lease_renewal_offer_message_check CHECK (message IS NULL OR length(message) <= 2000),
  CONSTRAINT lease_renewal_offer_reason_check CHECK (decline_reason IS NULL OR length(decline_reason) <= 500),
  CONSTRAINT lease_renewal_offer_decided_check CHECK (state NOT IN ('accepted', 'declined') OR decided_at IS NOT NULL),
  CONSTRAINT lease_renewal_offer_withdrawn_check CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
COMMENT ON TABLE ops.lease_renewal_offer IS 'D-294 (G3): a renewal offer on a lease (B7.5 renewal_offer letter) answered by the resident: accepted → renewal lease, declined → notice / move-out (D-219), expired after respond_by.';
CREATE UNIQUE INDEX lease_renewal_offer_open_key ON ops.lease_renewal_offer (lease_id) WHERE state = 'offered';
CREATE INDEX lease_renewal_offer_tenant_id_state_idx ON ops.lease_renewal_offer (tenant_id, state);
CREATE INDEX lease_renewal_offer_lease_id_idx ON ops.lease_renewal_offer (lease_id);
CREATE INDEX lease_renewal_offer_building_id_idx ON ops.lease_renewal_offer (building_id);
CREATE INDEX lease_renewal_offer_unit_id_idx ON ops.lease_renewal_offer (unit_id);
CREATE INDEX lease_renewal_offer_notice_id_idx ON ops.lease_renewal_offer (notice_id);
CREATE INDEX lease_renewal_offer_new_lease_id_idx ON ops.lease_renewal_offer (new_lease_id);
CREATE INDEX lease_renewal_offer_decided_by_party_id_idx ON ops.lease_renewal_offer (decided_by_party_id);
CREATE INDEX lease_renewal_offer_decided_by_user_id_idx ON ops.lease_renewal_offer (decided_by_user_id);
CREATE INDEX lease_renewal_offer_due_idx ON ops.lease_renewal_offer (respond_by) WHERE state = 'offered';
CREATE TRIGGER lease_renewal_offer_set_updated_at BEFORE UPDATE ON ops.lease_renewal_offer FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Links -----------------------------------------------------------------------------------------------------------
ALTER TABLE ops.lease ADD COLUMN renewal_reminded_days smallint,
  ADD CONSTRAINT lease_renewal_reminded_days_check CHECK (renewal_reminded_days IS NULL OR renewal_reminded_days BETWEEN 0 AND 366);
ALTER TABLE ops.co_broke_agreement ADD COLUMN contract_document_id uuid,
  ADD CONSTRAINT co_broke_agreement_contract_document_id_fkey FOREIGN KEY (contract_document_id) REFERENCES ops.contract_document (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX co_broke_agreement_contract_document_id_idx ON ops.co_broke_agreement (contract_document_id);
ALTER TABLE ops.listing_mandate ADD COLUMN contract_document_id uuid,
  ADD CONSTRAINT listing_mandate_contract_document_id_fkey FOREIGN KEY (contract_document_id) REFERENCES ops.contract_document (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX listing_mandate_contract_document_id_idx ON ops.listing_mandate (contract_document_id);

-- RLS -------------------------------------------------------------------------------------------------------------
ALTER TABLE ops.contract_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.contract_document FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_document_rls_pair ON ops.contract_document FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()) OR counterparty_tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR counterparty_tenant_id = (SELECT core.current_tenant_id()));
ALTER TABLE ops.contract_signature ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.contract_signature FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_signature_rls_read ON ops.contract_signature FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.contract_document d WHERE d.id = contract_document_id));
CREATE POLICY contract_signature_rls_write ON ops.contract_signature FOR INSERT
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR signer_tenant_id = (SELECT core.current_tenant_id()));
SELECT platform.apply_rls('ops.lease_renewal_offer', 'tenant');

GRANT SELECT, INSERT, UPDATE ON ops.contract_document, ops.lease_renewal_offer TO gp_app, gp_platform;
GRANT SELECT, INSERT ON ops.contract_signature TO gp_app, gp_platform;
GRANT SELECT ON ops.contract_document, ops.contract_signature, ops.lease_renewal_offer TO gp_reporting;
