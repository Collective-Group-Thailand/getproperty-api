-- getproperty-api 0042 — B7.2 listings, owner verification, moderation (D-252); the public read of B7.3.
-- schema-design §7.5 rows 107–111. A listing carries a snapshot of its unit's searchable facts (kind, size, rooms,
-- province, district, full address — D-252: nothing hidden but the unit number, which the owner may show) so that
-- the anonymous search reads one table. Photos are core.document rows of kind listing_photo (EXIF stripped and
-- three WebP renditions made by the scan job). Verification evidence is a certificate document; reports are
-- platform-only (the owner sees the count, never the reporter).

CREATE TYPE ops.listing_state AS ENUM ('draft', 'pending_review', 'published', 'paused', 'closed', 'rejected');
CREATE TYPE ops.listing_close_reason AS ENUM ('leased', 'withdrawn', 'hidden');
CREATE TYPE platform.listing_verification_state AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE platform.ownership_evidence AS ENUM ('title_deed', 'condo_title', 'sale_contract');
CREATE TYPE platform.listing_report_reason AS ENUM ('scam', 'wrong_info', 'not_available', 'duplicate', 'offensive', 'other');
CREATE TYPE platform.listing_report_state AS ENUM ('open', 'upheld', 'dismissed');

-- ----------------------------------------------------------------------------------------------------- listing
CREATE TABLE ops.listing (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  unit_id             uuid NOT NULL,
  building_id         uuid NOT NULL,
  state               ops.listing_state NOT NULL DEFAULT 'draft',
  slug                text NOT NULL,
  title_th            text NOT NULL,
  title_en            text,
  description_th      text NOT NULL DEFAULT '',
  description_en      text,
  rent                numeric(14,2) NOT NULL,
  deposit_months      smallint NOT NULL DEFAULT 2,
  advance_months      smallint NOT NULL DEFAULT 1,
  min_term_months     smallint NOT NULL DEFAULT 12,
  available_from      date,
  furnishing          ops.furnishing,
  pets_allowed        boolean NOT NULL DEFAULT false,
  smoking_allowed     boolean NOT NULL DEFAULT false,
  facilities          text[] NOT NULL DEFAULT '{}',
  show_unit_no        boolean NOT NULL DEFAULT false,
  transit_name        text,
  transit_line        text,
  transit_distance_m  integer,
  -- snapshot of the unit (refreshed on every save and on submit)
  unit_kind           ops.portfolio_unit_kind,
  size_sqm            numeric(8,2),
  bedrooms            smallint,
  bathrooms           smallint,
  floor_label         text,
  province            text,
  district            text,
  address_text        text,
  lat                 numeric(9,6),
  lng                 numeric(9,6),
  -- review and moderation
  review_reasons      text[] NOT NULL DEFAULT '{}',
  rejected_reason     text,
  reviewed_by         uuid,
  reviewed_at         timestamptz(6),
  hidden_at           timestamptz(6),
  hidden_reason       text,
  report_count        integer NOT NULL DEFAULT 0,
  published_at        timestamptz(6),
  paused_at           timestamptz(6),
  closed_at           timestamptz(6),
  closed_reason       ops.listing_close_reason,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT listing_pkey PRIMARY KEY (id),
  CONSTRAINT listing_slug_key UNIQUE (slug),
  CONSTRAINT listing_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT listing_title_th_check CHECK (length(title_th) BETWEEN 1 AND 120),
  CONSTRAINT listing_title_en_check CHECK (title_en IS NULL OR length(title_en) BETWEEN 1 AND 120),
  CONSTRAINT listing_description_check CHECK (length(description_th) <= 5000 AND (description_en IS NULL OR length(description_en) <= 5000)),
  CONSTRAINT listing_rent_check CHECK (rent > 0),
  CONSTRAINT listing_months_check CHECK (deposit_months BETWEEN 0 AND 12 AND advance_months BETWEEN 0 AND 12 AND min_term_months BETWEEN 1 AND 120),
  CONSTRAINT listing_transit_check CHECK (transit_distance_m IS NULL OR transit_distance_m BETWEEN 0 AND 50000),
  CONSTRAINT listing_facilities_check CHECK (cardinality(facilities) <= 40),
  CONSTRAINT listing_published_check CHECK (state NOT IN ('published', 'paused') OR published_at IS NOT NULL),
  CONSTRAINT listing_closed_check CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL)),
  CONSTRAINT listing_rejected_check CHECK (state <> 'rejected' OR rejected_reason IS NOT NULL)
);
COMMENT ON TABLE ops.listing IS 'A rental listing of a unit (D-252): terms, description th/en, facilities, nearest transit, and a snapshot of the unit''s searchable facts; state draft → pending_review | published → paused → closed, rejected by moderation. Hidden (report threshold or moderator) = hidden_at set: not public until restored.';
-- one live listing per unit (a unit has one tenant, so (unit, tenant) = unit): a second submit answers listing.duplicate_unit
CREATE UNIQUE INDEX listing_unit_id_live_key ON ops.listing (unit_id, tenant_id) WHERE state IN ('pending_review', 'published', 'paused');
CREATE INDEX listing_tenant_id_state_idx ON ops.listing (tenant_id, state);
CREATE INDEX listing_public_search_idx ON ops.listing (province, district, rent) WHERE state = 'published' AND hidden_at IS NULL;
CREATE INDEX listing_public_published_at_idx ON ops.listing (published_at DESC) WHERE state = 'published' AND hidden_at IS NULL;
CREATE INDEX listing_building_id_idx ON ops.listing (building_id);
CREATE TRIGGER listing_set_updated_at BEFORE UPDATE ON ops.listing FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.listing_photo (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  listing_id   uuid NOT NULL,
  document_id  uuid NOT NULL,
  sort_order   smallint NOT NULL,
  caption      text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT listing_photo_pkey PRIMARY KEY (id),
  CONSTRAINT listing_photo_listing_id_document_id_key UNIQUE (listing_id, document_id),
  CONSTRAINT listing_photo_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_photo_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT listing_photo_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_photo_caption_check CHECK (caption IS NULL OR length(caption) <= 200),
  CONSTRAINT listing_photo_sort_order_check CHECK (sort_order BETWEEN 0 AND 99)
);
COMMENT ON TABLE ops.listing_photo IS 'Photos of a listing in order (D-252: ≥ listing.photos.min, ≤ listing.photos.max); the first is the cover. The document''s renditions (w480/w960/w1600 WebP) are made by the scan job with EXIF and location removed.';
CREATE INDEX listing_photo_listing_id_sort_order_idx ON ops.listing_photo (listing_id, sort_order);
CREATE INDEX listing_photo_document_id_idx ON ops.listing_photo (document_id);
CREATE INDEX listing_photo_tenant_id_idx ON ops.listing_photo (tenant_id);

