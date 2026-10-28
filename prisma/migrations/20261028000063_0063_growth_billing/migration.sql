-- getproperty-api 0063 — boost & growth billing (pack G step G5, module E6; D-287, D-291, D-293, D-297, D-298).
-- schema-design §7.5 rows 176–180.
--   * ops.listing_boost: a paid (or free) boost of one listing or one building — pending until its purchase platform
--     invoice is paid, then active for its window; public search shows boosted listings labelled, a few per page.
--   * platform.media_service_order: a verified photo / 360° tour ordered from the platform (a partner fulfils, O-032);
--     the deliverables are documents of the ordering tenant (listing media, counted to its quota — D-286).
--   * ops.fee_accrual: the G2 invoice / credit-note references get their foreign keys; uninvoiced accruals indexed.
-- Every purchase is a line on a platform invoice (no stored value, no prepaid balance — D-298); nothing is charged
-- through the payment gateway (O-020) and an unpaid invoice never suspends anyone (D-250).

CREATE TYPE ops.boost_state AS ENUM ('pending_payment', 'active', 'expired', 'cancelled');
CREATE TYPE platform.media_service_kind AS ENUM ('verified_photo', 'tour_360');
CREATE TYPE platform.media_service_state AS ENUM ('pending_payment', 'requested', 'scheduled', 'delivered', 'cancelled');

