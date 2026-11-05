-- getproperty-api 0078 — vendors, service contracts, quotation rounds, evaluations, preventive maintenance by contract
-- (Phase J step J2.2, D-310, D-331). schema-design §7.5 rows 268–278 (§7.6 J2-k … J2-p).
--   * juristic.vendor (a core.party with categories, contact and a MASKED bank account — never the full number; the
--     tax id stays on core.party.tax_id, which the 50 ทวิ reads).
--   * juristic.vendor_contract (+ instalments → scheduled expense requests, documents, expiry alerts 90 / 60 / 30).
--   * juristic.quotation_round / quotation / quotation_approval (≥ 3 quotations above juristic.quotation_threshold or
--     a recorded reason; award by resolution or band approval with a maker-checker trigger).
--   * juristic.vendor_evaluation (monthly per contract; SLA breaches snapshotted).
--   * ops.maintenance_plan.vendor_contract_id (= the pack's pm_schedule, J0), juristic.expense_request + vendor_id,
--     vendor_contract_id, quotation_round_id.
-- Every new table RLS:T. DDL only (no DML on RLS tables); no core.* change.

CREATE TYPE juristic.vendor_category AS ENUM ('security', 'cleaning', 'gardening', 'lift', 'pump', 'fire_system',
  'electrical', 'plumbing', 'pest_control', 'pool', 'cctv', 'waste', 'building_works', 'professional', 'insurance', 'other');
CREATE TYPE juristic.vendor_state AS ENUM ('active', 'blocked');
CREATE TYPE juristic.vendor_contract_state AS ENUM ('draft', 'active', 'expired', 'terminated');
CREATE TYPE juristic.contract_instalment_state AS ENUM ('scheduled', 'requested', 'cancelled');
CREATE TYPE juristic.contract_document_kind AS ENUM ('contract', 'amendment', 'insurance', 'guarantee', 'other');
CREATE TYPE juristic.quotation_round_state AS ENUM ('open', 'awaiting_approval', 'awarded', 'cancelled');
CREATE TYPE juristic.award_outcome AS ENUM ('contract', 'expense');
CREATE TYPE juristic.award_basis AS ENUM ('resolution', 'approval');

-- ------------------------------------------------------------------------------- vendors (§7.6 J2-l)
CREATE TABLE juristic.vendor (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  party_id           uuid NOT NULL,
  name               text NOT NULL,
  categories         juristic.vendor_category[] NOT NULL DEFAULT '{}',
  contact_name       text,
  contact_phone      text,
  contact_email      citext,
  bank_name          text,
  bank_account_name  text,
  bank_account_last4 text,
  state              juristic.vendor_state NOT NULL DEFAULT 'active',
  blocked_reason     text,
  note               text,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT vendor_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_name_check CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT vendor_bank_last4_check CHECK (bank_account_last4 IS NULL OR bank_account_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT vendor_texts_check CHECK ((contact_name IS NULL OR length(contact_name) <= 200) AND (contact_phone IS NULL OR length(contact_phone) <= 30)
    AND (bank_name IS NULL OR length(bank_name) <= 100) AND (bank_account_name IS NULL OR length(bank_account_name) <= 200) AND (note IS NULL OR length(note) <= 2000)),
  CONSTRAINT vendor_blocked_check CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL) AND (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 3 AND 1000))
);
COMMENT ON TABLE juristic.vendor IS 'D-310 / D-331 (J2.2): a vendor of a juristic tenant = a core.party (its tax id on the party, used by the 50 ทวิ) with categories, a contact and a masked bank account (bank, account name, last 4 digits only).';
CREATE UNIQUE INDEX vendor_tenant_id_party_id_key ON juristic.vendor (tenant_id, party_id);
CREATE INDEX vendor_tenant_id_state_idx ON juristic.vendor (tenant_id, state);
SELECT platform.apply_rls('juristic.vendor', 'tenant');
REVOKE DELETE ON juristic.vendor FROM gp_app;

