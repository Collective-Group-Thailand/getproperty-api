-- getproperty-api 0053 — share kit (B7 deliverable 7.9 part 2, D-268): one short link per listing and channel (UTM on
-- the way to the listing, clicks counted), the square photo cards (th / en) kept on the listing, and the channel an
-- enquiry came from. schema-design §7.5 rows 134–136.

CREATE TYPE ops.listing_channel AS ENUM ('line', 'facebook_group', 'facebook_marketplace', 'qr', 'link');

CREATE TABLE ops.listing_share_link (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  listing_id       uuid NOT NULL,
  channel          ops.listing_channel NOT NULL,
  code             text NOT NULL,
  clicks           integer NOT NULL DEFAULT 0,
  last_clicked_at  timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT listing_share_link_pkey PRIMARY KEY (id),
  CONSTRAINT listing_share_link_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_share_link_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_share_link_code_key UNIQUE (code),
  CONSTRAINT listing_share_link_listing_id_channel_key UNIQUE (listing_id, channel),
  CONSTRAINT listing_share_link_code_check CHECK (code ~ '^[a-z0-9]{8}$'),
  CONSTRAINT listing_share_link_clicks_check CHECK (clicks >= 0)
);
COMMENT ON TABLE ops.listing_share_link IS 'D-268: the short link of a listing for one channel (`<web>/s/<code>` → the listing with utm_source = channel); clicks counted when opened. One per listing and channel.';
CREATE INDEX listing_share_link_tenant_id_idx ON ops.listing_share_link (tenant_id);

ALTER TABLE ops.listing
  ADD COLUMN share_card_th_document_id uuid,
  ADD COLUMN share_card_en_document_id uuid,
  ADD COLUMN share_card_hash text,
  ADD CONSTRAINT listing_share_card_th_document_id_fkey FOREIGN KEY (share_card_th_document_id) REFERENCES core.document (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT listing_share_card_en_document_id_fkey FOREIGN KEY (share_card_en_document_id) REFERENCES core.document (id) ON DELETE SET NULL ON UPDATE NO ACTION;
COMMENT ON COLUMN ops.listing.share_card_hash IS 'D-268: sha256 of what the share cards show (photo, texts, rent, link); the cards are rendered again only when it changes.';
CREATE INDEX listing_share_card_th_document_id_idx ON ops.listing (share_card_th_document_id);
CREATE INDEX listing_share_card_en_document_id_idx ON ops.listing (share_card_en_document_id);

ALTER TABLE ops.listing_lead ADD COLUMN channel ops.listing_channel;
COMMENT ON COLUMN ops.listing_lead.channel IS 'D-268: the share-kit channel the prospect came from (utm_source of the short link), if any.';

SELECT platform.apply_rls('ops.listing_share_link', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.listing_share_link TO gp_app, gp_platform;
GRANT SELECT ON ops.listing_share_link TO gp_reporting;
