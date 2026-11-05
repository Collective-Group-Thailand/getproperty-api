-- getproperty-api 0072 — platform-unique slips, allocation surcharge part, payment plans, recurring channel and
-- debt clearance (Phase J step J1.2a, D-305, D-306, D-308, D-325). schema-design §7.5 rows 216–225 (§7.6 J1-n, J1-o,
-- J1-p, J1-r, J1-s).
--   * ops.slip_review: the reference of a live slip is unique across ALL tenants (was per tenant). Building the index
--     fails when two tenants already hold the same live reference — resolve by hand first (docs/deployment.md); a
--     booked slip is never rewritten by a migration.
--   * ops.payment_allocation.surcharge_amount (the late-fee part of an allocation; surcharge_first policy).
--   * ops.payment_method + recurring; ops.payment_mandate, ops.recurring_charge, ops.recurring_webhook (O-020: fake).
--   * ops.note_reason + payment_plan; ops.invoice_line_kind + plan_instalment; ops.document_type + debt_clearance.
--   * juristic.payment_plan, payment_plan_instalment, debt_clearance (RLS tenant).
-- DDL only (no DML on RLS tables); no core.* change.

ALTER TYPE ops.payment_method ADD VALUE IF NOT EXISTS 'recurring';
ALTER TYPE ops.note_reason ADD VALUE IF NOT EXISTS 'payment_plan';
ALTER TYPE ops.invoice_line_kind ADD VALUE IF NOT EXISTS 'plan_instalment';
ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'debt_clearance';

-- ------------------------------------------------------------------------------- slips: platform-unique reference
DROP INDEX IF EXISTS ops.slip_review_trans_ref_key;
CREATE UNIQUE INDEX slip_review_trans_ref_key ON ops.slip_review (trans_ref)
  WHERE trans_ref IS NOT NULL AND status NOT IN ('duplicate', 'rejected');
COMMENT ON INDEX ops.slip_review_trans_ref_key IS 'D-308 / D-325 (J1.2a): one bank transfer pays once on the whole platform — the reference of a slip that is not duplicate / rejected is unique across tenants (a unique index is enforced whatever RLS hides).';

-- ------------------------------------------------------------------------------- allocation: surcharge part
ALTER TABLE ops.payment_allocation ADD COLUMN surcharge_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE ops.payment_allocation ADD CONSTRAINT payment_allocation_surcharge_amount_check
  CHECK (surcharge_amount >= 0 AND surcharge_amount <= amount);
COMMENT ON COLUMN ops.payment_allocation.surcharge_amount IS 'D-325 (J1.2a): the part of the allocation that paid late-fee (surcharge) lines of the invoice; the rest paid the principal.';

-- ------------------------------------------------------------------------------- recurring channel (O-020)
CREATE TYPE ops.payment_mandate_state AS ENUM ('pending', 'active', 'revoked', 'failed');
CREATE TYPE ops.payment_mandate_method AS ENUM ('direct_debit', 'card_token');
CREATE TYPE ops.payment_mandate_scope AS ENUM ('advance_invoices', 'all_invoices');
CREATE TYPE ops.recurring_charge_state AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE ops.payment_mandate (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  building_id     uuid NOT NULL,
  unit_id         uuid NOT NULL,
  party_id        uuid NOT NULL,
  provider        text NOT NULL,
  method          ops.payment_mandate_method NOT NULL,
  scope           ops.payment_mandate_scope NOT NULL DEFAULT 'advance_invoices',
  state           ops.payment_mandate_state NOT NULL DEFAULT 'pending',
  mandate_ref     text NOT NULL,
  masked          text,
  requested_by    uuid,
  activated_at    timestamptz(6),
  ended_at        timestamptz(6),
  end_reason      text,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT payment_mandate_pkey PRIMARY KEY (id),
  CONSTRAINT payment_mandate_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_mandate_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_mandate_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_mandate_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_mandate_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_mandate_provider_check CHECK (length(provider) BETWEEN 1 AND 40),
  CONSTRAINT payment_mandate_masked_check CHECK (masked IS NULL OR length(masked) <= 40),
  CONSTRAINT payment_mandate_active_check CHECK (state <> 'active' OR activated_at IS NOT NULL),
  CONSTRAINT payment_mandate_ended_check CHECK ((state IN ('revoked', 'failed')) = (ended_at IS NOT NULL))
);
COMMENT ON TABLE ops.payment_mandate IS 'D-308 / D-325 (J1.2a): a direct-debit / tokenised-card authorisation of a billed party for a unit (payment channel recurring); the provider token is never stored — only its reference and a masked hint. Fake adapter until O-020.';
CREATE UNIQUE INDEX payment_mandate_provider_mandate_ref_key ON ops.payment_mandate (provider, mandate_ref);
CREATE UNIQUE INDEX payment_mandate_open_key ON ops.payment_mandate (unit_id, party_id) WHERE (state IN ('pending', 'active'));
CREATE INDEX payment_mandate_tenant_id_state_idx ON ops.payment_mandate (tenant_id, state);
CREATE INDEX payment_mandate_party_id_idx ON ops.payment_mandate (party_id);
SELECT platform.apply_rls('ops.payment_mandate', 'tenant');

