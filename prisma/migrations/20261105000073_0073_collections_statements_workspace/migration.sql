-- getproperty-api 0073 — collections ladder, owner statements, letter batches and the D-270 juristic workspace
-- (Phase J step J1.2b, D-270, D-305, D-307, D-326). schema-design §7.5 rows 226–233 (§7.6 J1-j … J1-m, J1-q, J1-u).
--   * juristic.collection_ladder / collection_step: the tenant's ladder per legal form, created from the code template
--     (src/modules/ops-juristic/collections/ladder-templates.ts); every step but remind starts disabled (O-038).
--   * juristic.collection_case per (party, unit) and its append-only timeline juristic.collection_event; a step has at
--     most one final outcome per case (unique index) — the ladder runs each step exactly once.
--   * juristic.statement (series STM) and juristic.letter_batch (A4 letters for owners without digital channels).
--   * juristic.workspace_link: a landlord's invitation of a condo's juristic office for its units in a stub (D-270).
--   * ops.document_type + owner_statement, collection_letter; ops.export_kind + juristic_receivables_csv;
--     platform.compliance_rule.applies_to accepts collection_step.
-- DDL only (no DML on RLS tables); no core.* change.

ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'owner_statement';
ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'collection_letter';
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'juristic_receivables_csv';

-- the compliance registry gains rules that apply to collections ladder steps (compliance.condo_act_* …, O-038)
ALTER TABLE platform.compliance_rule DROP CONSTRAINT compliance_rule_applies_to_check;
ALTER TABLE platform.compliance_rule ADD CONSTRAINT compliance_rule_applies_to_check CHECK (cardinality(applies_to) > 0
  AND applies_to <@ ARRAY['tenant', 'lease', 'rate_plan', 'invoice', 'deposit', 'access', 'notice', 'collection_step']::text[]);

CREATE TYPE juristic.collection_action AS ENUM ('remind', 'surcharge', 'notice_letter', 'suspend_services', 'lawyer_letter', 'legal_action');
CREATE TYPE juristic.collection_channel AS ENUM ('line', 'email', 'sms', 'letter');
CREATE TYPE juristic.collection_case_state AS ENUM ('open', 'paused', 'resolved');
CREATE TYPE juristic.collection_event_kind AS ENUM ('opened', 'step', 'paused', 'resumed', 'dispute_opened', 'dispute_closed', 'resolved');
CREATE TYPE juristic.collection_outcome AS ENUM ('sent', 'skipped', 'awaiting_approval', 'approved', 'refused', 'failed');
CREATE TYPE juristic.letter_batch_state AS ENUM ('queued', 'ready', 'failed');
CREATE TYPE juristic.workspace_link_state AS ENUM ('invited', 'active', 'revoked');

-- ------------------------------------------------------------------------------- ladder (§7.6 J1-j, J1-k)
CREATE TABLE juristic.collection_ladder (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  legal_form           core.building_legal_form NOT NULL,
  name                 text NOT NULL,
  source_template_key  text NOT NULL,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              integer NOT NULL DEFAULT 1,
  CONSTRAINT collection_ladder_pkey PRIMARY KEY (id),
  CONSTRAINT collection_ladder_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_ladder_name_check CHECK (length(name) BETWEEN 1 AND 200)
);
COMMENT ON TABLE juristic.collection_ladder IS 'D-305 / D-326 (J1.2b): the collections ladder of a juristic tenant for one building legal form, copied from the code template on first use; edited by owner / manager.';
CREATE UNIQUE INDEX collection_ladder_tenant_id_legal_form_key ON juristic.collection_ladder (tenant_id, legal_form);
SELECT platform.apply_rls('juristic.collection_ladder', 'tenant');