CREATE TABLE ops.listing_availability (
  listing_id   uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  weekly       jsonb NOT NULL DEFAULT '[]',
  exceptions   jsonb NOT NULL DEFAULT '[]',
  slot_minutes smallint NOT NULL DEFAULT 30,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT listing_availability_pkey PRIMARY KEY (listing_id),
  CONSTRAINT listing_availability_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT listing_availability_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_availability_weekly_check CHECK (jsonb_typeof(weekly) = 'array' AND jsonb_array_length(weekly) <= 50),
  CONSTRAINT listing_availability_exceptions_check CHECK (jsonb_typeof(exceptions) = 'array' AND jsonb_array_length(exceptions) <= 100),
  CONSTRAINT listing_availability_slot_minutes_check CHECK (slot_minutes IN (15, 20, 30, 45, 60, 90, 120))
);
COMMENT ON TABLE ops.listing_availability IS 'When the owner can show the unit (D-252, viewings in B7.3): weekly [{weekday 0–6 (Sunday 0), from "HH:MM", to "HH:MM"}] in Asia/Bangkok, exceptions [{date, closed: true} | {date, from, to}].';
CREATE INDEX listing_availability_tenant_id_idx ON ops.listing_availability (tenant_id);
CREATE TRIGGER listing_availability_set_updated_at BEFORE UPDATE ON ops.listing_availability FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------ verification
CREATE TABLE platform.listing_verification (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  unit_id               uuid NOT NULL,
  state                 platform.listing_verification_state NOT NULL DEFAULT 'pending',
  evidence_kind         platform.ownership_evidence NOT NULL,
  evidence_document_ids uuid[] NOT NULL,
  note                  text,
  submitted_by          uuid,
  submitted_at          timestamptz(6) NOT NULL DEFAULT now(),
  reviewed_by           uuid,
  checked_by            uuid,
  decided_at            timestamptz(6),
  decision_note         text,
  evidence_purge_after  timestamptz(6),
  evidence_purged_at    timestamptz(6),
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT listing_verification_pkey PRIMARY KEY (id),
  CONSTRAINT listing_verification_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_verification_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_verification_evidence_check CHECK (cardinality(evidence_document_ids) BETWEEN 1 AND 5),
  CONSTRAINT listing_verification_decided_check CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT listing_verification_rejected_check CHECK (state <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT listing_verification_note_check CHECK (note IS NULL OR length(note) <= 1000)
);
COMMENT ON TABLE platform.listing_verification IS 'Owner verification of a unit (D-252, badge "เจ้าของตัวจริง"): title deed, condo title or sale-purchase contract as certificate documents, decided by platform Support (a second reviewer when listing.verification.maker_checker). Evidence files are deleted listing.verification.evidence_retention_days after the decision (O-018, conservative default).';
CREATE UNIQUE INDEX listing_verification_unit_id_open_key ON platform.listing_verification (unit_id, tenant_id) WHERE state = 'pending';
CREATE INDEX listing_verification_tenant_id_unit_id_idx ON platform.listing_verification (tenant_id, unit_id);
CREATE INDEX listing_verification_state_submitted_at_idx ON platform.listing_verification (state, submitted_at);
CREATE TRIGGER listing_verification_set_updated_at BEFORE UPDATE ON platform.listing_verification FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE platform.listing_report (
  id                uuid NOT NULL DEFAULT uuidv7(),
  listing_id        uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  reason            platform.listing_report_reason NOT NULL,
  details           text,
  reporter_user_id  uuid,
  reporter_hash     bytea NOT NULL,
  state             platform.listing_report_state NOT NULL DEFAULT 'open',
  decided_by        uuid,
  decided_at        timestamptz(6),
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT listing_report_pkey PRIMARY KEY (id),
  CONSTRAINT listing_report_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT listing_report_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_report_details_check CHECK (details IS NULL OR length(details) <= 1000),
  CONSTRAINT listing_report_decided_check CHECK ((state = 'open') = (decided_at IS NULL))
);
COMMENT ON TABLE platform.listing_report IS 'Viewers'' reports of a listing (D-252: scam, wrong information, …). reporter_hash = HMAC of the user or the client address: one open report per reporter and listing; after listing.report.hide_after open reports the listing is hidden pending review. Platform-only: the owner sees the count, never who reported.';
CREATE UNIQUE INDEX listing_report_listing_id_reporter_hash_open_key ON platform.listing_report (listing_id, reporter_hash) WHERE state = 'open';
CREATE INDEX listing_report_state_created_at_idx ON platform.listing_report (state, created_at);
CREATE INDEX listing_report_tenant_id_idx ON platform.listing_report (tenant_id);

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('ops.listing', 'tenant');
SELECT platform.apply_rls('ops.listing_photo', 'tenant');
SELECT platform.apply_rls('ops.listing_availability', 'tenant');
SELECT platform.apply_rls('platform.listing_verification', 'tenant');
SELECT platform.apply_rls('platform.listing_report', 'platform_only');

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.listing, ops.listing_photo, ops.listing_availability TO gp_app, gp_platform;
GRANT SELECT, INSERT, UPDATE ON platform.listing_verification TO gp_app, gp_platform;
GRANT SELECT, INSERT, UPDATE ON platform.listing_report TO gp_platform;
GRANT SELECT ON ops.listing, ops.listing_photo, ops.listing_availability, platform.listing_verification,
  platform.listing_report TO gp_reporting;
