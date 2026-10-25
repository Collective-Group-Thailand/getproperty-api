-- getproperty-api 0043 — B7.3 part 2: prospects, enquiries (leads), lead messages and viewings (D-252).
-- schema-design §7.5 rows 112–115. A prospect signs in to the `prospect` audience (LINE); an enquiry or a viewing
-- request creates a party in the OWNER's tenant (tenant-scoped copy, D-152, linked to the login `line_match`) and
-- one open lead per listing and prospect. Viewings book against the listing's availability; overlapping live
-- viewings of one listing are refused by the database (exclusion constraint → 409 listing.viewing_slot_taken).

ALTER TYPE platform.audience ADD VALUE IF NOT EXISTS 'prospect';
-- prospects are recipients of their own kind: consent purpose prospect.enquiry, LINE templates and routes
ALTER TYPE platform.notification_audience ADD VALUE IF NOT EXISTS 'prospect';

CREATE TYPE ops.listing_lead_state AS ENUM ('new', 'contacted', 'viewing_booked', 'viewed', 'applied', 'won', 'lost');
CREATE TYPE ops.listing_lead_lost_reason AS ENUM ('price', 'location', 'unit_unsuitable', 'chose_other', 'no_response', 'not_qualified', 'unit_leased', 'other');
CREATE TYPE ops.listing_lead_author AS ENUM ('prospect', 'owner');
CREATE TYPE ops.listing_viewing_state AS ENUM ('requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show');