-- Boosts ---------------------------------------------------------------------------------------------------------------
CREATE TABLE ops.listing_boost (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  listing_id            uuid,
  building_id           uuid,
  product_key           text NOT NULL,
  price_plan_version_id uuid NOT NULL,
  days                  smallint,
  months                smallint,
  price                 numeric(14,2) NOT NULL DEFAULT 0,
  free                  boolean NOT NULL DEFAULT false,
  state                 ops.boost_state NOT NULL DEFAULT 'pending_payment',
  platform_invoice_id   uuid,
  starts_at             timestamptz(6),
  ends_at               timestamptz(6),
  activated_at          timestamptz(6),
  cancelled_at          timestamptz(6),
  cancel_reason         text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT listing_boost_pkey PRIMARY KEY (id),
  CONSTRAINT listing_boost_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_boost_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_boost_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_boost_price_plan_version_id_fkey FOREIGN KEY (price_plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_boost_platform_invoice_id_fkey FOREIGN KEY (platform_invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_boost_target_check CHECK ((listing_id IS NULL) <> (building_id IS NULL)),
  CONSTRAINT listing_boost_duration_check CHECK ((days IS NULL) <> (months IS NULL) AND COALESCE(days, months) BETWEEN 1 AND 366),
  CONSTRAINT listing_boost_price_check CHECK (price >= 0 AND (NOT free OR price = 0)),
  CONSTRAINT listing_boost_pending_check CHECK (state <> 'pending_payment' OR platform_invoice_id IS NOT NULL),
  CONSTRAINT listing_boost_window_check CHECK ((starts_at IS NULL) = (ends_at IS NULL) AND (ends_at IS NULL OR ends_at > starts_at)),
  CONSTRAINT listing_boost_active_check CHECK (state NOT IN ('active', 'expired') OR (starts_at IS NOT NULL AND activated_at IS NOT NULL)),
  CONSTRAINT listing_boost_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT listing_boost_cancel_reason_check CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  CONSTRAINT listing_boost_product_key_check CHECK (length(product_key) BETWEEN 1 AND 100)
);
COMMENT ON TABLE ops.listing_boost IS 'D-287 / D-297 (G5): a boost of one listing or one building, bought as a purchase platform invoice line (or free by setting); active for its window once the invoice is paid; public search labels boosted listings and shows at most boost.search.max_per_page per page.';
CREATE UNIQUE INDEX listing_boost_pending_listing_key ON ops.listing_boost (listing_id, product_key) WHERE state = 'pending_payment';
CREATE UNIQUE INDEX listing_boost_pending_building_key ON ops.listing_boost (building_id, product_key) WHERE state = 'pending_payment';
CREATE INDEX listing_boost_tenant_id_state_idx ON ops.listing_boost (tenant_id, state);
CREATE INDEX listing_boost_state_ends_at_idx ON ops.listing_boost (state, ends_at);
CREATE INDEX listing_boost_active_listing_idx ON ops.listing_boost (listing_id, ends_at) WHERE state = 'active';
CREATE INDEX listing_boost_active_building_idx ON ops.listing_boost (building_id, ends_at) WHERE state = 'active';
CREATE INDEX listing_boost_platform_invoice_id_idx ON ops.listing_boost (platform_invoice_id);
CREATE INDEX listing_boost_price_plan_version_id_idx ON ops.listing_boost (price_plan_version_id);
CREATE TRIGGER listing_boost_set_updated_at BEFORE UPDATE ON ops.listing_boost FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.listing_boost', 'tenant');
GRANT SELECT ON ops.listing_boost TO gp_app;
GRANT SELECT, INSERT, UPDATE ON ops.listing_boost TO gp_platform;
GRANT SELECT ON ops.listing_boost TO gp_reporting;

-- Verified photo / 360° orders -----------------------------------------------------------------------------------------
CREATE TABLE platform.media_service_order (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  listing_id               uuid,
  unit_id                  uuid NOT NULL,
  building_id              uuid NOT NULL,
  service                  platform.media_service_kind NOT NULL,
  price_plan_version_id    uuid NOT NULL,
  price                    numeric(14,2) NOT NULL DEFAULT 0,
  state                    platform.media_service_state NOT NULL DEFAULT 'pending_payment',
  platform_invoice_id      uuid,
  note                     text,
  partner_ref              text,
  scheduled_for            timestamptz(6),
  deliverable_document_ids uuid[] NOT NULL DEFAULT '{}',
  requested_at             timestamptz(6),
  scheduled_at             timestamptz(6),
  delivered_at             timestamptz(6),
  cancelled_at             timestamptz(6),
  cancel_reason            text,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT media_service_order_pkey PRIMARY KEY (id),
  CONSTRAINT media_service_order_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_price_plan_version_id_fkey FOREIGN KEY (price_plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_platform_invoice_id_fkey FOREIGN KEY (platform_invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT media_service_order_price_check CHECK (price >= 0),
  CONSTRAINT media_service_order_pending_check CHECK (state <> 'pending_payment' OR platform_invoice_id IS NOT NULL),
  CONSTRAINT media_service_order_note_check CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT media_service_order_partner_ref_check CHECK (partner_ref IS NULL OR length(partner_ref) <= 200),
  CONSTRAINT media_service_order_cancel_reason_check CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  CONSTRAINT media_service_order_deliverables_check CHECK (cardinality(deliverable_document_ids) <= 60),
  CONSTRAINT media_service_order_requested_check CHECK (state = 'pending_payment' OR state = 'cancelled' OR requested_at IS NOT NULL),
  CONSTRAINT media_service_order_scheduled_check CHECK (state <> 'scheduled' OR scheduled_at IS NOT NULL),
  CONSTRAINT media_service_order_delivered_check CHECK ((state = 'delivered') = (delivered_at IS NOT NULL) AND (state <> 'delivered' OR cardinality(deliverable_document_ids) > 0)),
  CONSTRAINT media_service_order_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
COMMENT ON TABLE platform.media_service_order IS 'D-287 / D-297 (G5): a verified photo / 360° tour of a unit ordered from the platform as a purchase platform invoice line; a partner fulfils (O-032); deliverables are documents of the tenant (counted to its quota, D-286).';
CREATE UNIQUE INDEX media_service_order_open_key ON platform.media_service_order (unit_id, service) WHERE state IN ('pending_payment', 'requested', 'scheduled');
CREATE INDEX media_service_order_tenant_id_state_idx ON platform.media_service_order (tenant_id, state);
CREATE INDEX media_service_order_state_idx ON platform.media_service_order (state, created_at);
CREATE INDEX media_service_order_listing_id_idx ON platform.media_service_order (listing_id);
CREATE INDEX media_service_order_unit_id_idx ON platform.media_service_order (unit_id);
CREATE INDEX media_service_order_building_id_idx ON platform.media_service_order (building_id);
CREATE INDEX media_service_order_price_plan_version_id_idx ON platform.media_service_order (price_plan_version_id);
CREATE INDEX media_service_order_platform_invoice_id_idx ON platform.media_service_order (platform_invoice_id);
CREATE TRIGGER media_service_order_set_updated_at BEFORE UPDATE ON platform.media_service_order FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.media_service_order', 'tenant');
GRANT SELECT ON platform.media_service_order TO gp_app;
GRANT SELECT, INSERT, UPDATE ON platform.media_service_order TO gp_platform;
GRANT SELECT ON platform.media_service_order TO gp_reporting;

-- G2 accruals: references of the platform invoice line and the credit note ---------------------------------------------
ALTER TABLE ops.fee_accrual
  ADD CONSTRAINT fee_accrual_platform_invoice_line_id_fkey FOREIGN KEY (platform_invoice_line_id) REFERENCES platform.platform_invoice_line (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT fee_accrual_credit_note_id_fkey FOREIGN KEY (credit_note_id) REFERENCES platform.platform_credit_note (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT fee_accrual_credit_after_invoice_check CHECK (credit_note_id IS NULL OR platform_invoice_line_id IS NOT NULL);
CREATE UNIQUE INDEX fee_accrual_platform_invoice_line_id_key ON ops.fee_accrual (platform_invoice_line_id) WHERE platform_invoice_line_id IS NOT NULL;
CREATE INDEX fee_accrual_credit_note_id_idx ON ops.fee_accrual (credit_note_id);
CREATE INDEX fee_accrual_uninvoiced_idx ON ops.fee_accrual (tenant_id, accrued_on) WHERE platform_invoice_line_id IS NULL;

-- An accrual is invoiced once: its invoice line is set from NULL and never changed afterwards (the credit-note
-- reference may change — a rejected dispute can be raised again).
CREATE OR REPLACE FUNCTION ops.fee_accrual_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (to_jsonb(OLD) - 'platform_invoice_line_id' - 'credit_note_id') <> (to_jsonb(NEW) - 'platform_invoice_line_id' - 'credit_note_id') THEN
    RAISE EXCEPTION 'core.append_only: ops.fee_accrual is append-only (% refused)', TG_OP USING ERRCODE = 'P0001';
  END IF;
  IF OLD.platform_invoice_line_id IS NOT NULL AND NEW.platform_invoice_line_id IS DISTINCT FROM OLD.platform_invoice_line_id THEN
    RAISE EXCEPTION 'core.append_only: ops.fee_accrual is invoiced once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
