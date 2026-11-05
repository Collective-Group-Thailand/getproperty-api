-- getproperty-api 0075 — barrier, LPR, resident open, SOS (Phase J step J4.2, D-316, D-317, D-328). schema-design
-- §7.5 rows 246–250 (§7.6 J4-c, J4-g2, J4-i, J4-j, J4-k).
--   * smart.gate_device: barrier / LPR rows bound to an edge gateway (smart.device) and a channel on it; the reserved
--     kind lpr_camera is renamed lpr (no row used it).
--   * device protocol 1.3: smart.command_type + gate_open (wire `gate.open`), smart.device_event_type + gate_state,
--     plate_detected (wire `gate.state`, `plate.detected`).
--   * smart.resident_vehicle (a unit's own cars, no expiry), smart.plate_detection (camera reads; pending ones
--     pre-fill the guard form), visit entry basis resident_vehicle, visit event gate_opened.
--   * smart.incident completed (acknowledged → resolved, cancelled by the resident within 30 s) + smart.incident_event.
-- New enum values are only referenced as text in this file (they cannot be used in the transaction that adds them).
-- Every new table RLS:T. DDL only.

ALTER TYPE smart.gate_device_kind RENAME VALUE 'lpr_camera' TO 'lpr';
ALTER TYPE smart.command_type ADD VALUE IF NOT EXISTS 'gate_open';
ALTER TYPE smart.device_event_type ADD VALUE IF NOT EXISTS 'gate_state';
ALTER TYPE smart.device_event_type ADD VALUE IF NOT EXISTS 'plate_detected';
ALTER TYPE smart.visit_entry_basis ADD VALUE IF NOT EXISTS 'resident_vehicle';
ALTER TYPE smart.visit_event_kind ADD VALUE IF NOT EXISTS 'gate_opened';
ALTER TYPE smart.incident_state RENAME VALUE 'closed' TO 'resolved';
ALTER TYPE smart.incident_state ADD VALUE IF NOT EXISTS 'cancelled';

CREATE TYPE smart.gate_hw_state AS ENUM ('open', 'closed', 'fault');
CREATE TYPE smart.plate_detection_state AS ENUM ('pending', 'matched', 'claimed', 'dismissed', 'expired', 'ignored');
CREATE TYPE smart.plate_match AS ENUM ('resident_vehicle', 'remembered_vehicle', 'blacklisted', 'ambiguous', 'low_confidence', 'none');
CREATE TYPE smart.incident_event_kind AS ENUM ('raised', 'acknowledged', 'resolved', 'cancelled', 'note');

