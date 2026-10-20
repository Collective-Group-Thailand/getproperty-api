-- getproperty-api 0031 — B6.2 e-Tax & TM30, B6.3 analytics (D-050, D-052, D-083, D-162; D-215, D-216, D-217):
--   ops.etax_submission       one e-Tax submission per receipt / tax invoice of a VAT-registered tenant with e-Tax
--                             enabled: the provider's reference, status and the signed artefacts (core.document);
--   ops.tm30_export           one TM30 notification duty per foreign occupant of a lease at move-in (24 h, workflow
--                             engine), the Immigration upload file it went into and the owner's manual submission;
--   platform.analytics_fact   analytics events (monthly native partitions, D-162) written by the analytics
--                             subscriber and the derivation job;
--   platform.analytics_rollup day / week / month sums per tenant (and building) — what KPIs and insights read;
--   platform.benchmark_bucket anonymised percentiles of opted-in tenants, only for buckets of k >= 5 tenants;
--   platform.csat_response    the residents' 1-question survey answers (service request ratings stay on the request).
-- Deviations (schema-design §7.5 rows 90–95): etax + building_id, number, document_type_code, provider_meta, attempts,
-- next_attempt_at, source_document_id, amounts, issued_at; tm30 + unit_id, moved_in_at, due_at, workflow_instance_id,
-- status due / cancelled, submitted_*; analytics_fact + id (PK with time); rollup tenant_id NOT NULL (platform-wide
-- figures are benchmark buckets), building_id nullable with NULLS NOT DISTINCT; csat_response + unit_id.

ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'etax_monthly_xlsx';

CREATE TYPE ops.etax_subject_type AS ENUM ('receipt', 'tax_invoice', 'credit_note', 'debit_note');
CREATE TYPE ops.etax_status AS ENUM ('queued', 'submitted', 'signed', 'rejected', 'failed');
CREATE TYPE ops.tm30_status AS ENUM ('due', 'generated', 'downloaded', 'submitted_manually', 'cancelled');
CREATE TYPE platform.rollup_bucket AS ENUM ('day', 'week', 'month');

