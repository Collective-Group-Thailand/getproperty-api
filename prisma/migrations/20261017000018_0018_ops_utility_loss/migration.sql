-- getproperty-api 0018 (B3.4) — utility invoices and loss (D-032): the building's MEA/PEA/MWA/PWA invoice per period,
-- the loss report per building × utility × period (billing_cycle_id without FK until B4.2 adds ops.billing_cycle) and
-- its suspects (schema-design v2 §3.3.8, §7.3). Deviations: schema-design §7.5 rows 45–46.

CREATE TYPE ops.utility_invoice_source AS ENUM ('manual', 'ocr', 'ebill_import');
CREATE TYPE ops.loss_suspect_kind AS ENUM ('zero_consumption_occupied', 'usage_while_vacant', 'estimated_reading', 'night_water_flow',
  'stale_meter', 'consumption_anomaly');

CREATE TABLE ops.utility_invoice (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  utility_account_id  uuid,
  utility             core.utility NOT NULL,
  provider            platform.utility_provider NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  invoice_no          text,
  units               numeric(12,3) NOT NULL,
  amount              numeric(14,2) NOT NULL,
  ft                  numeric(14,4),
  service_charge      numeric(14,2),
  vat                 numeric(14,2),
  previous_register   numeric(12,3),
  current_register    numeric(12,3),
  invoice_document_id uuid,
  ocr_raw             jsonb,
  source              ops.utility_invoice_source NOT NULL DEFAULT 'manual',
  entered_by          uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT utility_invoice_pkey PRIMARY KEY (id),
  CONSTRAINT utility_invoice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_invoice_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_invoice_utility_account_id_fkey FOREIGN KEY (utility_account_id) REFERENCES ops.utility_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_invoice_invoice_document_id_fkey FOREIGN KEY (invoice_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_invoice_provider_check CHECK ((utility = 'electric' AND provider IN ('mea', 'pea')) OR (utility = 'water' AND provider IN ('mwa', 'pwa'))),
  CONSTRAINT utility_invoice_period_check CHECK (period_end >= period_start AND period_end - period_start <= 62),
  CONSTRAINT utility_invoice_units_check CHECK (units >= 0),
  CONSTRAINT utility_invoice_amount_check CHECK (amount >= 0 AND amount = round(amount, 2)),
  CONSTRAINT utility_invoice_registers_check CHECK (previous_register IS NULL OR current_register IS NULL OR current_register >= previous_register),
  CONSTRAINT utility_invoice_version_check CHECK (version >= 1)
);
COMMENT ON TABLE ops.utility_invoice IS 'The building''s MEA/PEA/MWA/PWA invoice per period (D-032): entered by the owner, prefilled by OCR or imported from the e-bill; also an expense for A2.6 reports.';
CREATE UNIQUE INDEX utility_invoice_period_key ON ops.utility_invoice (building_id, utility, period_start, period_end, utility_account_id) NULLS NOT DISTINCT;
CREATE INDEX utility_invoice_tenant_id_building_id_idx ON ops.utility_invoice (tenant_id, building_id);
CREATE INDEX utility_invoice_utility_account_id_idx ON ops.utility_invoice (utility_account_id);
CREATE INDEX utility_invoice_invoice_document_id_idx ON ops.utility_invoice (invoice_document_id);

CREATE TABLE ops.loss_report (
  id                        uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                 uuid NOT NULL,
  building_id               uuid NOT NULL,
  billing_cycle_id          uuid,
  utility                   core.utility NOT NULL,
  period_start              date NOT NULL,
  period_end                date NOT NULL,
  utility_invoice_id        uuid,
  invoice_units             numeric(12,3) NOT NULL,
  unit_billed_units         numeric(12,3) NOT NULL,
  common_area_units         numeric(12,3) NOT NULL,
  loss_units                numeric(12,3) NOT NULL,
  loss_pct                  numeric(7,4),
  loss_thb                  numeric(14,2) NOT NULL,
  price_basis               text NOT NULL,
  utility_tariff_version_id uuid,
  billed_units_source       text NOT NULL,
  computed_at               timestamptz(6) NOT NULL,
  inputs_snapshot           jsonb NOT NULL,
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                uuid,
  CONSTRAINT loss_report_pkey PRIMARY KEY (id),
  CONSTRAINT loss_report_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_report_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_report_utility_invoice_id_fkey FOREIGN KEY (utility_invoice_id) REFERENCES ops.utility_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_report_utility_tariff_version_id_fkey FOREIGN KEY (utility_tariff_version_id) REFERENCES platform.utility_tariff_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_report_period_check CHECK (period_end >= period_start),
  CONSTRAINT loss_report_thb_check CHECK (loss_thb = round(loss_thb, 2)),
  CONSTRAINT loss_report_price_basis_check CHECK (price_basis IN ('utility_tariff', 'invoice_average')),
  CONSTRAINT loss_report_billed_source_check CHECK (billed_units_source IN ('invoices', 'meter_readings_stub'))
);
COMMENT ON TABLE ops.loss_report IS 'Utility loss per building × utility × billing period (D-032): invoice units − Σ unit-billed units − Σ common-area units, in units and THB; recomputed while inputs change, the latest computation wins.';
CREATE UNIQUE INDEX loss_report_building_id_utility_period_start_period_end_key ON ops.loss_report (building_id, utility, period_start, period_end);
CREATE INDEX loss_report_tenant_id_building_id_idx ON ops.loss_report (tenant_id, building_id);
CREATE INDEX loss_report_utility_invoice_id_idx ON ops.loss_report (utility_invoice_id);
CREATE INDEX loss_report_utility_tariff_version_id_idx ON ops.loss_report (utility_tariff_version_id);

CREATE TABLE ops.loss_suspect (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  loss_report_id uuid NOT NULL,
  asset_item_id  uuid,
  unit_id        uuid,
  kind           ops.loss_suspect_kind NOT NULL,
  score          numeric(5,2) NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT loss_suspect_pkey PRIMARY KEY (id),
  CONSTRAINT loss_suspect_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_suspect_loss_report_id_fkey FOREIGN KEY (loss_report_id) REFERENCES ops.loss_report (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT loss_suspect_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_suspect_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT loss_suspect_score_check CHECK (score BETWEEN 0 AND 100)
);
COMMENT ON TABLE ops.loss_suspect IS 'Why the loss may be where it is (D-032): occupied units with zero consumption, usage in vacant units, estimated readings, night-time water flow, stale meters, consumption anomalies (> 2σ).';
CREATE INDEX loss_suspect_loss_report_id_idx ON ops.loss_suspect (loss_report_id);
CREATE INDEX loss_suspect_tenant_id_idx ON ops.loss_suspect (tenant_id);
CREATE INDEX loss_suspect_asset_item_id_idx ON ops.loss_suspect (asset_item_id);
CREATE INDEX loss_suspect_unit_id_idx ON ops.loss_suspect (unit_id);

CREATE TRIGGER utility_invoice_set_updated_at BEFORE UPDATE ON ops.utility_invoice FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER loss_report_set_updated_at BEFORE UPDATE ON ops.loss_report FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('ops.utility_invoice', 'building', 'ops.billing');
SELECT platform.apply_rls('ops.loss_report', 'building', 'ops.billing');
SELECT platform.apply_rls('ops.loss_suspect', 'platform_only');
CREATE POLICY loss_suspect_rls_read ON ops.loss_suspect FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR EXISTS (SELECT 1 FROM ops.loss_report r WHERE r.id = loss_report_id));
CREATE POLICY loss_suspect_rls_write ON ops.loss_suspect FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.utility_invoice, ops.loss_report, ops.loss_suspect TO gp_app, gp_platform;
GRANT SELECT ON ops.utility_invoice, ops.loss_report, ops.loss_suspect TO gp_reporting;
