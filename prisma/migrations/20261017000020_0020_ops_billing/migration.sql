-- getproperty-api 0020 (B4.2) — rate plans, billing cycles, invoices, notes and estimate settlements (schema-design v2
-- §3.3.4, §4.2, §4.9, §7.3; D-021a, D-022, D-030, D-031, D-040, D-041, D-046, D-141, D-151). Deviations: §7.5 rows 48–55
-- (`ops.invoice_charge` one-off queue, invoice `is_final`/`review_flags`/`replaces_invoice_id`, line `meter_segments`,
-- cycle `period_key`/`auto_issue_at`, settlement `advance_rent_unused`, estimated readings never constrain real ones).

CREATE TYPE ops.rate_plan_kind AS ENUM ('power', 'water', 'common_fee', 'fund', 'rent', 'service');
CREATE TYPE ops.rate_basis AS ENUM ('per_unit', 'per_sqm', 'per_ownership_ratio', 'fixed');
CREATE TYPE ops.billing_cycle_status AS ENUM ('open', 'readings_pending', 'computed', 'issued', 'closed', 'cancelled');
CREATE TYPE ops.estimate_policy AS ENUM ('allow', 'block');
CREATE TYPE ops.invoice_status AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void');
CREATE TYPE ops.invoice_line_source_type AS ENUM ('rent', 'meter', 'common_fee', 'fund', 'penalty', 'service', 'deposit', 'adjustment');
CREATE TYPE ops.invoice_line_kind AS ENUM ('rent', 'electricity', 'water', 'internet', 'parking', 'cleaning', 'furniture',
  'common_fee', 'fund', 'water_minimum', 'other_fixed', 'one_off', 'late_fee', 'estimate_settlement', 'prior_balance',
  'discount', 'deposit_offset', 'service_charge_work');
CREATE TYPE ops.note_reason AS ENUM ('reading_correction', 'tariff_correction', 'goodwill', 'duplicate', 'estimate_settlement', 'other');
CREATE TYPE ops.note_status AS ENUM ('issued', 'applied', 'void');
CREATE TYPE ops.estimate_settlement_status AS ENUM ('pending', 'settled_on_invoice', 'settled_by_note');
CREATE TYPE ops.invoice_charge_status AS ENUM ('pending', 'applied', 'cancelled');

