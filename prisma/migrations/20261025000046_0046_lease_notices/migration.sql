-- getproperty-api 0046 — B7.5 landlord document set, part 2: written notices to the lessee (D-253, D-020, D-024).
-- schema-design §7.5 row 119. A notice is a numbered letter (series `notice`, NTC-YYYY-00001) in the landlord's name,
-- rendered as a PDF (`core.document` kind pdf_notice) and sent to the resident in LINE: rent increase at renewal,
-- renewal offer, non-renewal, termination, late payment. Notice periods come from settings and the compliance rules.

ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'notice';

CREATE TYPE ops.lease_notice_kind AS ENUM ('rent_increase', 'renewal_offer', 'non_renewal', 'termination', 'late_payment');

CREATE TABLE ops.lease_notice (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  lease_id        uuid NOT NULL,
  building_id     uuid NOT NULL,
  unit_id         uuid NOT NULL,
  kind            ops.lease_notice_kind NOT NULL,
  number          text NOT NULL,
  language        char(2) NOT NULL DEFAULT 'th',
  issued_on       date NOT NULL,
  effective_date  date,
  respond_by      date,
  notice_days     integer,
  new_rent        numeric(14,2),
  renewal_months  integer,
  amount_due      numeric(14,2),
  reason_code     text,
  message         text,
  details         jsonb NOT NULL DEFAULT '{}',
  document_id     uuid,
  sent_at         timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  created_by      uuid,
  CONSTRAINT lease_notice_pkey PRIMARY KEY (id),
  CONSTRAINT lease_notice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_notice_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_notice_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_notice_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_notice_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lease_notice_language_check CHECK (language IN ('th', 'en')),
  CONSTRAINT lease_notice_amounts_check CHECK ((new_rent IS NULL OR new_rent > 0) AND (amount_due IS NULL OR amount_due > 0)),
  CONSTRAINT lease_notice_renewal_months_check CHECK (renewal_months IS NULL OR renewal_months BETWEEN 1 AND 120),
  CONSTRAINT lease_notice_message_check CHECK (message IS NULL OR length(message) <= 2000),
  CONSTRAINT lease_notice_rent_check CHECK (kind NOT IN ('rent_increase', 'renewal_offer') OR new_rent IS NOT NULL),
  CONSTRAINT lease_notice_due_check CHECK (kind <> 'late_payment' OR amount_due IS NOT NULL),
  CONSTRAINT lease_notice_effective_check CHECK (kind = 'late_payment' OR effective_date IS NOT NULL)
);
COMMENT ON TABLE ops.lease_notice IS 'Written notices from the lessor to the lessee (B7.5, D-253): numbered (series notice), a PDF in the landlord''s name, sent in LINE. Append-only.';
COMMENT ON COLUMN ops.lease_notice.notice_days IS 'The notice period applied (days between issue and effect), from the setting or compliance rule of the kind.';
COMMENT ON COLUMN ops.lease_notice.details IS 'Snapshot rendered in the letter, e.g. the overdue invoices of a late-payment notice.';
CREATE UNIQUE INDEX lease_notice_tenant_id_number_key ON ops.lease_notice (tenant_id, number);
CREATE INDEX lease_notice_lease_id_issued_on_idx ON ops.lease_notice (lease_id, issued_on DESC);
CREATE INDEX lease_notice_building_id_idx ON ops.lease_notice (building_id);
CREATE INDEX lease_notice_unit_id_idx ON ops.lease_notice (unit_id);
CREATE INDEX lease_notice_document_id_idx ON ops.lease_notice (document_id);

SELECT platform.apply_rls('ops.lease_notice', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.lease_notice TO gp_app, gp_platform;
GRANT SELECT ON ops.lease_notice TO gp_reporting;
