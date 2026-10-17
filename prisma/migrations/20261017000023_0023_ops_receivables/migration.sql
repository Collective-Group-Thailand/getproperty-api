-- getproperty-api 0023 (B4.5) — receivables, dunning, penalties (schema-design v2 §3.3.6; D-044 balances, D-045
-- reminders 1/3/7 + aging + late fee only when allowed, D-024 nothing else automatic).
-- Deviations (§7.5 rows 62–64): + ops.receivable_entry.event_id (the domain event that posted it, unique: postings
-- are event subscribers), ops.receivable_balance unique per (tenant, party, unit) as two partial indexes (unit /
-- no unit) instead of a coalesce expression, + version; ops.dunning_reminder + timer_id (the workflow timer of the
-- step), uniqueness of (invoice_id, step) for scheduled steps only (owner "send now" may repeat), + created_by;
-- ops.penalty_assessment + party_id, unit_id, invoice_charge_id (the queued charge the next invoice picks up).

CREATE TYPE ops.receivable_entry_type AS ENUM ('invoice', 'payment', 'credit_note', 'debit_note', 'refund', 'write_off',
  'deposit_offset', 'opening');
CREATE TYPE ops.reminder_status AS ENUM ('scheduled', 'sent', 'skipped_paid', 'deferred_quiet_hours', 'cancelled', 'failed');
CREATE TYPE ops.reminder_trigger AS ENUM ('schedule', 'owner');
CREATE TYPE ops.penalty_status AS ENUM ('pending', 'applied', 'waived');