CREATE TABLE ops.recurring_charge (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  mandate_id      uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  amount          numeric(14,2) NOT NULL,
  provider        text NOT NULL,
  charge_ref      text,
  state           ops.recurring_charge_state NOT NULL DEFAULT 'pending',
  payment_id      uuid,
  failure_reason  text,
  requested_at    timestamptz(6) NOT NULL DEFAULT now(),
  settled_at      timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT recurring_charge_pkey PRIMARY KEY (id),
  CONSTRAINT recurring_charge_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT recurring_charge_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES ops.payment_mandate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT recurring_charge_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT recurring_charge_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT recurring_charge_amount_check CHECK (amount > 0),
  CONSTRAINT recurring_charge_succeeded_check CHECK ((state = 'succeeded') = (payment_id IS NOT NULL))
);
COMMENT ON TABLE ops.recurring_charge IS 'D-325 (J1.2a): one charge of an invoice through an active mandate (advance invoices on issue); succeeded → a recurring payment allocated like any other.';
CREATE UNIQUE INDEX recurring_charge_provider_charge_ref_key ON ops.recurring_charge (provider, charge_ref) WHERE (charge_ref IS NOT NULL);
CREATE UNIQUE INDEX recurring_charge_invoice_open_key ON ops.recurring_charge (mandate_id, invoice_id) WHERE (state IN ('pending', 'succeeded'));
CREATE INDEX recurring_charge_invoice_id_idx ON ops.recurring_charge (invoice_id);
CREATE INDEX recurring_charge_tenant_id_state_idx ON ops.recurring_charge (tenant_id, state);
SELECT platform.apply_rls('ops.recurring_charge', 'tenant');

