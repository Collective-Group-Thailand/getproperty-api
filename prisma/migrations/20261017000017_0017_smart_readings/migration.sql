-- getproperty-api 0017 (B3.3) — meter readings, the billing source of truth (D-012, D-030, D-035, D-142, D-143):
-- smart.reading_batch (staff rounds, imports, HTTPS batches, inspections, cycle estimates), smart.meter_reading
-- (+ monotonicity and immutability triggers), smart.meter_reading_review (owner review queue), and the reading FKs
-- of smart.meter_swap / smart.meter_status announced in 0015. Deviations: schema-design §7.5 rows 41–44.

CREATE TYPE smart.reading_source AS ENUM ('iot', 'ocr', 'manual', 'estimated');
CREATE TYPE smart.reading_review_state AS ENUM ('accepted', 'pending_review', 'rejected', 'corrected');
CREATE TYPE smart.reading_channel AS ENUM ('mqtt', 'https_batch', 'staff_pwa', 'owner_web', 'inspection', 'cycle_estimate', 'import');
CREATE TYPE smart.reading_batch_kind AS ENUM ('staff_round', 'import', 'cycle_estimate', 'https_batch', 'inspection');
CREATE TYPE smart.review_reason AS ENUM ('non_monotonic', 'out_of_band', 'ocr_low_confidence', 'clock_suspect', 'missing_photo',
  'manual_flag', 'decreasing_without_swap');
CREATE TYPE smart.review_status AS ENUM ('open', 'accepted', 'corrected', 'rejected');

CREATE TABLE smart.reading_batch (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  kind             smart.reading_batch_kind NOT NULL,
  billing_cycle_id uuid,
  period_key       text,
  started_at       timestamptz(6) NOT NULL DEFAULT now(),
  completed_at     timestamptz(6),
  submitted_by     uuid,
  stats            jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT reading_batch_pkey PRIMARY KEY (id),
  CONSTRAINT reading_batch_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_batch_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_batch_period_key_check CHECK (period_key IS NULL OR period_key ~ '^\d{4}-\d{2}$')
);
COMMENT ON TABLE smart.reading_batch IS 'A staff reading round (one per building and billing period), an import, an HTTPS batch, an inspection or a cycle-estimate run (blueprint reading_batch_id).';
CREATE UNIQUE INDEX reading_batch_building_id_kind_period_key_key ON smart.reading_batch (building_id, kind, period_key) WHERE (kind = 'staff_round'::smart.reading_batch_kind);
CREATE INDEX reading_batch_tenant_id_building_id_idx ON smart.reading_batch (tenant_id, building_id);