-- ------------------------------------------------------------------------------------------- receivables
CREATE TABLE ops.receivable_entry (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  building_id  uuid NOT NULL,
  unit_id      uuid,
  party_id     uuid NOT NULL,
  lease_id     uuid,
  entry_type   ops.receivable_entry_type NOT NULL,
  ref_type     text NOT NULL,
  ref_id       uuid NOT NULL,
  amount       numeric(14,2) NOT NULL,
  occurred_at  timestamptz(6) NOT NULL,
  event_id     uuid,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT receivable_entry_pkey PRIMARY KEY (id),
  CONSTRAINT receivable_entry_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_entry_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_entry_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_entry_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_entry_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_entry_amount_check CHECK (amount <> 0 AND amount = round(amount, 2))
);
COMMENT ON TABLE ops.receivable_entry IS 'Ledger of what a billed party owes for a unit (D-044): invoice +, payment −, credit note −, debit note +, refund +, write-off −. Append-only; posted by subscribers of the business events.';
CREATE UNIQUE INDEX receivable_entry_event_id_key ON ops.receivable_entry (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX receivable_entry_party_id_unit_id_occurred_at_idx ON ops.receivable_entry (party_id, unit_id, occurred_at);
CREATE INDEX receivable_entry_tenant_id_idx ON ops.receivable_entry (tenant_id);
CREATE INDEX receivable_entry_building_id_idx ON ops.receivable_entry (building_id);
CREATE INDEX receivable_entry_unit_id_idx ON ops.receivable_entry (unit_id);
CREATE INDEX receivable_entry_lease_id_idx ON ops.receivable_entry (lease_id);
CREATE INDEX receivable_entry_ref_id_idx ON ops.receivable_entry (ref_id);

CREATE TABLE ops.receivable_balance (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  party_id             uuid NOT NULL,
  unit_id              uuid,
  balance              numeric(14,2) NOT NULL DEFAULT 0,
  open_invoices_count  integer NOT NULL DEFAULT 0,
  oldest_due_date      date,
  days_overdue         integer NOT NULL DEFAULT 0,
  aging                jsonb NOT NULL DEFAULT '{}',
  credit_balance       numeric(14,2) NOT NULL DEFAULT 0,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1,
  CONSTRAINT receivable_balance_pkey PRIMARY KEY (id),
  CONSTRAINT receivable_balance_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_balance_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_balance_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_balance_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT receivable_balance_counts_check CHECK (open_invoices_count >= 0 AND days_overdue >= 0 AND credit_balance >= 0)
);
COMMENT ON TABLE ops.receivable_balance IS 'What a billed party owes for a unit now (D-044, D-045): open invoices, credit, aging buckets, days overdue. Materialised with each ledger entry and refreshed daily.';
CREATE UNIQUE INDEX receivable_balance_party_unit_key ON ops.receivable_balance (tenant_id, party_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX receivable_balance_party_key ON ops.receivable_balance (tenant_id, party_id) WHERE unit_id IS NULL;
CREATE INDEX receivable_balance_tenant_id_building_id_balance_idx ON ops.receivable_balance (tenant_id, building_id, balance DESC);
CREATE INDEX receivable_balance_building_id_idx ON ops.receivable_balance (building_id);
CREATE INDEX receivable_balance_party_id_idx ON ops.receivable_balance (party_id);
CREATE INDEX receivable_balance_unit_id_idx ON ops.receivable_balance (unit_id);

-- ------------------------------------------------------------------------------------------- dunning
CREATE TABLE ops.dunning_reminder (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  invoice_id            uuid NOT NULL,
  workflow_instance_id  uuid,
  timer_id              uuid,
  step                  smallint NOT NULL,
  scheduled_for         timestamptz(6) NOT NULL,
  status                ops.reminder_status NOT NULL DEFAULT 'scheduled',
  sent_at               timestamptz(6),
  notification_id       uuid,
  triggered_by          ops.reminder_trigger NOT NULL,
  created_by            uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT dunning_reminder_pkey PRIMARY KEY (id),
  CONSTRAINT dunning_reminder_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_workflow_instance_id_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_timer_id_fkey FOREIGN KEY (timer_id) REFERENCES ops.workflow_timer (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES platform.notification (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_created_by_fkey FOREIGN KEY (created_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dunning_reminder_step_check CHECK (step >= 0 AND (triggered_by = 'owner' OR step > 0)),
  CONSTRAINT dunning_reminder_sent_check CHECK (status NOT IN ('sent', 'deferred_quiet_hours') OR sent_at IS NOT NULL)
);
COMMENT ON TABLE ops.dunning_reminder IS 'Payment reminders of an overdue invoice (D-045): the steps of reminders.schedule as workflow timers, and the owner''s "send now".';
CREATE UNIQUE INDEX dunning_reminder_invoice_id_step_key ON ops.dunning_reminder (invoice_id, step) WHERE triggered_by = 'schedule';
CREATE INDEX dunning_reminder_invoice_id_idx ON ops.dunning_reminder (invoice_id);
CREATE INDEX dunning_reminder_tenant_id_idx ON ops.dunning_reminder (tenant_id);
CREATE INDEX dunning_reminder_building_id_idx ON ops.dunning_reminder (building_id);
CREATE INDEX dunning_reminder_workflow_instance_id_idx ON ops.dunning_reminder (workflow_instance_id);
CREATE INDEX dunning_reminder_timer_id_idx ON ops.dunning_reminder (timer_id);
CREATE INDEX dunning_reminder_notification_id_idx ON ops.dunning_reminder (notification_id);
CREATE INDEX dunning_reminder_created_by_idx ON ops.dunning_reminder (created_by);

-- ------------------------------------------------------------------------------------------- penalties
CREATE TABLE ops.penalty_assessment (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  building_id              uuid NOT NULL,
  invoice_id               uuid NOT NULL,
  lease_id                 uuid,
  party_id                 uuid NOT NULL,
  unit_id                  uuid,
  amount                   numeric(14,2) NOT NULL,
  basis                    jsonb NOT NULL DEFAULT '{}',
  compliance_rule_id       text NOT NULL DEFAULT 'compliance.late_fee_policy',
  allowed                  boolean NOT NULL,
  invoice_charge_id        uuid,
  applied_invoice_line_id  uuid,
  status                   ops.penalty_status NOT NULL DEFAULT 'pending',
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  version                  integer NOT NULL DEFAULT 1,
  CONSTRAINT penalty_assessment_pkey PRIMARY KEY (id),
  CONSTRAINT penalty_assessment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES ops.invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_invoice_charge_id_fkey FOREIGN KEY (invoice_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_applied_invoice_line_id_fkey FOREIGN KEY (applied_invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT penalty_assessment_amount_check CHECK (amount >= 0 AND amount = round(amount, 2)),
  -- ⚖ O-002 / D-024: a penalty that is not allowed never reaches an invoice
  CONSTRAINT penalty_assessment_allowed_check CHECK (allowed OR (status = 'waived' AND invoice_charge_id IS NULL)),
  CONSTRAINT penalty_assessment_applied_check CHECK ((status = 'applied') = (applied_invoice_line_id IS NOT NULL))
);
COMMENT ON TABLE ops.penalty_assessment IS 'Late fee of an overdue invoice (D-045, ⚖ O-002): only when late_fee.enabled and compliance.late_fee_policy allows; added to the next invoice, never to the issued one.';
CREATE UNIQUE INDEX penalty_assessment_invoice_id_key ON ops.penalty_assessment (invoice_id);
CREATE INDEX penalty_assessment_tenant_id_idx ON ops.penalty_assessment (tenant_id);
CREATE INDEX penalty_assessment_building_id_idx ON ops.penalty_assessment (building_id);
CREATE INDEX penalty_assessment_lease_id_idx ON ops.penalty_assessment (lease_id);
CREATE INDEX penalty_assessment_party_id_idx ON ops.penalty_assessment (party_id);
CREATE INDEX penalty_assessment_unit_id_idx ON ops.penalty_assessment (unit_id);
CREATE INDEX penalty_assessment_invoice_charge_id_idx ON ops.penalty_assessment (invoice_charge_id);
CREATE INDEX penalty_assessment_applied_invoice_line_id_idx ON ops.penalty_assessment (applied_invoice_line_id);

-- ------------------------------------------------------------------------------------------- integrity
CREATE TRIGGER receivable_entry_append_only BEFORE UPDATE OR DELETE ON ops.receivable_entry FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER receivable_balance_set_updated_at BEFORE UPDATE ON ops.receivable_balance FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER dunning_reminder_set_updated_at BEFORE UPDATE ON ops.dunning_reminder FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER penalty_assessment_set_updated_at BEFORE UPDATE ON ops.penalty_assessment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------- RLS (§4.5)
SELECT platform.apply_rls('ops.receivable_entry', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.receivable_balance', 'unit', 'ops.billing');
SELECT platform.apply_rls('ops.dunning_reminder', 'building', 'ops.billing');
SELECT platform.apply_rls('ops.penalty_assessment', 'unit', 'ops.billing');

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.receivable_entry, ops.receivable_balance, ops.dunning_reminder,
  ops.penalty_assessment TO gp_app, gp_platform;
GRANT SELECT ON ops.receivable_entry, ops.receivable_balance, ops.dunning_reminder, ops.penalty_assessment TO gp_reporting;
