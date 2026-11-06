-- getproperty-api 0079 — import wizard for juristic tenants moving from a legacy system (Phase J step J3.1, D-313,
-- D-332). schema-design §7.5 rows 279–285 (§7.6 J3-a, J3-b).
--   * juristic.import_job (one per building: as-of date, state, reconciliation with the note + attachment, go-live,
--     rollback), juristic.import_file (one file per sheet), juristic.import_row (normalised data + field errors),
--     juristic.import_created (every id the commit created — the rollback deletes exactly these),
--     juristic.legacy_payment (payment history kept as history only), juristic.import_cycle_difference (parallel cycle).
--   * ops.invoice.import_job_id (opening-balance invoices), ops.invoice_line_kind + opening_balance,
--     ops.document_type + opening_balance (series OPB), ops.export_kind + juristic_full_export.
-- Every new table RLS:T. DDL only (no DML on RLS tables); no core.* change.

ALTER TYPE ops.invoice_line_kind ADD VALUE IF NOT EXISTS 'opening_balance';
ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'opening_balance';
ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'juristic_full_export';

CREATE TYPE juristic.import_state AS ENUM ('draft', 'validated', 'reconciled', 'committed', 'live', 'rolled_back', 'cancelled');
CREATE TYPE juristic.import_sheet AS ENUM ('register', 'opening_balance', 'payment_history', 'bank_balance', 'legacy_bills');

