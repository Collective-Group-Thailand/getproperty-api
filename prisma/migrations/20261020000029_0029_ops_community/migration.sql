-- getproperty-api 0029 — B5.3 community (D-073, D-025, D-152): announcements with translations and read receipts,
-- parcels (photo, pick-up PIN), facilities and bookings (no double booking: exclusion constraint), building rules
-- (versions, acknowledgements — at lease signing too), contacts.
-- Deviations (schema-design §7.5 rows 84–88): announcement + title, version, archived_at; read + user_id; parcel +
-- carrier, tracking_no, pickup_pin_enc, notified_at, returned_at / return_reason, picked_up_by_party_id,
-- handed_over_by; facility_booking + decided_by / decided_at, cancel_reason, note; building_rule + title,
-- published_at; rule ack + user_id; contact + sort_order.

CREATE TYPE ops.parcel_status AS ENUM ('received', 'notified', 'picked_up', 'returned');
CREATE TYPE ops.pickup_confirmation AS ENUM ('resident_pin', 'staff');
CREATE TYPE ops.facility_kind AS ENUM ('meeting_room', 'fitness', 'pool', 'bbq', 'parking_visitor', 'other');
CREATE TYPE ops.booking_status AS ENUM ('requested', 'confirmed', 'cancelled', 'no_show');
CREATE TYPE ops.contact_kind AS ENUM ('emergency', 'building', 'vendor', 'utility');