-- ------------------------------------------------------------------------------------------- rate plans
CREATE TABLE ops.rate_plan (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  building_id uuid,
  kind        ops.rate_plan_kind NOT NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  deleted_at  timestamptz(6),
  deleted_by  uuid,
  version     integer NOT NULL DEFAULT 1,
  CONSTRAINT rate_plan_pkey PRIMARY KEY (id),
  CONSTRAINT rate_plan_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rate_plan_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rate_plan_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT rate_plan_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.rate_plan IS 'A tenant-set tariff for power, water, common fees, funds, rent or services (D-151, D-021a); building_id null = tenant-wide; versions hold the tiers.';
CREATE UNIQUE INDEX rate_plan_default_key ON ops.rate_plan (tenant_id, building_id, kind) NULLS NOT DISTINCT WHERE (is_default AND deleted_at IS NULL);
CREATE INDEX rate_plan_tenant_id_building_id_idx ON ops.rate_plan (tenant_id, building_id);
CREATE INDEX rate_plan_building_id_idx ON ops.rate_plan (building_id);

CREATE TABLE ops.rate_plan_version (
  id                             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                      uuid NOT NULL,
  rate_plan_id                   uuid NOT NULL,
  effective_from                 date NOT NULL,
  effective_to                   date,
  tiers                          jsonb NOT NULL,
  basis                          ops.rate_basis NOT NULL,
  minimum_charge                 numeric(14,2),
  currency                       char(3) NOT NULL DEFAULT 'THB',
  cap_check                      jsonb,
  above_cap                      boolean NOT NULL DEFAULT false,
  compliance_acknowledgement_id  uuid,
  note                           text,
  created_at                     timestamptz(6) NOT NULL DEFAULT now(),
  created_by                     uuid,
  updated_at                     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                     uuid,
  CONSTRAINT rate_plan_version_pkey PRIMARY KEY (id),
  CONSTRAINT rate_plan_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rate_plan_version_rate_plan_id_fkey FOREIGN KEY (rate_plan_id) REFERENCES ops.rate_plan (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT rate_plan_version_ack_fkey FOREIGN KEY (compliance_acknowledgement_id) REFERENCES platform.compliance_acknowledgement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rate_plan_version_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT rate_plan_version_currency_check CHECK (currency = 'THB'),
  CONSTRAINT rate_plan_version_minimum_check CHECK (minimum_charge IS NULL OR (minimum_charge >= 0 AND minimum_charge = round(minimum_charge, 2))),
  CONSTRAINT rate_plan_version_tiers_check CHECK (jsonb_typeof(tiers) = 'object' AND tiers ? 'kind'),
  CONSTRAINT rate_plan_version_ack_check CHECK (NOT above_cap OR compliance_acknowledgement_id IS NOT NULL),
  CONSTRAINT rate_plan_version_no_overlap EXCLUDE USING gist (rate_plan_id WITH =, daterange(effective_from, effective_to) WITH &&)
);
COMMENT ON TABLE ops.rate_plan_version IS 'Effective-dated tiers of a rate plan interpreted by the billing engine (blueprint rule 7, schema-design §4.2.2); cap check snapshot and the Owner acknowledgement when above the utility rate (D-021a).';
CREATE UNIQUE INDEX rate_plan_version_rate_plan_id_effective_from_key ON ops.rate_plan_version (rate_plan_id, effective_from);
CREATE INDEX rate_plan_version_tenant_id_idx ON ops.rate_plan_version (tenant_id);
CREATE INDEX rate_plan_version_compliance_acknowledgement_id_idx ON ops.rate_plan_version (compliance_acknowledgement_id);

-- ------------------------------------------------------------------------------------------- billing cycles
CREATE TABLE ops.billing_cycle (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  property_id             uuid NOT NULL,
  period_key              text NOT NULL,
  period_start            date NOT NULL,
  period_end              date NOT NULL,
  cut_off_at              timestamptz(6) NOT NULL,
  status                  ops.billing_cycle_status NOT NULL DEFAULT 'open',
  readings_window_minutes integer NOT NULL,
  grace_deadline_at       timestamptz(6) NOT NULL,
  estimate_policy         ops.estimate_policy NOT NULL,
  generated_at            timestamptz(6) NOT NULL DEFAULT now(),
  readings_requested_at   timestamptz(6),
  computed_at             timestamptz(6),
  issued_at               timestamptz(6),
  closed_at               timestamptz(6),
  auto_issue_at           timestamptz(6),
  stats                   jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT billing_cycle_pkey PRIMARY KEY (id),
  CONSTRAINT billing_cycle_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT billing_cycle_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT billing_cycle_period_key_check CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT billing_cycle_period_check CHECK (period_end >= period_start AND period_end - period_start <= 62),
  CONSTRAINT billing_cycle_grace_check CHECK (grace_deadline_at >= cut_off_at),
  CONSTRAINT billing_cycle_window_check CHECK (readings_window_minutes BETWEEN 0 AND 10080),
  CONSTRAINT billing_cycle_issued_check CHECK (status NOT IN ('issued', 'closed') OR issued_at IS NOT NULL),
  CONSTRAINT billing_cycle_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.billing_cycle IS 'A billing period of a property (D-031): cut-off from billing.cutoff, readings pending → computed (draft invoices per billed party × unit) → issued → closed.';
CREATE UNIQUE INDEX billing_cycle_property_id_period_start_key ON ops.billing_cycle (property_id, period_start);
CREATE UNIQUE INDEX billing_cycle_property_id_period_key_key ON ops.billing_cycle (property_id, period_key);
CREATE INDEX billing_cycle_tenant_id_status_idx ON ops.billing_cycle (tenant_id, status);

-- ------------------------------------------------------------------------------------------- invoices
CREATE TABLE ops.invoice (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid,
  billed_party_id        uuid NOT NULL,
  lease_id               uuid,
  billing_cycle_id       uuid,
  is_final               boolean NOT NULL DEFAULT false,
  number                 citext,
  document_id            uuid,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  issued_at              timestamptz(6),
  due_date               date,
  status                 ops.invoice_status NOT NULL DEFAULT 'draft',
  subtotal               numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount             numeric(14,2) NOT NULL DEFAULT 0,
  total                  numeric(14,2) NOT NULL DEFAULT 0,
  paid_total             numeric(14,2) NOT NULL DEFAULT 0,
  balance                numeric(14,2) NOT NULL DEFAULT 0,
  credited_total         numeric(14,2) NOT NULL DEFAULT 0,
  debited_total          numeric(14,2) NOT NULL DEFAULT 0,
  prior_balance_carried  numeric(14,2) NOT NULL DEFAULT 0,
  has_estimate           boolean NOT NULL DEFAULT false,
  has_above_cap_line     boolean NOT NULL DEFAULT false,
  compliance_flags       text[] NOT NULL DEFAULT '{}',
  review_flags           text[] NOT NULL DEFAULT '{}',
  notes_to_payer         text,
  snapshot               jsonb,
  snapshot_sha256        bytea,
  promptpay_ref          text,
  qr_payload             text,
  qr_provider            platform.payment_provider,
  qr_expires_at          timestamptz(6),
  voided_at              timestamptz(6),
  void_reason            text,
  voided_by              uuid,
  replaced_by_invoice_id uuid,
  replaces_invoice_id    uuid,
  last_payment_at        timestamptz(6),
  overdue_since          date,
  reminder_count         smallint NOT NULL DEFAULT 0,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT invoice_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_billed_party_id_fkey FOREIGN KEY (billed_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_billing_cycle_id_fkey FOREIGN KEY (billing_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_replaced_by_fkey FOREIGN KEY (replaced_by_invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_replaces_fkey FOREIGN KEY (replaces_invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_period_check CHECK (period_end >= period_start),
  CONSTRAINT invoice_amounts_check CHECK (total = round(total, 2) AND subtotal = round(subtotal, 2) AND vat_amount = round(vat_amount, 2)
    AND paid_total >= 0 AND total >= 0 AND vat_amount >= 0 AND balance >= 0 AND credited_total >= 0 AND debited_total >= 0
    AND prior_balance_carried >= 0 AND total = subtotal + vat_amount),
  CONSTRAINT invoice_issued_check CHECK (status IN ('draft', 'void') OR (number IS NOT NULL AND snapshot IS NOT NULL AND issued_at IS NOT NULL AND due_date IS NOT NULL)),
  CONSTRAINT invoice_void_check CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CONSTRAINT invoice_reminder_check CHECK (reminder_count >= 0),
  CONSTRAINT invoice_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.invoice IS 'One invoice per billed party × unit × period (D-151: the payer is a party); immutable once issued (D-040, trigger invoice_immutable) with the snapshot of everything it used (§4.2.3).';
CREATE UNIQUE INDEX invoice_tenant_id_number_key ON ops.invoice (tenant_id, number) WHERE (number IS NOT NULL);
CREATE UNIQUE INDEX invoice_tenant_id_promptpay_ref_key ON ops.invoice (tenant_id, promptpay_ref) WHERE (promptpay_ref IS NOT NULL);
CREATE INDEX invoice_tenant_id_building_id_status_due_date_idx ON ops.invoice (tenant_id, building_id, status, due_date);
CREATE INDEX invoice_lease_id_period_start_idx ON ops.invoice (lease_id, period_start DESC);
CREATE INDEX invoice_billed_party_id_status_idx ON ops.invoice (billed_party_id, status);
CREATE INDEX invoice_billing_cycle_id_idx ON ops.invoice (billing_cycle_id);
CREATE INDEX invoice_unit_id_idx ON ops.invoice (unit_id);
CREATE INDEX invoice_document_id_idx ON ops.invoice (document_id);
CREATE INDEX invoice_replaced_by_invoice_id_idx ON ops.invoice (replaced_by_invoice_id);
CREATE INDEX invoice_replaces_invoice_id_idx ON ops.invoice (replaces_invoice_id);

CREATE TABLE ops.invoice_line_kind_rule (
  line_kind             ops.invoice_line_kind NOT NULL,
  source_type           ops.invoice_line_source_type NOT NULL,
  requires_lease_line   boolean NOT NULL DEFAULT false,
  requires_meter        boolean NOT NULL DEFAULT false,
  compliance_rule_id    text,
  allowed_when_setting  text,
  description           text NOT NULL,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_kind_rule_pkey PRIMARY KEY (line_kind),
  CONSTRAINT invoice_line_kind_rule_compliance_rule_id_fkey FOREIGN KEY (compliance_rule_id) REFERENCES platform.compliance_rule (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.invoice_line_kind_rule IS 'Seeded catalogue of invoice line kinds (D-041): the source type each kind is billed under, whether it needs a lease line or a meter, its compliance rule and the setting that allows it.';
CREATE INDEX invoice_line_kind_rule_compliance_rule_id_idx ON ops.invoice_line_kind_rule (compliance_rule_id);

CREATE TABLE ops.invoice_line (
  id                            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                     uuid NOT NULL,
  invoice_id                    uuid NOT NULL,
  line_no                       smallint NOT NULL,
  source_type                   ops.invoice_line_source_type NOT NULL,
  line_kind                     ops.invoice_line_kind NOT NULL,
  source_id                     uuid,
  description                   text NOT NULL,
  quantity                      numeric(12,3) NOT NULL DEFAULT 1,
  unit                          text,
  unit_price                    numeric(14,4),
  amount                        numeric(14,2) NOT NULL,
  period_from                   date,
  period_to                     date,
  asset_item_id                 uuid,
  meter_assignment_id           uuid,
  reading_from_id               uuid,
  reading_to_id                 uuid,
  register_from                 numeric(12,3),
  register_to                   numeric(12,3),
  units                         numeric(12,3),
  multiplier                    numeric(12,6),
  reading_source                smart.reading_source,
  is_estimated                  boolean NOT NULL DEFAULT false,
  meter_segments                jsonb,
  rate_plan_version_id          uuid,
  utility_tariff_version_id     uuid,
  cap_per_unit                  numeric(14,4),
  above_cap                     boolean NOT NULL DEFAULT false,
  compliance_acknowledgement_id uuid,
  tier_breakdown                jsonb,
  pro_rata                      jsonb,
  lease_line_id                 uuid,
  estimate_settlement_id        uuid,
  source_invoice_id             uuid,
  compliance_rule_ids           text[] NOT NULL DEFAULT '{}',
  compliance_flags              text[] NOT NULL DEFAULT '{}',
  vat_applicable                boolean NOT NULL DEFAULT false,
  created_at                    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_line_kind_fkey FOREIGN KEY (line_kind) REFERENCES ops.invoice_line_kind_rule (line_kind) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_meter_assignment_id_fkey FOREIGN KEY (meter_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_reading_from_id_fkey FOREIGN KEY (reading_from_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_reading_to_id_fkey FOREIGN KEY (reading_to_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_rate_plan_version_id_fkey FOREIGN KEY (rate_plan_version_id) REFERENCES ops.rate_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_utility_tariff_version_id_fkey FOREIGN KEY (utility_tariff_version_id) REFERENCES platform.utility_tariff_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_ack_fkey FOREIGN KEY (compliance_acknowledgement_id) REFERENCES platform.compliance_acknowledgement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_lease_line_id_fkey FOREIGN KEY (lease_line_id) REFERENCES ops.lease_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_source_invoice_id_fkey FOREIGN KEY (source_invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_line_amount_check CHECK (amount = round(amount, 2)),
  CONSTRAINT invoice_line_line_no_check CHECK (line_no >= 1),
  CONSTRAINT invoice_line_meter_check CHECK (source_type <> 'meter' OR (unit_price IS NOT NULL AND units IS NOT NULL AND utility_tariff_version_id IS NOT NULL AND cap_per_unit IS NOT NULL)),
  CONSTRAINT invoice_line_above_cap_check CHECK (above_cap = (source_type = 'meter' AND COALESCE(unit_price > cap_per_unit, false))),
  CONSTRAINT invoice_line_period_check CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from)
);
COMMENT ON TABLE ops.invoice_line IS 'Invoice lines (D-041): source_type says where the amount came from, line_kind the detail; meter lines carry readings, units, the rate plan version, the utility tariff version and the cap compared (D-021a, D-022, D-140).';
CREATE UNIQUE INDEX invoice_line_invoice_id_line_no_key ON ops.invoice_line (invoice_id, line_no);
CREATE INDEX invoice_line_asset_item_id_reading_to_id_idx ON ops.invoice_line (asset_item_id, reading_to_id);
CREATE INDEX invoice_line_tenant_id_idx ON ops.invoice_line (tenant_id);
CREATE INDEX invoice_line_line_kind_idx ON ops.invoice_line (line_kind);
CREATE INDEX invoice_line_meter_assignment_id_idx ON ops.invoice_line (meter_assignment_id);
CREATE INDEX invoice_line_reading_from_id_idx ON ops.invoice_line (reading_from_id);
CREATE INDEX invoice_line_reading_to_id_idx ON ops.invoice_line (reading_to_id);
CREATE INDEX invoice_line_rate_plan_version_id_idx ON ops.invoice_line (rate_plan_version_id);
CREATE INDEX invoice_line_utility_tariff_version_id_idx ON ops.invoice_line (utility_tariff_version_id);
CREATE INDEX invoice_line_compliance_acknowledgement_id_idx ON ops.invoice_line (compliance_acknowledgement_id);
CREATE INDEX invoice_line_lease_line_id_idx ON ops.invoice_line (lease_line_id);
CREATE INDEX invoice_line_source_invoice_id_idx ON ops.invoice_line (source_invoice_id);
CREATE INDEX invoice_line_estimate_settlement_id_idx ON ops.invoice_line (estimate_settlement_id);

-- one-off items queued for a party × unit until the next invoice picks them up (deviation §7.5 row 48)
CREATE TABLE ops.invoice_charge (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  building_id              uuid NOT NULL,
  unit_id                  uuid NOT NULL,
  party_id                 uuid NOT NULL,
  lease_id                 uuid,
  billing_cycle_id         uuid,
  source_type              ops.invoice_line_source_type NOT NULL,
  line_kind                ops.invoice_line_kind NOT NULL,
  source_id                uuid,
  description              text NOT NULL,
  quantity                 numeric(12,3) NOT NULL DEFAULT 1,
  unit_price               numeric(14,4) NOT NULL,
  amount                   numeric(14,2) NOT NULL,
  status                   ops.invoice_charge_status NOT NULL DEFAULT 'pending',
  applied_invoice_line_id  uuid,
  cancelled_at             timestamptz(6),
  cancel_reason            text,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT invoice_charge_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_charge_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_billing_cycle_id_fkey FOREIGN KEY (billing_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_line_kind_fkey FOREIGN KEY (line_kind) REFERENCES ops.invoice_line_kind_rule (line_kind) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_applied_line_fkey FOREIGN KEY (applied_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT invoice_charge_amount_check CHECK (amount = round(amount, 2) AND quantity > 0),
  CONSTRAINT invoice_charge_description_check CHECK (char_length(description) BETWEEN 1 AND 200),
  CONSTRAINT invoice_charge_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
COMMENT ON TABLE ops.invoice_charge IS 'One-off items (keys, agreed damages, late fees from ops.penalty_assessment) queued for a billed party × unit until the next invoice of the period applies them (D-041, D-045).';
CREATE INDEX invoice_charge_tenant_id_status_idx ON ops.invoice_charge (tenant_id, status);
CREATE INDEX invoice_charge_unit_id_party_id_idx ON ops.invoice_charge (unit_id, party_id);
CREATE INDEX invoice_charge_building_id_idx ON ops.invoice_charge (building_id);
CREATE INDEX invoice_charge_lease_id_idx ON ops.invoice_charge (lease_id);
CREATE INDEX invoice_charge_billing_cycle_id_idx ON ops.invoice_charge (billing_cycle_id);
CREATE INDEX invoice_charge_party_id_idx ON ops.invoice_charge (party_id);
CREATE INDEX invoice_charge_applied_invoice_line_id_idx ON ops.invoice_charge (applied_invoice_line_id);

-- ------------------------------------------------------------------------------------------- notes
CREATE TABLE ops.credit_note (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  building_id  uuid NOT NULL,
  unit_id      uuid,
  invoice_id   uuid NOT NULL,
  number       citext NOT NULL,
  document_id  uuid,
  reason       ops.note_reason NOT NULL,
  reason_text  text NOT NULL,
  subtotal     numeric(14,2) NOT NULL,
  vat_amount   numeric(14,2) NOT NULL DEFAULT 0,
  total        numeric(14,2) NOT NULL,
  issued_at    timestamptz(6) NOT NULL,
  issued_by    uuid,
  status       ops.note_status NOT NULL DEFAULT 'issued',
  applied_at   timestamptz(6),
  voided_at    timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT credit_note_pkey PRIMARY KEY (id),
  CONSTRAINT credit_note_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_amounts_check CHECK (total > 0 AND total = subtotal + vat_amount AND total = round(total, 2) AND vat_amount >= 0),
  CONSTRAINT credit_note_reason_text_check CHECK (char_length(reason_text) BETWEEN 3 AND 500)
);
COMMENT ON TABLE ops.credit_note IS 'Credit note referencing an issued invoice (D-040): reduces what the payer owes; numbered (series credit_note), immutable except its status.';
CREATE UNIQUE INDEX credit_note_tenant_id_number_key ON ops.credit_note (tenant_id, number);
CREATE INDEX credit_note_invoice_id_idx ON ops.credit_note (invoice_id);
CREATE INDEX credit_note_building_id_idx ON ops.credit_note (building_id);
CREATE INDEX credit_note_unit_id_idx ON ops.credit_note (unit_id);
CREATE INDEX credit_note_document_id_idx ON ops.credit_note (document_id);

CREATE TABLE ops.credit_note_line (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  note_id             uuid NOT NULL,
  line_no             smallint NOT NULL,
  line_kind           ops.invoice_line_kind NOT NULL,
  description         text NOT NULL,
  quantity            numeric(12,3) NOT NULL DEFAULT 1,
  unit_price          numeric(14,4),
  amount              numeric(14,2) NOT NULL,
  ref_invoice_line_id uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT credit_note_line_pkey PRIMARY KEY (id),
  CONSTRAINT credit_note_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_line_note_id_fkey FOREIGN KEY (note_id) REFERENCES ops.credit_note (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT credit_note_line_ref_invoice_line_id_fkey FOREIGN KEY (ref_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT credit_note_line_amount_check CHECK (amount > 0 AND amount = round(amount, 2))
);
CREATE UNIQUE INDEX credit_note_line_note_id_line_no_key ON ops.credit_note_line (note_id, line_no);
CREATE INDEX credit_note_line_tenant_id_idx ON ops.credit_note_line (tenant_id);
CREATE INDEX credit_note_line_ref_invoice_line_id_idx ON ops.credit_note_line (ref_invoice_line_id);

CREATE TABLE ops.debit_note (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  building_id  uuid NOT NULL,
  unit_id      uuid,
  invoice_id   uuid NOT NULL,
  number       citext NOT NULL,
  document_id  uuid,
  reason       ops.note_reason NOT NULL,
  reason_text  text NOT NULL,
  subtotal     numeric(14,2) NOT NULL,
  vat_amount   numeric(14,2) NOT NULL DEFAULT 0,
  total        numeric(14,2) NOT NULL,
  issued_at    timestamptz(6) NOT NULL,
  issued_by    uuid,
  status       ops.note_status NOT NULL DEFAULT 'issued',
  applied_at   timestamptz(6),
  voided_at    timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT debit_note_pkey PRIMARY KEY (id),
  CONSTRAINT debit_note_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_amounts_check CHECK (total > 0 AND total = subtotal + vat_amount AND total = round(total, 2) AND vat_amount >= 0),
  CONSTRAINT debit_note_reason_text_check CHECK (char_length(reason_text) BETWEEN 3 AND 500)
);
COMMENT ON TABLE ops.debit_note IS 'Debit note referencing an issued invoice (D-040): adds to what the payer owes; numbered (series debit_note), immutable except its status.';
CREATE UNIQUE INDEX debit_note_tenant_id_number_key ON ops.debit_note (tenant_id, number);
CREATE INDEX debit_note_invoice_id_idx ON ops.debit_note (invoice_id);
CREATE INDEX debit_note_building_id_idx ON ops.debit_note (building_id);
CREATE INDEX debit_note_unit_id_idx ON ops.debit_note (unit_id);
CREATE INDEX debit_note_document_id_idx ON ops.debit_note (document_id);

CREATE TABLE ops.debit_note_line (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  note_id             uuid NOT NULL,
  line_no             smallint NOT NULL,
  line_kind           ops.invoice_line_kind NOT NULL,
  description         text NOT NULL,
  quantity            numeric(12,3) NOT NULL DEFAULT 1,
  unit_price          numeric(14,4),
  amount              numeric(14,2) NOT NULL,
  ref_invoice_line_id uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT debit_note_line_pkey PRIMARY KEY (id),
  CONSTRAINT debit_note_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_line_note_id_fkey FOREIGN KEY (note_id) REFERENCES ops.debit_note (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT debit_note_line_ref_invoice_line_id_fkey FOREIGN KEY (ref_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT debit_note_line_amount_check CHECK (amount > 0 AND amount = round(amount, 2))
);
CREATE UNIQUE INDEX debit_note_line_note_id_line_no_key ON ops.debit_note_line (note_id, line_no);
CREATE INDEX debit_note_line_tenant_id_idx ON ops.debit_note_line (tenant_id);
CREATE INDEX debit_note_line_ref_invoice_line_id_idx ON ops.debit_note_line (ref_invoice_line_id);

-- ------------------------------------------------------------------------------------------- estimate settlements
CREATE TABLE ops.estimate_settlement (
  id                        uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                 uuid NOT NULL,
  building_id               uuid NOT NULL,
  unit_id                   uuid,
  asset_item_id             uuid NOT NULL,
  meter_assignment_id       uuid NOT NULL,
  estimated_reading_id      uuid NOT NULL,
  actual_reading_id         uuid,
  estimated_invoice_line_id uuid NOT NULL,
  estimated_units           numeric(12,3) NOT NULL,
  actual_units              numeric(12,3),
  delta_units               numeric(12,3),
  delta_amount              numeric(14,2),
  rate_plan_version_id      uuid NOT NULL,
  utility_tariff_version_id uuid NOT NULL,
  status                    ops.estimate_settlement_status NOT NULL DEFAULT 'pending',
  settled_invoice_line_id   uuid,
  settled_note_id           uuid,
  settled_at                timestamptz(6),
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                uuid,
  CONSTRAINT estimate_settlement_pkey PRIMARY KEY (id),
  CONSTRAINT estimate_settlement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_meter_assignment_id_fkey FOREIGN KEY (meter_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_estimated_reading_fkey FOREIGN KEY (estimated_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_actual_reading_fkey FOREIGN KEY (actual_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_estimated_line_fkey FOREIGN KEY (estimated_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_settled_line_fkey FOREIGN KEY (settled_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_settled_note_fkey FOREIGN KEY (settled_note_id) REFERENCES ops.credit_note (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_rate_plan_version_fkey FOREIGN KEY (rate_plan_version_id) REFERENCES ops.rate_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_tariff_version_fkey FOREIGN KEY (utility_tariff_version_id) REFERENCES platform.utility_tariff_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT estimate_settlement_settled_check CHECK (status = 'pending' OR (actual_reading_id IS NOT NULL AND settled_at IS NOT NULL AND delta_amount IS NOT NULL))
);
COMMENT ON TABLE ops.estimate_settlement IS 'An estimated meter line (cycle N) reconciled by the actual reading (cycle N+1): delta units × the same rate, settled on the next invoice or by a credit note (D-012, D-031).';
CREATE UNIQUE INDEX estimate_settlement_estimated_invoice_line_id_key ON ops.estimate_settlement (estimated_invoice_line_id);
CREATE INDEX estimate_settlement_tenant_id_status_idx ON ops.estimate_settlement (tenant_id, status);
CREATE INDEX estimate_settlement_building_id_idx ON ops.estimate_settlement (building_id);
CREATE INDEX estimate_settlement_unit_id_idx ON ops.estimate_settlement (unit_id);
CREATE INDEX estimate_settlement_meter_assignment_id_idx ON ops.estimate_settlement (meter_assignment_id);
CREATE INDEX estimate_settlement_asset_item_id_idx ON ops.estimate_settlement (asset_item_id);
CREATE INDEX estimate_settlement_estimated_reading_id_idx ON ops.estimate_settlement (estimated_reading_id);
CREATE INDEX estimate_settlement_actual_reading_id_idx ON ops.estimate_settlement (actual_reading_id);
CREATE INDEX estimate_settlement_settled_invoice_line_id_idx ON ops.estimate_settlement (settled_invoice_line_id);
CREATE INDEX estimate_settlement_settled_note_id_idx ON ops.estimate_settlement (settled_note_id);
CREATE INDEX estimate_settlement_rate_plan_version_id_idx ON ops.estimate_settlement (rate_plan_version_id);
CREATE INDEX estimate_settlement_utility_tariff_version_id_idx ON ops.estimate_settlement (utility_tariff_version_id);
ALTER TABLE ops.invoice_line ADD CONSTRAINT invoice_line_estimate_settlement_id_fkey FOREIGN KEY (estimate_settlement_id) REFERENCES ops.estimate_settlement (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ------------------------------------------------------------------------------------------- forward references (§7.3)
ALTER TABLE ops.lease
  ADD CONSTRAINT lease_power_rate_plan_id_fkey FOREIGN KEY (power_rate_plan_id) REFERENCES ops.rate_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT lease_water_rate_plan_id_fkey FOREIGN KEY (water_rate_plan_id) REFERENCES ops.rate_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.lease VALIDATE CONSTRAINT lease_power_rate_plan_id_fkey;
ALTER TABLE ops.lease VALIDATE CONSTRAINT lease_water_rate_plan_id_fkey;
CREATE INDEX lease_power_rate_plan_id_idx ON ops.lease (power_rate_plan_id);
CREATE INDEX lease_water_rate_plan_id_idx ON ops.lease (water_rate_plan_id);
ALTER TABLE ops.loss_report
  ADD CONSTRAINT loss_report_billing_cycle_id_fkey FOREIGN KEY (billing_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.loss_report VALIDATE CONSTRAINT loss_report_billing_cycle_id_fkey;
CREATE INDEX loss_report_billing_cycle_id_idx ON ops.loss_report (billing_cycle_id);
ALTER TABLE ops.deposit_settlement
  ADD CONSTRAINT deposit_settlement_final_invoice_id_fkey FOREIGN KEY (final_invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD COLUMN advance_rent_unused numeric(14,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT deposit_settlement_advance_unused_check CHECK (advance_rent_unused >= 0 AND advance_rent_unused = round(advance_rent_unused, 2));
ALTER TABLE ops.deposit_settlement VALIDATE CONSTRAINT deposit_settlement_final_invoice_id_fkey;
CREATE INDEX deposit_settlement_final_invoice_id_idx ON ops.deposit_settlement (final_invoice_id);
ALTER TABLE smart.reading_batch
  ADD CONSTRAINT reading_batch_billing_cycle_id_fkey FOREIGN KEY (billing_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE smart.reading_batch VALIDATE CONSTRAINT reading_batch_billing_cycle_id_fkey;
CREATE INDEX reading_batch_billing_cycle_id_idx ON smart.reading_batch (billing_cycle_id);

-- ------------------------------------------------------------------------------------------- immutability (§4.9)
CREATE OR REPLACE FUNCTION ops.invoice_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'paid_total', 'balance', 'credited_total', 'debited_total', 'last_payment_at',
    'overdue_since', 'reminder_count', 'voided_at', 'void_reason', 'voided_by', 'replaced_by_invoice_id', 'qr_payload',
    'qr_provider', 'qr_expires_at', 'document_id', 'updated_at', 'updated_by', 'version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'compliance.invoice_immutable: invoices are never deleted once issued (%)', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.issued_at IS NOT NULL AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: issued invoice % cannot be modified', OLD.number USING ERRCODE = 'P0001';
  END IF;
  -- a draft line may be above the cap while it waits for the owner's acknowledgement; issuing needs it (D-021a)
  IF OLD.issued_at IS NULL AND NEW.issued_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM ops.invoice_line l WHERE l.invoice_id = NEW.id AND l.above_cap AND l.compliance_acknowledgement_id IS NULL) THEN
    RAISE EXCEPTION 'compliance.tariff_cap: invoice % has a line above the utility rate without an acknowledgement', NEW.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.issued_at IS NOT NULL AND OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: the document of issued invoice % is final', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_immutable BEFORE UPDATE OR DELETE ON ops.invoice FOR EACH ROW EXECUTE FUNCTION ops.invoice_guard_immutable();

CREATE OR REPLACE FUNCTION ops.invoice_line_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  issued timestamptz;
  inv uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END;
BEGIN
  SELECT i.issued_at INTO issued FROM ops.invoice i WHERE i.id = inv;
  IF issued IS NOT NULL THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: lines of an issued invoice cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER invoice_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON ops.invoice_line FOR EACH ROW EXECUTE FUNCTION ops.invoice_line_guard_immutable();

-- notes: content is final; only the status, its timestamps and the document link change; never deleted
CREATE OR REPLACE FUNCTION ops.note_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'applied_at', 'voided_at', 'document_id', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: %.% rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'compliance.invoice_immutable: note % cannot be modified', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER credit_note_immutable BEFORE UPDATE OR DELETE ON ops.credit_note FOR EACH ROW EXECUTE FUNCTION ops.note_guard_immutable();
CREATE TRIGGER debit_note_immutable BEFORE UPDATE OR DELETE ON ops.debit_note FOR EACH ROW EXECUTE FUNCTION ops.note_guard_immutable();
CREATE TRIGGER credit_note_line_append_only BEFORE UPDATE OR DELETE ON ops.credit_note_line FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER debit_note_line_append_only BEFORE UPDATE OR DELETE ON ops.debit_note_line FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

-- rate plan versions close the previous open version of their plan (schema-design §4.1)
CREATE TRIGGER rate_plan_version_close_previous BEFORE INSERT ON ops.rate_plan_version
  FOR EACH ROW EXECUTE FUNCTION core.close_previous_period('rate_plan_id', 'effective_from', 'effective_to');

-- an estimated reading (cycle estimate, D-012) never constrains a real reading: it is settled by it (D-192)
CREATE OR REPLACE FUNCTION smart.meter_reading_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  prev numeric;
  nxt numeric;
  initial numeric;
BEGIN
  IF NEW.review_state <> 'accepted' OR NEW.superseded_by_reading_id IS NOT NULL OR NEW.is_rollover THEN
    RETURN NEW;
  END IF;
  SELECT r.register INTO prev FROM smart.meter_reading r
   WHERE r.meter_assignment_id = NEW.meter_assignment_id AND r.id <> NEW.id AND r.review_state = 'accepted'
     AND r.superseded_by_reading_id IS NULL AND r.read_at < NEW.read_at
     AND (NEW.source = 'estimated' OR r.source <> 'estimated')
   ORDER BY r.read_at DESC LIMIT 1;
  IF prev IS NULL THEN
    SELECT a.initial_reading INTO initial FROM core.meter_assignment a WHERE a.id = NEW.meter_assignment_id;
    prev := initial;
  END IF;
  IF prev IS NOT NULL AND NEW.register < prev THEN
    RAISE EXCEPTION 'smart.monotonic: register % is below the previous reading % of assignment %', NEW.register, prev, NEW.meter_assignment_id
      USING ERRCODE = 'P0001';
  END IF;
  SELECT r.register INTO nxt FROM smart.meter_reading r
   WHERE r.meter_assignment_id = NEW.meter_assignment_id AND r.id <> NEW.id AND r.review_state = 'accepted'
     AND r.superseded_by_reading_id IS NULL AND r.read_at > NEW.read_at AND NOT r.is_rollover
     AND r.source <> 'estimated'
   ORDER BY r.read_at ASC LIMIT 1;
  IF nxt IS NOT NULL AND NEW.register > nxt THEN
    RAISE EXCEPTION 'smart.monotonic: register % is above the next reading % of assignment %', NEW.register, nxt, NEW.meter_assignment_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER rate_plan_set_updated_at BEFORE UPDATE ON ops.rate_plan FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER rate_plan_version_set_updated_at BEFORE UPDATE ON ops.rate_plan_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER billing_cycle_set_updated_at BEFORE UPDATE ON ops.billing_cycle FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER invoice_set_updated_at BEFORE UPDATE ON ops.invoice FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER invoice_line_kind_rule_set_updated_at BEFORE UPDATE ON ops.invoice_line_kind_rule FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER invoice_charge_set_updated_at BEFORE UPDATE ON ops.invoice_charge FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER credit_note_set_updated_at BEFORE UPDATE ON ops.credit_note FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER debit_note_set_updated_at BEFORE UPDATE ON ops.debit_note FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER estimate_settlement_set_updated_at BEFORE UPDATE ON ops.estimate_settlement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------- RLS (§4.5)
SELECT platform.apply_rls('ops.rate_plan', 'building', 'ops.billing');
SELECT platform.apply_rls('ops.rate_plan_version', 'tenant');
SELECT platform.apply_rls('ops.billing_cycle', 'tenant');
SELECT platform.apply_rls('ops.invoice', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.invoice_line_kind_rule', 'platform');
SELECT platform.apply_rls('ops.invoice_charge', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.credit_note', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.debit_note', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.estimate_settlement', 'unit', 'ops.billing');
-- child rows: readable with their (visible) parent, written by the parent's tenant
SELECT platform.apply_rls('ops.invoice_line', 'platform_only');
CREATE POLICY invoice_line_rls_read ON ops.invoice_line FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.invoice i WHERE i.id = invoice_id));
CREATE POLICY invoice_line_rls_write ON ops.invoice_line FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
SELECT platform.apply_rls('ops.credit_note_line', 'platform_only');
CREATE POLICY credit_note_line_rls_read ON ops.credit_note_line FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.credit_note n WHERE n.id = note_id));
CREATE POLICY credit_note_line_rls_write ON ops.credit_note_line FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
SELECT platform.apply_rls('ops.debit_note_line', 'platform_only');
CREATE POLICY debit_note_line_rls_read ON ops.debit_note_line FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.debit_note n WHERE n.id = note_id));
CREATE POLICY debit_note_line_rls_write ON ops.debit_note_line FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.rate_plan, ops.rate_plan_version, ops.billing_cycle, ops.invoice, ops.invoice_line,
  ops.invoice_charge, ops.credit_note, ops.credit_note_line, ops.debit_note, ops.debit_note_line, ops.estimate_settlement TO gp_app, gp_platform;
REVOKE INSERT, UPDATE, DELETE ON ops.invoice_line_kind_rule FROM gp_app;
GRANT SELECT ON ops.invoice_line_kind_rule TO gp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.invoice_line_kind_rule TO gp_platform;
GRANT SELECT ON ops.rate_plan, ops.rate_plan_version, ops.billing_cycle, ops.invoice, ops.invoice_line, ops.invoice_line_kind_rule,
  ops.invoice_charge, ops.credit_note, ops.credit_note_line, ops.debit_note, ops.debit_note_line, ops.estimate_settlement TO gp_reporting;
