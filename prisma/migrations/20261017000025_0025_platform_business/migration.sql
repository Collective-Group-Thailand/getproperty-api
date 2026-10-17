-- getproperty-api 0025 (B6.1, B6.3 KPIs, B6.4 AI usage) — price plans, subscriptions, platform invoicing, HaaS,
-- pilots, field orders, AI usage records, pilot KPI snapshots
-- (schema-design v2 §3.2.10; D-081 HaaS register, D-082 lifecycle + read-only suspension + unit counting, D-083 pilot
-- terms, D-091 maker-checker credit notes, D-146 platform series with tenant_id NULL, D-156 pricing, D-204).
-- Deviations (§7.5 rows 68–74): price_plan_version + unit_price / price_range (a version carries its price, not only
-- tiers), state = template_version_state with published_at; subscription + plan_key, addon_plan_version_ids kept as
-- uuid[] (validated by the service), current_period_end; subscription_usage + amounts per line kind
-- (lines jsonb) and ocr_images; platform_invoice + kind (first | monthly | adjustment), usage_id, credited_total,
-- overdue_since, qr_expires_at; platform_payment + state enum, recorded_by, evidence_document_id;
-- platform_credit_note + state (requested | issued | rejected), number null until issued (maker-checker request lives
-- on the row); install_order + site_survey_request_id, notes; site_survey_request + target_plan_key, install_order_id,
-- notes, updated_*; haas_asset + building nullable while allocated, kind (from the device), installed_at nullable;
-- ai_usage_record + outcome, feature + invoice_ocr; kpi_snapshot as designed.

CREATE TYPE platform.plan_kind AS ENUM ('software', 'addon', 'hardware_rental', 'hardware_sale', 'service');
CREATE TYPE platform.plan_billing_unit AS ENUM ('per_unit', 'per_meter_point', 'per_building', 'per_tenant', 'per_report');
CREATE TYPE platform.subscription_status AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled');
CREATE TYPE platform.billing_period AS ENUM ('monthly', 'annual');
CREATE TYPE platform.platform_invoice_status AS ENUM ('draft', 'issued', 'paid', 'partially_paid', 'overdue', 'void', 'credited');
CREATE TYPE platform.platform_invoice_kind AS ENUM ('first', 'monthly', 'adjustment');
CREATE TYPE platform.platform_line_kind AS ENUM ('subscription', 'addon', 'setup', 'hardware_rental', 'hardware_sale', 'ai_overage', 'inspection', 'discount', 'adjustment');
CREATE TYPE platform.platform_payment_method AS ENUM ('qr', 'bank_transfer', 'card', 'offset');
CREATE TYPE platform.platform_payment_state AS ENUM ('confirmed', 'reversed');
CREATE TYPE platform.platform_credit_note_state AS ENUM ('requested', 'issued', 'rejected');
CREATE TYPE platform.haas_state AS ENUM ('allocated', 'installed', 'in_service', 'replaced', 'deinstalled', 'written_off');
CREATE TYPE platform.site_survey_state AS ENUM ('requested', 'scheduled', 'done', 'cancelled');
CREATE TYPE platform.install_order_kind AS ENUM ('install', 'deinstall', 'replace', 'site_survey');
CREATE TYPE platform.install_order_state AS ENUM ('open', 'in_progress', 'done', 'cancelled');

-- platform company document types for Collective's own series (D-146) already exist in ops.document_type (0007)

-- ------------------------------------------------------------------------------------------- price plans
CREATE TABLE platform.price_plan (
  id           uuid NOT NULL DEFAULT uuidv7(),
  key          text NOT NULL,
  tenant_type  core.tenant_type,
  name_th      text NOT NULL,
  name_en      text NOT NULL,
  kind         platform.plan_kind NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT price_plan_pkey PRIMARY KEY (id),
  CONSTRAINT price_plan_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$')
);
COMMENT ON TABLE platform.price_plan IS 'Plans of the platform (D-156): apartment Starter / Smart, meter rental, condo, juristic pro, access add-on, PM portfolio, landlord, inspection report. Only active plans are sold.';
CREATE UNIQUE INDEX price_plan_key_key ON platform.price_plan (key);