-- ------------------------------------------------------------------------------- quotation rounds (§7.6 J2-n, J2-o)
CREATE TABLE juristic.quotation_round (
  id                           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                    uuid NOT NULL,
  building_id                  uuid NOT NULL,
  title                        text NOT NULL,
  description                  text,
  category                     juristic.vendor_category,
  estimated_amount             numeric(14,2),
  state                        juristic.quotation_round_state NOT NULL DEFAULT 'open',
  awarded_quotation_id         uuid,
  outcome                      juristic.award_outcome,
  basis                        juristic.award_basis,
  resolution_id                uuid,
  fewer_quotations_reason      text,
  quotation_count              smallint,
  above_threshold              boolean,
  threshold                    numeric(14,2),
  award_options                jsonb,
  band                         jsonb,
  approvals_required           smallint,
  approver_roles               text[] NOT NULL DEFAULT '{}',
  award_requested_by           uuid,
  award_requested_at           timestamptz(6),
  awarded_at                   timestamptz(6),
  outcome_contract_id          uuid,
  outcome_expense_request_id   uuid,
  cancelled_at                 timestamptz(6),
  cancel_reason                text,
  created_at                   timestamptz(6) NOT NULL DEFAULT now(),
  created_by                   uuid,
  updated_at                   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                   uuid,
  version                      integer NOT NULL DEFAULT 1,
  CONSTRAINT quotation_round_pkey PRIMARY KEY (id),
  CONSTRAINT quotation_round_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_award_requested_by_fkey FOREIGN KEY (award_requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_outcome_expense_request_id_fkey FOREIGN KEY (outcome_expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT quotation_round_texts_check CHECK ((description IS NULL OR length(description) <= 4000) AND (cancel_reason IS NULL OR length(cancel_reason) <= 1000)),
  CONSTRAINT quotation_round_estimate_check CHECK (estimated_amount IS NULL OR estimated_amount > 0),
  CONSTRAINT quotation_round_award_check CHECK (state IN ('open', 'cancelled') OR (awarded_quotation_id IS NOT NULL AND outcome IS NOT NULL AND basis IS NOT NULL AND award_requested_by IS NOT NULL)),
  CONSTRAINT quotation_round_resolution_basis_check CHECK (basis IS DISTINCT FROM 'resolution' OR resolution_id IS NOT NULL),
  CONSTRAINT quotation_round_approval_basis_check CHECK (basis IS DISTINCT FROM 'approval' OR approvals_required BETWEEN 1 AND 5),
  -- D-310: fewer than 3 quotations above the threshold only with a recorded reason
  CONSTRAINT quotation_round_minimum_check CHECK (state IN ('open', 'cancelled') OR NOT above_threshold OR quotation_count >= 3
    OR (fewer_quotations_reason IS NOT NULL AND length(fewer_quotations_reason) BETWEEN 10 AND 1000)),
  CONSTRAINT quotation_round_awarded_check CHECK ((state = 'awarded') = (awarded_at IS NOT NULL))
);
COMMENT ON TABLE juristic.quotation_round IS 'D-310 / D-331 (J2.2): a round of quotations for a purchase or a service contract; awarded by an adopted resolution or the approval band (maker-checker); fewer than 3 quotations above juristic.quotation_threshold only with a recorded reason (CHECK). The award creates a contract draft or an expense request draft.';
CREATE INDEX quotation_round_tenant_id_state_idx ON juristic.quotation_round (tenant_id, state, created_at DESC);
CREATE INDEX quotation_round_building_id_idx ON juristic.quotation_round (building_id);
SELECT platform.apply_rls('juristic.quotation_round', 'tenant');
REVOKE DELETE ON juristic.quotation_round FROM gp_app;

CREATE TABLE juristic.quotation (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  round_id     uuid NOT NULL,
  vendor_id    uuid NOT NULL,
  amount       numeric(14,2) NOT NULL,
  vat_amount   numeric(14,2) NOT NULL DEFAULT 0,
  valid_until  date NOT NULL,
  document_id  uuid NOT NULL,
  note         text,
  received_on  date NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT quotation_pkey PRIMARY KEY (id),
  CONSTRAINT quotation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_round_id_fkey FOREIGN KEY (round_id) REFERENCES juristic.quotation_round (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES juristic.vendor (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_amount_check CHECK (amount > 0 AND vat_amount >= 0 AND vat_amount <= amount),
  CONSTRAINT quotation_note_check CHECK (note IS NULL OR length(note) <= 1000)
);
COMMENT ON TABLE juristic.quotation IS 'D-310 / D-331 (J2.2): one vendor''s quotation in a round (document required); append-only.';
CREATE UNIQUE INDEX quotation_round_id_vendor_id_key ON juristic.quotation (round_id, vendor_id);
CREATE INDEX quotation_vendor_id_idx ON juristic.quotation (vendor_id);
SELECT platform.apply_rls('juristic.quotation', 'tenant');
REVOKE UPDATE, DELETE ON juristic.quotation FROM gp_app;

ALTER TABLE juristic.quotation_round ADD CONSTRAINT quotation_round_awarded_quotation_id_fkey
  FOREIGN KEY (awarded_quotation_id) REFERENCES juristic.quotation (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE juristic.quotation_approval (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  round_id          uuid NOT NULL,
  approver_user_id  uuid NOT NULL,
  role              text NOT NULL,
  decision          juristic.expense_decision NOT NULL,
  reason            text,
  band_key          text NOT NULL,
  award_requested_at timestamptz(6) NOT NULL,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT quotation_approval_pkey PRIMARY KEY (id),
  CONSTRAINT quotation_approval_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_approval_round_id_fkey FOREIGN KEY (round_id) REFERENCES juristic.quotation_round (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_approval_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT quotation_approval_role_check CHECK (role IN ('owner', 'manager', 'committee')),
  CONSTRAINT quotation_approval_reason_check CHECK (reason IS NULL OR length(reason) <= 1000)
);
COMMENT ON TABLE juristic.quotation_approval IS 'D-091 / D-331 (J2.2): one approver''s decision on the award of a quotation round (append-only, per award request); the approver is never the one who asked for the award (trigger).';
CREATE UNIQUE INDEX quotation_approval_round_request_approver_key ON juristic.quotation_approval (round_id, award_requested_at, approver_user_id);
CREATE INDEX quotation_approval_tenant_id_idx ON juristic.quotation_approval (tenant_id);
SELECT platform.apply_rls('juristic.quotation_approval', 'tenant');
REVOKE UPDATE, DELETE ON juristic.quotation_approval FROM gp_app;

CREATE FUNCTION juristic.quotation_approval_maker_checker() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM juristic.quotation_round r WHERE r.id = NEW.round_id AND r.award_requested_by = NEW.approver_user_id) THEN
    RAISE EXCEPTION 'the requester of the award of quotation round % cannot approve it (maker-checker, D-091)', NEW.round_id
      USING ERRCODE = '23514', CONSTRAINT = 'quotation_approval_maker_checker';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quotation_approval_maker_checker BEFORE INSERT ON juristic.quotation_approval
  FOR EACH ROW EXECUTE FUNCTION juristic.quotation_approval_maker_checker();

-- ------------------------------------------------------------------------------- contracts (§7.6 J2-m)
CREATE TABLE juristic.vendor_contract (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  vendor_id             uuid NOT NULL,
  title                 text NOT NULL,
  scope                 text,
  category              juristic.vendor_category,
  sla_terms             jsonb NOT NULL DEFAULT '[]',
  starts_on             date NOT NULL,
  ends_on               date NOT NULL,
  renewal_notice_days   smallint NOT NULL DEFAULT 30,
  value                 numeric(14,2) NOT NULL,
  expense_account_id    uuid,
  wht_key               text,
  instalment_plan       jsonb,
  penalty_clauses       text,
  state                 juristic.vendor_contract_state NOT NULL DEFAULT 'draft',
  quotation_round_id    uuid,
  resolution_id         uuid,
  renews_contract_id    uuid,
  activated_at          timestamptz(6),
  activated_by          uuid,
  terminated_on         date,
  terminated_at         timestamptz(6),
  terminated_by         uuid,
  termination_reason    text,
  expired_at            timestamptz(6),
  note                  text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT vendor_contract_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_contract_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES juristic.vendor (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_expense_account_id_fkey FOREIGN KEY (expense_account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_quotation_round_id_fkey FOREIGN KEY (quotation_round_id) REFERENCES juristic.quotation_round (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_renews_contract_id_fkey FOREIGN KEY (renews_contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_terminated_by_fkey FOREIGN KEY (terminated_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT vendor_contract_texts_check CHECK ((scope IS NULL OR length(scope) <= 8000) AND (penalty_clauses IS NULL OR length(penalty_clauses) <= 8000)
    AND (note IS NULL OR length(note) <= 2000) AND (termination_reason IS NULL OR length(termination_reason) <= 1000)),
  CONSTRAINT vendor_contract_period_check CHECK (ends_on >= starts_on),
  CONSTRAINT vendor_contract_notice_check CHECK (renewal_notice_days BETWEEN 0 AND 365),
  CONSTRAINT vendor_contract_value_check CHECK (value >= 0),
  CONSTRAINT vendor_contract_sla_check CHECK (jsonb_typeof(sla_terms) = 'array'),
  CONSTRAINT vendor_contract_active_check CHECK (state = 'draft' OR (activated_at IS NOT NULL AND activated_by IS NOT NULL)),
  CONSTRAINT vendor_contract_terminated_check CHECK ((state = 'terminated') = (terminated_at IS NOT NULL AND terminated_on IS NOT NULL AND termination_reason IS NOT NULL)),
  CONSTRAINT vendor_contract_plan_account_check CHECK (state = 'draft' OR instalment_plan IS NULL OR expense_account_id IS NOT NULL)
);
COMMENT ON TABLE juristic.vendor_contract IS 'D-310 / D-331 (J2.2): a service contract of a building with a vendor: scope, SLA terms per priority, term, renewal notice, value, instalment plan (→ scheduled expense requests), penalty clauses; draft → active → expired | terminated. Kept 10 years.';
CREATE INDEX vendor_contract_tenant_id_state_idx ON juristic.vendor_contract (tenant_id, state);
CREATE INDEX vendor_contract_ends_on_idx ON juristic.vendor_contract (ends_on) WHERE (state = 'active');
CREATE INDEX vendor_contract_vendor_id_idx ON juristic.vendor_contract (vendor_id);
CREATE INDEX vendor_contract_building_id_idx ON juristic.vendor_contract (building_id);
CREATE UNIQUE INDEX vendor_contract_renews_contract_id_key ON juristic.vendor_contract (renews_contract_id) WHERE (renews_contract_id IS NOT NULL);
SELECT platform.apply_rls('juristic.vendor_contract', 'tenant');
REVOKE DELETE ON juristic.vendor_contract FROM gp_app;

ALTER TABLE juristic.quotation_round ADD CONSTRAINT quotation_round_outcome_contract_id_fkey
  FOREIGN KEY (outcome_contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE juristic.vendor_contract_instalment (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  contract_id         uuid NOT NULL,
  seq                 smallint NOT NULL,
  due_on              date NOT NULL,
  amount              numeric(14,2) NOT NULL,
  vat_amount          numeric(14,2) NOT NULL DEFAULT 0,
  description         text NOT NULL,
  state               juristic.contract_instalment_state NOT NULL DEFAULT 'scheduled',
  expense_request_id  uuid,
  requested_at        timestamptz(6),
  cancelled_at        timestamptz(6),
  cancel_reason       text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT vendor_contract_instalment_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_contract_instalment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_instalment_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_instalment_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_instalment_amount_check CHECK (amount > 0 AND vat_amount >= 0 AND vat_amount <= amount),
  CONSTRAINT vendor_contract_instalment_description_check CHECK (length(description) BETWEEN 1 AND 300),
  CONSTRAINT vendor_contract_instalment_requested_check CHECK ((state = 'requested') = (expense_request_id IS NOT NULL AND requested_at IS NOT NULL)),
  CONSTRAINT vendor_contract_instalment_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
COMMENT ON TABLE juristic.vendor_contract_instalment IS 'D-331 (J2.2): an instalment of a contract''s schedule; the vendor-contracts job turns it into one expense request lead days before its due date (UQ request: idempotent).';
CREATE UNIQUE INDEX vendor_contract_instalment_contract_id_seq_key ON juristic.vendor_contract_instalment (contract_id, seq);
CREATE UNIQUE INDEX vendor_contract_instalment_expense_request_id_key ON juristic.vendor_contract_instalment (expense_request_id) WHERE (expense_request_id IS NOT NULL);
CREATE INDEX vendor_contract_instalment_due_idx ON juristic.vendor_contract_instalment (due_on) WHERE (state = 'scheduled');
SELECT platform.apply_rls('juristic.vendor_contract_instalment', 'tenant');
REVOKE DELETE ON juristic.vendor_contract_instalment FROM gp_app;

CREATE TABLE juristic.vendor_contract_document (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  contract_id  uuid NOT NULL,
  document_id  uuid NOT NULL,
  kind         juristic.contract_document_kind NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT vendor_contract_document_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_contract_document_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_document_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_document_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE juristic.vendor_contract_document IS 'D-331 (J2.2): the signed contract, amendments, insurance and guarantees of a vendor contract (append-only).';
CREATE UNIQUE INDEX vendor_contract_document_contract_id_document_id_key ON juristic.vendor_contract_document (contract_id, document_id);
CREATE INDEX vendor_contract_document_document_id_idx ON juristic.vendor_contract_document (document_id);
SELECT platform.apply_rls('juristic.vendor_contract_document', 'tenant');
REVOKE UPDATE, DELETE ON juristic.vendor_contract_document FROM gp_app;

CREATE TABLE juristic.vendor_contract_alert (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  contract_id  uuid NOT NULL,
  days_before  smallint NOT NULL,
  ends_on      date NOT NULL,
  sent_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT vendor_contract_alert_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_contract_alert_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_alert_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_contract_alert_days_check CHECK (days_before BETWEEN 1 AND 365)
);
COMMENT ON TABLE juristic.vendor_contract_alert IS 'D-331 (J2.2): an expiry alert sent for a contract at a threshold (90 / 60 / 30 days) of its end date — once per (contract, threshold, end date).';
CREATE UNIQUE INDEX vendor_contract_alert_contract_days_ends_key ON juristic.vendor_contract_alert (contract_id, days_before, ends_on);
SELECT platform.apply_rls('juristic.vendor_contract_alert', 'tenant');
REVOKE UPDATE, DELETE ON juristic.vendor_contract_alert FROM gp_app;

-- ------------------------------------------------------------------------------- evaluations (§7.6 J2-p)
CREATE TABLE juristic.vendor_evaluation (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  contract_id      uuid NOT NULL,
  vendor_id        uuid NOT NULL,
  month            date NOT NULL,
  scores           jsonb NOT NULL,
  score            numeric(3,2) NOT NULL,
  incidents        integer NOT NULL DEFAULT 0,
  incident_note    text,
  sla_breaches     integer NOT NULL DEFAULT 0,
  sla_items        jsonb NOT NULL DEFAULT '[]',
  work_orders      integer NOT NULL DEFAULT 0,
  note             text,
  evaluated_by     uuid NOT NULL,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT vendor_evaluation_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_evaluation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_evaluation_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_evaluation_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES juristic.vendor (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_evaluation_evaluated_by_fkey FOREIGN KEY (evaluated_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT vendor_evaluation_month_check CHECK (extract(day FROM month) = 1),
  CONSTRAINT vendor_evaluation_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT vendor_evaluation_counts_check CHECK (incidents >= 0 AND sla_breaches >= 0 AND work_orders >= 0),
  CONSTRAINT vendor_evaluation_texts_check CHECK ((incident_note IS NULL OR length(incident_note) <= 2000) AND (note IS NULL OR length(note) <= 2000))
);
COMMENT ON TABLE juristic.vendor_evaluation IS 'D-310 / D-331 (J2.2): the monthly evaluation of a vendor contract — scores 1–5 per criterion, incidents, SLA breaches pulled from the vendor''s work orders and service requests (snapshotted); append-only.';
CREATE UNIQUE INDEX vendor_evaluation_contract_id_month_key ON juristic.vendor_evaluation (contract_id, month);
CREATE INDEX vendor_evaluation_vendor_id_month_idx ON juristic.vendor_evaluation (vendor_id, month DESC);
SELECT platform.apply_rls('juristic.vendor_evaluation', 'tenant');
REVOKE UPDATE, DELETE ON juristic.vendor_evaluation FROM gp_app;

-- ------------------------------------------------------------------------------- links (§7.6 J2-k, J2-e)
-- the pack's pm_schedule (J0): a preventive plan of a core.asset_item may be performed under a vendor contract
ALTER TABLE ops.maintenance_plan ADD COLUMN vendor_contract_id uuid;
ALTER TABLE ops.maintenance_plan ADD CONSTRAINT maintenance_plan_vendor_contract_id_fkey
  FOREIGN KEY (vendor_contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX maintenance_plan_vendor_contract_id_idx ON ops.maintenance_plan (vendor_contract_id) WHERE (vendor_contract_id IS NOT NULL);

ALTER TABLE juristic.expense_request ADD COLUMN vendor_id uuid;
ALTER TABLE juristic.expense_request ADD COLUMN vendor_contract_id uuid;
ALTER TABLE juristic.expense_request ADD COLUMN quotation_round_id uuid;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES juristic.vendor (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_vendor_contract_id_fkey
  FOREIGN KEY (vendor_contract_id) REFERENCES juristic.vendor_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_quotation_round_id_fkey
  FOREIGN KEY (quotation_round_id) REFERENCES juristic.quotation_round (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_vendor_link_check
  CHECK ((vendor_contract_id IS NULL AND quotation_round_id IS NULL) OR vendor_id IS NOT NULL);
CREATE INDEX expense_request_vendor_id_idx ON juristic.expense_request (vendor_id) WHERE (vendor_id IS NOT NULL);
CREATE INDEX expense_request_vendor_contract_id_idx ON juristic.expense_request (vendor_contract_id) WHERE (vendor_contract_id IS NOT NULL);
