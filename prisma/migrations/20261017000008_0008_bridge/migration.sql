-- getproperty-api 0008 — bridge.integration_event: every event exchanged with getbuild / getpack, persisted
-- for replay (D-153, blueprint "Integration contracts", schema-design v2 §3.5). Payloads follow the zod
-- contracts of @collective/asset-core (contract_version = the package semver). No consumer in Phase 1.

CREATE TYPE bridge.integration_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE bridge.integration_platform AS ENUM ('getbuild', 'getpack');
CREATE TYPE bridge.integration_status AS ENUM ('received', 'validated', 'applied', 'rejected', 'pending', 'sent', 'acked', 'failed', 'dead');

CREATE TABLE bridge.integration_event (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  direction          bridge.integration_direction NOT NULL,
  platform           bridge.integration_platform NOT NULL,
  event_type         text NOT NULL,
  contract_version   text NOT NULL,
  idempotency_key    text NOT NULL,
  tenant_id          uuid,
  building_id        uuid,
  subject_type       text,
  subject_id         uuid,
  payload            jsonb NOT NULL,
  payload_sha256     bytea NOT NULL,
  correlation_id     uuid,
  causation_event_id uuid,
  status             bridge.integration_status NOT NULL,
  attempts           smallint NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz(6),
  last_error         text,
  occurred_at        timestamptz(6) NOT NULL,
  received_at        timestamptz(6),
  sent_at            timestamptz(6),
  acked_at           timestamptz(6),
  ack_due_at         timestamptz(6) NOT NULL DEFAULT (now() + '24:00:00'::interval),
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT integration_event_pkey PRIMARY KEY (id),
  CONSTRAINT integration_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT integration_event_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT integration_event_event_type_check CHECK (event_type IN ('building.handover.requested', 'unit.transferred', 'warranty.defect.reported',
    'warranty.defect.closed', 'juristic.formed', 'procurement.rfq.requested', 'procurement.order.updated', 'identity.party.linked')),
  CONSTRAINT integration_event_contract_version_check CHECK (contract_version ~ '^[0-9]+\.[0-9]+\.[0-9]+'),
  CONSTRAINT integration_event_payload_sha256_check CHECK (octet_length(payload_sha256) = 32),
  CONSTRAINT integration_event_status_direction_check CHECK (
    (direction = 'inbound' AND status IN ('received', 'validated', 'applied', 'rejected', 'failed', 'dead'))
    OR (direction = 'outbound' AND status IN ('pending', 'sent', 'acked', 'failed', 'dead')))
);
COMMENT ON TABLE bridge.integration_event IS 'In/out integration events with getbuild/getpack; ack within 24 h (ack_due_at = occurred_at + 24 h, set by trigger); PII in payloads encrypted with the Collective shared integration key.';
CREATE UNIQUE INDEX integration_event_platform_direction_idempotency_key_key ON bridge.integration_event (platform, direction, idempotency_key);
CREATE INDEX integration_event_status_next_attempt_at_idx ON bridge.integration_event (status, next_attempt_at);
CREATE INDEX integration_event_status_ack_due_at_idx ON bridge.integration_event (status, ack_due_at) WHERE (acked_at IS NULL);
CREATE INDEX integration_event_tenant_id_event_type_occurred_at_idx ON bridge.integration_event (tenant_id, event_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION bridge.set_ack_due_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.ack_due_at := NEW.occurred_at + interval '24 hours';
  RETURN NEW;
END
$$;
CREATE TRIGGER integration_event_ack_due_at BEFORE INSERT OR UPDATE OF occurred_at ON bridge.integration_event
  FOR EACH ROW EXECUTE FUNCTION bridge.set_ack_due_at();
CREATE TRIGGER integration_event_set_updated_at BEFORE UPDATE ON bridge.integration_event FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
