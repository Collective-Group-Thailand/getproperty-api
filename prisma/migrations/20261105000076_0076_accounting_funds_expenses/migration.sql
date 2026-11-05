-- getproperty-api 0076 — light GL, expenses with approval bands, withholding tax, petty cash, funds, bank statements
-- (Phase J step J2.1, D-311, D-312, D-329). schema-design §7.5 rows 251–266 (§7.6 J2-a … J2-j).
--   * juristic.account (chart per tenant, copied from the code template of a legal form), juristic.journal /
--     journal_line: double entry, BALANCED at commit (deferred constraint triggers: Σ debit = Σ credit, ≥ 2 lines),
--     IMMUTABLE (no UPDATE / DELETE for anyone — corrections are reversal journals), a credit to a fund bank account
--     needs a resolution (money leaving a fund, D-311).
--   * juristic.fund (+ fund_transfer: out needs a resolution — CHECK — and another user's approval — CHECK).
--   * juristic.expense_request (+ lines, attachments, append-only approvals with a maker-checker trigger),
--     juristic.withholding_certificate (50 ทวิ, series WHT), juristic.petty_cash (+ entries, counts).
--   * juristic.bank_statement / bank_statement_line (idempotent import by file checksum and line key, matching queue).
--   * juristic.revenue_schedule gains recognised_amount / journal_id (J2.1 recognition); budget_line.account_id FK.
--   * ops.document_type + expense_request, withholding_certificate; ops.export_kind + 3 journal export formats.
-- DDL only (no DML on RLS tables); no core.* change.

ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'expense_request';
ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'withholding_certificate';
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'juristic_journal_csv';
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'juristic_journal_express';
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'juristic_journal_flowaccount';

CREATE TYPE juristic.account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE juristic.journal_source AS ENUM ('invoice', 'invoice_void', 'credit_note', 'debit_note', 'payment', 'payment_reversal',
  'refund', 'revenue_recognition', 'expense_payment', 'petty_cash', 'fund_transfer', 'manual', 'opening', 'reversal');
CREATE TYPE juristic.fund_kind AS ENUM ('sinking', 'reserve', 'other');
CREATE TYPE juristic.fund_transfer_direction AS ENUM ('in', 'out');
CREATE TYPE juristic.fund_transfer_state AS ENUM ('requested', 'posted', 'rejected', 'cancelled');
CREATE TYPE juristic.expense_kind AS ENUM ('expense', 'petty_cash_top_up');
CREATE TYPE juristic.expense_state AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled');
CREATE TYPE juristic.expense_decision AS ENUM ('approved', 'rejected');
CREATE TYPE juristic.expense_payment_method AS ENUM ('bank_transfer', 'cheque', 'cash', 'fund');
CREATE TYPE juristic.expense_attachment_kind AS ENUM ('quotation', 'invoice', 'receipt', 'payment_evidence', 'other');
CREATE TYPE juristic.wht_form AS ENUM ('pnd3', 'pnd53');
CREATE TYPE juristic.petty_cash_entry_kind AS ENUM ('top_up', 'spend', 'count_difference');
CREATE TYPE juristic.bank_line_match AS ENUM ('none', 'payment', 'expense', 'fund_transfer', 'ignored');

-- ------------------------------------------------------------------------------- funds (§7.6 J2-d)
CREATE TABLE juristic.fund (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  kind             juristic.fund_kind NOT NULL DEFAULT 'sinking',
  name             text NOT NULL,
  bank_account_id  uuid,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT fund_pkey PRIMARY KEY (id),
  CONSTRAINT fund_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_name_check CHECK (length(name) BETWEEN 1 AND 120)
);
COMMENT ON TABLE juristic.fund IS 'D-311 / D-329 (J2.1): a fund of a building (sinking fund first) with its own ledger (fund bank + fund equity accounts) and bank account; money leaves it only with a resolution.';
CREATE UNIQUE INDEX fund_building_id_kind_name_key ON juristic.fund (building_id, kind, name);
CREATE INDEX fund_tenant_id_idx ON juristic.fund (tenant_id);
CREATE INDEX fund_bank_account_id_idx ON juristic.fund (bank_account_id) WHERE (bank_account_id IS NOT NULL);
SELECT platform.apply_rls('juristic.fund', 'tenant');

-- ------------------------------------------------------------------------------- chart of accounts (§7.6 J2-a)
CREATE TABLE juristic.account (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  code             text NOT NULL,
  name_th          text NOT NULL,
  name_en          text NOT NULL,
  type             juristic.account_type NOT NULL,
  role             text,
  fund_id          uuid,
  bank_account_id  uuid,
  is_system        boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  source_template_key text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT account_pkey PRIMARY KEY (id),
  CONSTRAINT account_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT account_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES juristic.fund (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT account_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT account_code_check CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'),
  CONSTRAINT account_name_th_check CHECK (length(name_th) BETWEEN 1 AND 200),
  CONSTRAINT account_name_en_check CHECK (length(name_en) BETWEEN 1 AND 200),
  CONSTRAINT account_role_check CHECK (role IS NULL OR role ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT account_fund_role_check CHECK (fund_id IS NULL OR role IN ('fund_bank', 'fund_equity'))
);
COMMENT ON TABLE juristic.account IS 'D-312 / D-329 (J2.1): the juristic chart of accounts of a tenant, copied once from the code template of a legal form (accounting/chart-templates.ts) and then edited by the tenant; role = the posting rule key of system accounts.';
CREATE UNIQUE INDEX account_tenant_id_code_key ON juristic.account (tenant_id, code);
CREATE UNIQUE INDEX account_tenant_id_role_key ON juristic.account (tenant_id, role) WHERE (role IS NOT NULL AND fund_id IS NULL);
CREATE UNIQUE INDEX account_fund_id_role_key ON juristic.account (fund_id, role) WHERE (fund_id IS NOT NULL);
CREATE INDEX account_bank_account_id_idx ON juristic.account (bank_account_id) WHERE (bank_account_id IS NOT NULL);
SELECT platform.apply_rls('juristic.account', 'tenant');

ALTER TABLE juristic.budget_line ADD CONSTRAINT budget_line_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX budget_line_account_id_idx ON juristic.budget_line (account_id) WHERE (account_id IS NOT NULL);

-- ------------------------------------------------------------------------------- journals (§7.6 J2-b, J2-c)
CREATE TABLE juristic.journal (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  posted_on            date NOT NULL,
  source_type          juristic.journal_source NOT NULL,
  source_id            uuid,
  memo                 text NOT NULL,
  reverses_journal_id  uuid,
  resolution_id        uuid,
  fund_id              uuid,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  CONSTRAINT journal_pkey PRIMARY KEY (id),
  CONSTRAINT journal_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_reverses_journal_id_fkey FOREIGN KEY (reverses_journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES juristic.fund (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_memo_check CHECK (length(memo) BETWEEN 1 AND 500),
  CONSTRAINT journal_reversal_check CHECK ((source_type = 'reversal') = (reverses_journal_id IS NOT NULL)),
  CONSTRAINT journal_source_check CHECK (source_type IN ('manual', 'opening') OR source_id IS NOT NULL)
);
COMMENT ON TABLE juristic.journal IS 'D-312 / D-329 (J2.1): a double-entry journal of a building, posted by the ledger subscriber / job or by hand; balanced at commit, immutable (reversal journals only). Kept 10 years (⚖ O-025 (b)).';
CREATE UNIQUE INDEX journal_source_key ON juristic.journal (tenant_id, source_type, source_id) WHERE (source_id IS NOT NULL);
CREATE INDEX journal_tenant_id_building_id_posted_on_idx ON juristic.journal (tenant_id, building_id, posted_on);
CREATE INDEX journal_resolution_id_idx ON juristic.journal (resolution_id) WHERE (resolution_id IS NOT NULL);
CREATE INDEX journal_fund_id_idx ON juristic.journal (fund_id) WHERE (fund_id IS NOT NULL);
SELECT platform.apply_rls('juristic.journal', 'tenant');

CREATE TABLE juristic.journal_line (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  journal_id  uuid NOT NULL,
  line_no     smallint NOT NULL,
  account_id  uuid NOT NULL,
  debit       numeric(14,2) NOT NULL DEFAULT 0,
  credit      numeric(14,2) NOT NULL DEFAULT 0,
  unit_id     uuid,
  party_id    uuid,
  memo        text,
  CONSTRAINT journal_line_pkey PRIMARY KEY (id),
  CONSTRAINT journal_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_line_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_line_account_id_fkey FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_line_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_line_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT journal_line_side_check CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0))),
  CONSTRAINT journal_line_memo_check CHECK (memo IS NULL OR length(memo) <= 500)
);
COMMENT ON TABLE juristic.journal_line IS 'D-312 (J2.1): one side of a journal — a debit or a credit (never both, never zero) on an account, optionally of a unit / party.';
CREATE UNIQUE INDEX journal_line_journal_id_line_no_key ON juristic.journal_line (journal_id, line_no);
CREATE INDEX journal_line_account_id_idx ON juristic.journal_line (account_id);
CREATE INDEX journal_line_tenant_id_idx ON juristic.journal_line (tenant_id);
CREATE INDEX journal_line_unit_id_idx ON juristic.journal_line (unit_id) WHERE (unit_id IS NOT NULL);
CREATE INDEX journal_line_party_id_idx ON juristic.journal_line (party_id) WHERE (party_id IS NOT NULL);
SELECT platform.apply_rls('juristic.journal_line', 'tenant');

-- balanced at commit: Σ debit = Σ credit and at least two lines; a credit to a fund bank account (money leaving a fund)
-- needs the journal's resolution unless it reverses an earlier journal (D-311)
CREATE FUNCTION juristic.journal_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  jid uuid;
  j   juristic.journal%ROWTYPE;
  d   numeric;
  c   numeric;
  n   integer;
BEGIN
  IF TG_TABLE_NAME = 'journal' THEN
    jid := NEW.id;
  ELSE
    jid := NEW.journal_id;
  END IF;
  SELECT * INTO j FROM juristic.journal WHERE id = jid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM juristic.journal_line WHERE journal_id = jid;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % has % line(s); a journal needs a debit and a credit', jid, n
      USING ERRCODE = '23514', CONSTRAINT = 'journal_balanced';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal % is not balanced (debit %, credit %)', jid, d, c
      USING ERRCODE = '23514', CONSTRAINT = 'journal_balanced';
  END IF;
  IF j.resolution_id IS NULL AND j.source_type <> 'reversal' AND EXISTS (
       SELECT 1 FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
        WHERE l.journal_id = jid AND l.credit > 0 AND a.role = 'fund_bank') THEN
    RAISE EXCEPTION 'journal % takes money out of a fund without a resolution', jid
      USING ERRCODE = '23514', CONSTRAINT = 'journal_fund_resolution';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON juristic.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION juristic.journal_check();
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON juristic.journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION juristic.journal_check();

-- immutable after post: corrections are reversal journals
CREATE FUNCTION juristic.ledger_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable once posted; post a reversal journal', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON juristic.journal
  FOR EACH ROW EXECUTE FUNCTION juristic.ledger_immutable();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON juristic.journal_line
  FOR EACH ROW EXECUTE FUNCTION juristic.ledger_immutable();
REVOKE UPDATE, DELETE ON juristic.journal FROM gp_app;
REVOKE UPDATE, DELETE ON juristic.journal_line FROM gp_app;

CREATE UNIQUE INDEX journal_reverses_journal_id_key ON juristic.journal (reverses_journal_id) WHERE (reverses_journal_id IS NOT NULL);

-- revenue recognition (D-323 → D-329): recognised_amount = amount − credited_amount, posted by the juristic-ledger job
ALTER TABLE juristic.revenue_schedule ADD COLUMN recognised_amount numeric(14,2);
ALTER TABLE juristic.revenue_schedule ADD COLUMN journal_id uuid;
-- credit notes on a scheduled line take the unearned part from the last months first (D-329)
ALTER TABLE juristic.revenue_schedule ADD COLUMN credited_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE juristic.revenue_schedule ADD CONSTRAINT revenue_schedule_credited_check
  CHECK (credited_amount >= 0 AND (amount <= 0 OR credited_amount <= amount) AND (amount > 0 OR credited_amount = 0));
ALTER TABLE juristic.revenue_schedule ADD CONSTRAINT revenue_schedule_journal_id_fkey
  FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE juristic.revenue_schedule ADD CONSTRAINT revenue_schedule_recognised_check
  CHECK ((recognised_at IS NULL) = (recognised_amount IS NULL));
CREATE INDEX revenue_schedule_due_idx ON juristic.revenue_schedule (month) WHERE (recognised_at IS NULL);
CREATE INDEX revenue_schedule_journal_id_idx ON juristic.revenue_schedule (journal_id) WHERE (journal_id IS NOT NULL);

-- ------------------------------------------------------------------------------- fund transfers (§7.6 J2-d)
CREATE TABLE juristic.fund_transfer (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  fund_id             uuid NOT NULL,
  direction           juristic.fund_transfer_direction NOT NULL,
  amount              numeric(14,2) NOT NULL,
  counter_account_id  uuid NOT NULL,
  transfer_on         date NOT NULL,
  resolution_id       uuid,
  reference           text,
  note                text,
  state               juristic.fund_transfer_state NOT NULL DEFAULT 'requested',
  requested_by        uuid NOT NULL,
  requested_at        timestamptz(6) NOT NULL DEFAULT now(),
  decided_by          uuid,
  decided_at          timestamptz(6),
  decision_reason     text,
  journal_id          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT fund_transfer_pkey PRIMARY KEY (id),
  CONSTRAINT fund_transfer_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES juristic.fund (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_counter_account_id_fkey FOREIGN KEY (counter_account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fund_transfer_amount_check CHECK (amount > 0),
  CONSTRAINT fund_transfer_resolution_check CHECK (direction <> 'out' OR resolution_id IS NOT NULL),
  CONSTRAINT fund_transfer_maker_checker_check CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT fund_transfer_posted_check CHECK ((state = 'posted') = (journal_id IS NOT NULL)),
  CONSTRAINT fund_transfer_decided_check CHECK ((state IN ('posted', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT fund_transfer_reference_check CHECK (reference IS NULL OR length(reference) <= 100),
  CONSTRAINT fund_transfer_note_check CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT fund_transfer_reason_check CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000)
);
COMMENT ON TABLE juristic.fund_transfer IS 'D-311 / D-329 (J2.1): money into or out of a fund; out needs an adopted resolution (CHECK) and another user''s approval (maker-checker CHECK); the approval posts the journal.';
CREATE INDEX fund_transfer_fund_id_idx ON juristic.fund_transfer (fund_id, requested_at DESC);
CREATE INDEX fund_transfer_tenant_id_state_idx ON juristic.fund_transfer (tenant_id, state);
SELECT platform.apply_rls('juristic.fund_transfer', 'tenant');
REVOKE DELETE ON juristic.fund_transfer FROM gp_app;

-- ------------------------------------------------------------------------------- petty cash (§7.6 J2-g)
CREATE TABLE juristic.petty_cash (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  building_id        uuid NOT NULL,
  name               text NOT NULL,
  custodian_user_id  uuid NOT NULL,
  float_amount       numeric(14,2) NOT NULL,
  account_id         uuid NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT petty_cash_pkey PRIMARY KEY (id),
  CONSTRAINT petty_cash_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_custodian_user_id_fkey FOREIGN KEY (custodian_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_account_id_fkey FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_name_check CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT petty_cash_float_amount_check CHECK (float_amount > 0)
);
COMMENT ON TABLE juristic.petty_cash IS 'D-311 / D-329 (J2.1): a petty cash float of a building held by a custodian, with its own GL account; balance = Σ entries.';
CREATE UNIQUE INDEX petty_cash_building_id_name_key ON juristic.petty_cash (building_id, name);
CREATE UNIQUE INDEX petty_cash_account_id_key ON juristic.petty_cash (account_id);
CREATE INDEX petty_cash_tenant_id_idx ON juristic.petty_cash (tenant_id);
SELECT platform.apply_rls('juristic.petty_cash', 'tenant');

-- ------------------------------------------------------------------------------- expenses (§7.6 J2-e, J2-f)
CREATE TABLE juristic.expense_request (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  number                citext,
  kind                  juristic.expense_kind NOT NULL DEFAULT 'expense',
  title                 text NOT NULL,
  payee_party_id        uuid,
  payee_name            text NOT NULL,
  petty_cash_id         uuid,
  fund_id               uuid,
  resolution_id         uuid,
  state                 juristic.expense_state NOT NULL DEFAULT 'draft',
  amount                numeric(14,2) NOT NULL DEFAULT 0,
  wht_amount            numeric(14,2) NOT NULL DEFAULT 0,
  net_amount            numeric(14,2) NOT NULL DEFAULT 0,
  band                  jsonb,
  approvals_required    smallint,
  approver_roles        text[] NOT NULL DEFAULT '{}',
  requested_by          uuid NOT NULL,
  submitted_at          timestamptz(6),
  approved_at           timestamptz(6),
  rejected_at           timestamptz(6),
  decision_reason       text,
  cancelled_at          timestamptz(6),
  cancel_reason         text,
  paid_at               timestamptz(6),
  paid_on               date,
  payment_method        juristic.expense_payment_method,
  payment_reference     text,
  paid_from_account_id  uuid,
  paid_by               uuid,
  journal_id            uuid,
  note                  text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT expense_request_pkey PRIMARY KEY (id),
  CONSTRAINT expense_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_payee_party_id_fkey FOREIGN KEY (payee_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_petty_cash_id_fkey FOREIGN KEY (petty_cash_id) REFERENCES juristic.petty_cash (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES juristic.fund (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_paid_from_account_id_fkey FOREIGN KEY (paid_from_account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT expense_request_payee_name_check CHECK (length(payee_name) BETWEEN 1 AND 200),
  CONSTRAINT expense_request_amounts_check CHECK (amount >= 0 AND wht_amount >= 0 AND wht_amount <= amount AND net_amount = amount - wht_amount),
  CONSTRAINT expense_request_fund_resolution_check CHECK (fund_id IS NULL OR resolution_id IS NOT NULL),
  CONSTRAINT expense_request_top_up_check CHECK ((kind = 'petty_cash_top_up') = (petty_cash_id IS NOT NULL) AND (kind = 'expense' OR fund_id IS NULL)),
  CONSTRAINT expense_request_paid_check CHECK ((state = 'paid') = (paid_at IS NOT NULL AND journal_id IS NOT NULL AND payment_method IS NOT NULL AND paid_on IS NOT NULL)),
  CONSTRAINT expense_request_submitted_check CHECK (state IN ('draft', 'cancelled') OR (submitted_at IS NOT NULL AND number IS NOT NULL AND approvals_required IS NOT NULL)),
  CONSTRAINT expense_request_approvals_check CHECK (approvals_required IS NULL OR approvals_required BETWEEN 1 AND 5),
  CONSTRAINT expense_request_reference_check CHECK (payment_reference IS NULL OR length(payment_reference) <= 100),
  CONSTRAINT expense_request_note_check CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT expense_request_reasons_check CHECK ((decision_reason IS NULL OR length(decision_reason) <= 1000) AND (cancel_reason IS NULL OR length(cancel_reason) <= 1000))
);
COMMENT ON TABLE juristic.expense_request IS 'D-311 / D-329 (J2.1): a spending request (or a petty cash top-up): draft → submitted (band snapshot) → approved by the band''s roles (maker-checker) → paid (journal, WHT certificate). Paid from a fund only with a resolution (CHECK). Kept 10 years.';
CREATE UNIQUE INDEX expense_request_tenant_id_number_key ON juristic.expense_request (tenant_id, number) WHERE (number IS NOT NULL);
CREATE INDEX expense_request_tenant_id_state_idx ON juristic.expense_request (tenant_id, state, created_at DESC);
CREATE INDEX expense_request_building_id_idx ON juristic.expense_request (building_id);
CREATE INDEX expense_request_fund_id_idx ON juristic.expense_request (fund_id) WHERE (fund_id IS NOT NULL);
CREATE INDEX expense_request_petty_cash_id_idx ON juristic.expense_request (petty_cash_id) WHERE (petty_cash_id IS NOT NULL);
SELECT platform.apply_rls('juristic.expense_request', 'tenant');
REVOKE DELETE ON juristic.expense_request FROM gp_app;

CREATE TABLE juristic.expense_request_line (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  expense_request_id  uuid NOT NULL,
  line_no             smallint NOT NULL,
  account_id          uuid NOT NULL,
  description         text NOT NULL,
  amount              numeric(14,2) NOT NULL,
  vat_amount          numeric(14,2) NOT NULL DEFAULT 0,
  wht_key             text,
  wht_income_type     text,
  wht_rate            numeric(5,2),
  wht_amount          numeric(14,2) NOT NULL DEFAULT 0,
  CONSTRAINT expense_request_line_pkey PRIMARY KEY (id),
  CONSTRAINT expense_request_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_line_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT expense_request_line_account_id_fkey FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_request_line_description_check CHECK (length(description) BETWEEN 1 AND 300),
  CONSTRAINT expense_request_line_amount_check CHECK (amount > 0 AND vat_amount >= 0 AND vat_amount <= amount),
  CONSTRAINT expense_request_line_wht_check CHECK ((wht_key IS NULL) = (wht_rate IS NULL) AND (wht_rate IS NULL OR (wht_rate > 0 AND wht_rate <= 100)) AND wht_amount >= 0 AND wht_amount <= amount - vat_amount AND (wht_key IS NOT NULL OR wht_amount = 0))
);
COMMENT ON TABLE juristic.expense_request_line IS 'D-329 (J2.1): a line of an expense request (expense account, amount incl. VAT, optional withholding-tax rate snapshotted from juristic.wht_rates).';
CREATE UNIQUE INDEX expense_request_line_request_id_line_no_key ON juristic.expense_request_line (expense_request_id, line_no);
CREATE INDEX expense_request_line_account_id_idx ON juristic.expense_request_line (account_id);
SELECT platform.apply_rls('juristic.expense_request_line', 'tenant');

CREATE TABLE juristic.expense_attachment (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  expense_request_id  uuid NOT NULL,
  document_id         uuid NOT NULL,
  kind                juristic.expense_attachment_kind NOT NULL,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT expense_attachment_pkey PRIMARY KEY (id),
  CONSTRAINT expense_attachment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_attachment_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_attachment_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE juristic.expense_attachment IS 'D-329 (J2.1): quotations, the vendor''s invoice / receipt and the payment evidence of an expense request.';
CREATE UNIQUE INDEX expense_attachment_request_id_document_id_key ON juristic.expense_attachment (expense_request_id, document_id);
CREATE INDEX expense_attachment_document_id_idx ON juristic.expense_attachment (document_id);
SELECT platform.apply_rls('juristic.expense_attachment', 'tenant');
REVOKE UPDATE, DELETE ON juristic.expense_attachment FROM gp_app;

CREATE TABLE juristic.expense_approval (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  expense_request_id  uuid NOT NULL,
  approver_user_id    uuid NOT NULL,
  role                text NOT NULL,
  decision            juristic.expense_decision NOT NULL,
  reason              text,
  band_key            text NOT NULL,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT expense_approval_pkey PRIMARY KEY (id),
  CONSTRAINT expense_approval_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_approval_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_approval_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT expense_approval_role_check CHECK (role IN ('owner', 'manager', 'committee')),
  CONSTRAINT expense_approval_reason_check CHECK (reason IS NULL OR length(reason) <= 1000)
);
COMMENT ON TABLE juristic.expense_approval IS 'D-091 / D-311 / D-329 (J2.1): one approver''s decision on an expense request (append-only); the approver is never the requester (trigger).';
CREATE UNIQUE INDEX expense_approval_request_id_approver_key ON juristic.expense_approval (expense_request_id, approver_user_id);
CREATE INDEX expense_approval_tenant_id_idx ON juristic.expense_approval (tenant_id);
SELECT platform.apply_rls('juristic.expense_approval', 'tenant');
REVOKE UPDATE, DELETE ON juristic.expense_approval FROM gp_app;

CREATE FUNCTION juristic.expense_approval_maker_checker() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM juristic.expense_request r WHERE r.id = NEW.expense_request_id AND r.requested_by = NEW.approver_user_id) THEN
    RAISE EXCEPTION 'the requester of expense request % cannot approve it (maker-checker, D-091)', NEW.expense_request_id
      USING ERRCODE = '23514', CONSTRAINT = 'expense_approval_maker_checker';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER expense_approval_maker_checker BEFORE INSERT ON juristic.expense_approval
  FOR EACH ROW EXECUTE FUNCTION juristic.expense_approval_maker_checker();

-- ------------------------------------------------------------------------------- withholding tax (§7.6 J2-h)
CREATE TABLE juristic.withholding_certificate (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  expense_request_id  uuid NOT NULL,
  payee_party_id      uuid NOT NULL,
  payee_name          text NOT NULL,
  payee_tax_id_hint   text NOT NULL,
  form                juristic.wht_form NOT NULL,
  number              citext NOT NULL,
  items               jsonb NOT NULL,
  base                numeric(14,2) NOT NULL,
  tax                 numeric(14,2) NOT NULL,
  paid_on             date NOT NULL,
  document_id         uuid,
  issued_at           timestamptz(6) NOT NULL DEFAULT now(),
  issued_by           uuid,
  CONSTRAINT withholding_certificate_pkey PRIMARY KEY (id),
  CONSTRAINT withholding_certificate_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT withholding_certificate_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT withholding_certificate_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT withholding_certificate_payee_party_id_fkey FOREIGN KEY (payee_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT withholding_certificate_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT withholding_certificate_amounts_check CHECK (base > 0 AND tax > 0 AND tax <= base),
  CONSTRAINT withholding_certificate_hint_check CHECK (payee_tax_id_hint ~ '^[0-9]{4}$')
);
COMMENT ON TABLE juristic.withholding_certificate IS 'D-311 / D-329 (J2.1, ⚖ O-041): หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) of a paid expense request, gapless series WHT; the PDF is built by the worker. Kept 10 years.';
CREATE UNIQUE INDEX withholding_certificate_tenant_id_number_key ON juristic.withholding_certificate (tenant_id, number);
CREATE UNIQUE INDEX withholding_certificate_expense_request_id_key ON juristic.withholding_certificate (expense_request_id);
CREATE INDEX withholding_certificate_payee_party_id_idx ON juristic.withholding_certificate (payee_party_id);
SELECT platform.apply_rls('juristic.withholding_certificate', 'tenant');
REVOKE DELETE ON juristic.withholding_certificate FROM gp_app;

-- ------------------------------------------------------------------------------- petty cash entries / counts
CREATE TABLE juristic.petty_cash_count (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  petty_cash_id   uuid NOT NULL,
  counted_on      date NOT NULL,
  counted_amount  numeric(14,2) NOT NULL,
  book_balance    numeric(14,2) NOT NULL,
  difference      numeric(14,2) NOT NULL,
  note            text,
  counted_by      uuid,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT petty_cash_count_pkey PRIMARY KEY (id),
  CONSTRAINT petty_cash_count_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_count_petty_cash_id_fkey FOREIGN KEY (petty_cash_id) REFERENCES juristic.petty_cash (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_count_amount_check CHECK (counted_amount >= 0 AND difference = counted_amount - book_balance),
  CONSTRAINT petty_cash_count_note_check CHECK (note IS NULL OR length(note) <= 1000)
);
COMMENT ON TABLE juristic.petty_cash_count IS 'D-329 (J2.1): a cash count of a petty cash float (reconciliation); a difference is posted as an entry.';
CREATE INDEX petty_cash_count_petty_cash_id_idx ON juristic.petty_cash_count (petty_cash_id, counted_on DESC);
SELECT platform.apply_rls('juristic.petty_cash_count', 'tenant');
REVOKE UPDATE, DELETE ON juristic.petty_cash_count FROM gp_app;

CREATE TABLE juristic.petty_cash_entry (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  petty_cash_id        uuid NOT NULL,
  kind                 juristic.petty_cash_entry_kind NOT NULL,
  amount               numeric(14,2) NOT NULL,
  entry_on             date NOT NULL,
  description          text NOT NULL,
  account_id           uuid,
  receipt_document_id  uuid,
  expense_request_id   uuid,
  count_id             uuid,
  journal_id           uuid NOT NULL,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  CONSTRAINT petty_cash_entry_pkey PRIMARY KEY (id),
  CONSTRAINT petty_cash_entry_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_petty_cash_id_fkey FOREIGN KEY (petty_cash_id) REFERENCES juristic.petty_cash (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_account_id_fkey FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_receipt_document_id_fkey FOREIGN KEY (receipt_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_count_id_fkey FOREIGN KEY (count_id) REFERENCES juristic.petty_cash_count (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT petty_cash_entry_description_check CHECK (length(description) BETWEEN 1 AND 300),
  CONSTRAINT petty_cash_entry_kind_check CHECK (
    (kind = 'top_up' AND amount > 0 AND expense_request_id IS NOT NULL)
    OR (kind = 'spend' AND amount < 0 AND account_id IS NOT NULL AND receipt_document_id IS NOT NULL)
    OR (kind = 'count_difference' AND amount <> 0 AND count_id IS NOT NULL))
);
COMMENT ON TABLE juristic.petty_cash_entry IS 'D-329 (J2.1): a movement of a petty cash float — top-up (+, a paid expense request), spend (−, with its receipt) or a count difference; append-only, each with its journal.';
CREATE INDEX petty_cash_entry_petty_cash_id_idx ON juristic.petty_cash_entry (petty_cash_id, entry_on);
CREATE UNIQUE INDEX petty_cash_entry_expense_request_id_key ON juristic.petty_cash_entry (expense_request_id) WHERE (expense_request_id IS NOT NULL);
SELECT platform.apply_rls('juristic.petty_cash_entry', 'tenant');
REVOKE UPDATE, DELETE ON juristic.petty_cash_entry FROM gp_app;

-- ------------------------------------------------------------------------------- bank statements (§7.6 J2-i, J2-j)
CREATE TABLE juristic.bank_statement (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  bank_account_id   uuid NOT NULL,
  account_id        uuid NOT NULL,
  format_key        text NOT NULL,
  file_name         text NOT NULL,
  file_document_id  uuid,
  checksum          bytea NOT NULL,
  period_start      date,
  period_end        date,
  line_count        integer NOT NULL DEFAULT 0,
  duplicate_count   integer NOT NULL DEFAULT 0,
  imported_at       timestamptz(6) NOT NULL DEFAULT now(),
  imported_by       uuid,
  CONSTRAINT bank_statement_pkey PRIMARY KEY (id),
  CONSTRAINT bank_statement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_account_id_fkey FOREIGN KEY (account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_file_document_id_fkey FOREIGN KEY (file_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_format_key_check CHECK (format_key IN ('kbank', 'scb', 'bbl', 'ktb')),
  CONSTRAINT bank_statement_file_name_check CHECK (length(file_name) BETWEEN 1 AND 200),
  CONSTRAINT bank_statement_checksum_check CHECK (length(checksum) = 32),
  CONSTRAINT bank_statement_period_check CHECK (period_start IS NULL OR period_end >= period_start)
);
COMMENT ON TABLE juristic.bank_statement IS 'D-329 (J2.1): an imported bank statement file (column map per bank as data); re-importing the same file (sha256) returns it. Kept 10 years.';
CREATE UNIQUE INDEX bank_statement_bank_account_id_checksum_key ON juristic.bank_statement (bank_account_id, checksum);
CREATE INDEX bank_statement_tenant_id_imported_at_idx ON juristic.bank_statement (tenant_id, imported_at DESC);
SELECT platform.apply_rls('juristic.bank_statement', 'tenant');
REVOKE DELETE ON juristic.bank_statement FROM gp_app;

CREATE TABLE juristic.bank_statement_line (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  statement_id     uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  line_no          integer NOT NULL,
  booked_on        date NOT NULL,
  amount           numeric(14,2) NOT NULL,
  description      text NOT NULL DEFAULT '',
  reference        text,
  balance          numeric(14,2),
  line_key         bytea NOT NULL,
  match_kind       juristic.bank_line_match NOT NULL DEFAULT 'none',
  match_id         uuid,
  match_method     text,
  matched_by       uuid,
  matched_at       timestamptz(6),
  ignore_reason    text,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT bank_statement_line_pkey PRIMARY KEY (id),
  CONSTRAINT bank_statement_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_line_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES juristic.bank_statement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_line_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bank_statement_line_amount_check CHECK (amount <> 0),
  CONSTRAINT bank_statement_line_description_check CHECK (length(description) <= 500),
  CONSTRAINT bank_statement_line_reference_check CHECK (reference IS NULL OR length(reference) <= 200),
  CONSTRAINT bank_statement_line_key_check CHECK (length(line_key) = 32),
  CONSTRAINT bank_statement_line_match_check CHECK ((match_kind IN ('none', 'ignored')) = (match_id IS NULL)),
  CONSTRAINT bank_statement_line_method_check CHECK ((match_kind = 'none') = (match_method IS NULL) AND (match_method IS NULL OR match_method IN ('auto', 'manual'))),
  CONSTRAINT bank_statement_line_ignore_check CHECK ((match_kind = 'ignored') = (ignore_reason IS NOT NULL) AND (ignore_reason IS NULL OR length(ignore_reason) BETWEEN 3 AND 600))
);
COMMENT ON TABLE juristic.bank_statement_line IS 'D-329 (J2.1): a line of an imported bank statement (signed amount: + money in), matched to a payment, a paid expense or a fund transfer, ignored with a reason, or waiting in the unmatched queue.';
CREATE UNIQUE INDEX bank_statement_line_bank_account_id_line_key_key ON juristic.bank_statement_line (bank_account_id, line_key);
CREATE UNIQUE INDEX bank_statement_line_match_key ON juristic.bank_statement_line (match_kind, match_id) WHERE (match_id IS NOT NULL);
CREATE INDEX bank_statement_line_statement_id_idx ON juristic.bank_statement_line (statement_id, line_no);
CREATE INDEX bank_statement_line_unmatched_idx ON juristic.bank_statement_line (tenant_id, booked_on) WHERE (match_kind = 'none');
SELECT platform.apply_rls('juristic.bank_statement_line', 'tenant');
REVOKE DELETE ON juristic.bank_statement_line FROM gp_app;
