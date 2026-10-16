-- getproperty-api 0004 — attachments, audit log, domain events, outbox, idempotency keys
-- (schema-design v2 §3.2.5, §4.8). audit_log and domain_event are append-only (§4.9); D-147: plain tables
-- with indexes in R1, partition when > 1M rows.

CREATE TYPE platform.audit_outcome AS ENUM ('success', 'denied', 'failure');
CREATE TYPE platform.outbox_state AS ENUM ('pending', 'publishing', 'published', 'failed', 'dead');
CREATE TYPE platform.idempotency_status AS ENUM ('in_progress', 'completed');

CREATE TABLE platform.attachment (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  document_id  uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  building_id  uuid,
  role         text NOT NULL,
  position     smallint NOT NULL DEFAULT 0,
  caption      text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT attachment_pkey PRIMARY KEY (id),
  CONSTRAINT attachment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT attachment_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT attachment_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT attachment_subject_type_check CHECK (subject_type ~ '^[a-z]+\.[a-z_]+$')
);
COMMENT ON TABLE platform.attachment IS 'Polymorphic link core.document ↔ any app row (photos, evidence, signed PDFs, slips).';
CREATE UNIQUE INDEX attachment_document_id_subject_type_subject_id_role_key ON platform.attachment (document_id, subject_type, subject_id, role);
CREATE INDEX attachment_subject_type_subject_id_idx ON platform.attachment (subject_type, subject_id);
CREATE INDEX attachment_tenant_id_idx ON platform.attachment (tenant_id);

CREATE TABLE platform.audit_log (
  id               uuid NOT NULL DEFAULT uuidv7(),
  occurred_at      timestamptz(6) NOT NULL DEFAULT now(),
  tenant_id        uuid,
  building_id      uuid,
  actor            jsonb NOT NULL,
  actor_id         uuid,
  action           text NOT NULL,
  subject_type     text,
  subject_id       uuid,
  outcome          platform.audit_outcome NOT NULL DEFAULT 'success',
  request_id       text,
  ip               inet,
  user_agent       text,
  support_grant_id uuid,
  before           jsonb,
  after            jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT audit_log_pkey PRIMARY KEY (id),
  CONSTRAINT audit_log_support_grant_id_fkey FOREIGN KEY (support_grant_id) REFERENCES platform.support_grant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT audit_log_action_check CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT audit_log_actor_check CHECK (jsonb_typeof(actor) = 'object' AND actor ? 'type')
);
COMMENT ON TABLE platform.audit_log IS 'Security, money and PDPA actions — append-only, 10-year retention. actor = §4.8 shape; actor_id = actor.id when it is a user/device (indexed lookup, replaces an expression index). tenant_id null rows are platform-only.';
CREATE INDEX audit_log_tenant_id_occurred_at_idx ON platform.audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_subject_type_subject_id_idx ON platform.audit_log (subject_type, subject_id);
CREATE INDEX audit_log_actor_id_occurred_at_idx ON platform.audit_log (actor_id, occurred_at);
CREATE INDEX audit_log_action_occurred_at_idx ON platform.audit_log (action, occurred_at);
CREATE INDEX audit_log_support_grant_id_idx ON platform.audit_log (support_grant_id);

CREATE TABLE platform.domain_event (
  id             uuid NOT NULL DEFAULT uuidv7(),
  type           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  tenant_id      uuid,
  building_id    uuid,
  actor          jsonb NOT NULL,
  occurred_at    timestamptz(6) NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL,
  causation_id   uuid,
  payload        jsonb NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  CONSTRAINT domain_event_pkey PRIMARY KEY (id),
  CONSTRAINT domain_event_type_check CHECK (type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT domain_event_schema_version_check CHECK (schema_version >= 1)
);
COMMENT ON TABLE platform.domain_event IS 'Every state change (envelope §4.8); id = envelope id (uuidv7 generated in code). Append-only.';
CREATE INDEX domain_event_aggregate_type_aggregate_id_occurred_at_idx ON platform.domain_event (aggregate_type, aggregate_id, occurred_at);
CREATE INDEX domain_event_tenant_id_type_occurred_at_idx ON platform.domain_event (tenant_id, type, occurred_at);
CREATE INDEX domain_event_correlation_id_idx ON platform.domain_event (correlation_id);

CREATE TABLE platform.outbox_message (
  id              uuid NOT NULL DEFAULT uuidv7(),
  event_id        uuid NOT NULL,
  topic           text NOT NULL,
  state           platform.outbox_state NOT NULL DEFAULT 'pending',
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  last_error      text,
  published_at    timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT outbox_message_pkey PRIMARY KEY (id),
  CONSTRAINT outbox_message_event_id_fkey FOREIGN KEY (event_id) REFERENCES platform.domain_event (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT outbox_message_attempts_check CHECK (attempts >= 0)
);
COMMENT ON TABLE platform.outbox_message IS 'Relay queue for domain events, written in the same transaction (gp_app may only INSERT; the relay runs as gp_platform).';
CREATE UNIQUE INDEX outbox_message_event_id_key ON platform.outbox_message (event_id);
CREATE INDEX outbox_message_state_next_attempt_at_idx ON platform.outbox_message (state, next_attempt_at) WHERE (state = ANY (ARRAY['pending'::platform.outbox_state, 'failed'::platform.outbox_state]));
CREATE INDEX outbox_message_created_at_idx ON platform.outbox_message (created_at);

CREATE TABLE platform.idempotency_key (
  scope            text NOT NULL,
  key              uuid NOT NULL,
  request_sha256   bytea NOT NULL,
  status           platform.idempotency_status NOT NULL,
  response_status  smallint,
  response_headers jsonb,
  response_body    jsonb,
  locked_until     timestamptz(6),
  expires_at       timestamptz(6) NOT NULL,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_key_pkey PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_key_request_sha256_check CHECK (octet_length(request_sha256) = 32),
  CONSTRAINT idempotency_key_completed_check CHECK (status = 'in_progress' OR response_status IS NOT NULL)
);
COMMENT ON TABLE platform.idempotency_key IS 'Durable tier behind Redis (contract §3). scope = actorKey|METHOD|path; replays within 24 h return the stored response.';
CREATE INDEX idempotency_key_expires_at_idx ON platform.idempotency_key (expires_at);

CREATE TRIGGER attachment_set_updated_at BEFORE UPDATE ON platform.attachment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER idempotency_key_set_updated_at BEFORE UPDATE ON platform.idempotency_key FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON platform.audit_log FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER domain_event_append_only BEFORE UPDATE OR DELETE ON platform.domain_event FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
-- TRUNCATE bypasses row triggers: forbid it too on the append-only logs.
CREATE OR REPLACE FUNCTION platform.deny_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'core.append_only: %.% cannot be truncated', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON platform.audit_log FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
CREATE TRIGGER domain_event_no_truncate BEFORE TRUNCATE ON platform.domain_event FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