CREATE TABLE juristic.collection_step (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  ladder_id          uuid NOT NULL,
  seq                smallint NOT NULL,
  offset_days        integer NOT NULL,
  action             juristic.collection_action NOT NULL,
  channels           juristic.collection_channel[] NOT NULL DEFAULT '{}',
  template_key       text NOT NULL,
  requires_approval  boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT false,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT collection_step_pkey PRIMARY KEY (id),
  CONSTRAINT collection_step_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_step_ladder_id_fkey FOREIGN KEY (ladder_id) REFERENCES juristic.collection_ladder (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT collection_step_seq_check CHECK (seq BETWEEN 1 AND 50),
  CONSTRAINT collection_step_offset_days_check CHECK (offset_days BETWEEN 0 AND 3650),
  CONSTRAINT collection_step_template_key_check CHECK (length(template_key) BETWEEN 1 AND 120),
  CONSTRAINT collection_step_approval_check CHECK (action NOT IN ('suspend_services', 'lawyer_letter', 'legal_action') OR requires_approval)
);
COMMENT ON TABLE juristic.collection_step IS 'D-305 / D-326 (J1.2b): one step of a ladder (days after the oldest due date, action, channels, template, approval). suspend_services / lawyer_letter / legal_action always need approval; surcharge and every legal measure stay disabled until counsel (O-038).';
CREATE UNIQUE INDEX collection_step_ladder_id_seq_key ON juristic.collection_step (ladder_id, seq);
SELECT platform.apply_rls('juristic.collection_step', 'tenant');

-- ------------------------------------------------------------------------------- cases (§7.6 J1-l, J1-m)
CREATE TABLE juristic.collection_case (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  unit_id               uuid NOT NULL,
  party_id              uuid NOT NULL,
  ladder_id             uuid NOT NULL,
  legal_form            core.building_legal_form NOT NULL,
  state                 juristic.collection_case_state NOT NULL DEFAULT 'open',
  anchor_on             date NOT NULL,
  opened_at             timestamptz(6) NOT NULL DEFAULT now(),
  next_seq              smallint NOT NULL DEFAULT 1,
  awaiting_step_id      uuid,
  plan_id               uuid,
  dispute_opened_at     timestamptz(6),
  dispute_reason        text,
  paused_at             timestamptz(6),
  paused_days           integer NOT NULL DEFAULT 0,
  surcharged_through    date,
  resolved_at           timestamptz(6),
  resolve_reason        text,
  workflow_instance_id  uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT collection_case_pkey PRIMARY KEY (id),
  CONSTRAINT collection_case_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_ladder_id_fkey FOREIGN KEY (ladder_id) REFERENCES juristic.collection_ladder (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_awaiting_step_id_fkey FOREIGN KEY (awaiting_step_id) REFERENCES juristic.collection_step (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES juristic.payment_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_workflow_instance_id_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_case_paused_days_check CHECK (paused_days >= 0),
  CONSTRAINT collection_case_dispute_reason_check CHECK (dispute_reason IS NULL OR length(dispute_reason) <= 1000),
  CONSTRAINT collection_case_paused_check CHECK ((state = 'paused') = (paused_at IS NOT NULL)),
  CONSTRAINT collection_case_resolved_check CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
COMMENT ON TABLE juristic.collection_case IS 'D-305 / D-326 (J1.2b): the collections of one billed party for one unit, opened when an invoice becomes overdue; paused while an approved payment plan is active or a dispute is open; resolved when nothing is owed. Kept 10 years.';
CREATE UNIQUE INDEX collection_case_open_key ON juristic.collection_case (party_id, unit_id) WHERE (state IN ('open', 'paused'));
CREATE INDEX collection_case_tenant_id_state_idx ON juristic.collection_case (tenant_id, state);
CREATE INDEX collection_case_unit_id_idx ON juristic.collection_case (unit_id);
CREATE INDEX collection_case_plan_id_idx ON juristic.collection_case (plan_id) WHERE (plan_id IS NOT NULL);
SELECT platform.apply_rls('juristic.collection_case', 'tenant');

CREATE TABLE juristic.collection_event (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  case_id            uuid NOT NULL,
  kind               juristic.collection_event_kind NOT NULL,
  step_id            uuid,
  seq                smallint,
  action             juristic.collection_action,
  outcome            juristic.collection_outcome,
  reason             text,
  amount             numeric(14,2),
  invoice_charge_id  uuid,
  document_id        uuid,
  actor_user_id      uuid,
  payload            jsonb NOT NULL DEFAULT '{}',
  occurred_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT collection_event_pkey PRIMARY KEY (id),
  CONSTRAINT collection_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_case_id_fkey FOREIGN KEY (case_id) REFERENCES juristic.collection_case (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_step_id_fkey FOREIGN KEY (step_id) REFERENCES juristic.collection_step (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_invoice_charge_id_fkey FOREIGN KEY (invoice_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT collection_event_step_check CHECK ((kind = 'step') = (step_id IS NOT NULL AND outcome IS NOT NULL AND action IS NOT NULL)),
  CONSTRAINT collection_event_reason_check CHECK (reason IS NULL OR length(reason) <= 1000),
  CONSTRAINT collection_event_amount_check CHECK (amount IS NULL OR amount >= 0)
);
COMMENT ON TABLE juristic.collection_event IS 'D-305 / D-326 (J1.2b): append-only timeline of a collection case (evidence for disputes). A step has at most one final outcome (sent / skipped / refused / failed) per case: each step runs once.';
CREATE UNIQUE INDEX collection_event_step_final_key ON juristic.collection_event (case_id, step_id)
  WHERE (kind = 'step' AND outcome IN ('sent', 'skipped', 'refused', 'failed'));
CREATE UNIQUE INDEX collection_event_step_outcome_key ON juristic.collection_event (case_id, step_id, outcome) WHERE (kind = 'step');
CREATE INDEX collection_event_case_id_occurred_at_idx ON juristic.collection_event (case_id, occurred_at);
CREATE INDEX collection_event_tenant_id_occurred_at_idx ON juristic.collection_event (tenant_id, occurred_at DESC);
SELECT platform.apply_rls('juristic.collection_event', 'tenant');
REVOKE DELETE ON juristic.collection_event FROM gp_app;
-- append-only: the only change allowed is attaching the letter PDF once (document_id null → value, worker)
CREATE FUNCTION juristic.collection_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.document_id IS NULL AND NEW.document_id IS NOT NULL
     AND (NEW.id, NEW.tenant_id, NEW.case_id, NEW.kind, NEW.step_id, NEW.seq, NEW.action, NEW.outcome, NEW.reason,
          NEW.amount, NEW.invoice_charge_id, NEW.actor_user_id, NEW.payload, NEW.occurred_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.case_id, OLD.kind, OLD.step_id, OLD.seq, OLD.action, OLD.outcome, OLD.reason,
          OLD.amount, OLD.invoice_charge_id, OLD.actor_user_id, OLD.payload, OLD.occurred_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'juristic.collection_event is append-only (only a letter document may be attached once)'
    USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER collection_event_append_only BEFORE UPDATE ON juristic.collection_event
  FOR EACH ROW EXECUTE FUNCTION juristic.collection_event_guard();

-- ------------------------------------------------------------------------------- statements (§7.6 J1-q)
CREATE TABLE juristic.letter_batch (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  period_key     text NOT NULL,
  state          juristic.letter_batch_state NOT NULL DEFAULT 'queued',
  statement_ids  uuid[] NOT NULL DEFAULT '{}',
  document_id    uuid,
  error          text,
  requested_by   uuid,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  finished_at    timestamptz(6),
  CONSTRAINT letter_batch_pkey PRIMARY KEY (id),
  CONSTRAINT letter_batch_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT letter_batch_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT letter_batch_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT letter_batch_period_key_check CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT letter_batch_ready_check CHECK ((state = 'ready') = (document_id IS NOT NULL))
);
COMMENT ON TABLE juristic.letter_batch IS 'D-307 / D-326 (J1.2b): one printable A4 PDF (address window) of the statements of a month for owners with no LINE, e-mail or phone; built by the worker.';
CREATE INDEX letter_batch_tenant_id_created_at_idx ON juristic.letter_batch (tenant_id, created_at DESC);
SELECT platform.apply_rls('juristic.letter_batch', 'tenant');

CREATE TABLE juristic.statement (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  party_id         uuid NOT NULL,
  number           text NOT NULL,
  period_key       text NOT NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  language         char(2) NOT NULL DEFAULT 'th',
  unit_ids         uuid[] NOT NULL DEFAULT '{}',
  invoice_ids      uuid[] NOT NULL DEFAULT '{}',
  opening          numeric(14,2) NOT NULL,
  charges          numeric(14,2) NOT NULL,
  credits          numeric(14,2) NOT NULL,
  payments         numeric(14,2) NOT NULL,
  closing          numeric(14,2) NOT NULL,
  amount_due       numeric(14,2) NOT NULL,
  snapshot         jsonb NOT NULL DEFAULT '{}',
  document_id      uuid,
  delivered_via    text[] NOT NULL DEFAULT '{}',
  letter_batch_id  uuid,
  payment_ids      uuid[] NOT NULL DEFAULT '{}',
  issued_at        timestamptz(6) NOT NULL DEFAULT now(),
  issued_by        uuid,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT statement_pkey PRIMARY KEY (id),
  CONSTRAINT statement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT statement_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT statement_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT statement_letter_batch_id_fkey FOREIGN KEY (letter_batch_id) REFERENCES juristic.letter_batch (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT statement_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT statement_period_key_check CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT statement_period_check CHECK (period_end >= period_start),
  CONSTRAINT statement_language_check CHECK (language IN ('th', 'en')),
  CONSTRAINT statement_amount_due_check CHECK (amount_due >= 0),
  CONSTRAINT statement_closing_check CHECK (closing = opening + charges - credits - payments)
);
COMMENT ON TABLE juristic.statement IS 'D-307 / D-326 (J1.2b): the monthly statement of one owner party across all their units in the tenant (number STM, gapless): opening, charges, credits, payments, closing and what is due now; PDF + LINE Flex + e-mail, or a printed letter. Kept 10 years.';
CREATE UNIQUE INDEX statement_tenant_id_party_id_period_key ON juristic.statement (tenant_id, party_id, period_start);
CREATE UNIQUE INDEX statement_tenant_id_number_key ON juristic.statement (tenant_id, number);
CREATE INDEX statement_tenant_id_period_key_idx ON juristic.statement (tenant_id, period_key);
CREATE INDEX statement_party_id_idx ON juristic.statement (party_id);
SELECT platform.apply_rls('juristic.statement', 'tenant');
REVOKE DELETE ON juristic.statement FROM gp_app;

-- ------------------------------------------------------------------------------- D-270 workspace (§7.6 J1-u)
CREATE TABLE juristic.workspace_link (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  unit_ids            uuid[] NOT NULL,
  office_name         text NOT NULL,
  office_phone        text,
  state               juristic.workspace_link_state NOT NULL DEFAULT 'invited',
  code_hash           bytea NOT NULL,
  code_hint           text NOT NULL,
  expires_at          timestamptz(6) NOT NULL,
  juristic_tenant_id  uuid,
  landlord_party_id   uuid,
  grant_ids           uuid[] NOT NULL DEFAULT '{}',
  invited_by          uuid,
  accepted_at         timestamptz(6),
  accepted_by         uuid,
  revoked_at          timestamptz(6),
  revoke_reason       text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT workspace_link_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_link_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_juristic_tenant_id_fkey FOREIGN KEY (juristic_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_landlord_party_id_fkey FOREIGN KEY (landlord_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workspace_link_units_check CHECK (cardinality(unit_ids) BETWEEN 1 AND 50),
  CONSTRAINT workspace_link_office_name_check CHECK (length(office_name) BETWEEN 1 AND 200),
  CONSTRAINT workspace_link_other_tenant_check CHECK (juristic_tenant_id IS NULL OR juristic_tenant_id <> tenant_id),
  CONSTRAINT workspace_link_active_check CHECK ((state = 'active') = (accepted_at IS NOT NULL AND juristic_tenant_id IS NOT NULL AND revoked_at IS NULL) OR state = 'revoked'),
  CONSTRAINT workspace_link_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
COMMENT ON TABLE juristic.workspace_link IS 'D-270 / D-326 (J1.2b): a landlord invites the juristic office of its condo for its units in a stub building; on acceptance the office''s juristic tenant gets unit-scope grants (module juristic only) to those units and bills the landlord its common fees. Revoked → grants revoked.';
CREATE UNIQUE INDEX workspace_link_code_hash_key ON juristic.workspace_link (code_hash);
CREATE INDEX workspace_link_tenant_id_state_idx ON juristic.workspace_link (tenant_id, state);
CREATE INDEX workspace_link_juristic_tenant_id_idx ON juristic.workspace_link (juristic_tenant_id) WHERE (juristic_tenant_id IS NOT NULL);
SELECT platform.apply_rls('juristic.workspace_link', 'tenant');
REVOKE DELETE ON juristic.workspace_link FROM gp_app;
