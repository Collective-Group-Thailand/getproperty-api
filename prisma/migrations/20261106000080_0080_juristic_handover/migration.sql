-- getproperty-api 0080 — developer handover from getbuild (Phase J step J3.2, D-314 = D-J13, D-333).
-- schema-design §7.5 rows 286–289.
--   * juristic.handover: one `building.handover.requested` (v1 / v2) received from getbuild — tenant null until the
--     platform assigns it to a juristic tenant (inbox of the juristic office), then accepted (applied) or rejected
--     (sent back to getbuild through the GETBUILD_HANDOFF port); formation of the juristic person switches the operator
--     period from the developer.
--   * juristic.handover_unit: per unit money of an accepted handover (advance common fees, first fund contribution,
--     receivables brought forward) and its journal.
--   * ops.invoice.handover_id (opening-balance invoices of a handover), ops.payer_credit.handover_id,
--     ops.credit_entry_kind + handover_advance, juristic.journal_source + handover.
-- Every new table RLS:T (a null tenant is invisible to gp_app; the platform reads as gp_platform). No core.* change.

ALTER TYPE ops.credit_entry_kind ADD VALUE IF NOT EXISTS 'handover_advance';
ALTER TYPE juristic.journal_source ADD VALUE IF NOT EXISTS 'handover';

CREATE TYPE juristic.handover_state AS ENUM ('received', 'pending_review', 'accepted', 'rejected', 'superseded');