CREATE TABLE ops.recurring_webhook (
  id              uuid NOT NULL DEFAULT uuidv7(),
  provider        text NOT NULL,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  tenant_id       uuid,
  signature_valid boolean NOT NULL,
  outcome         ops.webhook_outcome NOT NULL DEFAULT 'received',
  detail          text,
  payload         jsonb NOT NULL DEFAULT '{}',
  received_at     timestamptz(6) NOT NULL DEFAULT now(),
  processed_at    timestamptz(6),
  CONSTRAINT recurring_webhook_pkey PRIMARY KEY (id),
  CONSTRAINT recurring_webhook_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.recurring_webhook IS 'D-325 (J1.2a): callbacks of the recurring-payment provider, stored once per (provider, event id) — a replay is acknowledged as a duplicate and changes nothing. Payload without card / account numbers.';
CREATE UNIQUE INDEX recurring_webhook_provider_event_id_key ON ops.recurring_webhook (provider, event_id);
CREATE INDEX recurring_webhook_tenant_id_idx ON ops.recurring_webhook (tenant_id);
SELECT platform.apply_rls('ops.recurring_webhook', 'platform_only');
REVOKE ALL ON ops.recurring_webhook FROM gp_app;

-- ------------------------------------------------------------------------------- payment plans (§7.6 J1-n, J1-o)
CREATE TYPE juristic.payment_plan_state AS ENUM ('proposed', 'active', 'completed', 'defaulted', 'cancelled', 'rejected');
CREATE TYPE juristic.plan_proposer AS ENUM ('staff', 'resident');
CREATE TYPE juristic.instalment_state AS ENUM ('scheduled', 'billed', 'paid', 'cancelled');

CREATE TABLE juristic.payment_plan (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid NOT NULL,
  party_id               uuid NOT NULL,
  state                  juristic.payment_plan_state NOT NULL DEFAULT 'proposed',
  proposed_by_kind       juristic.plan_proposer NOT NULL,
  requested_by_user      uuid,
  instalment_count       smallint NOT NULL,
  first_due_on           date NOT NULL,
  proposed_principal     numeric(14,2) NOT NULL,
  principal              numeric(14,2),
  invoice_ids            uuid[] NOT NULL DEFAULT '{}',
  credit_note_ids        uuid[] NOT NULL DEFAULT '{}',
  default_after_days     smallint,
  note                   text,
  approved_at            timestamptz(6),
  approved_by            uuid,
  decided_reason         text,
  ended_at               timestamptz(6),
  accelerated_charge_id  uuid,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT payment_plan_pkey PRIMARY KEY (id),
  CONSTRAINT payment_plan_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_requested_by_user_fkey FOREIGN KEY (requested_by_user) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_accelerated_charge_id_fkey FOREIGN KEY (accelerated_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_instalment_count_check CHECK (instalment_count BETWEEN 2 AND 60),
  CONSTRAINT payment_plan_proposed_principal_check CHECK (proposed_principal >= 0),
  CONSTRAINT payment_plan_principal_check CHECK (principal IS NULL OR principal > 0),
  CONSTRAINT payment_plan_note_check CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT payment_plan_reason_check CHECK (decided_reason IS NULL OR length(decided_reason) <= 1000),
  CONSTRAINT payment_plan_approved_check CHECK (state IN ('proposed', 'rejected') OR (state = 'cancelled' AND approved_at IS NULL) OR (approved_at IS NOT NULL AND principal IS NOT NULL AND default_after_days IS NOT NULL))
);
COMMENT ON TABLE juristic.payment_plan IS 'D-308 / D-325 (J1.2a): an instalment plan of a party''s open invoices of a unit — proposed by staff or requested by the resident, approved by owner / manager / committee (the covered invoices get credit notes; the principal moves onto instalments), defaulted after default_after_days late (ladder resumes, J1.2b). 10 years.';
CREATE UNIQUE INDEX payment_plan_open_key ON juristic.payment_plan (unit_id, party_id) WHERE (state IN ('proposed', 'active'));
CREATE INDEX payment_plan_tenant_id_state_idx ON juristic.payment_plan (tenant_id, state);
CREATE INDEX payment_plan_party_id_idx ON juristic.payment_plan (party_id);
SELECT platform.apply_rls('juristic.payment_plan', 'tenant');

CREATE TABLE juristic.payment_plan_instalment (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  plan_id            uuid NOT NULL,
  seq                smallint NOT NULL,
  due_on             date NOT NULL,
  amount             numeric(14,2) NOT NULL,
  state              juristic.instalment_state NOT NULL DEFAULT 'scheduled',
  invoice_charge_id  uuid,
  billed_at          timestamptz(6),
  paid_at            timestamptz(6),
  cancelled_at       timestamptz(6),
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT payment_plan_instalment_pkey PRIMARY KEY (id),
  CONSTRAINT payment_plan_instalment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_instalment_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES juristic.payment_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_instalment_invoice_charge_id_fkey FOREIGN KEY (invoice_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_plan_instalment_amount_check CHECK (amount > 0),
  CONSTRAINT payment_plan_instalment_billed_check CHECK (state = 'scheduled' OR state = 'cancelled' OR invoice_charge_id IS NOT NULL)
);
COMMENT ON TABLE juristic.payment_plan_instalment IS 'D-325 (J1.2a): one instalment of a payment plan; its invoice charge (line kind plan_instalment) is queued on the first day of the due month and billed by the next monthly cycle.';
CREATE UNIQUE INDEX payment_plan_instalment_plan_id_seq_key ON juristic.payment_plan_instalment (plan_id, seq);
CREATE INDEX payment_plan_instalment_state_due_on_idx ON juristic.payment_plan_instalment (state, due_on);
CREATE INDEX payment_plan_instalment_invoice_charge_id_idx ON juristic.payment_plan_instalment (invoice_charge_id);
SELECT platform.apply_rls('juristic.payment_plan_instalment', 'tenant');

-- ------------------------------------------------------------------------------- debt clearance (§7.6 J1-p)
CREATE TYPE juristic.debt_clearance_state AS ENUM ('requested', 'issued', 'refused');
CREATE TYPE juristic.request_channel AS ENUM ('liff', 'web');

CREATE TABLE juristic.debt_clearance (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  building_id             uuid NOT NULL,
  unit_id                 uuid NOT NULL,
  party_id                uuid NOT NULL,
  requested_via           juristic.request_channel NOT NULL,
  requested_by            uuid,
  as_of                   date NOT NULL,
  language                char(2) NOT NULL DEFAULT 'th',
  state                   juristic.debt_clearance_state NOT NULL DEFAULT 'requested',
  outstanding             numeric(14,2) NOT NULL DEFAULT 0,
  fee                     numeric(14,2) NOT NULL DEFAULT 0,
  fee_charge_id           uuid,
  number                  text,
  document_id             uuid,
  verify_code_hash        bytea,
  verify_code_hint        text,
  valid_until             date,
  issued_at               timestamptz(6),
  issued_by               uuid,
  refused_at              timestamptz(6),
  refused_by              uuid,
  refuse_reason           text,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT debt_clearance_pkey PRIMARY KEY (id),
  CONSTRAINT debt_clearance_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_fee_charge_id_fkey FOREIGN KEY (fee_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debt_clearance_language_check CHECK (language IN ('th', 'en')),
  CONSTRAINT debt_clearance_amounts_check CHECK (outstanding >= 0 AND fee >= 0),
  CONSTRAINT debt_clearance_issued_check CHECK ((state = 'issued') = (number IS NOT NULL AND document_id IS NOT NULL AND verify_code_hash IS NOT NULL AND valid_until IS NOT NULL AND issued_at IS NOT NULL)),
  CONSTRAINT debt_clearance_issued_zero_check CHECK (state <> 'issued' OR outstanding = 0),
  CONSTRAINT debt_clearance_refused_check CHECK ((state = 'refused') = (refused_at IS NOT NULL AND refuse_reason IS NOT NULL)),
  CONSTRAINT debt_clearance_reason_check CHECK (refuse_reason IS NULL OR length(refuse_reason) <= 500)
);
COMMENT ON TABLE juristic.debt_clearance IS 'D-306 / D-325 (J1.2a): หนังสือรับรองการปลอดหนี้ — issued only when the unit''s receivable of the requesting owner is 0 at issue time (number series DCL, gapless); public verification by code shows unit number and name initials only. 10 years.';
CREATE UNIQUE INDEX debt_clearance_tenant_id_number_key ON juristic.debt_clearance (tenant_id, number) WHERE (number IS NOT NULL);
CREATE UNIQUE INDEX debt_clearance_verify_code_hash_key ON juristic.debt_clearance (verify_code_hash) WHERE (verify_code_hash IS NOT NULL);
CREATE INDEX debt_clearance_unit_id_idx ON juristic.debt_clearance (unit_id, created_at DESC);
CREATE INDEX debt_clearance_tenant_id_state_idx ON juristic.debt_clearance (tenant_id, state);
CREATE INDEX debt_clearance_party_id_idx ON juristic.debt_clearance (party_id);
SELECT platform.apply_rls('juristic.debt_clearance', 'tenant');
REVOKE DELETE ON juristic.debt_clearance FROM gp_app;