-- ------------------------------------------------------------------------------- jobs (§7.6 J3-a)
CREATE TABLE juristic.import_job (
  id                          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL,
  building_id                 uuid NOT NULL,
  number                      integer NOT NULL,
  state                       juristic.import_state NOT NULL DEFAULT 'draft',
  as_of_date                  date NOT NULL,
  note                        text,
  computed_totals             jsonb NOT NULL DEFAULT '{}',
  declared_receivables        numeric(14,2),
  reconciliation              jsonb,
  reconciliation_note         text,
  reconciliation_document_id  uuid,
  reconciled_at               timestamptz(6),
  reconciled_by               uuid,
  bill_to_consent_document_id uuid,
  committed_at                timestamptz(6),
  committed_by                uuid,
  live_at                     timestamptz(6),
  live_by                     uuid,
  notify_opening_balances     boolean,
  rolled_back_at              timestamptz(6),
  rolled_back_by              uuid,
  rollback_reason             text,
  cancelled_at                timestamptz(6),
  cancelled_by                uuid,
  parallel_cycle_id           uuid,
  parallel_run_at             timestamptz(6),
  differences_acknowledged_at timestamptz(6),
  differences_acknowledged_by uuid,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                  uuid,
  version                     integer NOT NULL DEFAULT 1,
  CONSTRAINT import_job_pkey PRIMARY KEY (id),
  CONSTRAINT import_job_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_job_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_job_reconciliation_document_id_fkey FOREIGN KEY (reconciliation_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_job_bill_to_consent_document_id_fkey FOREIGN KEY (bill_to_consent_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_job_parallel_cycle_id_fkey FOREIGN KEY (parallel_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_job_number_check CHECK (number > 0),
  CONSTRAINT import_job_texts_check CHECK ((note IS NULL OR length(note) <= 2000)
    AND (reconciliation_note IS NULL OR length(reconciliation_note) BETWEEN 10 AND 2000)
    AND (rollback_reason IS NULL OR length(rollback_reason) BETWEEN 5 AND 1000)),
  CONSTRAINT import_job_explained_check CHECK ((reconciliation_note IS NULL) = (reconciliation_document_id IS NULL)),
  CONSTRAINT import_job_state_check CHECK ((state <> 'committed' OR committed_at IS NOT NULL)
    AND (state <> 'live' OR (committed_at IS NOT NULL AND live_at IS NOT NULL))
    AND (state <> 'rolled_back' OR (committed_at IS NOT NULL AND rolled_back_at IS NOT NULL AND live_at IS NULL)))
);
COMMENT ON TABLE juristic.import_job IS 'D-313 / D-332 (J3.1): one legacy-system import of a building — files per sheet, validation, reconciliation (an explained difference needs a note and an attachment), commit in one transaction, rollback of exactly what was created until go-live, parallel cycle, go-live.';
CREATE UNIQUE INDEX import_job_tenant_id_number_key ON juristic.import_job (tenant_id, number);
CREATE UNIQUE INDEX import_job_building_open_key ON juristic.import_job (building_id)
  WHERE state IN ('draft', 'validated', 'reconciled', 'committed');
CREATE INDEX import_job_tenant_id_state_idx ON juristic.import_job (tenant_id, state);
CREATE INDEX import_job_reconciliation_document_id_idx ON juristic.import_job (reconciliation_document_id);
CREATE INDEX import_job_bill_to_consent_document_id_idx ON juristic.import_job (bill_to_consent_document_id);
CREATE INDEX import_job_parallel_cycle_id_idx ON juristic.import_job (parallel_cycle_id);
SELECT platform.apply_rls('juristic.import_job', 'tenant');
REVOKE DELETE ON juristic.import_job FROM gp_app;

-- ------------------------------------------------------------------------------- files
CREATE TABLE juristic.import_file (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  job_id        uuid NOT NULL,
  sheet         juristic.import_sheet NOT NULL,
  document_id   uuid NOT NULL,
  file_name     text NOT NULL,
  format        text NOT NULL,
  sha256        bytea NOT NULL,
  row_count     integer NOT NULL DEFAULT 0,
  error_count   integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  uploaded_at   timestamptz(6) NOT NULL DEFAULT now(),
  uploaded_by   uuid,
  CONSTRAINT import_file_pkey PRIMARY KEY (id),
  CONSTRAINT import_file_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_file_job_id_fkey FOREIGN KEY (job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_file_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_file_format_check CHECK (format IN ('csv', 'xlsx')),
  CONSTRAINT import_file_file_name_check CHECK (length(file_name) BETWEEN 1 AND 200),
  CONSTRAINT import_file_counts_check CHECK (row_count >= 0 AND error_count >= 0 AND warning_count >= 0)
);
COMMENT ON TABLE juristic.import_file IS 'D-332 (J3.1): the file of one sheet of an import job (CSV or XLSX, a core.document kind other); replaced by a new upload.';
CREATE UNIQUE INDEX import_file_job_id_sheet_key ON juristic.import_file (job_id, sheet);
CREATE INDEX import_file_document_id_idx ON juristic.import_file (document_id);
SELECT platform.apply_rls('juristic.import_file', 'tenant');

-- ------------------------------------------------------------------------------- rows (§7.6 J3-b)
CREATE TABLE juristic.import_row (
  id        uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  job_id    uuid NOT NULL,
  sheet     juristic.import_sheet NOT NULL,
  row_no    integer NOT NULL,
  data      jsonb NOT NULL,
  errors    jsonb NOT NULL DEFAULT '[]',
  warnings  jsonb NOT NULL DEFAULT '[]',
  CONSTRAINT import_row_pkey PRIMARY KEY (id),
  CONSTRAINT import_row_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_row_job_id_fkey FOREIGN KEY (job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_row_row_no_check CHECK (row_no > 0)
);
COMMENT ON TABLE juristic.import_row IS 'D-332 (J3.1): one normalised row of an import file with its field errors / warnings (ID numbers: type + last 4 only); deleted 90 days after the job went live, was rolled back or cancelled.';
CREATE UNIQUE INDEX import_row_job_id_sheet_row_no_key ON juristic.import_row (job_id, sheet, row_no);
CREATE INDEX import_row_errors_idx ON juristic.import_row (job_id, sheet) WHERE errors <> '[]'::jsonb;
SELECT platform.apply_rls('juristic.import_row', 'tenant');

-- ------------------------------------------------------------------------------- what a commit created
CREATE TABLE juristic.import_created (
  id        uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  job_id    uuid NOT NULL,
  seq       integer NOT NULL,
  entity    text NOT NULL,
  entity_id uuid NOT NULL,
  CONSTRAINT import_created_pkey PRIMARY KEY (id),
  CONSTRAINT import_created_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_created_job_id_fkey FOREIGN KEY (job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_created_entity_check CHECK (entity IN ('floor', 'unit', 'party', 'unit_ownership', 'bill_to', 'invoice', 'legacy_payment'))
);
COMMENT ON TABLE juristic.import_created IS 'D-332 (J3.1): every row an import commit created, in order — the rollback deletes exactly these (newest first) and nothing else.';
CREATE UNIQUE INDEX import_created_job_id_entity_entity_id_key ON juristic.import_created (job_id, entity, entity_id);
CREATE INDEX import_created_job_id_seq_idx ON juristic.import_created (job_id, seq);
SELECT platform.apply_rls('juristic.import_created', 'tenant');
REVOKE UPDATE, DELETE ON juristic.import_created FROM gp_app;

-- ------------------------------------------------------------------------------- payment history (history only)
CREATE TABLE juristic.legacy_payment (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  building_id uuid NOT NULL,
  job_id      uuid NOT NULL,
  unit_id     uuid NOT NULL,
  party_id    uuid,
  paid_on     date NOT NULL,
  amount      numeric(14,2) NOT NULL,
  method      text NOT NULL,
  reference   text,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT legacy_payment_pkey PRIMARY KEY (id),
  CONSTRAINT legacy_payment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT legacy_payment_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT legacy_payment_job_id_fkey FOREIGN KEY (job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT legacy_payment_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT legacy_payment_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT legacy_payment_amount_check CHECK (amount > 0),
  CONSTRAINT legacy_payment_method_check CHECK (method IN ('cash', 'transfer', 'cheque', 'promptpay', 'card', 'other')),
  CONSTRAINT legacy_payment_reference_check CHECK (reference IS NULL OR length(reference) <= 100)
);
COMMENT ON TABLE juristic.legacy_payment IS 'D-332 (J3.1): payments received by the legacy system (last 12 months) — history only: the opening balance already nets them, so they are no ops.payment, no receipt and no journal.';
CREATE INDEX legacy_payment_tenant_id_unit_id_paid_on_idx ON juristic.legacy_payment (tenant_id, unit_id, paid_on DESC);
CREATE INDEX legacy_payment_job_id_idx ON juristic.legacy_payment (job_id);
CREATE INDEX legacy_payment_building_id_idx ON juristic.legacy_payment (building_id);
CREATE INDEX legacy_payment_unit_id_idx ON juristic.legacy_payment (unit_id);
CREATE INDEX legacy_payment_party_id_idx ON juristic.legacy_payment (party_id);
SELECT platform.apply_rls('juristic.legacy_payment', 'tenant');
REVOKE UPDATE ON juristic.legacy_payment FROM gp_app;

-- ------------------------------------------------------------------------------- parallel cycle
CREATE TABLE juristic.import_cycle_difference (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  job_id       uuid NOT NULL,
  unit_id      uuid,
  unit_no      text NOT NULL,
  computed     numeric(14,2) NOT NULL,
  legacy       numeric(14,2) NOT NULL,
  difference   numeric(14,2) NOT NULL,
  explanation  text,
  explained_at timestamptz(6),
  explained_by uuid,
  CONSTRAINT import_cycle_difference_pkey PRIMARY KEY (id),
  CONSTRAINT import_cycle_difference_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_cycle_difference_job_id_fkey FOREIGN KEY (job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_cycle_difference_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT import_cycle_difference_amount_check CHECK (difference = computed - legacy),
  CONSTRAINT import_cycle_difference_explained_check CHECK ((explanation IS NULL) = (explained_at IS NULL)
    AND (explanation IS NULL OR length(explanation) BETWEEN 5 AND 1000))
);
COMMENT ON TABLE juristic.import_cycle_difference IS 'D-313 / D-332 (J3.1): per unit, the parallel cycle''s computed amount against the legacy bill; a difference needs an explanation before go-live (unless the tenant allows it with an acknowledgement).';
CREATE UNIQUE INDEX import_cycle_difference_job_id_unit_no_key ON juristic.import_cycle_difference (job_id, unit_no);
CREATE INDEX import_cycle_difference_unit_id_idx ON juristic.import_cycle_difference (unit_id);
SELECT platform.apply_rls('juristic.import_cycle_difference', 'tenant');

-- ------------------------------------------------------------------------------- opening-balance invoices
ALTER TABLE ops.invoice ADD COLUMN import_job_id uuid;
ALTER TABLE ops.invoice
  ADD CONSTRAINT invoice_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES juristic.import_job (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.invoice VALIDATE CONSTRAINT invoice_import_job_id_fkey;
CREATE INDEX invoice_import_job_id_idx ON ops.invoice (import_job_id) WHERE import_job_id IS NOT NULL;
COMMENT ON COLUMN ops.invoice.import_job_id IS 'D-332 (J3.1): the import job of an opening-balance invoice (a draft flagged opening_balance_pending_go_live until the job goes live; issued then in series OPB).';
