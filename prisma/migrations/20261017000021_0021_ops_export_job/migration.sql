-- getproperty-api 0021 (B4.3) — export jobs (schema-design v2 §3.3.7): document archives per period now (B4.3),
-- Excel / FlowAccount / PEAK / VAT working figures in B4.5. A job is queued by an operator, built by the worker
-- (event `export.requested`), and its file kept as a `core.document` (kind `export`). Deviation (§7.5 row 57):
-- + building_id (Staff limited to buildings see their exports), row_count, version.

CREATE TYPE ops.export_kind AS ENUM ('invoices_xlsx', 'payments_xlsx', 'arrears_xlsx', 'flowaccount_csv', 'peak_csv',
  'vat_pp30', 'income_expense', 'document_archive_zip', 'readings_csv', 'tm30', 'units_xlsx', 'tax_annual_summary');
CREATE TYPE ops.job_status AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE ops.export_job (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  building_id       uuid,
  kind              ops.export_kind NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}',
  status            ops.job_status NOT NULL DEFAULT 'queued',
  file_document_id  uuid,
  row_count         integer,
  requested_by      uuid,
  started_at        timestamptz(6),
  finished_at       timestamptz(6),
  error             text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT export_job_pkey PRIMARY KEY (id),
  CONSTRAINT export_job_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT export_job_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT export_job_file_document_id_fkey FOREIGN KEY (file_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT export_job_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT export_job_done_check CHECK (status <> 'done' OR (file_document_id IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT export_job_failed_check CHECK (status <> 'failed' OR (error IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT export_job_row_count_check CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT export_job_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.export_job IS 'Exports requested by operators and built by the worker (D-051): document archives (B4.3), Excel / FlowAccount / PEAK / VAT figures (B4.5).';
CREATE INDEX export_job_tenant_id_status_idx ON ops.export_job (tenant_id, status);
CREATE INDEX export_job_tenant_id_created_at_idx ON ops.export_job (tenant_id, created_at DESC);
CREATE INDEX export_job_building_id_idx ON ops.export_job (building_id);
CREATE INDEX export_job_file_document_id_idx ON ops.export_job (file_document_id);
CREATE INDEX export_job_requested_by_idx ON ops.export_job (requested_by);

CREATE TRIGGER export_job_set_updated_at BEFORE UPDATE ON ops.export_job FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('ops.export_job', 'tenant');
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.export_job TO gp_app, gp_platform;
GRANT SELECT ON ops.export_job TO gp_reporting;
