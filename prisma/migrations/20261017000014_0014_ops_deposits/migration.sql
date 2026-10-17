-- getproperty-api 0014 — A1 deposits, move-in/move-out inspections and the 7-day settlement (B2.4; schema-design v2
-- §3.3.3, §7.3; D-023, D-159). The settlement runs on a workflow instance (deposit_settlement v2); deductions need
-- evidence and never cover normal wear (compliance.deposit_evidence / compliance.deposit_wear).

CREATE TYPE ops.deposit_status AS ENUM ('pending', 'held', 'settling', 'refunded', 'forfeited_partially', 'forfeited', 'disputed');
CREATE TYPE ops.settlement_status AS ENUM ('opened', 'inspected', 'proposed', 'agreed', 'disputed', 'refunded', 'closed');
CREATE TYPE ops.resident_response AS ENUM ('accepted', 'disputed');
CREATE TYPE ops.refund_method AS ENUM ('bank_transfer', 'cash', 'offset');
CREATE TYPE ops.deduction_kind AS ENUM ('damage', 'missing_item', 'cleaning', 'unpaid_invoice', 'other');
CREATE TYPE ops.wear_category AS ENUM ('normal_wear', 'damage');
CREATE TYPE ops.inspection_type AS ENUM ('move_in', 'move_out', 'periodic');
CREATE TYPE ops.inspection_status AS ENUM ('scheduled', 'in_progress', 'completed', 'signed');
CREATE TYPE ops.item_condition AS ENUM ('good', 'fair', 'damaged', 'missing', 'not_applicable');

CREATE TABLE ops.inspection_template (
  id         uuid NOT NULL DEFAULT uuidv7(),
  tenant_id  uuid,
  name       text NOT NULL,
  items      jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT inspection_template_pkey PRIMARY KEY (id),
  CONSTRAINT inspection_template_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_template_name_check CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT inspection_template_items_check CHECK (jsonb_typeof(items) = 'array')
);
COMMENT ON TABLE ops.inspection_template IS 'Checklist of a room inspection ([{key, labelTh, labelEn, area}]); tenant_id NULL = the platform default checklist.';
CREATE UNIQUE INDEX inspection_template_tenant_id_name_key ON ops.inspection_template (tenant_id, name) NULLS NOT DISTINCT;

