-- 0005_platform_files_audit_events — file objects, attachments, audit log, domain events, outbox, idempotency
-- keys (schema-design §3.1.3, §3.1.4; D-025, D-040, D-147, contract §3). No native partitioning in R1 (D-147).

-- §3.1.3 file_objects — one row per S3 object (private by default). property_id FK in B2.1.
CREATE TABLE file_objects (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL DEFAULT uuidv7(),
  org_id          bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  property_id     bigint,
  bucket          text NOT NULL,
  object_key      text NOT NULL,
  retention_class file_retention_class NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          bytea,
  width           integer,
  height          integer,
  scan_status     file_scan_status NOT NULL DEFAULT 'pending',
  scanned_at      timestamptz,
  upload_state    file_upload_state NOT NULL DEFAULT 'presigned',
  uploaded_at     timestamptz,
  thumbnail_key   text,
  expires_at      timestamptz,
  deleted_at      timestamptz,
  delete_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint,
  CONSTRAINT file_objects_public_id_key UNIQUE (public_id),
  CONSTRAINT file_objects_object_key_key UNIQUE (object_key),
  CONSTRAINT file_objects_size_bytes_check CHECK (size_bytes > 0),
  CONSTRAINT file_objects_sha256_check CHECK (sha256 IS NULL OR length(sha256) = 32),
  CONSTRAINT file_objects_verified_has_sha_check CHECK (upload_state <> 'verified' OR sha256 IS NOT NULL),
  CONSTRAINT file_objects_dimensions_check CHECK ((width IS NULL) = (height IS NULL) AND coalesce(width, 1) > 0 AND coalesce(height, 1) > 0)
);
CREATE INDEX file_objects_org_id_retention_class_created_at_idx ON file_objects (org_id, retention_class, created_at);
CREATE INDEX file_objects_expires_at_idx ON file_objects (expires_at) WHERE deleted_at IS NULL;
CREATE INDEX file_objects_sha256_idx ON file_objects (sha256);

-- Deferred FKs now that file_objects exists.
ALTER TABLE orgs ADD CONSTRAINT orgs_logo_file_id_fkey
  FOREIGN KEY (logo_file_id) REFERENCES file_objects (id) ON DELETE SET NULL;
ALTER TABLE tariff_versions ADD CONSTRAINT tariff_versions_source_document_file_id_fkey
  FOREIGN KEY (source_document_file_id) REFERENCES file_objects (id) ON DELETE SET NULL;

-- attachments — polymorphic link file ↔ business row (open-ended photo sets; mandatory files use a direct FK)
CREATE TABLE attachments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  file_object_id bigint NOT NULL REFERENCES file_objects (id) ON DELETE RESTRICT,
  subject_type   text NOT NULL,
  subject_id     bigint NOT NULL,
  role           text NOT NULL,
  position       smallint NOT NULL DEFAULT 0,
  caption        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint,
  CONSTRAINT attachments_file_subject_role_key UNIQUE (file_object_id, subject_type, subject_id, role)
);
CREATE INDEX attachments_subject_type_subject_id_idx ON attachments (subject_type, subject_id);
CREATE INDEX attachments_org_id_idx ON attachments (org_id);

-- §3.1.4 audit_logs ⟲ — security, money and PDPA actions; never updated/deleted (trigger in 0008).
CREATE TABLE audit_logs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         uuid NOT NULL DEFAULT uuidv7(),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  org_id            bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  property_id       bigint,
  actor             jsonb NOT NULL,
  action            text NOT NULL,
  subject_type      text,
  subject_id        bigint,
  subject_public_id uuid,
  outcome           audit_outcome NOT NULL,
  request_id        text,
  ip                inet,
  user_agent        text,
  support_grant_id  bigint REFERENCES support_grants (id) ON DELETE RESTRICT,
  before            jsonb,
  after             jsonb,
  metadata          jsonb,
  CONSTRAINT audit_logs_public_id_key UNIQUE (public_id),
  CONSTRAINT audit_logs_action_check CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
CREATE INDEX audit_logs_org_id_occurred_at_idx ON audit_logs (org_id, occurred_at DESC);
CREATE INDEX audit_logs_subject_type_subject_id_idx ON audit_logs (subject_type, subject_id);
CREATE INDEX audit_logs_actor_public_id_occurred_at_idx ON audit_logs ((actor ->> 'publicId'), occurred_at);
CREATE INDEX audit_logs_action_occurred_at_idx ON audit_logs (action, occurred_at);
CREATE INDEX audit_logs_support_grant_id_idx ON audit_logs (support_grant_id);

-- domain_events ⟲ — every state change (envelope §4.7); public_id is the envelope id generated in code (uuidv7)
CREATE TABLE domain_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      uuid NOT NULL,
  type           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  org_id         bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  property_id    bigint,
  actor          jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid,
  causation_id   uuid,
  payload        jsonb NOT NULL DEFAULT '{}',
  schema_version smallint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_events_public_id_key UNIQUE (public_id),
  CONSTRAINT domain_events_type_check CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id, occurred_at);
CREATE INDEX domain_events_org_id_type_occurred_at_idx ON domain_events (org_id, type, occurred_at);
CREATE INDEX domain_events_correlation_id_idx ON domain_events (correlation_id);

-- outbox_messages — relay queue for domain_events (written in the same transaction)
CREATE TABLE outbox_messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES domain_events (id) ON DELETE RESTRICT,
  topic           text NOT NULL,
  state           outbox_state NOT NULL DEFAULT 'pending',
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_messages_event_id_key UNIQUE (event_id),
  CONSTRAINT outbox_messages_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX outbox_messages_due_idx ON outbox_messages (state, next_attempt_at) WHERE state IN ('pending', 'failed');
CREATE INDEX outbox_messages_created_at_idx ON outbox_messages (created_at);

-- idempotency_keys — durable tier behind Redis (contract §3; src/common/idempotency/prisma-idempotency.store.ts)
CREATE TABLE idempotency_keys (
  scope            text NOT NULL,
  key              uuid NOT NULL,
  request_sha256   bytea NOT NULL,
  status           idempotency_status NOT NULL DEFAULT 'in_progress',
  response_status  smallint,
  response_headers jsonb,
  response_body    jsonb,
  locked_until     timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_keys_request_sha256_check CHECK (length(request_sha256) = 32),
  CONSTRAINT idempotency_keys_completed_check CHECK (status <> 'completed' OR response_status IS NOT NULL)
);
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
