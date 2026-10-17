-- getproperty-api 0022 (B4.4) — payments (schema-design v2 §3.3.5; D-042 Thai QR per invoice, D-043 slip fallback,
-- D-044 receipts, D-050 tax invoices): QR codes, payments and their allocations, slip reviews, provider webhooks and
-- settlement files, receipts, tax invoices, the payer's credit ledger and refunds. The tenant's own bank account
-- receives the money; the platform never holds funds (D-042, ADR-0008).
-- Deviations (§7.5 rows 58–61): + ops.payment_webhook (inbound callback log, idempotent on the provider event id),
-- + ops.payer_credit (overpayment credits per party × unit) and ops.refund, + platform.tenant_bank_account
-- provider_merchant_ref_hash (webhook → merchant lookup), payment_confirmation + `credit`.

CREATE TYPE ops.qr_status AS ENUM ('active', 'paid', 'expired', 'cancelled');
CREATE TYPE ops.payment_method AS ENUM ('qr', 'transfer_slip', 'cash', 'bank_transfer_manual', 'card', 'offset');
CREATE TYPE ops.payment_status AS ENUM ('pending', 'confirmed', 'failed', 'refunded', 'reversed');
CREATE TYPE ops.payment_confirmation AS ENUM ('webhook', 'settlement_file', 'slip_verified', 'slip_review', 'manual', 'credit');
CREATE TYPE ops.slip_status AS ENUM ('pending_verification', 'auto_confirmed', 'pending_review', 'approved', 'rejected', 'duplicate');
CREATE TYPE ops.settlement_file_status AS ENUM ('received', 'processed', 'failed');
CREATE TYPE ops.receipt_kind AS ENUM ('payment', 'deposit', 'advance');
CREATE TYPE ops.tax_invoice_kind AS ENUM ('tax_invoice', 'receipt_tax_invoice');
CREATE TYPE ops.credit_entry_kind AS ENUM ('overpayment', 'applied', 'refunded', 'reversed');
CREATE TYPE ops.webhook_outcome AS ENUM ('received', 'processed', 'ignored', 'rejected');

ALTER TABLE platform.tenant_bank_account ADD COLUMN provider_merchant_ref_hash bytea;
CREATE INDEX tenant_bank_account_provider_merchant_idx ON platform.tenant_bank_account (payment_provider, provider_merchant_ref_hash)
  WHERE provider_merchant_ref_hash IS NOT NULL;

CREATE TABLE ops.payment_qr_code (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  unit_id          uuid,
  invoice_id       uuid NOT NULL,
  provider         platform.payment_provider NOT NULL,
  bank_account_id  uuid NOT NULL,
  reference        text NOT NULL,
  amount           numeric(14,2) NOT NULL,
  payload          text NOT NULL,
  provider_qr_id   text,
  status           ops.qr_status NOT NULL DEFAULT 'active',
  expires_at       timestamptz(6),
  paid_at          timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT payment_qr_code_pkey PRIMARY KEY (id),
  CONSTRAINT payment_qr_code_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  CONSTRAINT payment_qr_code_provider_check CHECK (provider <> 'none')
);
COMMENT ON TABLE ops.payment_qr_code IS 'Dynamic Thai QR (Tag 30) per invoice and amount (D-042): the reference is the invoice payment reference; a new code replaces an expired one.';
CREATE INDEX payment_qr_code_tenant_id_idx ON ops.payment_qr_code (tenant_id);
CREATE INDEX payment_qr_code_building_id_idx ON ops.payment_qr_code (building_id);
CREATE INDEX payment_qr_code_unit_id_idx ON ops.payment_qr_code (unit_id);
CREATE INDEX payment_qr_code_invoice_id_idx ON ops.payment_qr_code (invoice_id);
CREATE INDEX payment_qr_code_bank_account_id_idx ON ops.payment_qr_code (bank_account_id);
CREATE INDEX payment_qr_code_provider_reference_idx ON ops.payment_qr_code (provider, reference);
CREATE UNIQUE INDEX payment_qr_code_active_key ON ops.payment_qr_code (invoice_id) WHERE status = 'active';