CREATE TABLE platform.price_plan_version (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  plan_id               uuid NOT NULL,
  version               integer NOT NULL,
  effective_from        date NOT NULL,
  effective_to          date,
  billing_unit          platform.plan_billing_unit NOT NULL,
  unit_price            numeric(14,4),
  price_range           jsonb,
  tiers                 jsonb NOT NULL DEFAULT '[]',
  min_units             integer,
  min_monthly           numeric(14,2),
  annual_discount_pct   numeric(7,4) NOT NULL DEFAULT 15,
  term_months           smallint,
  setup_fee             numeric(14,2) NOT NULL DEFAULT 0,
  included_allowances   jsonb NOT NULL DEFAULT '{}',
  vat_rate              numeric(5,4) NOT NULL DEFAULT 0.07,
  currency              char(3) NOT NULL DEFAULT 'THB',
  terms                 jsonb NOT NULL DEFAULT '{}',
  state                 platform.template_version_state NOT NULL DEFAULT 'draft',
  published_by          uuid,
  published_at          timestamptz(6),
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT price_plan_version_pkey PRIMARY KEY (id),
  CONSTRAINT price_plan_version_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES platform.price_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT price_plan_version_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT price_plan_version_money_check CHECK ((unit_price IS NULL OR unit_price >= 0) AND (min_monthly IS NULL OR min_monthly >= 0)
    AND setup_fee >= 0 AND annual_discount_pct >= 0 AND annual_discount_pct < 100 AND vat_rate >= 0 AND vat_rate < 1
    AND (min_units IS NULL OR min_units >= 0)),
  CONSTRAINT price_plan_version_published_check CHECK ((state = 'draft') = (published_at IS NULL) OR state = 'retired'),
  CONSTRAINT price_plan_version_tiers_check CHECK (jsonb_typeof(tiers) = 'array')
);
COMMENT ON TABLE platform.price_plan_version IS 'Effective-dated price of a plan (D-156 values, Proposed until the pilot): unit price or tiers / steps, minimums, billing unit, annual discount, VAT, allowances (D-161 OCR). Published versions never overlap; a published version is never edited.';
CREATE UNIQUE INDEX price_plan_version_plan_id_version_key ON platform.price_plan_version (plan_id, version);
ALTER TABLE platform.price_plan_version ADD CONSTRAINT price_plan_version_no_overlap
  EXCLUDE USING gist (plan_id WITH =, daterange(effective_from, effective_to) WITH &&) WHERE (state = 'published');

