-- getproperty-api 0062 — distribution (pack G step G4, modules E2 / E7; D-288, D-296). schema-design §7.5 rows 170–175.
--   * ops.listing_channel + facebook_page: the short link of a Facebook Page post (clicks / enquiries per channel, D-268).
--   * platform.social_channel: a tenant's own Facebook Page, its Page access token sealed with the tenant data key
--     (AAD tenant / table / token / row id — the D-240 / D-254 pattern); never returned, logged or put in events.
--   * ops.listing_social_post: one row per listing × Page — what getproperty posted there and what it still has to do
--     (publish on publish, update on a price change, delete when the unit is let or the listing stops being public).
--   * ops.listing.og_image_document_id / og_image_hash: the 1200 × 630 Open Graph card of the public page.
-- Groups are never automated (D-288; the Groups API is gone since Graph API v19) — the B7.9 share kit stays for them.
-- New enum values are not used in this transaction (ALTER TYPE … ADD VALUE).

ALTER TYPE ops.listing_channel ADD VALUE IF NOT EXISTS 'facebook_page';

CREATE TYPE platform.social_provider AS ENUM ('facebook_page');
CREATE TYPE platform.social_channel_state AS ENUM ('verified', 'failing', 'revoked');
CREATE TYPE ops.social_post_state AS ENUM ('queued', 'posted', 'failed', 'deleted');
CREATE TYPE ops.social_post_action AS ENUM ('publish', 'update', 'delete');

-- A tenant's own Facebook Page -----------------------------------------------------------------------------------------
CREATE TABLE platform.social_channel (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  provider         platform.social_provider NOT NULL DEFAULT 'facebook_page',
  page_id          text NOT NULL,
  page_name        text,
  token_enc        bytea NOT NULL,
  state            platform.social_channel_state NOT NULL DEFAULT 'verified',
  auto_post        boolean NOT NULL DEFAULT true,
  verified_at      timestamptz(6),
  last_checked_at  timestamptz(6),
  last_error       text,
  revoked_at       timestamptz(6),
  revoked_by       uuid,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT social_channel_pkey PRIMARY KEY (id),
  CONSTRAINT social_channel_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT social_channel_page_id_check CHECK (page_id ~ '^[0-9]{5,30}$'),
  CONSTRAINT social_channel_page_name_check CHECK (page_name IS NULL OR length(page_name) <= 200),
  CONSTRAINT social_channel_last_error_check CHECK (last_error IS NULL OR length(last_error) <= 500),
  CONSTRAINT social_channel_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT social_channel_verified_check CHECK (state <> 'verified' OR verified_at IS NOT NULL)
);
COMMENT ON TABLE platform.social_channel IS 'D-288 / D-296: a tenant''s own Facebook Page; the Page access token sealed with the tenant data key (D-148 / D-240). One live Page per tenant and provider.';
CREATE UNIQUE INDEX social_channel_tenant_provider_key ON platform.social_channel (tenant_id, provider) WHERE state <> 'revoked';
CREATE INDEX social_channel_tenant_id_state_idx ON platform.social_channel (tenant_id, state);
CREATE TRIGGER social_channel_set_updated_at BEFORE UPDATE ON platform.social_channel FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.social_channel', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.social_channel TO gp_app, gp_platform;

-- What getproperty posted on a Page for a listing ----------------------------------------------------------------------
CREATE TABLE ops.listing_social_post (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  listing_id        uuid NOT NULL,
  channel_id        uuid NOT NULL,
  state             ops.social_post_state NOT NULL DEFAULT 'queued',
  pending_action    ops.social_post_action,
  external_post_id  text,
  content_hash      text,
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz(6),
  last_error        text,
  posted_at         timestamptz(6),
  updated_on_page_at timestamptz(6),
  deleted_at        timestamptz(6),
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT listing_social_post_pkey PRIMARY KEY (id),
  CONSTRAINT listing_social_post_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_social_post_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_social_post_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES platform.social_channel (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_social_post_attempts_check CHECK (attempts >= 0),
  CONSTRAINT listing_social_post_last_error_check CHECK (last_error IS NULL OR length(last_error) <= 500),
  CONSTRAINT listing_social_post_external_post_id_check CHECK (external_post_id IS NULL OR external_post_id ~ '^[0-9_]{3,80}$'),
  CONSTRAINT listing_social_post_queued_check CHECK ((state = 'queued') = (pending_action IS NOT NULL)),
  CONSTRAINT listing_social_post_posted_check CHECK (state <> 'posted' OR (external_post_id IS NOT NULL AND posted_at IS NOT NULL))
);
COMMENT ON TABLE ops.listing_social_post IS 'D-288 / D-296: one row per listing × own Facebook Page — queued by listing events, carried out by the social-posts job (publish / update / delete).';
CREATE UNIQUE INDEX listing_social_post_listing_id_channel_id_key ON ops.listing_social_post (listing_id, channel_id);
CREATE INDEX listing_social_post_channel_id_idx ON ops.listing_social_post (channel_id);
CREATE INDEX listing_social_post_tenant_id_state_idx ON ops.listing_social_post (tenant_id, state);
CREATE INDEX listing_social_post_due_idx ON ops.listing_social_post (next_attempt_at) WHERE state = 'queued';
CREATE TRIGGER listing_social_post_set_updated_at BEFORE UPDATE ON ops.listing_social_post FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('ops.listing_social_post', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.listing_social_post TO gp_app, gp_platform;
GRANT SELECT ON ops.listing_social_post TO gp_reporting;

-- The Open Graph card of a public listing ------------------------------------------------------------------------------
ALTER TABLE ops.listing
  ADD COLUMN og_image_document_id uuid,
  ADD COLUMN og_image_hash text,
  ADD CONSTRAINT listing_og_image_document_id_fkey FOREIGN KEY (og_image_document_id) REFERENCES core.document (id) ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX listing_og_image_document_id_idx ON ops.listing (og_image_document_id);
COMMENT ON COLUMN ops.listing.og_image_document_id IS 'D-296: the 1200 × 630 Open Graph card of the public page (PNG document), re-rendered when og_image_hash changes.';