-- ---------------------------------------------------------------------------------------------- announcements
CREATE TABLE ops.announcement (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid,
  title            text NOT NULL,
  body_th          text NOT NULL,
  translations     jsonb NOT NULL DEFAULT '{}',
  audience_filter  jsonb NOT NULL DEFAULT '{}',
  pinned           boolean NOT NULL DEFAULT false,
  published_at     timestamptz(6),
  expires_at       timestamptz(6),
  archived_at      timestamptz(6),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT announcement_pkey PRIMARY KEY (id),
  CONSTRAINT announcement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT announcement_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT announcement_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT announcement_body_check CHECK (length(body_th) BETWEEN 1 AND 10000),
  CONSTRAINT announcement_expiry_check CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at)
);
COMMENT ON TABLE ops.announcement IS 'Announcements of a building or the whole tenant (D-073): Thai body + translations {lang: {title, body}}, audience filter {floorIds, unitIds}, pinned; LINE push on publish (quiet hours); read receipts per party.';
CREATE INDEX announcement_tenant_id_building_id_published_at_idx ON ops.announcement (tenant_id, building_id, published_at);
CREATE INDEX announcement_building_id_idx ON ops.announcement (building_id);
CREATE TRIGGER announcement_set_updated_at BEFORE UPDATE ON ops.announcement FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.announcement_read (
  announcement_id  uuid NOT NULL,
  party_id         uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  user_id          uuid,
  read_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT announcement_read_pkey PRIMARY KEY (announcement_id, party_id),
  CONSTRAINT announcement_read_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES ops.announcement (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT announcement_read_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT announcement_read_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.announcement_read IS 'Read receipts (D-073): one per announcement × party, the first read only.';
CREATE INDEX announcement_read_party_id_idx ON ops.announcement_read (party_id);
CREATE INDEX announcement_read_tenant_id_idx ON ops.announcement_read (tenant_id);

-- --------------------------------------------------------------------------------------------------- parcels
CREATE TABLE ops.parcel (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  building_id            uuid NOT NULL,
  unit_id                uuid NOT NULL,
  recipient_party_id     uuid,
  carrier                text,
  tracking_no            text,
  photo_document_id      uuid NOT NULL,
  received_by            uuid,
  received_at            timestamptz(6) NOT NULL,
  status                 ops.parcel_status NOT NULL DEFAULT 'received',
  notified_at            timestamptz(6),
  pickup_pin_enc         bytea NOT NULL,
  picked_up_at           timestamptz(6),
  pickup_confirmed_by    ops.pickup_confirmation,
  picked_up_by_party_id  uuid,
  handed_over_by         uuid,
  returned_at            timestamptz(6),
  return_reason          text,
  notes                  text,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT parcel_pkey PRIMARY KEY (id),
  CONSTRAINT parcel_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_recipient_party_id_fkey FOREIGN KEY (recipient_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_photo_document_id_fkey FOREIGN KEY (photo_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_picked_up_by_party_id_fkey FOREIGN KEY (picked_up_by_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT parcel_picked_up_check CHECK ((status = 'picked_up') = (picked_up_at IS NOT NULL AND pickup_confirmed_by IS NOT NULL)),
  CONSTRAINT parcel_returned_check CHECK ((status = 'returned') = (returned_at IS NOT NULL))
);
COMMENT ON TABLE ops.parcel IS 'Parcels received for a unit (D-073): staff photograph them, the resident is told on LINE and picks up with a PIN (encrypted with the tenant key) or staff confirm the hand-over.';
CREATE INDEX parcel_tenant_id_building_id_status_idx ON ops.parcel (tenant_id, building_id, status);
CREATE INDEX parcel_building_id_idx ON ops.parcel (building_id);
CREATE INDEX parcel_unit_id_status_idx ON ops.parcel (unit_id, status);
CREATE INDEX parcel_recipient_party_id_idx ON ops.parcel (recipient_party_id);
CREATE TRIGGER parcel_set_updated_at BEFORE UPDATE ON ops.parcel FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------- facilities & bookings
CREATE TABLE ops.facility (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  name             text NOT NULL,
  kind             ops.facility_kind NOT NULL,
  capacity         integer,
  rules            jsonb NOT NULL DEFAULT '{}',
  booking_policy   jsonb NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  deleted_at       timestamptz(6),
  deleted_by       uuid,
  CONSTRAINT facility_pkey PRIMARY KEY (id),
  CONSTRAINT facility_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_name_check CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT facility_capacity_check CHECK (capacity IS NULL OR capacity > 0)
);
COMMENT ON TABLE ops.facility IS 'A common facility of a building (blueprint A1.6): booking_policy {slotMinutes, openFrom, openTo, maxAdvanceDays, maxPerUnitPerWeek, requiresApproval}.';
CREATE INDEX facility_tenant_id_building_id_idx ON ops.facility (tenant_id, building_id);
CREATE INDEX facility_building_id_idx ON ops.facility (building_id);
CREATE TRIGGER facility_set_updated_at BEFORE UPDATE ON ops.facility FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.facility_booking (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  building_id    uuid NOT NULL,
  facility_id    uuid NOT NULL,
  unit_id        uuid NOT NULL,
  party_id       uuid,
  starts_at      timestamptz(6) NOT NULL,
  ends_at        timestamptz(6) NOT NULL,
  status         ops.booking_status NOT NULL DEFAULT 'requested',
  decided_by     uuid,
  decided_at     timestamptz(6),
  cancel_reason  text,
  note           text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT facility_booking_pkey PRIMARY KEY (id),
  CONSTRAINT facility_booking_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_booking_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_booking_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES ops.facility (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_booking_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_booking_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT facility_booking_window_check CHECK (ends_at > starts_at),
  CONSTRAINT facility_booking_no_overlap EXCLUDE USING gist (
    facility_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('requested', 'confirmed'))
);
COMMENT ON TABLE ops.facility_booking IS 'A booking of a facility by a unit (blueprint A1.6): requested (approval) or confirmed; two live bookings of one facility never overlap (exclusion constraint); quota per unit checked in code.';
CREATE INDEX facility_booking_tenant_id_building_id_idx ON ops.facility_booking (tenant_id, building_id);
CREATE INDEX facility_booking_building_id_idx ON ops.facility_booking (building_id);
CREATE INDEX facility_booking_facility_id_starts_at_idx ON ops.facility_booking (facility_id, starts_at);
CREATE INDEX facility_booking_unit_id_starts_at_idx ON ops.facility_booking (unit_id, starts_at);
CREATE INDEX facility_booking_party_id_idx ON ops.facility_booking (party_id);
CREATE TRIGGER facility_booking_set_updated_at BEFORE UPDATE ON ops.facility_booking FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- --------------------------------------------------------------------------------------------- building rules
CREATE TABLE ops.building_rule (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  version          integer NOT NULL,
  title            text NOT NULL,
  body_th          text NOT NULL,
  translations     jsonb NOT NULL DEFAULT '{}',
  effective_from   date NOT NULL,
  published_at     timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT building_rule_pkey PRIMARY KEY (id),
  CONSTRAINT building_rule_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_rule_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_rule_version_check CHECK (version > 0),
  CONSTRAINT building_rule_body_check CHECK (length(body_th) BETWEEN 1 AND 50000)
);
COMMENT ON TABLE ops.building_rule IS 'Versioned rules of a building (D-073): a new version is a new row; residents acknowledge the version in force (at lease signing, B2.3, or in the app).';
CREATE UNIQUE INDEX building_rule_building_id_version_key ON ops.building_rule (building_id, version);
CREATE INDEX building_rule_tenant_id_building_id_idx ON ops.building_rule (tenant_id, building_id);
CREATE TRIGGER building_rule_set_updated_at BEFORE UPDATE ON ops.building_rule FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.building_rule_ack (
  rule_id     uuid NOT NULL,
  party_id    uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  lease_id    uuid,
  user_id     uuid,
  acked_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT building_rule_ack_pkey PRIMARY KEY (rule_id, party_id),
  CONSTRAINT building_rule_ack_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES ops.building_rule (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_rule_ack_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_rule_ack_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_rule_ack_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.building_rule_ack IS 'Acknowledgement of a rule version by a party (append-only), with the lease it was given for.';
CREATE INDEX building_rule_ack_party_id_idx ON ops.building_rule_ack (party_id);
CREATE INDEX building_rule_ack_lease_id_idx ON ops.building_rule_ack (lease_id);
CREATE INDEX building_rule_ack_tenant_id_idx ON ops.building_rule_ack (tenant_id);

-- -------------------------------------------------------------------------------------------------- contacts
CREATE TABLE ops.contact (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  building_id  uuid,
  kind         ops.contact_kind NOT NULL,
  name         text NOT NULL,
  phone        text,
  line_id      text,
  party_id     uuid,
  notes        text,
  sort_order   smallint NOT NULL DEFAULT 0,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  deleted_at   timestamptz(6),
  deleted_by   uuid,
  CONSTRAINT contact_pkey PRIMARY KEY (id),
  CONSTRAINT contact_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contact_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contact_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT contact_name_check CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT contact_reach_check CHECK (phone IS NOT NULL OR line_id IS NOT NULL OR party_id IS NOT NULL)
);
COMMENT ON TABLE ops.contact IS 'Emergency, building, vendor and utility contacts of a building or the tenant (D-073), shown to residents.';
CREATE INDEX contact_tenant_id_building_id_idx ON ops.contact (tenant_id, building_id);
CREATE INDEX contact_building_id_idx ON ops.contact (building_id);
CREATE TRIGGER contact_set_updated_at BEFORE UPDATE ON ops.contact FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('ops.announcement', 'building', 'ops.community');
SELECT platform.apply_rls('ops.parcel', 'unit', 'ops.community');
SELECT platform.apply_rls('ops.facility', 'building', 'ops.community');
SELECT platform.apply_rls('ops.facility_booking', 'unit', 'ops.community');
SELECT platform.apply_rls('ops.building_rule', 'building', 'ops.community');
SELECT platform.apply_rls('ops.contact', 'building', 'ops.community');
-- child rows: with their announcement / rule
SELECT platform.apply_rls('ops.announcement_read', 'platform_only');
CREATE POLICY announcement_read_rls_read ON ops.announcement_read FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.announcement a WHERE a.id = announcement_id));
CREATE POLICY announcement_read_rls_write ON ops.announcement_read FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id())
              AND EXISTS (SELECT 1 FROM ops.announcement a WHERE a.id = announcement_id AND a.tenant_id = announcement_read.tenant_id));
SELECT platform.apply_rls('ops.building_rule_ack', 'platform_only');
CREATE POLICY building_rule_ack_rls_read ON ops.building_rule_ack FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.building_rule r WHERE r.id = rule_id));
CREATE POLICY building_rule_ack_rls_write ON ops.building_rule_ack FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id())
              AND EXISTS (SELECT 1 FROM ops.building_rule r WHERE r.id = rule_id AND r.tenant_id = building_rule_ack.tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.announcement, ops.announcement_read, ops.parcel, ops.facility,
  ops.facility_booking, ops.building_rule, ops.building_rule_ack, ops.contact TO gp_app, gp_platform;
GRANT SELECT ON ops.announcement, ops.announcement_read, ops.parcel, ops.facility, ops.facility_booking,
  ops.building_rule, ops.building_rule_ack, ops.contact TO gp_reporting;