CREATE TABLE ops.slip_review (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid,
  invoice_id             uuid NOT NULL,
  payer_party_id         uuid NOT NULL,
  slip_document_id       uuid NOT NULL,
  uploaded_by            uuid,
  uploaded_at            timestamptz(6) NOT NULL DEFAULT now(),
  verifier               text,
  verify_result          jsonb,
  trans_ref              text,
  amount_detected        numeric(14,2),
  receiver_account_masked text,
  receiver_bank_code     text,
  sender_name            text,
  slip_datetime          timestamptz(6),
  status                 ops.slip_status NOT NULL DEFAULT 'pending_verification',
  reasons                text[] NOT NULL DEFAULT '{}',
  duplicate_of_id        uuid,
  reviewed_by            uuid,
  reviewed_at            timestamptz(6),
  reject_reason          text,
  payment_id             uuid,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT slip_review_pkey PRIMARY KEY (id),
  CONSTRAINT slip_review_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_payer_party_id_fkey FOREIGN KEY (payer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_slip_document_id_fkey FOREIGN KEY (slip_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_duplicate_of_id_fkey FOREIGN KEY (duplicate_of_id) REFERENCES ops.slip_review (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT slip_review_decided_check CHECK (status NOT IN ('approved', 'rejected') OR reviewed_at IS NOT NULL),
  CONSTRAINT slip_review_rejected_check CHECK (status <> 'rejected' OR length(btrim(coalesce(reject_reason, ''))) >= 3),
  CONSTRAINT slip_review_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.slip_review IS 'Transfer slips (D-043 fallback): verified by the slip adapter, auto-confirmed when amount, receiving account and reference check out, otherwise reviewed by the owner.';
CREATE INDEX slip_review_tenant_id_status_idx ON ops.slip_review (tenant_id, status);
CREATE UNIQUE INDEX slip_review_trans_ref_key ON ops.slip_review (tenant_id, trans_ref) WHERE trans_ref IS NOT NULL AND status NOT IN ('duplicate', 'rejected');
CREATE INDEX slip_review_trans_ref_idx ON ops.slip_review (tenant_id, trans_ref);
CREATE INDEX slip_review_building_id_idx ON ops.slip_review (building_id);
CREATE INDEX slip_review_unit_id_idx ON ops.slip_review (unit_id);
CREATE INDEX slip_review_invoice_id_idx ON ops.slip_review (invoice_id);
CREATE INDEX slip_review_payer_party_id_idx ON ops.slip_review (payer_party_id);
CREATE INDEX slip_review_slip_document_id_idx ON ops.slip_review (slip_document_id);
CREATE INDEX slip_review_uploaded_by_idx ON ops.slip_review (uploaded_by);
CREATE INDEX slip_review_reviewed_by_idx ON ops.slip_review (reviewed_by);
CREATE INDEX slip_review_duplicate_of_id_idx ON ops.slip_review (duplicate_of_id);
CREATE INDEX slip_review_payment_id_idx ON ops.slip_review (payment_id);

CREATE TABLE ops.payment (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  unit_id               uuid,
  invoice_id            uuid,
  payer_party_id        uuid,
  lease_id              uuid,
  amount                numeric(14,2) NOT NULL,
  method                ops.payment_method NOT NULL,
  provider              platform.payment_provider,
  provider_ref          text,
  provider_payload      jsonb,
  bank_account_id       uuid,
  qr_code_id            uuid,
  status                ops.payment_status NOT NULL DEFAULT 'pending',
  paid_at               timestamptz(6) NOT NULL,
  confirmed_at          timestamptz(6),
  confirmed_via         ops.payment_confirmation,
  reconciled_at         timestamptz(6),
  slip_document_id      uuid,
  evidence_document_id  uuid,
  slip_review_id        uuid,
  recorded_by           uuid,
  wht_amount            numeric(14,2) NOT NULL DEFAULT 0,
  allocated_total       numeric(14,2) NOT NULL DEFAULT 0,
  credited_amount       numeric(14,2) NOT NULL DEFAULT 0,
  reversed_at           timestamptz(6),
  reverse_reason        text,
  notes                 text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT payment_pkey PRIMARY KEY (id),
  CONSTRAINT payment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_payer_party_id_fkey FOREIGN KEY (payer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_qr_code_id_fkey FOREIGN KEY (qr_code_id) REFERENCES ops.payment_qr_code (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_slip_document_id_fkey FOREIGN KEY (slip_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_evidence_document_id_fkey FOREIGN KEY (evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_slip_review_id_fkey FOREIGN KEY (slip_review_id) REFERENCES ops.slip_review (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_amount_check CHECK (amount > 0 AND amount = round(amount, 2) AND wht_amount >= 0),
  CONSTRAINT payment_split_check CHECK (allocated_total >= 0 AND credited_amount >= 0 AND allocated_total + credited_amount <= amount + wht_amount),
  CONSTRAINT payment_confirmed_check CHECK (status NOT IN ('confirmed', 'refunded', 'reversed') OR (confirmed_at IS NOT NULL AND confirmed_via IS NOT NULL)),
  CONSTRAINT payment_reversed_check CHECK ((status = 'reversed') = (reversed_at IS NOT NULL)),
  CONSTRAINT payment_provider_check CHECK (provider_ref IS NULL OR provider IS NOT NULL),
  CONSTRAINT payment_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.payment IS 'Money received into the tenant''s own account (D-042): by QR webhook, settlement file, verified or reviewed slip, or recorded manually with evidence; allocations hold the split over invoices, the rest is the payer''s credit.';
CREATE UNIQUE INDEX payment_provider_ref_key ON ops.payment (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payment_tenant_id_building_id_paid_at_idx ON ops.payment (tenant_id, building_id, paid_at DESC);
CREATE INDEX payment_invoice_id_idx ON ops.payment (invoice_id);
CREATE INDEX payment_payer_party_id_paid_at_idx ON ops.payment (payer_party_id, paid_at DESC);
CREATE INDEX payment_status_pending_idx ON ops.payment (status) WHERE status = 'pending';
CREATE INDEX payment_building_id_idx ON ops.payment (building_id);
CREATE INDEX payment_unit_id_idx ON ops.payment (unit_id);
CREATE INDEX payment_lease_id_idx ON ops.payment (lease_id);
CREATE INDEX payment_bank_account_id_idx ON ops.payment (bank_account_id);
CREATE INDEX payment_qr_code_id_idx ON ops.payment (qr_code_id);
CREATE INDEX payment_slip_document_id_idx ON ops.payment (slip_document_id);
CREATE INDEX payment_evidence_document_id_idx ON ops.payment (evidence_document_id);
CREATE INDEX payment_slip_review_id_idx ON ops.payment (slip_review_id);
CREATE INDEX payment_recorded_by_idx ON ops.payment (recorded_by);
ALTER TABLE ops.slip_review ADD CONSTRAINT slip_review_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE ops.payment_allocation (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  payment_id    uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  amount        numeric(14,2) NOT NULL,
  allocated_at  timestamptz(6) NOT NULL DEFAULT now(),
  reversed_at   timestamptz(6),
  CONSTRAINT payment_allocation_pkey PRIMARY KEY (id),
  CONSTRAINT payment_allocation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_allocation_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_allocation_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_allocation_amount_check CHECK (amount > 0 AND amount = round(amount, 2))
);
CREATE UNIQUE INDEX payment_allocation_payment_id_invoice_id_key ON ops.payment_allocation (payment_id, invoice_id);
CREATE INDEX payment_allocation_tenant_id_idx ON ops.payment_allocation (tenant_id);
CREATE INDEX payment_allocation_invoice_id_idx ON ops.payment_allocation (invoice_id);

CREATE TABLE ops.payment_webhook (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  provider            platform.payment_provider NOT NULL,
  event_id            text NOT NULL,
  tenant_id           uuid,
  bank_account_id     uuid,
  signature_valid     boolean NOT NULL,
  outcome             ops.webhook_outcome NOT NULL DEFAULT 'received',
  detail              text,
  payload             jsonb NOT NULL DEFAULT '{}',
  received_at         timestamptz(6) NOT NULL DEFAULT now(),
  processed_at        timestamptz(6),
  CONSTRAINT payment_webhook_pkey PRIMARY KEY (id),
  CONSTRAINT payment_webhook_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_webhook_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.payment_webhook IS 'Inbound payment provider callbacks (D-042): signature verdict, merchant, outcome; idempotent on the provider event id. Payloads are redacted (no account numbers).';
CREATE UNIQUE INDEX payment_webhook_provider_event_id_key ON ops.payment_webhook (provider, event_id);
CREATE INDEX payment_webhook_tenant_id_idx ON ops.payment_webhook (tenant_id);
CREATE INDEX payment_webhook_bank_account_id_idx ON ops.payment_webhook (bank_account_id);

CREATE TABLE ops.payment_settlement_file (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  provider           platform.payment_provider NOT NULL,
  bank_account_id    uuid NOT NULL,
  statement_date     date NOT NULL,
  file_document_id   uuid,
  rows_total         integer NOT NULL DEFAULT 0,
  rows_matched       integer NOT NULL DEFAULT 0,
  rows_created       integer NOT NULL DEFAULT 0,
  rows_unmatched     integer NOT NULL DEFAULT 0,
  discrepancies      jsonb NOT NULL DEFAULT '[]',
  processed_at       timestamptz(6),
  status             ops.settlement_file_status NOT NULL DEFAULT 'received',
  error              text,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  CONSTRAINT payment_settlement_file_pkey PRIMARY KEY (id),
  CONSTRAINT payment_settlement_file_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_settlement_file_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_settlement_file_file_document_id_fkey FOREIGN KEY (file_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payment_settlement_file_rows_check CHECK (rows_total >= 0 AND rows_matched >= 0 AND rows_created >= 0 AND rows_unmatched >= 0)
);
CREATE UNIQUE INDEX payment_settlement_file_provider_account_date_key ON ops.payment_settlement_file (provider, bank_account_id, statement_date);
CREATE INDEX payment_settlement_file_tenant_id_idx ON ops.payment_settlement_file (tenant_id);
CREATE INDEX payment_settlement_file_bank_account_id_idx ON ops.payment_settlement_file (bank_account_id);
CREATE INDEX payment_settlement_file_file_document_id_idx ON ops.payment_settlement_file (file_document_id);

CREATE TABLE ops.receipt (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  unit_id          uuid,
  kind             ops.receipt_kind NOT NULL,
  payment_id       uuid,
  deposit_id       uuid,
  payer_party_id   uuid NOT NULL,
  number           citext NOT NULL,
  issued_at        timestamptz(6) NOT NULL,
  document_id      uuid,
  amount           numeric(14,2) NOT NULL,
  lines            jsonb NOT NULL DEFAULT '[]',
  e_tax_ref        text,
  voided_at        timestamptz(6),
  void_reason      text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT receipt_pkey PRIMARY KEY (id),
  CONSTRAINT receipt_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_deposit_id_fkey FOREIGN KEY (deposit_id) REFERENCES ops.deposit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_payer_party_id_fkey FOREIGN KEY (payer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receipt_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  CONSTRAINT receipt_deposit_check CHECK ((kind = 'deposit') = (deposit_id IS NOT NULL)),
  CONSTRAINT receipt_payment_check CHECK (kind = 'deposit' OR payment_id IS NOT NULL),
  CONSTRAINT receipt_void_check CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
COMMENT ON TABLE ops.receipt IS 'Receipts (D-044): one per confirmed payment (kind payment, or advance for money received beyond what was due); numbered from the receipt series; immutable except the void and the document link.';
CREATE UNIQUE INDEX receipt_tenant_id_number_key ON ops.receipt (tenant_id, number);
CREATE INDEX receipt_payment_id_idx ON ops.receipt (payment_id);
CREATE INDEX receipt_building_id_idx ON ops.receipt (building_id);
CREATE INDEX receipt_unit_id_idx ON ops.receipt (unit_id);
CREATE INDEX receipt_deposit_id_idx ON ops.receipt (deposit_id);
CREATE INDEX receipt_payer_party_id_idx ON ops.receipt (payer_party_id);
CREATE INDEX receipt_document_id_idx ON ops.receipt (document_id);

CREATE TABLE ops.tax_invoice (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  unit_id          uuid,
  kind             ops.tax_invoice_kind NOT NULL,
  invoice_id       uuid,
  payment_id       uuid,
  buyer_party_id   uuid NOT NULL,
  number           citext NOT NULL,
  issued_at        timestamptz(6) NOT NULL,
  document_id      uuid,
  subtotal         numeric(14,2) NOT NULL,
  vat_amount       numeric(14,2) NOT NULL,
  total            numeric(14,2) NOT NULL,
  e_tax_ref        text,
  voided_at        timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT tax_invoice_pkey PRIMARY KEY (id),
  CONSTRAINT tax_invoice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_buyer_party_id_fkey FOREIGN KEY (buyer_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tax_invoice_amounts_check CHECK (total = subtotal + vat_amount AND vat_amount >= 0 AND total > 0)
);
COMMENT ON TABLE ops.tax_invoice IS 'Tax invoices / receipt-tax invoices of VAT-registered tenants (D-050, O-004, O-007); immutable except the void and the document link.';
CREATE UNIQUE INDEX tax_invoice_tenant_id_number_key ON ops.tax_invoice (tenant_id, number);
CREATE INDEX tax_invoice_building_id_idx ON ops.tax_invoice (building_id);
CREATE INDEX tax_invoice_unit_id_idx ON ops.tax_invoice (unit_id);
CREATE INDEX tax_invoice_invoice_id_idx ON ops.tax_invoice (invoice_id);
CREATE INDEX tax_invoice_payment_id_idx ON ops.tax_invoice (payment_id);
CREATE INDEX tax_invoice_buyer_party_id_idx ON ops.tax_invoice (buyer_party_id);
CREATE INDEX tax_invoice_document_id_idx ON ops.tax_invoice (document_id);

CREATE TABLE ops.payer_credit (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  building_id   uuid NOT NULL,
  unit_id       uuid,
  party_id      uuid NOT NULL,
  kind          ops.credit_entry_kind NOT NULL,
  amount        numeric(14,2) NOT NULL,
  payment_id    uuid,
  invoice_id    uuid,
  refund_id     uuid,
  note          text,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT payer_credit_pkey PRIMARY KEY (id),
  CONSTRAINT payer_credit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT payer_credit_amount_check CHECK (amount <> 0 AND amount = round(amount, 2)
    AND ((kind = 'overpayment' AND amount > 0) OR (kind IN ('applied', 'refunded', 'reversed') AND amount < 0)))
);
COMMENT ON TABLE ops.payer_credit IS 'Credit ledger of a payer × unit (D-044): money received beyond what was due (+), used on a later invoice or refunded (−). Append-only; the balance is the sum.';
CREATE INDEX payer_credit_party_id_unit_id_idx ON ops.payer_credit (party_id, unit_id);
CREATE INDEX payer_credit_tenant_id_idx ON ops.payer_credit (tenant_id);
CREATE INDEX payer_credit_building_id_idx ON ops.payer_credit (building_id);
CREATE INDEX payer_credit_unit_id_idx ON ops.payer_credit (unit_id);
CREATE INDEX payer_credit_payment_id_idx ON ops.payer_credit (payment_id);
CREATE INDEX payer_credit_invoice_id_idx ON ops.payer_credit (invoice_id);
CREATE INDEX payer_credit_refund_id_idx ON ops.payer_credit (refund_id);

CREATE TABLE ops.refund (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  unit_id               uuid,
  party_id              uuid NOT NULL,
  amount                numeric(14,2) NOT NULL,
  method                ops.refund_method NOT NULL,
  reference             text,
  evidence_document_id  uuid,
  refunded_at           timestamptz(6) NOT NULL,
  recorded_by           uuid,
  note                  text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT refund_pkey PRIMARY KEY (id),
  CONSTRAINT refund_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_evidence_document_id_fkey FOREIGN KEY (evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT refund_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  CONSTRAINT refund_method_check CHECK (method <> 'offset'),
  CONSTRAINT refund_evidence_check CHECK (method = 'cash' OR evidence_document_id IS NOT NULL)
);
COMMENT ON TABLE ops.refund IS 'Money paid back to a payer from their credit (D-044), with transfer evidence; append-only.';
CREATE INDEX refund_tenant_id_idx ON ops.refund (tenant_id);
CREATE INDEX refund_building_id_idx ON ops.refund (building_id);
CREATE INDEX refund_unit_id_idx ON ops.refund (unit_id);
CREATE INDEX refund_party_id_idx ON ops.refund (party_id);
CREATE INDEX refund_evidence_document_id_idx ON ops.refund (evidence_document_id);
CREATE INDEX refund_recorded_by_idx ON ops.refund (recorded_by);
ALTER TABLE ops.payer_credit ADD CONSTRAINT payer_credit_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES ops.refund (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ------------------------------------------------------------------------------------------- integrity
CREATE TRIGGER payment_qr_code_set_updated_at BEFORE UPDATE ON ops.payment_qr_code FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER slip_review_set_updated_at BEFORE UPDATE ON ops.slip_review FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER payment_set_updated_at BEFORE UPDATE ON ops.payment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER payer_credit_append_only BEFORE UPDATE OR DELETE ON ops.payer_credit FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER refund_append_only BEFORE UPDATE OR DELETE ON ops.refund FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

-- receipts and tax invoices are final documents: only the void and the PDF link change, never deleted (D-044, D-050)
CREATE OR REPLACE FUNCTION ops.receipt_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['voided_at', 'void_reason', 'document_id', 'e_tax_ref'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: %.% rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: % % cannot be modified', TG_TABLE_NAME, OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: the document of % % is final', TG_TABLE_NAME, OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON ops.receipt FOR EACH ROW EXECUTE FUNCTION ops.receipt_guard_immutable();
CREATE TRIGGER tax_invoice_immutable BEFORE UPDATE OR DELETE ON ops.tax_invoice FOR EACH ROW EXECUTE FUNCTION ops.receipt_guard_immutable();

-- ------------------------------------------------------------------------------------------- RLS (§4.5)
SELECT platform.apply_rls('ops.payment_qr_code', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.payment', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.slip_review', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.receipt', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.tax_invoice', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.payer_credit', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.refund', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.payment_settlement_file', 'tenant');
SELECT platform.apply_rls('ops.payment_webhook', 'platform_only');
SELECT platform.apply_rls('ops.payment_allocation', 'platform_only');
CREATE POLICY payment_allocation_rls_read ON ops.payment_allocation FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.payment p WHERE p.id = payment_id));
CREATE POLICY payment_allocation_rls_write ON ops.payment_allocation FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.payment_qr_code, ops.payment, ops.payment_allocation, ops.slip_review,
  ops.payment_settlement_file, ops.receipt, ops.tax_invoice, ops.payer_credit, ops.refund TO gp_app, gp_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.payment_webhook TO gp_platform;
GRANT SELECT ON ops.payment_qr_code, ops.payment, ops.payment_allocation, ops.slip_review, ops.payment_settlement_file,
  ops.receipt, ops.tax_invoice, ops.payer_credit, ops.refund, ops.payment_webhook TO gp_reporting;
