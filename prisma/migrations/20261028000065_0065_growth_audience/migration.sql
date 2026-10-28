-- getproperty-api 0065 — audience, marketing consent and sponsored broadcast (pack G step G6, module E4; D-287, D-300).
-- schema-design §7.5 rows 189–194.
--   * platform.audience_preference: what a person who consented to `platform.recommendations` wants to hear about
--     (areas, budget, unit kinds, move-in window, language, own quiet hours) — no special-category field exists;
--     platform-only (the buyer of a campaign never sees a person).
--   * platform.sponsored_campaign: a buyer tenant's campaign of its own published listings to a consented segment,
--     sent through getproperty's LINE OA (gate `broadcast.sponsored.enabled`, O-023); aggregates only.
--   * platform.sponsored_delivery: who got which campaign (frequency cap, history shown to the person, DSR) —
--     platform-only, never visible to the buyer; kept `broadcast.sponsored.delivery_keep_months`.
--   * platform.sponsored_campaign_link: one short code per campaign × listing (`<web>/s/<code>`), clicks per campaign.
--   * ops.listing_channel + `line_sponsored` (an enquiry that came from a sponsored message).
-- No core.* change.

CREATE TYPE platform.sponsored_campaign_state AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'rejected');
CREATE TYPE platform.sponsored_delivery_state AS ENUM ('pending', 'sent', 'failed', 'cancelled');
ALTER TYPE ops.listing_channel ADD VALUE IF NOT EXISTS 'line_sponsored';

