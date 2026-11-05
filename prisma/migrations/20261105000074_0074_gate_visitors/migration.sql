-- getproperty-api 0074 — gate & visitor (Phase J step J4.1, D-315, D-320, D-327). schema-design §7.5 rows 234–245
-- (§7.6 J4-a … J4-i).
--   * platform.audience + guard: gate tablets sign guards in with a PIN (`/v1/guard/*`).
--   * smart.gate per property, smart.gate_device (guard tablets enrolled with a one-time code, secret stored hashed),
--     smart.gate_guard (PIN hash, lockout) and smart.guard_shift (one open shift per guard).
--   * smart.visit (requested → approved | denied | timed_out → entered → exited, + cancelled) and its append-only
--     smart.visit_event (id = the domain event id, so the gate stream resumes from Last-Event-ID).
--   * smart.visit_invite (QR token hashed at rest), smart.remembered_vehicle, smart.house_gate_policy,
--     smart.gate_blacklist; smart.incident created as a stub for J4.2.
--   * PDPA (D-315): only the last 4 ID digits (CHECK), no full ID image; rows are deleted by the gate-retention job
--     after gate.retention_days (90).
-- Every table RLS:T (the operating tenant's own records; deviation from the draft's RLS:B-style). DDL only.

ALTER TYPE platform.audience ADD VALUE IF NOT EXISTS 'guard';
-- the RBAC catalogue's guard-surface permission (gate.visit.record, D-320)
ALTER TABLE platform.permission DROP CONSTRAINT permission_surfaces_check;
ALTER TABLE platform.permission ADD CONSTRAINT permission_surfaces_check
  CHECK (surfaces <@ ARRAY['owner', 'staff', 'admin', 'resident', 'technician', 'guard']::text[]);

CREATE TYPE smart.gate_kind AS ENUM ('main', 'side', 'service');
CREATE TYPE smart.gate_state AS ENUM ('active', 'inactive');
CREATE TYPE smart.gate_device_kind AS ENUM ('guard_tablet', 'barrier', 'lpr_camera');
CREATE TYPE smart.gate_device_state AS ENUM ('pending', 'active', 'revoked');
CREATE TYPE smart.gate_guard_state AS ENUM ('active', 'revoked');
CREATE TYPE smart.guard_shift_end_reason AS ENUM ('signed_out', 'superseded', 'device_revoked', 'guard_revoked');
CREATE TYPE smart.visit_kind AS ENUM ('guest', 'delivery', 'contractor', 'resident_vehicle', 'other');
CREATE TYPE smart.visit_state AS ENUM ('requested', 'approved', 'denied', 'timed_out', 'entered', 'exited', 'cancelled');
CREATE TYPE smart.visit_entry_basis AS ENUM ('approval', 'invite', 'remembered_vehicle', 'delivery_drop_point', 'policy', 'guard_override', 'offline');
CREATE TYPE smart.gate_policy_action AS ENUM ('allow_and_log', 'deny', 'guard_calls');
CREATE TYPE smart.visit_event_kind AS ENUM ('created', 'notified', 'answered', 'policy_applied', 'entered', 'exited', 'cancelled', 'photo_added', 'overstayed', 'note');
CREATE TYPE smart.visit_actor_kind AS ENUM ('guard', 'resident', 'operator', 'system', 'device');
CREATE TYPE smart.visit_invite_usage AS ENUM ('single', 'multi');
CREATE TYPE smart.visit_invite_state AS ENUM ('pending_approval', 'active', 'rejected', 'revoked');
CREATE TYPE smart.remembered_vehicle_kind AS ENUM ('resident', 'visitor');
CREATE TYPE smart.incident_kind AS ENUM ('fire', 'medical', 'intrusion', 'other');
CREATE TYPE smart.incident_source AS ENUM ('resident_sos', 'guard', 'device');
CREATE TYPE smart.incident_state AS ENUM ('open', 'acknowledged', 'closed');

-- ------------------------------------------------------------------------------- gates (§7.6 J4-b)
CREATE TABLE smart.gate (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  property_id  uuid NOT NULL,
  name         text NOT NULL,
  kind         smart.gate_kind NOT NULL DEFAULT 'main',
  state        smart.gate_state NOT NULL DEFAULT 'active',
  barrier      boolean NOT NULL DEFAULT false,
  lpr          boolean NOT NULL DEFAULT false,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer NOT NULL DEFAULT 1,
  CONSTRAINT gate_pkey PRIMARY KEY (id),
  CONSTRAINT gate_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_name_check CHECK (length(name) BETWEEN 1 AND 120)
);
COMMENT ON TABLE smart.gate IS 'D-315 / D-327 (J4.1): a gate (guard post) of a property; barrier / LPR flags are used by J4.2.';
CREATE UNIQUE INDEX gate_property_id_name_key ON smart.gate (property_id, name);
CREATE INDEX gate_tenant_id_idx ON smart.gate (tenant_id);
SELECT platform.apply_rls('smart.gate', 'tenant');

