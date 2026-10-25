-- getproperty-api 0049 — landlord service requests: who fixes, who pays (B7 deliverable 7.8, D-263). A landlord decides
-- per request who handles it and who bears the cost (a share when shared); every decision is a history row. Quotations
-- and receipts are attached with their amounts; the tenant's share (or the owner's share of what the tenant paid) is
-- settled onto the next invoice as a pending invoice charge; owner-borne costs are the expenses of the annual income
-- summary (B7.5). Apartments keep the technician queue (D-210). schema-design §7.5 rows 123–126.

CREATE TYPE ops.service_handler AS ENUM ('owner_technician', 'tenant', 'partner');
CREATE TYPE ops.service_cost_bearer AS ENUM ('owner', 'tenant', 'shared');
CREATE TYPE ops.service_cost_kind AS ENUM ('quotation', 'receipt');
CREATE TYPE ops.service_cost_payer AS ENUM ('owner', 'tenant');

ALTER TABLE ops.service_request
  ADD COLUMN handled_by ops.service_handler,
  ADD COLUMN cost_bearer ops.service_cost_bearer,
  ADD COLUMN tenant_share_percent numeric(5,2),
  ADD COLUMN decided_at timestamptz(6),
  ADD CONSTRAINT service_request_decision_check CHECK (
    (handled_by IS NULL) = (cost_bearer IS NULL) AND (handled_by IS NULL) = (decided_at IS NULL)
  ),
  ADD CONSTRAINT service_request_share_check CHECK (
    (cost_bearer = 'shared' AND tenant_share_percent > 0 AND tenant_share_percent < 100)
    OR (cost_bearer IS DISTINCT FROM 'shared' AND tenant_share_percent IS NULL)
  );
COMMENT ON COLUMN ops.service_request.handled_by IS 'D-263 (landlords): who fixes it — the owner''s technician, the tenant, or a juristic / partner technician.';
COMMENT ON COLUMN ops.service_request.cost_bearer IS 'D-263 (landlords): who pays — owner, tenant, or shared (tenant_share_percent).';

CREATE TABLE ops.service_decision (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  service_request_id    uuid NOT NULL,
  handled_by            ops.service_handler NOT NULL,
  cost_bearer           ops.service_cost_bearer NOT NULL,
  tenant_share_percent  numeric(5,2),
  note                  text,
  decided_at            timestamptz(6) NOT NULL DEFAULT now(),
  decided_by            uuid,
  CONSTRAINT service_decision_pkey PRIMARY KEY (id),
  CONSTRAINT service_decision_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_decision_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_decision_note_check CHECK (note IS NULL OR length(note) <= 500)
);
COMMENT ON TABLE ops.service_decision IS 'Every who-fixes / who-pays decision on a landlord''s service request, newest last (D-263); append-only.';
CREATE INDEX service_decision_service_request_id_idx ON ops.service_decision (service_request_id, decided_at);
CREATE INDEX service_decision_tenant_id_idx ON ops.service_decision (tenant_id);
SELECT platform.apply_rls('ops.service_decision', 'tenant');
GRANT SELECT, INSERT ON ops.service_decision TO gp_app, gp_platform;
GRANT SELECT ON ops.service_decision TO gp_reporting;

CREATE TABLE ops.service_cost (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  unit_id             uuid,
  service_request_id  uuid NOT NULL,
  kind                ops.service_cost_kind NOT NULL,
  description         text NOT NULL,
  amount              numeric(14,2) NOT NULL,
  paid_by             ops.service_cost_payer,
  vendor_name         text,
  document_id         uuid,
  issued_on           date NOT NULL,
  voided_at           timestamptz(6),
  void_reason         text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT service_cost_pkey PRIMARY KEY (id),
  CONSTRAINT service_cost_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_cost_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_cost_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_cost_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_cost_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_cost_amount_check CHECK (amount >= 0 AND amount = round(amount, 2)),
  CONSTRAINT service_cost_description_check CHECK (char_length(description) BETWEEN 1 AND 200),
  CONSTRAINT service_cost_vendor_check CHECK (vendor_name IS NULL OR char_length(vendor_name) <= 200),
  CONSTRAINT service_cost_payer_check CHECK ((kind = 'receipt') = (paid_by IS NOT NULL)),
  CONSTRAINT service_cost_void_check CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
COMMENT ON TABLE ops.service_cost IS 'Quotations and receipts of a landlord''s service request with their amounts and documents (D-263); a receipt says who paid the vendor. Voided, never deleted.';
CREATE INDEX service_cost_service_request_id_idx ON ops.service_cost (service_request_id);
CREATE INDEX service_cost_tenant_id_issued_on_idx ON ops.service_cost (tenant_id, issued_on);
CREATE INDEX service_cost_building_id_idx ON ops.service_cost (building_id);
CREATE INDEX service_cost_unit_id_idx ON ops.service_cost (unit_id);
CREATE INDEX service_cost_document_id_idx ON ops.service_cost (document_id);
SELECT platform.apply_rls('ops.service_cost', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.service_cost TO gp_app, gp_platform;
GRANT SELECT ON ops.service_cost TO gp_reporting;

CREATE TABLE ops.service_settlement (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  service_request_id  uuid NOT NULL,
  party_id            uuid NOT NULL,
  amount              numeric(14,2) NOT NULL,
  invoice_charge_id   uuid NOT NULL,
  settled_at          timestamptz(6) NOT NULL DEFAULT now(),
  settled_by          uuid,
  CONSTRAINT service_settlement_pkey PRIMARY KEY (id),
  CONSTRAINT service_settlement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_settlement_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_settlement_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_settlement_invoice_charge_id_fkey FOREIGN KEY (invoice_charge_id) REFERENCES ops.invoice_charge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_settlement_amount_check CHECK (amount <> 0 AND amount = round(amount, 2))
);
COMMENT ON TABLE ops.service_settlement IS 'The tenant''s share of a repair billed on the next invoice (positive) or the owner''s share of what the tenant paid credited (negative), as a pending invoice charge (D-263).';
CREATE INDEX service_settlement_service_request_id_idx ON ops.service_settlement (service_request_id);
CREATE INDEX service_settlement_tenant_id_idx ON ops.service_settlement (tenant_id);
CREATE INDEX service_settlement_party_id_idx ON ops.service_settlement (party_id);
CREATE UNIQUE INDEX service_settlement_invoice_charge_id_key ON ops.service_settlement (invoice_charge_id);
SELECT platform.apply_rls('ops.service_settlement', 'tenant');
GRANT SELECT, INSERT ON ops.service_settlement TO gp_app, gp_platform;
GRANT SELECT ON ops.service_settlement TO gp_reporting;