-- Audience preferences ------------------------------------------------------------------------------------------------
CREATE TABLE platform.audience_preference (
  id             uuid NOT NULL DEFAULT uuidv7(),
  user_id        uuid NOT NULL,
  consent_id     uuid,
  area_slugs     text[] NOT NULL DEFAULT '{}',
  budget_min     numeric(14,2),
  budget_max     numeric(14,2),
  unit_kinds     ops.portfolio_unit_kind[] NOT NULL DEFAULT '{}',
  move_in_from   date,
  move_in_to     date,
  language       char(2) NOT NULL DEFAULT 'th',
  quiet_start    time(0),
  quiet_end      time(0),
  withdrawn_at   timestamptz(6),
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT audience_preference_pkey PRIMARY KEY (id),
  CONSTRAINT audience_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT audience_preference_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES platform.consent (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT audience_preference_areas_check CHECK (cardinality(area_slugs) <= 10),
  CONSTRAINT audience_preference_budget_check CHECK ((budget_min IS NULL OR budget_min >= 0) AND (budget_max IS NULL OR budget_max > 0) AND (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)),
  CONSTRAINT audience_preference_move_in_check CHECK (move_in_from IS NULL OR move_in_to IS NULL OR move_in_from <= move_in_to),
  CONSTRAINT audience_preference_language_check CHECK (language IN ('th', 'en', 'my', 'km', 'lo', 'zh')),
  CONSTRAINT audience_preference_quiet_check CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);
COMMENT ON TABLE platform.audience_preference IS 'D-287 / D-300 (G6): what a person who consented to platform.recommendations wants to hear about; no special-category data; platform-only; deleted with DSR erasure and audience.preferences.keep_days_after_withdrawal after a withdrawal.';
CREATE UNIQUE INDEX audience_preference_user_id_key ON platform.audience_preference (user_id);
CREATE INDEX audience_preference_consent_id_idx ON platform.audience_preference (consent_id);
CREATE INDEX audience_preference_withdrawn_at_idx ON platform.audience_preference (withdrawn_at) WHERE withdrawn_at IS NOT NULL;
CREATE TRIGGER audience_preference_set_updated_at BEFORE UPDATE ON platform.audience_preference FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.audience_preference', 'platform_only');
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.audience_preference TO gp_platform;

-- Sponsored campaigns -------------------------------------------------------------------------------------------------
CREATE TABLE platform.sponsored_campaign (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  name                  text NOT NULL,
  listing_ids           uuid[] NOT NULL,
  segment               jsonb NOT NULL DEFAULT '{}',
  max_recipients        integer NOT NULL,
  price_plan_version_id uuid,
  price_per_recipient   numeric(14,4),
  vat_rate              numeric(5,4),
  minimum_recipients    integer,
  scheduled_at          timestamptz(6),
  state                 platform.sponsored_campaign_state NOT NULL DEFAULT 'draft',
  estimated             integer,
  delivered             integer NOT NULL DEFAULT 0,
  clicks                integer NOT NULL DEFAULT 0,
  platform_invoice_id   uuid,
  sending_started_at    timestamptz(6),
  completed_at          timestamptz(6),
  cancelled_at          timestamptz(6),
  rejected_at           timestamptz(6),
  reject_reason         text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT sponsored_campaign_pkey PRIMARY KEY (id),
  CONSTRAINT sponsored_campaign_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_price_plan_version_id_fkey FOREIGN KEY (price_plan_version_id) REFERENCES platform.price_plan_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_platform_invoice_id_fkey FOREIGN KEY (platform_invoice_id) REFERENCES platform.platform_invoice (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_name_check CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT sponsored_campaign_listings_check CHECK (cardinality(listing_ids) BETWEEN 1 AND 10),
  CONSTRAINT sponsored_campaign_max_recipients_check CHECK (max_recipients BETWEEN 1 AND 1000000),
  CONSTRAINT sponsored_campaign_price_check CHECK (price_per_recipient IS NULL OR price_per_recipient >= 0),
  CONSTRAINT sponsored_campaign_counters_check CHECK (delivered >= 0 AND clicks >= 0 AND (estimated IS NULL OR estimated >= 0) AND delivered <= max_recipients),
  CONSTRAINT sponsored_campaign_priced_check CHECK (state IN ('draft', 'cancelled', 'rejected') OR (price_plan_version_id IS NOT NULL AND price_per_recipient IS NOT NULL AND vat_rate IS NOT NULL AND minimum_recipients IS NOT NULL AND scheduled_at IS NOT NULL)),
  CONSTRAINT sponsored_campaign_sent_check CHECK ((state = 'sent') = (completed_at IS NOT NULL)),
  CONSTRAINT sponsored_campaign_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT sponsored_campaign_rejected_check CHECK ((state = 'rejected') = (rejected_at IS NOT NULL AND reject_reason IS NOT NULL)),
  CONSTRAINT sponsored_campaign_reason_check CHECK (reject_reason IS NULL OR length(reject_reason) BETWEEN 1 AND 500)
);
COMMENT ON TABLE platform.sponsored_campaign IS 'D-287 / D-300 (G6): a buyer tenant''s sponsored broadcast of its own published listings through getproperty''s LINE OA to a consented segment; aggregates only; billed per delivered recipient (purchase platform invoice); gate broadcast.sponsored.enabled (O-023).';
CREATE INDEX sponsored_campaign_tenant_id_state_idx ON platform.sponsored_campaign (tenant_id, state, created_at DESC);
CREATE INDEX sponsored_campaign_state_idx ON platform.sponsored_campaign (state, scheduled_at);
CREATE INDEX sponsored_campaign_price_plan_version_id_idx ON platform.sponsored_campaign (price_plan_version_id);
CREATE INDEX sponsored_campaign_platform_invoice_id_idx ON platform.sponsored_campaign (platform_invoice_id);
CREATE TRIGGER sponsored_campaign_set_updated_at BEFORE UPDATE ON platform.sponsored_campaign FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.sponsored_campaign', 'tenant');
GRANT SELECT ON platform.sponsored_campaign TO gp_app;
GRANT SELECT, INSERT, UPDATE ON platform.sponsored_campaign TO gp_platform;
GRANT SELECT ON platform.sponsored_campaign TO gp_reporting;

-- Deliveries (platform-only) ------------------------------------------------------------------------------------------
CREATE TABLE platform.sponsored_delivery (
  id            uuid NOT NULL DEFAULT uuidv7(),
  campaign_id   uuid NOT NULL,
  user_id       uuid NOT NULL,
  state         platform.sponsored_delivery_state NOT NULL DEFAULT 'pending',
  batch_id      uuid NOT NULL,
  language      char(2) NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0,
  sent_at       timestamptz(6),
  failed_reason text,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT sponsored_delivery_pkey PRIMARY KEY (id),
  CONSTRAINT sponsored_delivery_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES platform.sponsored_campaign (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_delivery_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT sponsored_delivery_sent_check CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT sponsored_delivery_reason_check CHECK (failed_reason IS NULL OR length(failed_reason) <= 500)
);
COMMENT ON TABLE platform.sponsored_delivery IS 'D-287 / D-300 (G6): one row per campaign × person (frequency cap, the person''s history, DSR); platform-only — never visible to the buyer; deleted after broadcast.sponsored.delivery_keep_months.';
CREATE UNIQUE INDEX sponsored_delivery_campaign_id_user_id_key ON platform.sponsored_delivery (campaign_id, user_id);
CREATE INDEX sponsored_delivery_user_id_created_at_idx ON platform.sponsored_delivery (user_id, created_at DESC);
CREATE INDEX sponsored_delivery_batch_id_idx ON platform.sponsored_delivery (batch_id) WHERE state = 'pending';
CREATE TRIGGER sponsored_delivery_set_updated_at BEFORE UPDATE ON platform.sponsored_delivery FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.sponsored_delivery', 'platform_only');
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.sponsored_delivery TO gp_platform;

-- Campaign links ------------------------------------------------------------------------------------------------------
CREATE TABLE platform.sponsored_campaign_link (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  campaign_id     uuid NOT NULL,
  listing_id      uuid NOT NULL,
  code            text NOT NULL,
  clicks          integer NOT NULL DEFAULT 0,
  last_clicked_at timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT sponsored_campaign_link_pkey PRIMARY KEY (id),
  CONSTRAINT sponsored_campaign_link_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_link_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES platform.sponsored_campaign (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_link_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT sponsored_campaign_link_code_check CHECK (code ~ '^[a-z0-9]{8}$'),
  CONSTRAINT sponsored_campaign_link_clicks_check CHECK (clicks >= 0)
);
COMMENT ON TABLE platform.sponsored_campaign_link IS 'D-300 (G6): the short link of one listing in one sponsored campaign (<web>/s/<code>, D-268 page); clicks counted per campaign, never per person.';
CREATE UNIQUE INDEX sponsored_campaign_link_code_key ON platform.sponsored_campaign_link (code);
CREATE UNIQUE INDEX sponsored_campaign_link_campaign_id_listing_id_key ON platform.sponsored_campaign_link (campaign_id, listing_id);
CREATE INDEX sponsored_campaign_link_tenant_id_idx ON platform.sponsored_campaign_link (tenant_id);
CREATE INDEX sponsored_campaign_link_listing_id_idx ON platform.sponsored_campaign_link (listing_id);
SELECT platform.apply_rls('platform.sponsored_campaign_link', 'tenant');
GRANT SELECT ON platform.sponsored_campaign_link TO gp_app;
GRANT SELECT, INSERT, UPDATE ON platform.sponsored_campaign_link TO gp_platform;
GRANT SELECT ON platform.sponsored_campaign_link TO gp_reporting;