ALTER TABLE ops.unit_profile
  ADD CONSTRAINT unit_profile_inspection_template_id_fkey FOREIGN KEY (inspection_template_id) REFERENCES ops.inspection_template (id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.unit_profile VALIDATE CONSTRAINT unit_profile_inspection_template_id_fkey;
CREATE INDEX unit_profile_inspection_template_id_idx ON ops.unit_profile (inspection_template_id);

CREATE TABLE ops.inspection (
  id                             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                      uuid NOT NULL,
  building_id                    uuid NOT NULL,
  unit_id                        uuid NOT NULL,
  lease_id                       uuid,
  type                           ops.inspection_type NOT NULL,
  template_id                    uuid,
  status                         ops.inspection_status NOT NULL DEFAULT 'scheduled',
  scheduled_for                  timestamptz(6),
  started_at                     timestamptz(6),
  completed_at                   timestamptz(6),
  inspector_user_id              uuid,
  resident_signature_document_id uuid,
  staff_signature_document_id    uuid,
  report_number                  citext,
  report_document_id             uuid,
  notes                          text,
  created_at                     timestamptz(6) NOT NULL DEFAULT now(),
  created_by                     uuid,
  updated_at                     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                     uuid,
  version                        integer NOT NULL DEFAULT 1,
  CONSTRAINT inspection_pkey PRIMARY KEY (id),
  CONSTRAINT inspection_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_template_id_fkey FOREIGN KEY (template_id) REFERENCES ops.inspection_template (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT inspection_resident_signature_fkey FOREIGN KEY (resident_signature_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_staff_signature_fkey FOREIGN KEY (staff_signature_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_report_document_fkey FOREIGN KEY (report_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_lease_type_check CHECK (type = 'periodic' OR lease_id IS NOT NULL),
  CONSTRAINT inspection_completed_check CHECK (status NOT IN ('completed', 'signed') OR completed_at IS NOT NULL)
);
COMMENT ON TABLE ops.inspection IS 'Move-in / move-out / periodic inspection of a unit with its checklist items, photos and signatures (D-023).';
CREATE UNIQUE INDEX inspection_tenant_id_report_number_key ON ops.inspection (tenant_id, report_number);
CREATE UNIQUE INDEX inspection_lease_id_type_key ON ops.inspection (lease_id, type) WHERE type <> 'periodic';
CREATE INDEX inspection_tenant_id_building_id_type_status_idx ON ops.inspection (tenant_id, building_id, type, status);
CREATE INDEX inspection_unit_id_idx ON ops.inspection (unit_id);

CREATE TABLE ops.inspection_item (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  inspection_id       uuid NOT NULL,
  item_key            text NOT NULL,
  label               text NOT NULL,
  area                text,
  condition           ops.item_condition,
  notes               text,
  photo_document_ids  uuid[] NOT NULL DEFAULT '{}',
  meter_asset_item_id uuid,
  meter_register      numeric(12,3),
  sort_order          smallint NOT NULL DEFAULT 0,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT inspection_item_pkey PRIMARY KEY (id),
  CONSTRAINT inspection_item_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_item_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES ops.inspection (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT inspection_item_meter_asset_item_id_fkey FOREIGN KEY (meter_asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT inspection_item_key_check CHECK (item_key ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  CONSTRAINT inspection_item_register_check CHECK (meter_register IS NULL OR meter_register >= 0),
  CONSTRAINT inspection_item_meter_check CHECK (meter_register IS NULL OR meter_asset_item_id IS NOT NULL)
);
COMMENT ON TABLE ops.inspection_item IS 'One checklist line: condition, notes, photos (core.document ids); meter registers are kept here until smart.meter_reading exists (B3.3).';
CREATE UNIQUE INDEX inspection_item_inspection_id_item_key_key ON ops.inspection_item (inspection_id, item_key);
CREATE INDEX inspection_item_tenant_id_idx ON ops.inspection_item (tenant_id);

CREATE TABLE ops.deposit (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  unit_id             uuid NOT NULL,
  lease_id            uuid NOT NULL,
  amount_security     numeric(14,2) NOT NULL,
  amount_advance_rent numeric(14,2) NOT NULL DEFAULT 0,
  status              ops.deposit_status NOT NULL DEFAULT 'pending',
  received_at         timestamptz(6),
  received_payment_id uuid,
  receipt_id          uuid,
  receipt_number      citext,
  receipt_document_id uuid,
  receipt_reference   text,
  carried_from_deposit_id uuid,
  held_at             timestamptz(6),
  settled_at          timestamptz(6),
  deductions_summary  jsonb,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT deposit_pkey PRIMARY KEY (id),
  CONSTRAINT deposit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_receipt_document_fkey FOREIGN KEY (receipt_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_carried_from_fkey FOREIGN KEY (carried_from_deposit_id) REFERENCES ops.deposit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_amounts_check CHECK (amount_security >= 0 AND amount_advance_rent >= 0
    AND amount_security = round(amount_security, 2) AND amount_advance_rent = round(amount_advance_rent, 2)),
  CONSTRAINT deposit_received_check CHECK (status = 'pending' OR received_at IS NOT NULL)
);
COMMENT ON TABLE ops.deposit IS 'Security deposit and advance rent of a lease (D-023); payment/receipt FKs arrive with B4.4/B4.3 (receipt_number from the deposit_receipt series until then).';
CREATE UNIQUE INDEX deposit_lease_id_key ON ops.deposit (lease_id);
CREATE UNIQUE INDEX deposit_tenant_id_receipt_number_key ON ops.deposit (tenant_id, receipt_number);
CREATE INDEX deposit_tenant_id_status_idx ON ops.deposit (tenant_id, status);
CREATE INDEX deposit_unit_id_idx ON ops.deposit (unit_id);
CREATE INDEX deposit_carried_from_deposit_id_idx ON ops.deposit (carried_from_deposit_id);

CREATE TABLE ops.deposit_settlement (
  id                          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL,
  building_id                 uuid NOT NULL,
  unit_id                     uuid NOT NULL,
  deposit_id                  uuid NOT NULL,
  lease_id                    uuid NOT NULL,
  workflow_instance_id        uuid NOT NULL,
  opened_at                   timestamptz(6) NOT NULL,
  move_out_at                 timestamptz(6) NOT NULL,
  deadline_at                 timestamptz(6) NOT NULL,
  status                      ops.settlement_status NOT NULL DEFAULT 'opened',
  move_in_inspection_id       uuid,
  move_out_inspection_id      uuid,
  final_invoice_id            uuid,
  deposit_held                numeric(14,2) NOT NULL,
  deductions_total            numeric(14,2) NOT NULL DEFAULT 0,
  utilities_final             numeric(14,2) NOT NULL DEFAULT 0,
  proposed_refund             numeric(14,2),
  agreed_refund               numeric(14,2),
  proposed_at                 timestamptz(6),
  proposed_by                 uuid,
  resident_response           ops.resident_response,
  resident_responded_at       timestamptz(6),
  dispute_reason              text,
  refunded_at                 timestamptz(6),
  refund_amount               numeric(14,2),
  refund_method               ops.refund_method,
  refund_reference            text,
  refund_evidence_document_id uuid,
  statement_number            citext,
  statement_document_id       uuid,
  closed_at                   timestamptz(6),
  is_late                     boolean NOT NULL DEFAULT false,
  late_flagged_at             timestamptz(6),
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                  uuid,
  version                     integer NOT NULL DEFAULT 1,
  CONSTRAINT deposit_settlement_pkey PRIMARY KEY (id),
  CONSTRAINT deposit_settlement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_deposit_id_fkey FOREIGN KEY (deposit_id) REFERENCES ops.deposit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_workflow_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_move_in_fkey FOREIGN KEY (move_in_inspection_id) REFERENCES ops.inspection (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_move_out_fkey FOREIGN KEY (move_out_inspection_id) REFERENCES ops.inspection (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_refund_evidence_fkey FOREIGN KEY (refund_evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_statement_document_fkey FOREIGN KEY (statement_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_amounts_check CHECK (deposit_held >= 0 AND deductions_total >= 0 AND utilities_final >= 0
    AND (proposed_refund IS NULL OR proposed_refund >= 0) AND (agreed_refund IS NULL OR agreed_refund >= 0)
    AND (refund_amount IS NULL OR refund_amount >= 0)),
  CONSTRAINT deposit_settlement_deadline_check CHECK (deadline_at > move_out_at),
  CONSTRAINT deposit_settlement_refund_check CHECK (status NOT IN ('refunded', 'closed') OR (refunded_at IS NOT NULL AND refund_amount IS NOT NULL AND refund_method IS NOT NULL)),
  CONSTRAINT deposit_settlement_transfer_evidence_check CHECK (refund_method IS DISTINCT FROM 'bank_transfer' OR refund_evidence_document_id IS NOT NULL),
  CONSTRAINT deposit_settlement_response_check CHECK ((resident_response IS NULL) = (resident_responded_at IS NULL)),
  CONSTRAINT deposit_settlement_late_check CHECK (NOT is_late OR late_flagged_at IS NOT NULL)
);
COMMENT ON TABLE ops.deposit_settlement IS 'The 7-day deposit settlement (D-023) on a deposit_settlement workflow instance; is_late is set when the SLA breaches or the refund is recorded after deadline_at.';
CREATE UNIQUE INDEX deposit_settlement_deposit_id_key ON ops.deposit_settlement (deposit_id);
CREATE UNIQUE INDEX deposit_settlement_tenant_id_statement_number_key ON ops.deposit_settlement (tenant_id, statement_number);
CREATE INDEX deposit_settlement_tenant_id_status_deadline_at_idx ON ops.deposit_settlement (tenant_id, status, deadline_at);
CREATE INDEX deposit_settlement_lease_id_idx ON ops.deposit_settlement (lease_id);
CREATE INDEX deposit_settlement_workflow_instance_id_idx ON ops.deposit_settlement (workflow_instance_id);

CREATE TABLE ops.deposit_settlement_item (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  settlement_id         uuid NOT NULL,
  kind                  ops.deduction_kind NOT NULL,
  description           text NOT NULL,
  amount                numeric(14,2) NOT NULL,
  inspection_item_id    uuid,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  wear_category         ops.wear_category NOT NULL DEFAULT 'damage',
  resident_accepted     boolean,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT deposit_settlement_item_pkey PRIMARY KEY (id),
  CONSTRAINT deposit_settlement_item_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_item_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES ops.deposit_settlement (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_item_inspection_item_id_fkey FOREIGN KEY (inspection_item_id) REFERENCES ops.inspection_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT deposit_settlement_item_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  CONSTRAINT deposit_settlement_item_wear_check CHECK (wear_category <> 'normal_wear'),
  CONSTRAINT deposit_settlement_item_evidence_check CHECK (kind NOT IN ('damage', 'missing_item') OR (cardinality(evidence_document_ids) >= 1 AND inspection_item_id IS NOT NULL))
);
COMMENT ON TABLE ops.deposit_settlement_item IS 'A deduction: damage and missing items need the move-out inspection item and photo evidence (compliance.deposit_evidence); normal wear is never deducted (compliance.deposit_wear).';
CREATE INDEX deposit_settlement_item_settlement_id_idx ON ops.deposit_settlement_item (settlement_id);
CREATE INDEX deposit_settlement_item_tenant_id_idx ON ops.deposit_settlement_item (tenant_id);
CREATE INDEX deposit_settlement_item_inspection_item_id_idx ON ops.deposit_settlement_item (inspection_item_id);

CREATE TRIGGER inspection_template_set_updated_at BEFORE UPDATE ON ops.inspection_template FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER inspection_set_updated_at BEFORE UPDATE ON ops.inspection FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER inspection_item_set_updated_at BEFORE UPDATE ON ops.inspection_item FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER deposit_set_updated_at BEFORE UPDATE ON ops.deposit FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER deposit_settlement_set_updated_at BEFORE UPDATE ON ops.deposit_settlement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER deposit_settlement_item_set_updated_at BEFORE UPDATE ON ops.deposit_settlement_item FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Row-level security (schema-design §4.5).
SELECT platform.apply_rls('ops.inspection_template', 'tenant_or_shared');
SELECT platform.apply_rls('ops.inspection', 'unit', 'ops.lease');
SELECT platform.apply_rls('ops.deposit', 'unit', 'ops.lease');
SELECT platform.apply_rls('ops.deposit_settlement', 'unit', 'ops.lease');
-- Children inherit their parent's visibility ("via inspection" / "via settlement"); writes stay with the tenant.
SELECT platform.apply_rls('ops.inspection_item', 'platform_only');
CREATE POLICY inspection_item_rls_read ON ops.inspection_item FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.inspection i WHERE i.id = inspection_id));
CREATE POLICY inspection_item_rls_write ON ops.inspection_item FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
SELECT platform.apply_rls('ops.deposit_settlement_item', 'platform_only');
CREATE POLICY deposit_settlement_item_rls_read ON ops.deposit_settlement_item FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.deposit_settlement s WHERE s.id = settlement_id));
CREATE POLICY deposit_settlement_item_rls_write ON ops.deposit_settlement_item FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.inspection_template, ops.inspection, ops.inspection_item, ops.deposit,
  ops.deposit_settlement, ops.deposit_settlement_item TO gp_app, gp_platform;
GRANT SELECT ON ops.inspection_template, ops.inspection, ops.inspection_item, ops.deposit, ops.deposit_settlement,
  ops.deposit_settlement_item TO gp_reporting;