-- ------------------------------------------------------------------------------- barrier / LPR devices (§7.6 J4-c)
-- the last barrier open of a gate (guard, resident or LPR): the per-gate interval is checked under the gate's row lock
ALTER TABLE smart.gate ADD COLUMN last_open_at timestamptz(6);
ALTER TABLE smart.gate_device
  ADD COLUMN edge_device_id uuid,
  ADD COLUMN channel        text,
  ADD COLUMN pulse_ms       integer,
  ADD COLUMN hw_state       smart.gate_hw_state,
  ADD COLUMN hw_state_at    timestamptz(6),
  ADD CONSTRAINT gate_device_edge_device_id_fkey FOREIGN KEY (edge_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT gate_device_hardware_check CHECK (
    (kind = 'guard_tablet' AND edge_device_id IS NULL AND channel IS NULL AND pulse_ms IS NULL)
    OR (kind IN ('barrier', 'lpr') AND edge_device_id IS NOT NULL AND channel ~ '^[A-Za-z0-9_.:-]{1,32}$'
        AND secret_hash IS NULL AND enrol_code_hash IS NULL)),
  ADD CONSTRAINT gate_device_pulse_check CHECK (pulse_ms IS NULL OR (kind = 'barrier' AND pulse_ms BETWEEN 200 AND 10000));
-- a hardware device is active from its attachment (no enrolment): the tablet rule applies to tablets only
ALTER TABLE smart.gate_device DROP CONSTRAINT gate_device_active_check;
ALTER TABLE smart.gate_device ADD CONSTRAINT gate_device_active_check
  CHECK (state <> 'active' OR kind <> 'guard_tablet' OR (secret_hash IS NOT NULL AND enrolled_at IS NOT NULL));
CREATE UNIQUE INDEX gate_device_edge_channel_live_key ON smart.gate_device (edge_device_id, channel)
  WHERE (edge_device_id IS NOT NULL AND state <> 'revoked');
CREATE INDEX gate_device_edge_device_id_idx ON smart.gate_device (edge_device_id) WHERE (edge_device_id IS NOT NULL);
COMMENT ON COLUMN smart.gate_device.edge_device_id IS 'D-328 (J4.2): the getproperty-edge gateway (smart.device kind gateway) that drives this barrier relay / reads this LPR camera.';

-- ------------------------------------------------------------------------------- resident vehicles (§7.6 J4-g2)
CREATE TABLE smart.resident_vehicle (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  property_id            uuid NOT NULL,
  unit_id                uuid NOT NULL,
  plate_category         text NOT NULL,
  plate_number           text NOT NULL,
  plate_province         text NOT NULL,
  label                  text,
  registered_by_user_id  uuid NOT NULL,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  removed_at             timestamptz(6),
  removed_by             uuid,
  remove_reason          text,
  CONSTRAINT resident_vehicle_pkey PRIMARY KEY (id),
  CONSTRAINT resident_vehicle_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resident_vehicle_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resident_vehicle_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resident_vehicle_user_fkey FOREIGN KEY (registered_by_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resident_vehicle_plate_check CHECK (plate_number ~ '^[0-9]{1,4}$' AND length(plate_category) BETWEEN 1 AND 4 AND length(plate_province) BETWEEN 1 AND 60),
  CONSTRAINT resident_vehicle_label_check CHECK (label IS NULL OR length(label) BETWEEN 1 AND 80),
  CONSTRAINT resident_vehicle_removed_check CHECK ((removed_at IS NULL) = (remove_reason IS NULL))
);
COMMENT ON TABLE smart.resident_vehicle IS 'D-328 (J4.2): the cars of a unit (no expiry) — LPR entry and resident barrier open. Removed when the registering login leaves the unit; removed rows deleted by gate-retention.';
CREATE UNIQUE INDEX resident_vehicle_live_key ON smart.resident_vehicle (unit_id, plate_category, plate_number, plate_province) WHERE (removed_at IS NULL);
CREATE INDEX resident_vehicle_property_id_plate_number_idx ON smart.resident_vehicle (property_id, plate_number);
SELECT platform.apply_rls('smart.resident_vehicle', 'tenant');

-- ------------------------------------------------------------------------------- plate detections (§7.6 J4-j)
CREATE TABLE smart.plate_detection (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  gate_id             uuid NOT NULL,
  gate_device_id      uuid NOT NULL,
  event_id            uuid NOT NULL,
  plate_category      text NOT NULL,
  plate_number        text NOT NULL,
  plate_province      text,
  confidence          numeric(4,3) NOT NULL,
  detected_at         timestamptz(6) NOT NULL,
  received_at         timestamptz(6) NOT NULL DEFAULT now(),
  image_ref           text,
  state               smart.plate_detection_state NOT NULL DEFAULT 'pending',
  match               smart.plate_match NOT NULL DEFAULT 'none',
  unit_id             uuid,
  matched_vehicle_id  uuid,
  visit_id            uuid,
  claimed_at          timestamptz(6),
  claimed_by          uuid,
  CONSTRAINT plate_detection_pkey PRIMARY KEY (id),
  CONSTRAINT plate_detection_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT plate_detection_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT plate_detection_gate_device_id_fkey FOREIGN KEY (gate_device_id) REFERENCES smart.gate_device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT plate_detection_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT plate_detection_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES smart.visit (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT plate_detection_plate_check CHECK (plate_number ~ '^[0-9]{1,4}$' AND length(plate_category) BETWEEN 1 AND 4 AND (plate_province IS NULL OR length(plate_province) BETWEEN 1 AND 60)),
  CONSTRAINT plate_detection_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT plate_detection_image_ref_check CHECK (image_ref IS NULL OR length(image_ref) <= 200)
);
COMMENT ON TABLE smart.plate_detection IS 'D-328 (J4.2): one LPR read at a gate (event id unique). Known plates → visit entered; others wait for the guard (pending → claimed / dismissed / expired). Deleted by gate-retention after gate.retention_days.';
CREATE UNIQUE INDEX plate_detection_event_id_key ON smart.plate_detection (event_id);
CREATE INDEX plate_detection_gate_id_detected_at_idx ON smart.plate_detection (gate_id, detected_at DESC);
CREATE INDEX plate_detection_pending_idx ON smart.plate_detection (received_at) WHERE (state = 'pending');
SELECT platform.apply_rls('smart.plate_detection', 'tenant');

-- ------------------------------------------------------------------------------- incidents (§7.6 J4-i, J4-k)
ALTER TABLE smart.incident
  ADD COLUMN gate_id            uuid,
  ADD COLUMN raised_by_user_id  uuid,
  ADD COLUMN resolved_at        timestamptz(6),
  ADD COLUMN resolved_by        uuid,
  ADD COLUMN resolution_note    text,
  ADD COLUMN cancelled_at       timestamptz(6),
  ADD COLUMN cancel_reason      text,
  ADD CONSTRAINT incident_gate_id_fkey FOREIGN KEY (gate_id) REFERENCES smart.gate (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT incident_raised_by_fkey FOREIGN KEY (raised_by_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT incident_resolution_note_check CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  ADD CONSTRAINT incident_cancel_reason_check CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300),
  ADD CONSTRAINT incident_resolved_check CHECK ((state::text = 'resolved') = (resolved_at IS NOT NULL)),
  ADD CONSTRAINT incident_cancelled_check CHECK ((state::text = 'cancelled') = (cancelled_at IS NOT NULL));
ALTER TABLE smart.incident DROP CONSTRAINT incident_ack_check;
ALTER TABLE smart.incident ADD CONSTRAINT incident_ack_check
  CHECK ((state::text <> 'open' OR acknowledged_at IS NULL) AND (state::text <> 'acknowledged' OR acknowledged_at IS NOT NULL));
CREATE INDEX incident_tenant_id_state_idx ON smart.incident (tenant_id, state);
COMMENT ON TABLE smart.incident IS 'D-317 / D-328 (J4.2): an SOS / incident of a property (resident LINE button or the gate tablet) linked to the visits active at the time; open → acknowledged → resolved, cancelled by the resident within gate.sos.cancel_seconds. Kept 2 years (⚖ O-038).';

CREATE TABLE smart.incident_event (
  id           uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  incident_id  uuid NOT NULL,
  kind         smart.incident_event_kind NOT NULL,
  actor_kind   smart.visit_actor_kind NOT NULL,
  actor_id     uuid,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT incident_event_pkey PRIMARY KEY (id),
  CONSTRAINT incident_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT incident_event_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES smart.incident (id) ON DELETE CASCADE ON UPDATE NO ACTION
);
COMMENT ON TABLE smart.incident_event IS 'D-328 (J4.2): append-only timeline of an incident; id = the domain event id.';
CREATE INDEX incident_event_incident_id_occurred_at_idx ON smart.incident_event (incident_id, occurred_at);
SELECT platform.apply_rls('smart.incident_event', 'tenant');
REVOKE UPDATE, DELETE ON smart.incident_event FROM gp_app;