CREATE TABLE smart.meter_reading (
  id                       uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL,
  building_id              uuid NOT NULL,
  asset_item_id            uuid NOT NULL,
  meter_assignment_id      uuid NOT NULL,
  unit_id                  uuid,
  device_id                uuid,
  reading_batch_id         uuid,
  register                 numeric(12,3) NOT NULL,
  unit                     smart.meter_unit NOT NULL,
  read_at                  timestamptz(6) NOT NULL,
  received_at              timestamptz(6) NOT NULL DEFAULT now(),
  source                   smart.reading_source NOT NULL,
  confidence               numeric(4,3) NOT NULL,
  quality                  smart.reading_quality,
  seq                      bigint,
  telemetry_time           timestamptz(6),
  review_state             smart.reading_review_state NOT NULL,
  review_id                uuid,
  previous_reading_id      uuid,
  consumption              numeric(12,3),
  is_rollover              boolean NOT NULL DEFAULT false,
  swap_id                  uuid,
  is_install               boolean NOT NULL DEFAULT false,
  is_final                 boolean NOT NULL DEFAULT false,
  evidence_document_id     uuid,
  ocr_raw_value            text,
  ocr_confidence           numeric(4,3),
  typed_value              numeric(12,3),
  submitted_by             uuid,
  submitted_via            smart.reading_channel NOT NULL,
  estimate_basis           jsonb,
  superseded_by_reading_id uuid,
  note                     text,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT meter_reading_pkey PRIMARY KEY (id),
  CONSTRAINT meter_reading_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_meter_assignment_id_fkey FOREIGN KEY (meter_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_reading_batch_id_fkey FOREIGN KEY (reading_batch_id) REFERENCES smart.reading_batch (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_previous_reading_id_fkey FOREIGN KEY (previous_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_superseded_by_reading_id_fkey FOREIGN KEY (superseded_by_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_swap_id_fkey FOREIGN KEY (swap_id) REFERENCES smart.meter_swap (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_evidence_document_id_fkey FOREIGN KEY (evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_register_check CHECK (register >= 0),
  CONSTRAINT meter_reading_confidence_check CHECK (confidence BETWEEN 0 AND 1 AND (ocr_confidence IS NULL OR ocr_confidence BETWEEN 0 AND 1)),
  CONSTRAINT meter_reading_iot_check CHECK ((source = 'iot') = (seq IS NOT NULL AND device_id IS NOT NULL AND quality IS NOT NULL)),
  CONSTRAINT meter_reading_evidence_check CHECK (NOT (is_install OR is_final) OR evidence_document_id IS NOT NULL),
  CONSTRAINT meter_reading_estimate_check CHECK ((source = 'estimated') = (estimate_basis IS NOT NULL)),
  CONSTRAINT meter_reading_superseded_check CHECK (superseded_by_reading_id IS NULL OR superseded_by_reading_id <> id),
  CONSTRAINT meter_reading_note_check CHECK (note IS NULL OR length(note) <= 500)
);
COMMENT ON TABLE smart.meter_reading IS 'One row per accepted (or reviewed) cumulative register reading from any source (D-012): the only input of the billing engine (D-030). Corrections supersede (D-142); IoT rows dedup on (device_id, seq) (D-143).';
-- D-142 with supersede: the business key holds for live rows (accepted or waiting for review); a corrected or
-- rejected row keeps its values and frees the key for the row that supersedes it.
CREATE UNIQUE INDEX meter_reading_asset_item_id_read_at_source_key ON smart.meter_reading (asset_item_id, read_at, source)
  WHERE (review_state = ANY (ARRAY['accepted'::smart.reading_review_state, 'pending_review'::smart.reading_review_state]));
CREATE UNIQUE INDEX meter_reading_device_id_seq_key ON smart.meter_reading (device_id, seq) WHERE (seq IS NOT NULL);
CREATE INDEX meter_reading_accepted_idx ON smart.meter_reading (tenant_id, building_id, asset_item_id, read_at DESC)
  WHERE (review_state = 'accepted'::smart.reading_review_state);
CREATE INDEX meter_reading_meter_assignment_id_read_at_idx ON smart.meter_reading (meter_assignment_id, read_at DESC);
CREATE INDEX meter_reading_pending_idx ON smart.meter_reading (tenant_id, review_state)
  WHERE (review_state = 'pending_review'::smart.reading_review_state);
CREATE INDEX meter_reading_unit_id_idx ON smart.meter_reading (unit_id);
CREATE INDEX meter_reading_reading_batch_id_idx ON smart.meter_reading (reading_batch_id);

CREATE TABLE smart.meter_reading_review (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  unit_id              uuid,
  reading_id           uuid NOT NULL,
  reason               smart.review_reason NOT NULL,
  band_low             numeric(12,3),
  band_high            numeric(12,3),
  trailing_avg         numeric(12,3),
  status               smart.review_status NOT NULL DEFAULT 'open',
  decided_by           uuid,
  decided_at           timestamptz(6),
  decision_note        text,
  corrected_register   numeric(12,3),
  corrected_reading_id uuid,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT meter_reading_review_pkey PRIMARY KEY (id),
  CONSTRAINT meter_reading_review_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_review_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_review_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_review_reading_id_fkey FOREIGN KEY (reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_review_corrected_reading_id_fkey FOREIGN KEY (corrected_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_reading_review_decided_check CHECK ((status = 'open') = (decided_at IS NULL)),
  CONSTRAINT meter_reading_review_corrected_check CHECK ((status = 'corrected') = (corrected_reading_id IS NOT NULL)),
  CONSTRAINT meter_reading_review_note_check CHECK (status NOT IN ('corrected', 'rejected') OR length(btrim(coalesce(decision_note, ''))) >= 3)
);
COMMENT ON TABLE smart.meter_reading_review IS 'Owner review queue (D-035): out-of-band, non-monotonic, low-confidence OCR, decreasing registers; accept, correct with a reason (superseding row) or reject.';
CREATE UNIQUE INDEX meter_reading_review_reading_id_key ON smart.meter_reading_review (reading_id);
CREATE INDEX meter_reading_review_tenant_id_status_created_at_idx ON smart.meter_reading_review (tenant_id, status, created_at);
CREATE INDEX meter_reading_review_building_id_idx ON smart.meter_reading_review (building_id);

ALTER TABLE smart.meter_reading
  ADD CONSTRAINT meter_reading_review_id_fkey FOREIGN KEY (review_id) REFERENCES smart.meter_reading_review (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX meter_reading_review_id_idx ON smart.meter_reading (review_id);

ALTER TABLE smart.meter_swap
  ADD CONSTRAINT meter_swap_old_last_reading_id_fkey FOREIGN KEY (old_last_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT meter_swap_new_first_reading_id_fkey FOREIGN KEY (new_first_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE smart.meter_swap VALIDATE CONSTRAINT meter_swap_old_last_reading_id_fkey;
ALTER TABLE smart.meter_swap VALIDATE CONSTRAINT meter_swap_new_first_reading_id_fkey;
CREATE INDEX meter_swap_old_last_reading_id_idx ON smart.meter_swap (old_last_reading_id);
CREATE INDEX meter_swap_new_first_reading_id_idx ON smart.meter_swap (new_first_reading_id);
ALTER TABLE smart.meter_status
  ADD CONSTRAINT meter_status_last_reading_id_fkey FOREIGN KEY (last_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE smart.meter_status VALIDATE CONSTRAINT meter_status_last_reading_id_fkey;
CREATE INDEX meter_status_last_reading_id_idx ON smart.meter_status (last_reading_id);

-- Monotonicity (D-035): an accepted, live reading may not be below the previous accepted live reading of the same
-- assignment (nor above the next one), unless it is flagged a rollover; the first reading of an assignment is
-- checked against the assignment's initial reading. The services check first (and route to review); this is the
-- database's last line.
CREATE OR REPLACE FUNCTION smart.meter_reading_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  prev numeric;
  nxt numeric;
  initial numeric;
BEGIN
  IF NEW.review_state <> 'accepted' OR NEW.superseded_by_reading_id IS NOT NULL OR NEW.is_rollover THEN
    RETURN NEW;
  END IF;
  SELECT r.register INTO prev FROM smart.meter_reading r
   WHERE r.meter_assignment_id = NEW.meter_assignment_id AND r.id <> NEW.id AND r.review_state = 'accepted'
     AND r.superseded_by_reading_id IS NULL AND r.read_at < NEW.read_at
   ORDER BY r.read_at DESC LIMIT 1;
  IF prev IS NULL THEN
    SELECT a.initial_reading INTO initial FROM core.meter_assignment a WHERE a.id = NEW.meter_assignment_id;
    prev := initial;
  END IF;
  IF prev IS NOT NULL AND NEW.register < prev THEN
    RAISE EXCEPTION 'smart.monotonic: register % is below the previous reading % of assignment %', NEW.register, prev, NEW.meter_assignment_id
      USING ERRCODE = 'P0001';
  END IF;
  SELECT r.register INTO nxt FROM smart.meter_reading r
   WHERE r.meter_assignment_id = NEW.meter_assignment_id AND r.id <> NEW.id AND r.review_state = 'accepted'
     AND r.superseded_by_reading_id IS NULL AND r.read_at > NEW.read_at AND NOT r.is_rollover
   ORDER BY r.read_at ASC LIMIT 1;
  IF nxt IS NOT NULL AND NEW.register > nxt THEN
    RAISE EXCEPTION 'smart.monotonic: register % is above the next reading % of assignment %', NEW.register, nxt, NEW.meter_assignment_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meter_reading_monotonic BEFORE INSERT OR UPDATE OF register, review_state, read_at, superseded_by_reading_id
  ON smart.meter_reading FOR EACH ROW EXECUTE FUNCTION smart.meter_reading_monotonic();

-- Content is immutable once written: only the review links, the review state and the supersede link change.
CREATE OR REPLACE FUNCTION smart.meter_reading_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'core.append_only: smart.meter_reading rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['review_state', 'review_id', 'superseded_by_reading_id', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['review_state', 'review_id', 'superseded_by_reading_id', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'core.append_only: the content of a meter reading is immutable (supersede it, D-142)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meter_reading_immutable BEFORE UPDATE OR DELETE ON smart.meter_reading FOR EACH ROW EXECUTE FUNCTION smart.meter_reading_immutable();

CREATE TRIGGER reading_batch_set_updated_at BEFORE UPDATE ON smart.reading_batch FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER meter_reading_set_updated_at BEFORE UPDATE ON smart.meter_reading FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER meter_reading_review_set_updated_at BEFORE UPDATE ON smart.meter_reading_review FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Row-level security (schema-design §4.5): readings and reviews are unit-scoped (landlord unit grants).
SELECT platform.apply_rls('smart.reading_batch', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.meter_reading', 'unit', 'smart.metering');
SELECT platform.apply_rls('smart.meter_reading_review', 'unit', 'smart.metering');

GRANT SELECT, INSERT, UPDATE ON smart.reading_batch, smart.meter_reading, smart.meter_reading_review TO gp_app, gp_platform;
GRANT SELECT ON smart.reading_batch, smart.meter_reading, smart.meter_reading_review TO gp_reporting;