CREATE TABLE juristic.handover (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid,
  integration_event_id   uuid NOT NULL,
  contract_version       smallint NOT NULL,
  state                  juristic.handover_state NOT NULL DEFAULT 'received',
  developer_ref          text NOT NULL,
  property_ref           text NOT NULL,
  building_ref           text NOT NULL,
  building_name          text NOT NULL,
  requested_handover_at  timestamptz(6) NOT NULL,
  as_of_date             date,
  payload                jsonb NOT NULL,
  totals                 jsonb NOT NULL DEFAULT '{}',
  receiving_bank         jsonb,
  developer_tenant_id    uuid,
  building_id            uuid,
  bank_account_id        uuid,
  assigned_at            timestamptz(6),
  assigned_by            uuid,
  accepted_at            timestamptz(6),
  accepted_by            uuid,
  notify_opening_balances boolean,
  rejected_at            timestamptz(6),
  rejected_by            uuid,
  reject_reason          text,
  rejection_delivered_at timestamptz(6),
  rejection_attempts     integer NOT NULL DEFAULT 0,
  last_delivery_error    text,
  superseded_by_id       uuid,
  formed_on              date,
  formed_at              timestamptz(6),
  formed_by              uuid,
  registration_no        text,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT handover_pkey PRIMARY KEY (id),
  CONSTRAINT handover_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_integration_event_id_fkey FOREIGN KEY (integration_event_id) REFERENCES bridge.integration_event (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_developer_tenant_id_fkey FOREIGN KEY (developer_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_superseded_by_id_fkey FOREIGN KEY (superseded_by_id) REFERENCES juristic.handover (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_contract_version_check CHECK (contract_version IN (1, 2)),
  CONSTRAINT handover_refs_check CHECK (length(developer_ref) BETWEEN 1 AND 200 AND length(property_ref) BETWEEN 1 AND 200
                                        AND length(building_ref) BETWEEN 1 AND 200),
  CONSTRAINT handover_assigned_check CHECK (state IN ('received', 'superseded', 'rejected') OR tenant_id IS NOT NULL),
  CONSTRAINT handover_accepted_check CHECK (state <> 'accepted' OR (accepted_at IS NOT NULL AND building_id IS NOT NULL)),
  CONSTRAINT handover_rejected_check CHECK ((state = 'rejected') = (rejected_at IS NOT NULL)
                                            AND (state <> 'rejected' OR length(reject_reason) BETWEEN 5 AND 1000)),
  CONSTRAINT handover_formed_check CHECK ((formed_at IS NULL) = (formed_on IS NULL) AND (formed_at IS NULL OR state = 'accepted')),
  CONSTRAINT handover_developer_check CHECK (developer_tenant_id IS NULL OR developer_tenant_id <> tenant_id)
);
COMMENT ON TABLE juristic.handover IS 'D-314 / D-333 (J3.2): one building.handover.requested from getbuild — assigned to a juristic tenant (its inbox), accepted (register, advance fees as credits, first fund contributions, receivables brought forward as OPB invoices; totals equal the payload) or rejected back to getbuild; the juristic person''s formation switches the operator period from the developer.';
CREATE UNIQUE INDEX handover_integration_event_id_key ON juristic.handover (integration_event_id);
CREATE UNIQUE INDEX handover_building_open_key ON juristic.handover (developer_ref, building_ref)
  WHERE (state IN ('received', 'pending_review', 'accepted'));
CREATE INDEX handover_tenant_id_state_idx ON juristic.handover (tenant_id, state);
CREATE INDEX handover_state_idx ON juristic.handover (state) WHERE (state = 'rejected' AND rejection_delivered_at IS NULL);
CREATE INDEX handover_developer_tenant_id_idx ON juristic.handover (developer_tenant_id) WHERE developer_tenant_id IS NOT NULL;
CREATE INDEX handover_building_id_idx ON juristic.handover (building_id) WHERE building_id IS NOT NULL;
CREATE INDEX handover_bank_account_id_idx ON juristic.handover (bank_account_id) WHERE bank_account_id IS NOT NULL;
CREATE INDEX handover_superseded_by_id_idx ON juristic.handover (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE TRIGGER handover_set_updated_at BEFORE UPDATE ON juristic.handover FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('juristic.handover', 'tenant');

CREATE TABLE juristic.handover_unit (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  handover_id         uuid NOT NULL,
  unit_id             uuid NOT NULL,
  unit_ref            text NOT NULL,
  advance_amount      numeric(14,2) NOT NULL DEFAULT 0,
  advance_period_from date,
  advance_period_to   date,
  fund_amount         numeric(14,2) NOT NULL DEFAULT 0,
  receivables_amount  numeric(14,2) NOT NULL DEFAULT 0,
  journal_id          uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT handover_unit_pkey PRIMARY KEY (id),
  CONSTRAINT handover_unit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_unit_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES juristic.handover (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_unit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_unit_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES juristic.journal (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT handover_unit_amounts_check CHECK (advance_amount >= 0 AND fund_amount >= 0 AND receivables_amount >= 0),
  CONSTRAINT handover_unit_period_check CHECK ((advance_period_from IS NULL) = (advance_period_to IS NULL)
                                               AND (advance_period_to IS NULL OR advance_period_to >= advance_period_from))
);
COMMENT ON TABLE juristic.handover_unit IS 'D-333 (J3.2): the money a unit brought with an accepted handover and its journal (source handover).';
CREATE UNIQUE INDEX handover_unit_handover_id_unit_id_key ON juristic.handover_unit (handover_id, unit_id);
CREATE INDEX handover_unit_tenant_id_idx ON juristic.handover_unit (tenant_id);
CREATE INDEX handover_unit_unit_id_idx ON juristic.handover_unit (unit_id);
CREATE INDEX handover_unit_journal_id_idx ON juristic.handover_unit (journal_id) WHERE journal_id IS NOT NULL;
SELECT platform.apply_rls('juristic.handover_unit', 'tenant');

ALTER TABLE ops.invoice ADD COLUMN handover_id uuid;
ALTER TABLE ops.invoice
  ADD CONSTRAINT invoice_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES juristic.handover (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.invoice VALIDATE CONSTRAINT invoice_handover_id_fkey;
CREATE INDEX invoice_handover_id_idx ON ops.invoice (handover_id) WHERE handover_id IS NOT NULL;
COMMENT ON COLUMN ops.invoice.handover_id IS 'D-333 (J3.2): the developer handover whose receivables brought forward this opening-balance invoice carries (series OPB; the payer''s credit is never set off against it).';

ALTER TABLE ops.payer_credit ADD COLUMN handover_id uuid;
ALTER TABLE ops.payer_credit
  ADD CONSTRAINT payer_credit_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES juristic.handover (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE ops.payer_credit VALIDATE CONSTRAINT payer_credit_handover_id_fkey;
CREATE INDEX payer_credit_handover_id_idx ON ops.payer_credit (handover_id) WHERE handover_id IS NOT NULL;
COMMENT ON COLUMN ops.payer_credit.handover_id IS 'D-333 (J3.2): advance common fees the owner paid to the developer, carried as credit (kind handover_advance).';
-- the advance fees are a positive credit like an overpayment, always from a handover (text comparison: the enum value
-- added above cannot be used as a literal in the same transaction)
ALTER TABLE ops.payer_credit DROP CONSTRAINT payer_credit_amount_check;
ALTER TABLE ops.payer_credit ADD CONSTRAINT payer_credit_amount_check CHECK (amount <> 0 AND amount = round(amount, 2)
  AND ((kind::text IN ('overpayment', 'handover_advance') AND amount > 0) OR (kind::text IN ('applied', 'refunded', 'reversed') AND amount < 0)));
ALTER TABLE ops.payer_credit ADD CONSTRAINT payer_credit_handover_check CHECK ((kind::text = 'handover_advance') = (handover_id IS NOT NULL));