CREATE OR REPLACE FUNCTION platform.price_plan_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['state', 'effective_to', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'price_plan.version_in_force: published price versions are never deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state <> 'draft' AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'price_plan.version_in_force: a published price version is never edited (add a new version)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER price_plan_version_guard BEFORE UPDATE OR DELETE ON platform.price_plan_version FOR EACH ROW EXECUTE FUNCTION platform.price_plan_version_guard();

-- ------------------------------------------------------------------------------------------- pilots & field work
CREATE TABLE platform.pilot_agreement (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  signed_at              date NOT NULL,
  discount_pct           numeric(7,4) NOT NULL,
  term_months            smallint NOT NULL,
  reference_site_rights  boolean NOT NULL DEFAULT true,
  anonymised_data_use    boolean NOT NULL DEFAULT true,
  feedback_cadence       text NOT NULL DEFAULT 'biweekly',
  kpi_review_at          date NOT NULL,
  kpi_targets            jsonb NOT NULL DEFAULT '{}',
  baseline               jsonb NOT NULL DEFAULT '{}',
  agreement_document_id  uuid,
  notes                  text,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT pilot_agreement_pkey PRIMARY KEY (id),
  CONSTRAINT pilot_agreement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pilot_agreement_agreement_document_id_fkey FOREIGN KEY (agreement_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- D-083: a paid pilot at a discounted rate, never free
  CONSTRAINT pilot_agreement_discount_check CHECK (discount_pct >= 0 AND discount_pct < 100),
  CONSTRAINT pilot_agreement_term_check CHECK (term_months > 0),
  CONSTRAINT pilot_agreement_review_check CHECK (kpi_review_at > signed_at)
);
COMMENT ON TABLE platform.pilot_agreement IS 'Pilot terms of a tenant (D-083): discounted paid pilot, reference-site rights, anonymised data use, feedback cadence, 90-day KPI review with targets and baseline.';
CREATE UNIQUE INDEX pilot_agreement_tenant_id_key ON platform.pilot_agreement (tenant_id);
CREATE INDEX pilot_agreement_agreement_document_id_idx ON platform.pilot_agreement (agreement_document_id);

CREATE TABLE platform.install_order (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  building_id             uuid NOT NULL,
  kind                    platform.install_order_kind NOT NULL,
  subscription_id         uuid,
  site_survey_request_id  uuid,
  state                   platform.install_order_state NOT NULL DEFAULT 'open',
  assigned_to             uuid,
  due_at                  timestamptz(6),
  items                   jsonb NOT NULL DEFAULT '[]',
  notes                   text,
  completed_at            timestamptz(6),
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT install_order_pkey PRIMARY KEY (id),
  CONSTRAINT install_order_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT install_order_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT install_order_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT install_order_items_check CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT install_order_done_check CHECK ((state = 'done') = (completed_at IS NOT NULL))
);
COMMENT ON TABLE platform.install_order IS 'Platform field work per building (D-081): install / de-install / replace hardware and site surveys, for Collective field engineers; items per unit.';
CREATE INDEX install_order_tenant_id_state_idx ON platform.install_order (tenant_id, state);
CREATE INDEX install_order_building_id_idx ON platform.install_order (building_id);
CREATE INDEX install_order_subscription_id_idx ON platform.install_order (subscription_id);
CREATE INDEX install_order_site_survey_request_id_idx ON platform.install_order (site_survey_request_id);
CREATE INDEX install_order_assigned_to_idx ON platform.install_order (assigned_to);

CREATE TABLE platform.site_survey_request (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  requested_by      uuid,
  target_plan_key   text NOT NULL DEFAULT 'apartment_smart',
  state             platform.site_survey_state NOT NULL DEFAULT 'requested',
  scheduled_for     timestamptz(6),
  assigned_to       uuid,
  findings          jsonb NOT NULL DEFAULT '{}',
  notes             text,
  install_order_id  uuid,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT site_survey_request_pkey PRIMARY KEY (id),
  CONSTRAINT site_survey_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT site_survey_request_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT site_survey_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT site_survey_request_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT site_survey_request_install_order_id_fkey FOREIGN KEY (install_order_id) REFERENCES platform.install_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT site_survey_request_scheduled_check CHECK (state <> 'scheduled' OR scheduled_for IS NOT NULL)
);
COMMENT ON TABLE platform.site_survey_request IS 'Upgrade Starter → Smart (D-156): the owner asks, a field engineer surveys the building, the outcome becomes an install order.';
CREATE INDEX site_survey_request_tenant_id_state_idx ON platform.site_survey_request (tenant_id, state);
CREATE INDEX site_survey_request_building_id_idx ON platform.site_survey_request (building_id);
CREATE INDEX site_survey_request_requested_by_idx ON platform.site_survey_request (requested_by);
CREATE INDEX site_survey_request_assigned_to_idx ON platform.site_survey_request (assigned_to);
CREATE INDEX site_survey_request_install_order_id_idx ON platform.site_survey_request (install_order_id);
ALTER TABLE platform.install_order ADD CONSTRAINT install_order_site_survey_request_id_fkey FOREIGN KEY (site_survey_request_id) REFERENCES platform.site_survey_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ------------------------------------------------------------------------------------------- subscriptions
CREATE TABLE platform.subscription (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  plan_version_id         uuid NOT NULL,
  plan_key                text NOT NULL,
  addon_plan_version_ids  uuid[] NOT NULL DEFAULT '{}',
  state                   platform.subscription_status NOT NULL DEFAULT 'trial',
  trial_ends_at           timestamptz(6) NOT NULL,
  started_at              timestamptz(6) NOT NULL,
  activated_at            timestamptz(6),
  term_start              date,
  term_end                date,
  billing_period          platform.billing_period NOT NULL DEFAULT 'monthly',
  billing_day             smallint NOT NULL DEFAULT 1,
  next_invoice_at         timestamptz(6),
  discount_pct            numeric(7,4) NOT NULL DEFAULT 0,
  discount_reason         text,
  pilot_agreement_id      uuid,
  past_due_since          timestamptz(6),
  suspended_at            timestamptz(6),
  cancelled_at            timestamptz(6),
  cancel_reason           text,
  cancel_effective_date   date,
  deinstall_order_id      uuid,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT subscription_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_plan_version_id_fkey FOREIGN KEY (plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_pilot_agreement_id_fkey FOREIGN KEY (pilot_agreement_id) REFERENCES platform.pilot_agreement (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_deinstall_order_id_fkey FOREIGN KEY (deinstall_order_id) REFERENCES platform.install_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_discount_check CHECK (discount_pct >= 0 AND discount_pct < 100),
  CONSTRAINT subscription_billing_day_check CHECK (billing_day = 1),
  CONSTRAINT subscription_states_check CHECK ((state <> 'past_due' OR past_due_since IS NOT NULL)
    AND (state <> 'suspended' OR suspended_at IS NOT NULL) AND (state <> 'cancelled' OR cancelled_at IS NOT NULL))
);
COMMENT ON TABLE platform.subscription IS 'A tenant''s subscription (D-082): trial → active (first payment) → past_due (due + grace) → suspended (read-only, never data loss) → cancelled (de-install order for HaaS hardware).';
CREATE UNIQUE INDEX subscription_tenant_id_open_key ON platform.subscription (tenant_id) WHERE state IN ('trial', 'active', 'past_due', 'suspended');
CREATE INDEX subscription_tenant_id_idx ON platform.subscription (tenant_id);
CREATE INDEX subscription_plan_version_id_idx ON platform.subscription (plan_version_id);
CREATE INDEX subscription_pilot_agreement_id_idx ON platform.subscription (pilot_agreement_id);
CREATE INDEX subscription_deinstall_order_id_idx ON platform.subscription (deinstall_order_id);
CREATE INDEX subscription_state_idx ON platform.subscription (state);
ALTER TABLE platform.install_order ADD CONSTRAINT install_order_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES platform.subscription (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE platform.subscription_event (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  type             text NOT NULL,
  occurred_at      timestamptz(6) NOT NULL DEFAULT now(),
  actor            jsonb NOT NULL DEFAULT '{}',
  data             jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT subscription_event_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_event_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES platform.subscription (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.subscription_event IS 'History of a subscription (state changes, plan changes, discounts). Append-only.';
CREATE INDEX subscription_event_subscription_id_occurred_at_idx ON platform.subscription_event (subscription_id, occurred_at);
CREATE INDEX subscription_event_tenant_id_idx ON platform.subscription_event (tenant_id);

CREATE TABLE platform.subscription_usage (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  subscription_id       uuid NOT NULL,
  month                 date NOT NULL,
  units_counted         integer NOT NULL,
  meter_points_counted  integer NOT NULL DEFAULT 0,
  ocr_images            integer NOT NULL DEFAULT 0,
  units_by_building     jsonb NOT NULL DEFAULT '{}',
  plan_version_id       uuid NOT NULL,
  amount_computed       numeric(14,2) NOT NULL,
  lines                 jsonb NOT NULL DEFAULT '[]',
  snapshot_at           timestamptz(6) NOT NULL,
  CONSTRAINT subscription_usage_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_usage_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES platform.subscription (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_usage_plan_version_id_fkey FOREIGN KEY (plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT subscription_usage_month_check CHECK (extract(day FROM month) = 1),
  CONSTRAINT subscription_usage_counts_check CHECK (units_counted >= 0 AND meter_points_counted >= 0 AND ocr_images >= 0)
);
COMMENT ON TABLE platform.subscription_usage IS 'Monthly snapshot on the 1st (D-082, D-156): units counted = the tenant''s units whose status is not inactive; rented meter points; OCR images of the previous month (D-161); the computed amount.';
CREATE UNIQUE INDEX subscription_usage_subscription_id_month_key ON platform.subscription_usage (subscription_id, month);
CREATE INDEX subscription_usage_tenant_id_idx ON platform.subscription_usage (tenant_id);
CREATE INDEX subscription_usage_plan_version_id_idx ON platform.subscription_usage (plan_version_id);

-- ------------------------------------------------------------------------------------------- platform AR
CREATE TABLE platform.platform_invoice (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  usage_id         uuid,
  kind             platform.platform_invoice_kind NOT NULL,
  number           citext NOT NULL,
  document_id      uuid,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  issued_at        timestamptz(6) NOT NULL,
  due_at           timestamptz(6) NOT NULL,
  subtotal         numeric(14,2) NOT NULL,
  discount         numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount       numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL,
  paid_total       numeric(14,2) NOT NULL DEFAULT 0,
  credited_total   numeric(14,2) NOT NULL DEFAULT 0,
  state            platform.platform_invoice_status NOT NULL DEFAULT 'issued',
  overdue_since    timestamptz(6),
  snapshot         jsonb NOT NULL DEFAULT '{}',
  qr_payload       text,
  qr_reference     text,
  qr_expires_at    timestamptz(6),
  voided_at        timestamptz(6),
  void_reason      text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT platform_invoice_pkey PRIMARY KEY (id),
  CONSTRAINT platform_invoice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES platform.subscription (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_usage_id_fkey FOREIGN KEY (usage_id) REFERENCES platform.subscription_usage (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_period_check CHECK (period_end >= period_start),
  CONSTRAINT platform_invoice_money_check CHECK (subtotal >= 0 AND discount >= 0 AND vat_amount >= 0 AND total >= 0
    AND paid_total >= 0 AND credited_total >= 0 AND total = subtotal - discount + vat_amount
    AND paid_total + credited_total <= total)
);
COMMENT ON TABLE platform.platform_invoice IS 'Collective Group (Thailand) → tenant (D-146, D-156): numbered in the platform series (tenant_id NULL), Thai QR through the platform''s own payment adapter; immutable apart from payment state, QR and document.';
CREATE UNIQUE INDEX platform_invoice_number_key ON platform.platform_invoice (number);
CREATE UNIQUE INDEX platform_invoice_qr_reference_key ON platform.platform_invoice (qr_reference);
CREATE UNIQUE INDEX platform_invoice_subscription_period_key ON platform.platform_invoice (subscription_id, kind, period_start) WHERE kind <> 'adjustment' AND state <> 'void';
CREATE INDEX platform_invoice_tenant_id_state_idx ON platform.platform_invoice (tenant_id, state);
CREATE INDEX platform_invoice_subscription_id_idx ON platform.platform_invoice (subscription_id);
CREATE INDEX platform_invoice_usage_id_idx ON platform.platform_invoice (usage_id);
CREATE INDEX platform_invoice_document_id_idx ON platform.platform_invoice (document_id);

CREATE TABLE platform.platform_invoice_line (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  line_no      smallint NOT NULL,
  kind         platform.platform_line_kind NOT NULL,
  description  text NOT NULL,
  quantity     numeric(12,3) NOT NULL,
  unit_price   numeric(14,4) NOT NULL,
  amount       numeric(14,2) NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_invoice_line_pkey PRIMARY KEY (id),
  CONSTRAINT platform_invoice_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_line_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_invoice_line_amount_check CHECK (amount = round(amount, 2) AND (kind NOT IN ('discount') OR amount <= 0)
    AND (kind IN ('discount', 'adjustment') OR amount >= 0))
);
CREATE UNIQUE INDEX platform_invoice_line_invoice_id_line_no_key ON platform.platform_invoice_line (invoice_id, line_no);
CREATE INDEX platform_invoice_line_tenant_id_idx ON platform.platform_invoice_line (tenant_id);

CREATE TABLE platform.platform_payment (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  invoice_id            uuid NOT NULL,
  amount                numeric(14,2) NOT NULL,
  method                platform.platform_payment_method NOT NULL,
  provider              text,
  provider_ref          text,
  paid_at               timestamptz(6) NOT NULL,
  confirmed_at          timestamptz(6) NOT NULL,
  state                 platform.platform_payment_state NOT NULL DEFAULT 'confirmed',
  recorded_by           uuid,
  evidence_document_id  uuid,
  receipt_id            uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_payment_pkey PRIMARY KEY (id),
  CONSTRAINT platform_payment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_payment_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_payment_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_payment_evidence_document_id_fkey FOREIGN KEY (evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_payment_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  CONSTRAINT platform_payment_provider_check CHECK (method <> 'qr' OR (provider IS NOT NULL AND provider_ref IS NOT NULL)),
  CONSTRAINT platform_payment_transfer_check CHECK (method <> 'bank_transfer' OR evidence_document_id IS NOT NULL OR provider_ref IS NOT NULL)
);
COMMENT ON TABLE platform.platform_payment IS 'Payments of platform invoices (QR callbacks of the platform merchant, or transfers recorded by Finance with evidence); idempotent on (provider, provider_ref).';
CREATE UNIQUE INDEX platform_payment_provider_ref_key ON platform.platform_payment (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX platform_payment_tenant_id_idx ON platform.platform_payment (tenant_id);
CREATE INDEX platform_payment_invoice_id_idx ON platform.platform_payment (invoice_id);
CREATE INDEX platform_payment_recorded_by_idx ON platform.platform_payment (recorded_by);
CREATE INDEX platform_payment_evidence_document_id_idx ON platform.platform_payment (evidence_document_id);

CREATE TABLE platform.platform_receipt (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  payment_id   uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  number       citext NOT NULL,
  amount       numeric(14,2) NOT NULL,
  vat_amount   numeric(14,2) NOT NULL DEFAULT 0,
  document_id  uuid,
  issued_at    timestamptz(6) NOT NULL,
  voided_at    timestamptz(6),
  void_reason  text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_receipt_pkey PRIMARY KEY (id),
  CONSTRAINT platform_receipt_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_receipt_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES platform.platform_payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_receipt_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_receipt_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX platform_receipt_payment_id_key ON platform.platform_receipt (payment_id);
CREATE UNIQUE INDEX platform_receipt_number_key ON platform.platform_receipt (number);
CREATE INDEX platform_receipt_tenant_id_idx ON platform.platform_receipt (tenant_id);
CREATE INDEX platform_receipt_invoice_id_idx ON platform.platform_receipt (invoice_id);
CREATE INDEX platform_receipt_document_id_idx ON platform.platform_receipt (document_id);
ALTER TABLE platform.platform_payment ADD CONSTRAINT platform_payment_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES platform.platform_receipt (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX platform_payment_receipt_id_idx ON platform.platform_payment (receipt_id);

CREATE TABLE platform.platform_credit_note (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  state         platform.platform_credit_note_state NOT NULL DEFAULT 'requested',
  number        citext,
  amount        numeric(14,2) NOT NULL,
  reason        text NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz(6) NOT NULL DEFAULT now(),
  approved_by   uuid,
  decided_at    timestamptz(6),
  issued_at     timestamptz(6),
  document_id   uuid,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_credit_note_pkey PRIMARY KEY (id),
  CONSTRAINT platform_credit_note_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_credit_note_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_credit_note_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_credit_note_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_credit_note_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_credit_note_amount_check CHECK (amount > 0 AND amount = round(amount, 2)),
  -- D-091: maker-checker — the approver is never the requester
  CONSTRAINT platform_credit_note_maker_checker_check CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT platform_credit_note_issued_check CHECK ((state = 'issued') = (number IS NOT NULL AND issued_at IS NOT NULL AND approved_by IS NOT NULL))
);
COMMENT ON TABLE platform.platform_credit_note IS 'Credit notes on platform invoices (D-091 maker-checker: requested by one platform user, approved by another, then numbered in the platform series).';
CREATE UNIQUE INDEX platform_credit_note_number_key ON platform.platform_credit_note (number) WHERE number IS NOT NULL;
CREATE INDEX platform_credit_note_tenant_id_idx ON platform.platform_credit_note (tenant_id);
CREATE INDEX platform_credit_note_invoice_id_idx ON platform.platform_credit_note (invoice_id);
CREATE INDEX platform_credit_note_requested_by_idx ON platform.platform_credit_note (requested_by);
CREATE INDEX platform_credit_note_approved_by_idx ON platform.platform_credit_note (approved_by);
CREATE INDEX platform_credit_note_document_id_idx ON platform.platform_credit_note (document_id);

-- ------------------------------------------------------------------------------------------- HaaS register
CREATE TABLE platform.haas_asset (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  device_id             uuid NOT NULL,
  tenant_id             uuid NOT NULL,
  building_id           uuid,
  subscription_id       uuid,
  kind                  smart.device_kind NOT NULL,
  installed_at          date,
  term_months           smallint NOT NULL,
  term_end              date,
  monthly_value         numeric(14,2) NOT NULL,
  acquisition_cost      numeric(14,2) NOT NULL,
  depreciation_method   text NOT NULL DEFAULT 'straight_line',
  state                 platform.haas_state NOT NULL DEFAULT 'allocated',
  replaced_by_asset_id  uuid,
  deinstall_order_id    uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT haas_asset_pkey PRIMARY KEY (id),
  CONSTRAINT haas_asset_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES platform.subscription (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_replaced_by_asset_id_fkey FOREIGN KEY (replaced_by_asset_id) REFERENCES platform.haas_asset (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_deinstall_order_id_fkey FOREIGN KEY (deinstall_order_id) REFERENCES platform.install_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_money_check CHECK (monthly_value >= 0 AND acquisition_cost >= 0),
  CONSTRAINT haas_asset_term_check CHECK (term_months > 0),
  CONSTRAINT haas_asset_installed_check CHECK (state IN ('allocated', 'written_off') OR installed_at IS NOT NULL),
  CONSTRAINT haas_asset_replaced_check CHECK ((state = 'replaced') = (replaced_by_asset_id IS NOT NULL))
);
COMMENT ON TABLE platform.haas_asset IS 'Platform-owned hardware at a tenant (D-081 HaaS, meter rental D-156): install date, term, monthly value, depreciation, replacement history, de-install order on cancellation.';
CREATE UNIQUE INDEX haas_asset_device_id_live_key ON platform.haas_asset (device_id) WHERE state NOT IN ('replaced', 'deinstalled', 'written_off');
CREATE INDEX haas_asset_device_id_idx ON platform.haas_asset (device_id);
CREATE INDEX haas_asset_tenant_id_state_idx ON platform.haas_asset (tenant_id, state);
CREATE INDEX haas_asset_building_id_idx ON platform.haas_asset (building_id);
CREATE INDEX haas_asset_subscription_id_idx ON platform.haas_asset (subscription_id);
CREATE INDEX haas_asset_replaced_by_asset_id_idx ON platform.haas_asset (replaced_by_asset_id);
CREATE INDEX haas_asset_deinstall_order_id_idx ON platform.haas_asset (deinstall_order_id);

CREATE TABLE platform.haas_asset_event (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  haas_asset_id     uuid NOT NULL,
  type              text NOT NULL,
  occurred_at       timestamptz(6) NOT NULL DEFAULT now(),
  actor             jsonb NOT NULL DEFAULT '{}',
  data              jsonb NOT NULL DEFAULT '{}',
  install_order_id  uuid,
  CONSTRAINT haas_asset_event_pkey PRIMARY KEY (id),
  CONSTRAINT haas_asset_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_event_haas_asset_id_fkey FOREIGN KEY (haas_asset_id) REFERENCES platform.haas_asset (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT haas_asset_event_install_order_id_fkey FOREIGN KEY (install_order_id) REFERENCES platform.install_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX haas_asset_event_haas_asset_id_occurred_at_idx ON platform.haas_asset_event (haas_asset_id, occurred_at);
CREATE INDEX haas_asset_event_tenant_id_idx ON platform.haas_asset_event (tenant_id);
CREATE INDEX haas_asset_event_install_order_id_idx ON platform.haas_asset_event (install_order_id);

-- ------------------------------------------------------------------------------------------- integrity
CREATE OR REPLACE FUNCTION platform.platform_document_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := CASE TG_TABLE_NAME
    WHEN 'platform_invoice' THEN ARRAY['state', 'paid_total', 'credited_total', 'overdue_since', 'qr_payload', 'qr_reference',
      'qr_expires_at', 'document_id', 'voided_at', 'void_reason', 'updated_at', 'version']
    WHEN 'platform_receipt' THEN ARRAY['document_id', 'voided_at', 'void_reason']
    WHEN 'platform_credit_note' THEN ARRAY['state', 'number', 'approved_by', 'decided_at', 'issued_at', 'document_id', 'updated_at']
    ELSE ARRAY[]::text[] END;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_invoice.immutable: %.% rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'platform_invoice.immutable: % % cannot be modified', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'platform_invoice.immutable: the document of % % is final', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
  END IF;
  -- compared as text: the literal must not be cast to the enum of another table
  IF TG_TABLE_NAME = 'platform_credit_note' THEN
    IF OLD.state::text <> 'requested' AND NEW.state::text IS DISTINCT FROM OLD.state::text THEN
      RAISE EXCEPTION 'platform_invoice.immutable: credit note % was already decided', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_invoice_immutable BEFORE UPDATE OR DELETE ON platform.platform_invoice FOR EACH ROW EXECUTE FUNCTION platform.platform_document_guard();
CREATE TRIGGER platform_receipt_immutable BEFORE UPDATE OR DELETE ON platform.platform_receipt FOR EACH ROW EXECUTE FUNCTION platform.platform_document_guard();
CREATE TRIGGER platform_credit_note_immutable BEFORE UPDATE OR DELETE ON platform.platform_credit_note FOR EACH ROW EXECUTE FUNCTION platform.platform_document_guard();
CREATE TRIGGER platform_invoice_line_append_only BEFORE UPDATE OR DELETE ON platform.platform_invoice_line FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER subscription_event_append_only BEFORE UPDATE OR DELETE ON platform.subscription_event FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER haas_asset_event_append_only BEFORE UPDATE OR DELETE ON platform.haas_asset_event FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER subscription_usage_append_only BEFORE UPDATE OR DELETE ON platform.subscription_usage FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

CREATE TRIGGER price_plan_set_updated_at BEFORE UPDATE ON platform.price_plan FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER price_plan_version_set_updated_at BEFORE UPDATE ON platform.price_plan_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER pilot_agreement_set_updated_at BEFORE UPDATE ON platform.pilot_agreement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER install_order_set_updated_at BEFORE UPDATE ON platform.install_order FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER site_survey_request_set_updated_at BEFORE UPDATE ON platform.site_survey_request FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER subscription_set_updated_at BEFORE UPDATE ON platform.subscription FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER platform_payment_set_updated_at BEFORE UPDATE ON platform.platform_payment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER haas_asset_set_updated_at BEFORE UPDATE ON platform.haas_asset FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------- RLS (§4.5)
-- catalogues readable by everyone, written by gp_platform; tenant rows: the tenant reads its own (owner surface),
-- the platform writes through gp_platform (BYPASSRLS)
SELECT platform.apply_rls('platform.price_plan', 'platform');
SELECT platform.apply_rls('platform.price_plan_version', 'platform');
SELECT platform.apply_rls('platform.pilot_agreement', 'tenant');
SELECT platform.apply_rls('platform.install_order', 'tenant');
SELECT platform.apply_rls('platform.site_survey_request', 'tenant');
SELECT platform.apply_rls('platform.subscription', 'tenant');
SELECT platform.apply_rls('platform.subscription_event', 'tenant');
SELECT platform.apply_rls('platform.subscription_usage', 'tenant');
SELECT platform.apply_rls('platform.platform_invoice', 'tenant');
SELECT platform.apply_rls('platform.platform_invoice_line', 'tenant');
SELECT platform.apply_rls('platform.platform_payment', 'tenant');
SELECT platform.apply_rls('platform.platform_receipt', 'tenant');
SELECT platform.apply_rls('platform.platform_credit_note', 'tenant');
SELECT platform.apply_rls('platform.haas_asset', 'tenant');
SELECT platform.apply_rls('platform.haas_asset_event', 'tenant');

GRANT SELECT ON platform.price_plan, platform.price_plan_version TO gp_app, gp_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.price_plan, platform.price_plan_version TO gp_platform;
-- the owner reads its subscription, invoices, receipts, usage, HaaS register and field orders, and asks for a site
-- survey (INSERT); everything else is written by the platform
GRANT SELECT ON platform.pilot_agreement, platform.install_order, platform.subscription, platform.subscription_event,
  platform.subscription_usage, platform.platform_invoice, platform.platform_invoice_line, platform.platform_payment,
  platform.platform_receipt, platform.platform_credit_note, platform.haas_asset, platform.haas_asset_event,
  platform.site_survey_request TO gp_app, gp_reporting;
GRANT INSERT ON platform.site_survey_request TO gp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.pilot_agreement, platform.install_order, platform.site_survey_request,
  platform.subscription, platform.subscription_event, platform.subscription_usage, platform.platform_invoice,
  platform.platform_invoice_line, platform.platform_payment, platform.platform_receipt, platform.platform_credit_note,
  platform.haas_asset, platform.haas_asset_event TO gp_platform;

-- ------------------------------------------------------------------------------------------- AI usage (B6.4, D-161)
CREATE TYPE platform.ai_feature AS ENUM ('meter_ocr', 'invoice_ocr', 'resident_bot', 'legal_qa', 'stt', 'minutes', 'other');
CREATE TYPE platform.ai_unit_kind AS ENUM ('tokens', 'images', 'seconds', 'requests');

CREATE TABLE platform.ai_usage_record (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  building_id     uuid,
  feature         platform.ai_feature NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  prompt_version  text,
  input_units     integer NOT NULL DEFAULT 0,
  output_units    integer NOT NULL DEFAULT 0,
  unit_kind       platform.ai_unit_kind NOT NULL,
  cost_thb        numeric(14,4) NOT NULL DEFAULT 0,
  request_ref     text,
  outcome         text NOT NULL DEFAULT 'ok',
  subject_type    text,
  subject_id      uuid,
  occurred_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_record_pkey PRIMARY KEY (id),
  CONSTRAINT ai_usage_record_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ai_usage_record_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ai_usage_record_units_check CHECK (input_units >= 0 AND output_units >= 0 AND cost_thb >= 0),
  CONSTRAINT ai_usage_record_outcome_check CHECK (outcome IN ('ok', 'error'))
);
COMMENT ON TABLE platform.ai_usage_record IS 'One row per AI adapter call (D-161): OCR of meter photos first; units, cost in THB, provider and model; monthly totals per tenant feed the OCR allowance of the plan (500 photos, THB 0.50 per extra, Proposed). Append-only.';
CREATE INDEX ai_usage_record_tenant_id_feature_occurred_at_idx ON platform.ai_usage_record (tenant_id, feature, occurred_at DESC);
CREATE INDEX ai_usage_record_building_id_idx ON platform.ai_usage_record (building_id);
CREATE TRIGGER ai_usage_record_append_only BEFORE UPDATE OR DELETE ON platform.ai_usage_record FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();

-- ------------------------------------------------------------------------------------------- pilot KPIs (B6.3 endpoint, R1)
CREATE TABLE platform.kpi_snapshot (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  "window"     text NOT NULL,
  as_of        date NOT NULL,
  baseline     jsonb NOT NULL DEFAULT '{}',
  current      jsonb NOT NULL DEFAULT '{}',
  computed_at  timestamptz(6) NOT NULL,
  CONSTRAINT kpi_snapshot_pkey PRIMARY KEY (id),
  CONSTRAINT kpi_snapshot_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT kpi_snapshot_window_check CHECK ("window" IN ('30d', '90d'))
);
COMMENT ON TABLE platform.kpi_snapshot IS 'Pilot KPIs of a tenant per day and window (D-083): the 7 KPIs + Phase 1 acceptance metrics, with the baseline they are compared to.';
CREATE UNIQUE INDEX kpi_snapshot_tenant_id_window_as_of_key ON platform.kpi_snapshot (tenant_id, "window", as_of);

SELECT platform.apply_rls('platform.ai_usage_record', 'tenant');
SELECT platform.apply_rls('platform.kpi_snapshot', 'tenant');
GRANT SELECT, INSERT ON platform.ai_usage_record TO gp_app;
GRANT SELECT ON platform.kpi_snapshot TO gp_app;
GRANT SELECT ON platform.ai_usage_record, platform.kpi_snapshot TO gp_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_usage_record, platform.kpi_snapshot TO gp_platform;
