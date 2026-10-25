-- getproperty-api 0047 — B7.5 landlord document set, part 3 (D-253): rent payment certificates (the resident asks in
-- LIFF, the owner issues or declines), annual rental income summaries (documents only, series income_summary) and the
-- bilingual lease (Thai and English texts in one signed PDF). schema-design §7.5 rows 120–121.

ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'rent_certificate';
ALTER TYPE ops.document_type ADD VALUE IF NOT EXISTS 'income_summary';

CREATE TYPE ops.rent_certificate_purpose AS ENUM ('visa', 'bank', 'employer', 'other');
CREATE TYPE ops.rent_certificate_state AS ENUM ('requested', 'issued', 'declined');

CREATE TABLE ops.rent_certificate (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  lease_id               uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid NOT NULL,
  requested_by_party_id  uuid,
  purpose                ops.rent_certificate_purpose NOT NULL,
  period_from            date NOT NULL,
  period_to              date NOT NULL,
  language               char(2) NOT NULL DEFAULT 'th',
  note                   text,
  state                  ops.rent_certificate_state NOT NULL DEFAULT 'requested',
  number                 text,
  document_id            uuid,
  total_paid             numeric(14,2),
  decline_reason         text,
  requested_at           timestamptz(6) NOT NULL DEFAULT now(),
  decided_at             timestamptz(6),
  decided_by             uuid,
  CONSTRAINT rent_certificate_pkey PRIMARY KEY (id),
  CONSTRAINT rent_certificate_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_requested_by_party_id_fkey FOREIGN KEY (requested_by_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT rent_certificate_language_check CHECK (language IN ('th', 'en')),
  CONSTRAINT rent_certificate_period_check CHECK (period_from <= period_to),
  CONSTRAINT rent_certificate_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT rent_certificate_issued_check CHECK (state <> 'issued' OR (number IS NOT NULL AND document_id IS NOT NULL AND total_paid IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT rent_certificate_declined_check CHECK (state <> 'declined' OR (decline_reason IS NOT NULL AND length(decline_reason) BETWEEN 1 AND 500 AND decided_at IS NOT NULL))
);
COMMENT ON TABLE ops.rent_certificate IS 'Rent payment certificates (B7.5, D-253): requested by the resident (or issued directly by the owner), a PDF in the landlord''s name listing the rent payments of a period.';
CREATE UNIQUE INDEX rent_certificate_tenant_id_number_key ON ops.rent_certificate (tenant_id, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX rent_certificate_one_open_key ON ops.rent_certificate (lease_id) WHERE state = 'requested';
CREATE INDEX rent_certificate_tenant_id_state_idx ON ops.rent_certificate (tenant_id, state, requested_at DESC);
CREATE INDEX rent_certificate_building_id_idx ON ops.rent_certificate (building_id);
CREATE INDEX rent_certificate_unit_id_idx ON ops.rent_certificate (unit_id);
CREATE INDEX rent_certificate_requested_by_party_id_idx ON ops.rent_certificate (requested_by_party_id);
CREATE INDEX rent_certificate_document_id_idx ON ops.rent_certificate (document_id);

SELECT platform.apply_rls('ops.rent_certificate', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.rent_certificate TO gp_app, gp_platform;
GRANT SELECT ON ops.rent_certificate TO gp_reporting;

ALTER TABLE ops.lease ADD COLUMN bilingual boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN ops.lease.bilingual IS 'B7.5: the contract carries the Thai and the English text of its template in one signed PDF (Thai prevails).';