-- ----------------------------------------------------------------------------------------------------- e-Tax
CREATE TABLE ops.etax_submission (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  building_id              uuid NOT NULL,
  subject_type             ops.etax_subject_type NOT NULL,
  subject_id               uuid NOT NULL,
  number                   citext NOT NULL,
  document_type_code       text NOT NULL,
  issued_at                timestamptz(6) NOT NULL,
  subtotal                 numeric(14,2) NOT NULL,
  vat_amount               numeric(14,2) NOT NULL,
  total                    numeric(14,2) NOT NULL,
  provider                 text NOT NULL,
  provider_doc_id          text,
  provider_meta            jsonb NOT NULL DEFAULT '{}',
  status                   ops.etax_status NOT NULL DEFAULT 'queued',
  attempts                 smallint NOT NULL DEFAULT 0,
  next_attempt_at          timestamptz(6),
  source_document_id       uuid,
  signed_xml_document_id   uuid,
  signed_pdf_document_id   uuid,
  submitted_at             timestamptz(6),
  signed_at                timestamptz(6),
  error                    text,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT etax_submission_pkey PRIMARY KEY (id),
  CONSTRAINT etax_submission_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT etax_submission_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT etax_submission_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT etax_submission_signed_xml_document_id_fkey FOREIGN KEY (signed_xml_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT etax_submission_signed_pdf_document_id_fkey FOREIGN KEY (signed_pdf_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT etax_submission_type_code_check CHECK (document_type_code IN ('T01', 'T03', '388', '80', '81')),
  CONSTRAINT etax_submission_attempts_check CHECK (attempts >= 0),
  CONSTRAINT etax_submission_signed_check CHECK (status <> 'signed' OR (signed_at IS NOT NULL AND signed_pdf_document_id IS NOT NULL AND signed_xml_document_id IS NOT NULL AND provider_doc_id IS NOT NULL)),
  CONSTRAINT etax_submission_amounts_check CHECK (total = subtotal + vat_amount AND vat_amount >= 0)
);
COMMENT ON TABLE ops.etax_submission IS 'e-Tax Invoice & e-Receipt (D-050, D-215): one submission per receipt / receipt-tax invoice of a VAT-registered tenant with e-Tax enabled, sent to the tenant''s Revenue-Department-approved service provider (the platform never signs); the provider''s reference, status, error and the signed XML / PDF it returned. Retried with backoff; a signed PDF becomes the document the resident receives.';
CREATE UNIQUE INDEX etax_submission_subject_type_subject_id_key ON ops.etax_submission (subject_type, subject_id);
CREATE INDEX etax_submission_tenant_id_status_idx ON ops.etax_submission (tenant_id, status);
CREATE INDEX etax_submission_tenant_id_issued_at_idx ON ops.etax_submission (tenant_id, issued_at);
CREATE INDEX etax_submission_status_next_attempt_at_idx ON ops.etax_submission (status, next_attempt_at);
CREATE INDEX etax_submission_building_id_idx ON ops.etax_submission (building_id);
CREATE INDEX etax_submission_source_document_id_idx ON ops.etax_submission (source_document_id);
CREATE INDEX etax_submission_signed_xml_document_id_idx ON ops.etax_submission (signed_xml_document_id);
CREATE INDEX etax_submission_signed_pdf_document_id_idx ON ops.etax_submission (signed_pdf_document_id);
CREATE TRIGGER etax_submission_set_updated_at BEFORE UPDATE ON ops.etax_submission FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------------------ TM30
CREATE TABLE ops.tm30_export (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid NOT NULL,
  lease_id               uuid NOT NULL,
  party_id               uuid NOT NULL,
  arrival_date           date,
  moved_in_at            timestamptz(6) NOT NULL,
  due_at                 timestamptz(6) NOT NULL,
  status                 ops.tm30_status NOT NULL DEFAULT 'due',
  workflow_instance_id   uuid,
  format                 text NOT NULL DEFAULT 'immigration_xlsx_v1',
  generated_at           timestamptz(6),
  generated_by           uuid,
  file_document_id       uuid,
  downloaded_at          timestamptz(6),
  reminder_sent_at       timestamptz(6),
  submitted_at           timestamptz(6),
  submitted_by           uuid,
  submission_ref         text,
  cancel_reason          text,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT tm30_export_pkey PRIMARY KEY (id),
  CONSTRAINT tm30_export_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_workflow_instance_id_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_file_document_id_fkey FOREIGN KEY (file_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tm30_export_format_check CHECK (format IN ('immigration_xlsx_v1')),
  CONSTRAINT tm30_export_due_check CHECK (due_at > moved_in_at),
  CONSTRAINT tm30_export_generated_check CHECK (status IN ('due', 'cancelled') OR (generated_at IS NOT NULL AND file_document_id IS NOT NULL) OR status = 'submitted_manually'),
  CONSTRAINT tm30_export_submitted_check CHECK (status <> 'submitted_manually' OR submitted_at IS NOT NULL),
  CONSTRAINT tm30_export_submission_ref_check CHECK (submission_ref IS NULL OR length(submission_ref) <= 100)
);
COMMENT ON TABLE ops.tm30_export IS 'TM30 (D-052, D-216; Immigration Act B.E. 2522 s.38): the house master''s 24-hour notification of a foreign occupant''s stay, opened at move-in on the workflow engine (reminder, breach); the Immigration Bureau upload file it was generated into (per building) and the owner''s manual submission — the platform never submits (no public API). The export log of the building.';
CREATE UNIQUE INDEX tm30_export_lease_id_party_id_key ON ops.tm30_export (lease_id, party_id);
CREATE INDEX tm30_export_tenant_id_building_id_status_idx ON ops.tm30_export (tenant_id, building_id, status);
CREATE INDEX tm30_export_building_id_idx ON ops.tm30_export (building_id);
CREATE INDEX tm30_export_unit_id_idx ON ops.tm30_export (unit_id);
CREATE INDEX tm30_export_party_id_idx ON ops.tm30_export (party_id);
CREATE INDEX tm30_export_workflow_instance_id_idx ON ops.tm30_export (workflow_instance_id);
CREATE INDEX tm30_export_file_document_id_idx ON ops.tm30_export (file_document_id);
CREATE TRIGGER tm30_export_set_updated_at BEFORE UPDATE ON ops.tm30_export FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------------ analytics
CREATE TABLE platform.analytics_fact (
  id             uuid NOT NULL DEFAULT uuidv7(),
  time           timestamptz(6) NOT NULL,
  tenant_id      uuid NOT NULL,
  building_id    uuid,
  fact           text NOT NULL,
  subject_type   text NOT NULL,
  subject_id     uuid NOT NULL,
  value          numeric(18,6) NOT NULL,
  dims           jsonb NOT NULL DEFAULT '{}',
  recorded_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT analytics_fact_pkey PRIMARY KEY (id, time),
  CONSTRAINT analytics_fact_fact_check CHECK (fact ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
) PARTITION BY RANGE (time);
COMMENT ON TABLE platform.analytics_fact IS 'Analytics events (B6.3, D-217): one row per measured thing (a cycle issued, an invoice due, a payment, a rating, a day of meter uptime …) with its value; monthly native partitions (D-162, no Timescale); written idempotently (one row per fact × subject × time) by the analytics subscriber and the derivation job. Raw facts never leave the tenant: insights and benchmarks read rollups.';
CREATE UNIQUE INDEX analytics_fact_fact_subject_id_time_key ON platform.analytics_fact (fact, subject_id, time);
CREATE INDEX analytics_fact_tenant_id_fact_time_idx ON platform.analytics_fact (tenant_id, fact, time DESC);

CREATE TABLE platform.analytics_rollup (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  building_id    uuid,
  fact           text NOT NULL,
  bucket         platform.rollup_bucket NOT NULL,
  bucket_start   date NOT NULL,
  value          numeric(20,6) NOT NULL,
  count          integer NOT NULL,
  min_value      numeric(18,6),
  max_value      numeric(18,6),
  computed_at    timestamptz(6) NOT NULL,
  CONSTRAINT analytics_rollup_pkey PRIMARY KEY (id),
  CONSTRAINT analytics_rollup_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT analytics_rollup_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT analytics_rollup_count_check CHECK (count >= 0)
);
COMMENT ON TABLE platform.analytics_rollup IS 'Rollups of analytics facts (B6.3, D-217): per tenant (building_id NULL = all buildings) and per building, per Bangkok day / ISO week / month — the sum of values and their count (average = value / count). Recomputed by the worker for the recent buckets; the pilot KPIs and the owner insights read only these.';
CREATE UNIQUE INDEX analytics_rollup_key ON platform.analytics_rollup (tenant_id, building_id, fact, bucket, bucket_start) NULLS NOT DISTINCT;
CREATE INDEX analytics_rollup_tenant_id_fact_bucket_bucket_start_idx ON platform.analytics_rollup (tenant_id, fact, bucket, bucket_start);
CREATE INDEX analytics_rollup_building_id_idx ON platform.analytics_rollup (building_id);

CREATE TABLE platform.benchmark_bucket (
  id             uuid NOT NULL DEFAULT uuidv7(),
  metric         text NOT NULL,
  bucket_key     text NOT NULL,
  k              integer NOT NULL,
  p25            numeric(18,6) NOT NULL,
  p50            numeric(18,6) NOT NULL,
  p75            numeric(18,6) NOT NULL,
  as_of          date NOT NULL,
  computed_at    timestamptz(6) NOT NULL,
  CONSTRAINT benchmark_bucket_pkey PRIMARY KEY (id),
  CONSTRAINT benchmark_bucket_k_check CHECK (k >= 5),
  CONSTRAINT benchmark_bucket_metric_check CHECK (metric IN ('loss_pct', 'on_time_payment_pct', 'rent_per_m2')),
  CONSTRAINT benchmark_bucket_order_check CHECK (p25 <= p50 AND p50 <= p75)
);
COMMENT ON TABLE platform.benchmark_bucket IS 'Anonymised benchmarks (B6.3, D-083 data use, D-217): percentiles of a metric over the tenants that opted in (consent analytics.anonymised), per bucket (district, tenant type, size band); a bucket exists only with at least 5 tenants (k-anonymity, CHECK) and never stores a tenant id.';
CREATE UNIQUE INDEX benchmark_bucket_metric_bucket_key_as_of_key ON platform.benchmark_bucket (metric, bucket_key, as_of);

CREATE TABLE platform.csat_response (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  party_id             uuid NOT NULL,
  unit_id              uuid,
  lease_id             uuid,
  service_request_id   uuid,
  question_key         text NOT NULL,
  rating               smallint NOT NULL,
  comment              text,
  answered_at          timestamptz(6) NOT NULL DEFAULT now(),
  answered_by          uuid,
  CONSTRAINT csat_response_pkey PRIMARY KEY (id),
  CONSTRAINT csat_response_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_answered_by_fkey FOREIGN KEY (answered_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT csat_response_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT csat_response_comment_check CHECK (comment IS NULL OR length(comment) <= 1000),
  CONSTRAINT csat_response_question_key_check CHECK (question_key ~ '^[a-z][a-z0-9_.]{1,63}$')
);
COMMENT ON TABLE platform.csat_response IS 'Resident satisfaction (B6.3, D-083 CSAT): the periodic 1-question LIFF survey (1–5, optional comment); repair ratings stay on ops.service_request. Both feed the csat.rating fact.';
CREATE INDEX csat_response_tenant_id_answered_at_idx ON platform.csat_response (tenant_id, answered_at DESC);
CREATE INDEX csat_response_party_id_answered_at_idx ON platform.csat_response (party_id, answered_at DESC);
CREATE INDEX csat_response_unit_id_idx ON platform.csat_response (unit_id);
CREATE INDEX csat_response_lease_id_idx ON platform.csat_response (lease_id);
CREATE INDEX csat_response_service_request_id_idx ON platform.csat_response (service_request_id);
CREATE INDEX csat_response_answered_by_idx ON platform.csat_response (answered_by);

-- monthly partitions of platform.analytics_fact, created on demand by the writers (advisory lock: concurrent
-- writers never race on the DDL)
CREATE OR REPLACE FUNCTION platform.ensure_analytics_partition(at timestamptz) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  first_day date := date_trunc('month', at AT TIME ZONE 'UTC')::date;
  part text := 'analytics_fact_' || to_char(first_day, 'YYYYMM');
BEGIN
  IF to_regclass('platform.' || part) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('platform.' || part));
    IF to_regclass('platform.' || part) IS NULL THEN
      EXECUTE format('CREATE TABLE platform.%I PARTITION OF platform.analytics_fact FOR VALUES FROM (%L) TO (%L)', part,
                     (first_day::timestamp AT TIME ZONE 'UTC'), ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', part);
    END IF;
  END IF;
  RETURN part;
END
$$;
COMMENT ON FUNCTION platform.ensure_analytics_partition(timestamptz) IS 'Creates the monthly partition of platform.analytics_fact holding `at` when missing (D-162); called by the analytics writers before they insert.';
REVOKE ALL ON FUNCTION platform.ensure_analytics_partition(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.ensure_analytics_partition(timestamptz) TO gp_app, gp_platform;

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('ops.etax_submission', 'building', 'ops.billing');
SELECT platform.apply_rls('ops.tm30_export', 'unit', 'ops.lease');
SELECT platform.apply_rls('platform.analytics_fact', 'tenant');
SELECT platform.apply_rls('platform.analytics_rollup', 'tenant');
SELECT platform.apply_rls('platform.benchmark_bucket', 'platform');
SELECT platform.apply_rls('platform.csat_response', 'tenant');

GRANT SELECT, INSERT, UPDATE ON ops.etax_submission, ops.tm30_export TO gp_app, gp_platform;
GRANT SELECT, INSERT ON platform.analytics_fact, platform.csat_response TO gp_app, gp_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.analytics_rollup TO gp_app, gp_platform;
GRANT SELECT ON platform.benchmark_bucket TO gp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.benchmark_bucket TO gp_platform;
GRANT SELECT ON ops.etax_submission, ops.tm30_export, platform.analytics_fact, platform.analytics_rollup,
  platform.benchmark_bucket TO gp_reporting;