CREATE TABLE smart.gate_device (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  gate_id           uuid NOT NULL,
  kind              smart.gate_device_kind NOT NULL DEFAULT 'guard_tablet',
  name              text NOT NULL,
  state             smart.gate_device_state NOT NULL DEFAULT 'pending',
  enrol_code_hash   bytea,
  enrol_expires_at  timestamptz(6),
  secret_hash       bytea,
  enrolled_at       timestamptz(6),
  last_seen_at      timestamptz(6),
  revoked_at        timestamptz(6),
  revoked_by        uuid,
  revoke_reason     text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT gate_device_pkey PRIMARY KEY (id),
  CONSTRAINT gate_device_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_device_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_device_name_check CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT gate_device_active_check CHECK (state <> 'active' OR (secret_hash IS NOT NULL AND enrolled_at IS NOT NULL)),
  CONSTRAINT gate_device_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT gate_device_revoke_reason_check CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500)
);
COMMENT ON TABLE smart.gate_device IS 'D-320 / D-327 (J4.1): a device of a gate — guard tablets enrol with a one-time code and keep a device secret (both stored as sha256 only).';
CREATE UNIQUE INDEX gate_device_enrol_code_hash_key ON smart.gate_device (enrol_code_hash) WHERE (enrol_code_hash IS NOT NULL);
CREATE UNIQUE INDEX gate_device_secret_hash_key ON smart.gate_device (secret_hash) WHERE (secret_hash IS NOT NULL);
CREATE INDEX gate_device_gate_id_idx ON smart.gate_device (gate_id);
SELECT platform.apply_rls('smart.gate_device', 'tenant');

