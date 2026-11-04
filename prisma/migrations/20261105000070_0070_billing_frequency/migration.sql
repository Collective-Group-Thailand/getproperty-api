-- getproperty-api 0070 — billing frequency and the revenue schedule (Phase J step J1.1a, D-303 = D-J02, D-323).
-- schema-design §7.5 rows 204–206 (§7.6 J1-a, J1-h).
--   * ops.billing_frequency (monthly · quarterly · semiannual · annual); ops.billing_cycle.frequency (existing rows =
--     monthly) and the two property-wide unique keys become per frequency, so a mixed property holds a monthly lease
--     cycle and a quarterly / semiannual / annual common-fee cycle side by side; the key format follows the frequency
--     (YYYY-MM, YYYY-Qn, YYYY-Hn, YYYY).
--   * ops.rate_plan.frequency: the cycle that bills the plan; only common-fee and fund plans may be non-monthly.
--   * juristic.revenue_schedule: the monthly recognition of advance-billed invoice lines (first table of `juristic`).
-- DDL only (no DML on RLS tables); no core.* change.

CREATE TYPE ops.billing_frequency AS ENUM ('monthly', 'quarterly', 'semiannual', 'annual');

ALTER TABLE ops.billing_cycle ADD COLUMN frequency ops.billing_frequency NOT NULL DEFAULT 'monthly';
DROP INDEX ops.billing_cycle_property_id_period_start_key;
DROP INDEX ops.billing_cycle_property_id_period_key_key;
CREATE UNIQUE INDEX billing_cycle_property_id_frequency_period_start_key ON ops.billing_cycle (property_id, frequency, period_start);
CREATE UNIQUE INDEX billing_cycle_property_id_frequency_period_key_key ON ops.billing_cycle (property_id, frequency, period_key);
ALTER TABLE ops.billing_cycle DROP CONSTRAINT billing_cycle_period_key_check;
ALTER TABLE ops.billing_cycle DROP CONSTRAINT billing_cycle_period_check;
ALTER TABLE ops.billing_cycle ADD CONSTRAINT billing_cycle_period_check CHECK (
  period_end >= period_start
  AND period_end - period_start <= CASE frequency WHEN 'monthly' THEN 62 WHEN 'quarterly' THEN 92 WHEN 'semiannual' THEN 184 ELSE 366 END
);
ALTER TABLE ops.billing_cycle ADD CONSTRAINT billing_cycle_period_key_check CHECK (
  (frequency = 'monthly' AND period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  OR (frequency = 'quarterly' AND period_key ~ '^[0-9]{4}-Q[1-4]$')
  OR (frequency = 'semiannual' AND period_key ~ '^[0-9]{4}-H[12]$')
  OR (frequency = 'annual' AND period_key ~ '^[0-9]{4}$')
);
COMMENT ON COLUMN ops.billing_cycle.frequency IS 'D-303 (J1.1a): monthly cycles bill leases, meters and monthly unit plans at the cut-off (arrears); quarterly / semiannual / annual cycles bill common-fee and fund plans of that frequency in advance, calendar-aligned.';

ALTER TABLE ops.rate_plan ADD COLUMN frequency ops.billing_frequency NOT NULL DEFAULT 'monthly';
ALTER TABLE ops.rate_plan ADD CONSTRAINT rate_plan_frequency_check CHECK (frequency = 'monthly' OR kind IN ('common_fee', 'fund'));
COMMENT ON COLUMN ops.rate_plan.frequency IS 'D-303 (J1.1a): the billing cycle that bills this plan; amounts stay per month and a cycle bills months × the monthly amount. Leases, utilities, rent and services are monthly.';

CREATE TABLE juristic.revenue_schedule (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  invoice_line_id  uuid NOT NULL,
  month            date NOT NULL,
  amount           numeric(14,2) NOT NULL,
  recognised_at    timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT revenue_schedule_pkey PRIMARY KEY (id),
  CONSTRAINT revenue_schedule_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT revenue_schedule_invoice_line_id_fkey FOREIGN KEY (invoice_line_id) REFERENCES ops.invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT revenue_schedule_month_check CHECK (extract(day FROM month) = 1)
);
COMMENT ON TABLE juristic.revenue_schedule IS 'D-303 (J1.1a): unearned revenue of an advance-billed invoice line (quarterly / semiannual / annual cycle) spread over the calendar months it covers by calendar days; Σ amount = the line amount; written at issue (D-040), recognised by J2.1.';
CREATE UNIQUE INDEX revenue_schedule_invoice_line_id_month_key ON juristic.revenue_schedule (invoice_line_id, month);
CREATE INDEX revenue_schedule_tenant_id_month_idx ON juristic.revenue_schedule (tenant_id, month);
SELECT platform.apply_rls('juristic.revenue_schedule', 'tenant');