-- -------------------------------------------------------------------------------------------------------- lead
CREATE TABLE ops.listing_lead (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  listing_id         uuid NOT NULL,
  party_id           uuid NOT NULL,
  user_id            uuid NOT NULL,
  state              ops.listing_lead_state NOT NULL DEFAULT 'new',
  move_in_date       date,
  term_months        smallint,
  occupants          smallint,
  nationality        char(2),
  notes              text,
  lost_reason        ops.listing_lead_lost_reason,
  lost_note          text,
  last_prospect_at   timestamptz(6) NOT NULL DEFAULT now(),
  last_owner_at      timestamptz(6),
  nudged_at          timestamptz(6),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT listing_lead_pkey PRIMARY KEY (id),
  CONSTRAINT listing_lead_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_term_check CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 120),
  CONSTRAINT listing_lead_occupants_check CHECK (occupants IS NULL OR occupants BETWEEN 1 AND 20),
  CONSTRAINT listing_lead_nationality_check CHECK (nationality IS NULL OR nationality ~ '^[A-Z]{2}$'),
  CONSTRAINT listing_lead_notes_check CHECK ((notes IS NULL OR length(notes) <= 2000) AND (lost_note IS NULL OR length(lost_note) <= 500)),
  CONSTRAINT listing_lead_lost_check CHECK ((state = 'lost') = (lost_reason IS NOT NULL))
);
COMMENT ON TABLE ops.listing_lead IS 'A prospect''s interest in a listing (D-252): what they asked (move-in, term, occupants, nationality optional), the owner''s private notes, state new → contacted → viewing_booked → viewed → applied → won | lost (with a reason). One open lead per listing and prospect; the party is the prospect''s copy in the owner''s tenant (D-152).';
CREATE UNIQUE INDEX listing_lead_listing_id_user_id_open_key ON ops.listing_lead (listing_id, user_id) WHERE state NOT IN ('won', 'lost');
CREATE INDEX listing_lead_tenant_id_state_idx ON ops.listing_lead (tenant_id, state, last_prospect_at DESC);
CREATE INDEX listing_lead_listing_id_idx ON ops.listing_lead (listing_id);
CREATE INDEX listing_lead_party_id_idx ON ops.listing_lead (party_id);
CREATE INDEX listing_lead_user_id_idx ON ops.listing_lead (user_id);
CREATE INDEX listing_lead_unanswered_idx ON ops.listing_lead (last_prospect_at) WHERE state = 'new' AND nudged_at IS NULL;
CREATE TRIGGER listing_lead_set_updated_at BEFORE UPDATE ON ops.listing_lead FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.listing_lead_message (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  lead_id         uuid NOT NULL,
  author          ops.listing_lead_author NOT NULL,
  author_user_id  uuid,
  body            text NOT NULL,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT listing_lead_message_pkey PRIMARY KEY (id),
  CONSTRAINT listing_lead_message_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_message_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ops.listing_lead (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_message_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_lead_message_body_check CHECK (length(body) BETWEEN 1 AND 2000)
);
COMMENT ON TABLE ops.listing_lead_message IS 'The conversation of a lead (D-252): the prospect writes in the app, the owner replies in the console and the reply reaches the prospect in LINE. Append-only.';
CREATE INDEX listing_lead_message_lead_id_created_at_idx ON ops.listing_lead_message (lead_id, created_at);
CREATE INDEX listing_lead_message_tenant_id_idx ON ops.listing_lead_message (tenant_id);
CREATE INDEX listing_lead_message_author_user_id_idx ON ops.listing_lead_message (author_user_id);

-- ----------------------------------------------------------------------------------------------------- viewing
CREATE TABLE ops.listing_viewing (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  listing_id      uuid NOT NULL,
  lead_id         uuid NOT NULL,
  starts_at       timestamptz(6) NOT NULL,
  ends_at         timestamptz(6) NOT NULL,
  state           ops.listing_viewing_state NOT NULL DEFAULT 'requested',
  note            text,
  decline_reason  text,
  cancelled_by    ops.listing_lead_author,
  rescheduled_to  uuid,
  decided_by      uuid,
  decided_at      timestamptz(6),
  reminded_at     timestamptz(6),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT listing_viewing_pkey PRIMARY KEY (id),
  CONSTRAINT listing_viewing_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_viewing_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT listing_viewing_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ops.listing_lead (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT listing_viewing_rescheduled_to_fkey FOREIGN KEY (rescheduled_to) REFERENCES ops.listing_viewing (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT listing_viewing_window_check CHECK (ends_at > starts_at),
  CONSTRAINT listing_viewing_text_check CHECK ((note IS NULL OR length(note) <= 500) AND (decline_reason IS NULL OR length(decline_reason) <= 500)),
  CONSTRAINT listing_viewing_cancelled_check CHECK ((state = 'cancelled') = (cancelled_by IS NOT NULL)),
  CONSTRAINT listing_viewing_no_overlap EXCLUDE USING gist (
    listing_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (state IN ('requested', 'confirmed'))
);
COMMENT ON TABLE ops.listing_viewing IS 'A viewing of a listing (D-252): a slot of the listing''s availability, requested by the prospect, confirmed or declined by the owner, cancelled or rescheduled (the old row points to the new one) by the prospect, completed (viewed / no show) by the owner. Live viewings of one listing never overlap (exclusion constraint). Reminders to both sides at listing.viewing.reminder_hours_before.';
CREATE INDEX listing_viewing_tenant_id_starts_at_idx ON ops.listing_viewing (tenant_id, starts_at);
CREATE INDEX listing_viewing_listing_id_starts_at_idx ON ops.listing_viewing (listing_id, starts_at);
CREATE INDEX listing_viewing_lead_id_idx ON ops.listing_viewing (lead_id);
CREATE INDEX listing_viewing_rescheduled_to_idx ON ops.listing_viewing (rescheduled_to);
CREATE INDEX listing_viewing_reminder_idx ON ops.listing_viewing (starts_at) WHERE state = 'confirmed' AND reminded_at IS NULL;
CREATE TRIGGER listing_viewing_set_updated_at BEFORE UPDATE ON ops.listing_viewing FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('ops.listing_lead', 'tenant');
SELECT platform.apply_rls('ops.listing_lead_message', 'tenant');
SELECT platform.apply_rls('ops.listing_viewing', 'tenant');

GRANT SELECT, INSERT, UPDATE ON ops.listing_lead, ops.listing_lead_message, ops.listing_viewing TO gp_app, gp_platform;
GRANT SELECT ON ops.listing_lead, ops.listing_lead_message, ops.listing_viewing TO gp_reporting;