CREATE TABLE smart.gate_guard (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  property_id      uuid NOT NULL,
  user_id          uuid NOT NULL,
  display_name     text NOT NULL,
  pin_hash         text NOT NULL,
  pin_set_at       timestamptz(6) NOT NULL DEFAULT now(),
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz(6),
  state            smart.gate_guard_state NOT NULL DEFAULT 'active',
  revoked_at       timestamptz(6),
  revoke_reason    text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT gate_guard_pkey PRIMARY KEY (id),
  CONSTRAINT gate_guard_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_guard_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_guard_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_guard_display_name_check CHECK (length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT gate_guard_failed_attempts_check CHECK (failed_attempts >= 0),
  CONSTRAINT gate_guard_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
COMMENT ON TABLE smart.gate_guard IS 'D-320 / D-327 (J4.1): a guard of a property — a credential-less login with membership role guard, signing in only with a PIN (argon2id) on an enrolled gate tablet.';
CREATE UNIQUE INDEX gate_guard_user_id_key ON smart.gate_guard (user_id);
CREATE INDEX gate_guard_property_id_idx ON smart.gate_guard (property_id);
SELECT platform.apply_rls('smart.gate_guard', 'tenant');

CREATE TABLE smart.guard_shift (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  gate_id            uuid NOT NULL,
  gate_device_id     uuid NOT NULL,
  guard_id           uuid NOT NULL,
  session_family_id  uuid NOT NULL,
  started_at         timestamptz(6) NOT NULL DEFAULT now(),
  ended_at           timestamptz(6),
  end_reason         smart.guard_shift_end_reason,
  CONSTRAINT guard_shift_pkey PRIMARY KEY (id),
  CONSTRAINT guard_shift_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT guard_shift_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT guard_shift_gate_device_id_fkey FOREIGN KEY (gate_device_id) REFERENCES smart.gate_device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT guard_shift_guard_id_fkey FOREIGN KEY (guard_id) REFERENCES smart.gate_guard (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT guard_shift_ended_check CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
COMMENT ON TABLE smart.guard_shift IS 'D-320 / D-327 (J4.1): a guard shift = one PIN sign-in on a gate tablet; at most one open shift per guard.';
CREATE UNIQUE INDEX guard_shift_open_key ON smart.guard_shift (guard_id) WHERE (ended_at IS NULL);
CREATE INDEX guard_shift_gate_id_started_at_idx ON smart.guard_shift (gate_id, started_at DESC);
CREATE INDEX guard_shift_gate_device_id_idx ON smart.guard_shift (gate_device_id);
SELECT platform.apply_rls('smart.guard_shift', 'tenant');

-- ------------------------------------------------------------------------------- invites (§7.6 J4-f)
CREATE TABLE smart.visit_invite (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  unit_id             uuid NOT NULL,
  created_by_user_id  uuid NOT NULL,
  usage               smart.visit_invite_usage NOT NULL,
  visitor_kind        smart.visit_kind NOT NULL DEFAULT 'guest',
  state               smart.visit_invite_state NOT NULL DEFAULT 'active',
  valid_from          timestamptz(6) NOT NULL,
  valid_to            timestamptz(6) NOT NULL,
  max_uses            smallint NOT NULL DEFAULT 1,
  uses                smallint NOT NULL DEFAULT 0,
  plate_category      text,
  plate_number        text,
  plate_province      text,
  visitor_name        text,
  note                text,
  token_hash          bytea NOT NULL,
  approved_at         timestamptz(6),
  approved_by         uuid,
  rejected_at         timestamptz(6),
  rejected_by         uuid,
  reject_reason       text,
  revoked_at          timestamptz(6),
  revoked_by          uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT visit_invite_pkey PRIMARY KEY (id),
  CONSTRAINT visit_invite_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_invite_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_invite_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_invite_window_check CHECK (valid_to > valid_from),
  CONSTRAINT visit_invite_uses_check CHECK (uses >= 0 AND uses <= max_uses AND max_uses BETWEEN 1 AND 100),
  CONSTRAINT visit_invite_single_check CHECK (usage <> 'single' OR max_uses = 1),
  CONSTRAINT visit_invite_kind_check CHECK (visitor_kind <> 'resident_vehicle'),
  CONSTRAINT visit_invite_plate_check CHECK (plate_number IS NULL OR plate_number ~ '^[0-9]{1,4}$'),
  CONSTRAINT visit_invite_plate_category_check CHECK (plate_category IS NULL OR length(plate_category) BETWEEN 1 AND 4),
  CONSTRAINT visit_invite_plate_province_check CHECK (plate_province IS NULL OR length(plate_province) BETWEEN 1 AND 60),
  CONSTRAINT visit_invite_visitor_name_check CHECK (visitor_name IS NULL OR length(visitor_name) BETWEEN 1 AND 120),
  CONSTRAINT visit_invite_note_check CHECK (note IS NULL OR length(note) <= 300),
  CONSTRAINT visit_invite_reject_reason_check CHECK (reject_reason IS NULL OR length(reject_reason) <= 500),
  CONSTRAINT visit_invite_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT visit_invite_rejected_check CHECK ((state = 'rejected') = (rejected_at IS NOT NULL))
);
COMMENT ON TABLE smart.visit_invite IS 'D-315 / D-327 (J4.1): a resident''s pre-registered visitor invite (single or multi use, time window, optional plate); the QR token is stored as sha256 only. Contractor invites wait for the operator''s approval. Deleted by gate-retention once ended.';
CREATE UNIQUE INDEX visit_invite_token_hash_key ON smart.visit_invite (token_hash);
CREATE INDEX visit_invite_unit_id_valid_to_idx ON smart.visit_invite (unit_id, valid_to);
CREATE INDEX visit_invite_tenant_id_state_idx ON smart.visit_invite (tenant_id, state);
SELECT platform.apply_rls('smart.visit_invite', 'tenant');

-- ------------------------------------------------------------------------------- shifts → visits (§7.6 J4-d, J4-e)
CREATE TABLE smart.visit (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  gate_id               uuid NOT NULL,
  property_id           uuid NOT NULL,
  unit_id               uuid,
  kind                  smart.visit_kind NOT NULL,
  state                 smart.visit_state NOT NULL DEFAULT 'requested',
  entry_basis           smart.visit_entry_basis,
  plate_category        text,
  plate_number          text,
  plate_province        text,
  visitor_name          text,
  id_last4              char(4),
  photo_document_id     uuid,
  invite_id             uuid,
  client_ref            uuid NOT NULL,
  note                  text,
  recorded_at           timestamptz(6),
  respond_by            timestamptz(6),
  timeout_action        smart.gate_policy_action,
  decided_at            timestamptz(6),
  decided_by_user_id    uuid,
  decision_reason       text,
  call_me_at            timestamptz(6),
  call_me_user_id       uuid,
  entered_at            timestamptz(6),
  exited_at             timestamptz(6),
  exited_by             smart.visit_actor_kind,
  cancelled_at          timestamptz(6),
  cancel_reason         text,
  overstay_notified_at  timestamptz(6),
  shift_id              uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT visit_pkey PRIMARY KEY (id),
  CONSTRAINT visit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_photo_document_id_fkey FOREIGN KEY (photo_document_id) REFERENCES core.document (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT visit_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES smart.visit_invite (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT visit_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES smart.guard_shift (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  -- D-315: the last 4 digits of an ID only — never more
  CONSTRAINT visit_id_last4_check CHECK (id_last4 IS NULL OR id_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT visit_plate_check CHECK (plate_number IS NULL OR plate_number ~ '^[0-9]{1,4}$'),
  CONSTRAINT visit_plate_category_check CHECK (plate_category IS NULL OR length(plate_category) BETWEEN 1 AND 4),
  CONSTRAINT visit_plate_province_check CHECK (plate_province IS NULL OR length(plate_province) BETWEEN 1 AND 60),
  CONSTRAINT visit_visitor_name_check CHECK (visitor_name IS NULL OR length(visitor_name) BETWEEN 1 AND 120),
  CONSTRAINT visit_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT visit_reason_check CHECK ((decision_reason IS NULL OR length(decision_reason) <= 500) AND (cancel_reason IS NULL OR length(cancel_reason) <= 500)),
  CONSTRAINT visit_unit_required_check CHECK (unit_id IS NOT NULL OR kind = 'other'),
  CONSTRAINT visit_entered_check CHECK (state NOT IN ('entered', 'exited') OR entered_at IS NOT NULL),
  CONSTRAINT visit_exited_check CHECK ((state = 'exited') = (exited_at IS NOT NULL)),
  CONSTRAINT visit_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT visit_requested_check CHECK (state <> 'requested' OR respond_by IS NOT NULL)
);
COMMENT ON TABLE smart.visit IS 'D-315 / D-327 (J4.1): one visit at a gate. Name optional, ID last 4 digits only, photo optional (retention class visitor). Deleted with its events and photo by gate-retention after gate.retention_days (90).';
CREATE UNIQUE INDEX visit_gate_id_client_ref_key ON smart.visit (gate_id, client_ref);
CREATE INDEX visit_unit_id_created_at_idx ON smart.visit (unit_id, created_at DESC);
CREATE INDEX visit_tenant_id_created_at_idx ON smart.visit (tenant_id, created_at DESC);
CREATE INDEX visit_gate_id_state_idx ON smart.visit (gate_id, state);
CREATE INDEX visit_state_respond_by_idx ON smart.visit (state, respond_by);
CREATE INDEX visit_photo_document_id_idx ON smart.visit (photo_document_id) WHERE (photo_document_id IS NOT NULL);
CREATE INDEX visit_invite_id_idx ON smart.visit (invite_id) WHERE (invite_id IS NOT NULL);
SELECT platform.apply_rls('smart.visit', 'tenant');

CREATE TABLE smart.visit_event (
  id           uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  gate_id      uuid NOT NULL,
  visit_id     uuid NOT NULL,
  kind         smart.visit_event_kind NOT NULL,
  actor_kind   smart.visit_actor_kind NOT NULL,
  actor_id     uuid,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT visit_event_pkey PRIMARY KEY (id),
  CONSTRAINT visit_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_event_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT visit_event_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES smart.visit (id) ON DELETE CASCADE ON UPDATE NO ACTION
);
COMMENT ON TABLE smart.visit_event IS 'D-315 / D-327 (J4.1): append-only timeline of a visit; id = the domain event id (Last-Event-ID of the gate stream). Deleted with the visit.';
CREATE INDEX visit_event_visit_id_occurred_at_idx ON smart.visit_event (visit_id, occurred_at);
CREATE INDEX visit_event_gate_id_id_idx ON smart.visit_event (gate_id, id);
SELECT platform.apply_rls('smart.visit_event', 'tenant');
-- append-only for the application; the retention job (gp_platform) deletes visits and their events
REVOKE UPDATE, DELETE ON smart.visit_event FROM gp_app;

-- ------------------------------------------------------------------------------- vehicles, policies, blacklist (§7.6 J4-g, J4-h)
CREATE TABLE smart.remembered_vehicle (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  unit_id             uuid NOT NULL,
  kind                smart.remembered_vehicle_kind NOT NULL DEFAULT 'visitor',
  plate_category      text NOT NULL,
  plate_number        text NOT NULL,
  plate_province      text NOT NULL,
  label               text,
  expires_at          timestamptz(6) NOT NULL,
  created_by_user_id  uuid,
  revoked_at          timestamptz(6),
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT remembered_vehicle_pkey PRIMARY KEY (id),
  CONSTRAINT remembered_vehicle_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT remembered_vehicle_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT remembered_vehicle_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT remembered_vehicle_plate_check CHECK (plate_number ~ '^[0-9]{1,4}$' AND length(plate_category) BETWEEN 1 AND 4 AND length(plate_province) BETWEEN 1 AND 60),
  CONSTRAINT remembered_vehicle_label_check CHECK (label IS NULL OR length(label) <= 80)
);
COMMENT ON TABLE smart.remembered_vehicle IS 'D-315 / D-327 (J4.1): "remember this car" per unit (gate.remember_days, 30) — its entries are notify-only. Deleted by gate-retention after expiry or revocation.';
-- expiry is checked in queries (now() cannot be in an index predicate)
CREATE UNIQUE INDEX remembered_vehicle_live_key ON smart.remembered_vehicle (unit_id, plate_category, plate_number, plate_province) WHERE (revoked_at IS NULL);
CREATE INDEX remembered_vehicle_property_id_plate_number_idx ON smart.remembered_vehicle (property_id, plate_number);
SELECT platform.apply_rls('smart.remembered_vehicle', 'tenant');

CREATE TABLE smart.house_gate_policy (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  unit_id                 uuid NOT NULL,
  timeout_seconds         integer NOT NULL DEFAULT 180,
  action                  smart.gate_policy_action NOT NULL DEFAULT 'guard_calls',
  delivery_skip_approval  boolean,
  household_note          text,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT house_gate_policy_pkey PRIMARY KEY (id),
  CONSTRAINT house_gate_policy_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT house_gate_policy_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT house_gate_policy_timeout_check CHECK (timeout_seconds BETWEEN 60 AND 900),
  CONSTRAINT house_gate_policy_note_check CHECK (household_note IS NULL OR length(household_note) <= 300)
);
COMMENT ON TABLE smart.house_gate_policy IS 'D-315 / D-327 (J4.1): what the gate does when nobody of the unit answers in time (allow_and_log | deny | guard_calls, default guard_calls after 180 s); a missing row = the estate defaults gate.policy.*.';
CREATE UNIQUE INDEX house_gate_policy_unit_id_key ON smart.house_gate_policy (unit_id);
SELECT platform.apply_rls('smart.house_gate_policy', 'tenant');

CREATE TABLE smart.gate_blacklist (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  property_id     uuid NOT NULL,
  plate_category  text NOT NULL,
  plate_number    text NOT NULL,
  plate_province  text NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  created_by      uuid,
  revoked_at      timestamptz(6),
  revoked_by      uuid,
  revoke_reason   text,
  CONSTRAINT gate_blacklist_pkey PRIMARY KEY (id),
  CONSTRAINT gate_blacklist_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_blacklist_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gate_blacklist_plate_check CHECK (plate_number ~ '^[0-9]{1,4}$' AND length(plate_category) BETWEEN 1 AND 4 AND length(plate_province) BETWEEN 1 AND 60),
  CONSTRAINT gate_blacklist_reason_check CHECK (length(reason) BETWEEN 5 AND 500),
  CONSTRAINT gate_blacklist_revoke_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE smart.gate_blacklist IS 'D-315 / D-327 (J4.1): plates refused at the estate''s gates, with a required reason (audited). Revoked entries are deleted by gate-retention.';
CREATE UNIQUE INDEX gate_blacklist_live_key ON smart.gate_blacklist (property_id, plate_category, plate_number, plate_province) WHERE (revoked_at IS NULL);
SELECT platform.apply_rls('smart.gate_blacklist', 'tenant');

-- ------------------------------------------------------------------------------- incident stub for J4.2 (§7.6 J4-i)
CREATE TABLE smart.incident (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  unit_id             uuid,
  kind                smart.incident_kind NOT NULL,
  source              smart.incident_source NOT NULL,
  note                text,
  photo_document_id   uuid,
  state               smart.incident_state NOT NULL DEFAULT 'open',
  acknowledged_by     uuid,
  acknowledged_at     timestamptz(6),
  service_request_id  uuid,
  visit_ids           uuid[] NOT NULL DEFAULT '{}',
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT incident_pkey PRIMARY KEY (id),
  CONSTRAINT incident_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT incident_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT incident_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT incident_photo_document_id_fkey FOREIGN KEY (photo_document_id) REFERENCES core.document (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT incident_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT incident_note_check CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT incident_ack_check CHECK ((state = 'open') = (acknowledged_at IS NULL))
);
COMMENT ON TABLE smart.incident IS 'D-317 (J4.2 stub, created in J4.1): an SOS / incident of a property linked to the visits active at the time; kept 2 years (⚖ O-038). No endpoint before J4.2.';
CREATE INDEX incident_property_id_created_at_idx ON smart.incident (property_id, created_at DESC);
SELECT platform.apply_rls('smart.incident', 'tenant');
