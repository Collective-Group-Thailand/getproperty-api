-- getproperty-api 0019 (B4.1) — the tenant compliance score per month (schema-design v2 §3.2.8, §7.3; ADR-0007):
-- invoices within the utility rate, lines above the cap acknowledged, deposits refunded on time, contracts on the
-- standard template. Recomputed by the worker (job `compliance-score`) and on demand; read by the owner dashboard
-- and B6 analytics. Deviation (§7.5 row 47): + created_at/updated_at, components kept in `details`.

CREATE TABLE platform.compliance_score (
  id                           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                    uuid NOT NULL,
  month                        date NOT NULL,
  score                        numeric(5,2) NOT NULL,
  invoices_total               integer NOT NULL DEFAULT 0,
  invoices_within_rate         integer NOT NULL DEFAULT 0,
  lines_above_cap              integer NOT NULL DEFAULT 0,
  lines_above_cap_acknowledged integer NOT NULL DEFAULT 0,
  deposits_due                 integer NOT NULL DEFAULT 0,
  deposits_refunded_on_time    integer NOT NULL DEFAULT 0,
  leases_total                 integer NOT NULL DEFAULT 0,
  leases_on_standard_template  integer NOT NULL DEFAULT 0,
  details                      jsonb NOT NULL DEFAULT '{}',
  computed_at                  timestamptz(6) NOT NULL,
  created_at                   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at                   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT compliance_score_pkey PRIMARY KEY (id),
  CONSTRAINT compliance_score_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_score_month_check CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT compliance_score_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT compliance_score_counts_check CHECK (
    invoices_within_rate BETWEEN 0 AND invoices_total
    AND lines_above_cap_acknowledged BETWEEN 0 AND lines_above_cap
    AND deposits_refunded_on_time BETWEEN 0 AND deposits_due
    AND leases_on_standard_template BETWEEN 0 AND leases_total)
);
COMMENT ON TABLE platform.compliance_score IS 'Tenant compliance score per month (B4.1, ADR-0007): invoices within the utility rate, above-cap lines acknowledged, deposits refunded on time, leases on the standard template; 0–100.';
CREATE UNIQUE INDEX compliance_score_tenant_id_month_key ON platform.compliance_score (tenant_id, month);

CREATE TRIGGER compliance_score_set_updated_at BEFORE UPDATE ON platform.compliance_score FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.compliance_score', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.compliance_score TO gp_app, gp_platform;
GRANT SELECT ON platform.compliance_score TO gp_reporting;
