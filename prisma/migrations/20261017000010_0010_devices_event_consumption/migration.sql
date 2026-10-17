-- getproperty-api 0010 (B1.3) — what identity, the outbox and device bootstrap need before B3.1:
--   * smart.device, smart.device_certificate ⟲, smart.provisioning_code (schema-design v2 §3.4.1, pulled forward
--     from B3.1 because `POST /v1/device/bootstrap` is a B1.3 endpoint; B3.1 adds the remaining device tables);
--   * smart.mqtt_acl — the EMQX authorization source (device protocol §1: a gateway publishes only to
--     gp/v1/<gatewayId>/+ and subscribes only to …/config and …/cmd), read by the broker as role gp_mqtt;
--   * platform.event_consumption — per-subscriber inbox of the outbox relay (exactly-once delivery, dead letters,
--     admin replay — §4.8 "subscribers are idempotent on event.id");
--   * the FK platform.auth_session.device_id → smart.device announced in 0003.
-- Deviations are recorded in schema-design §7.5 (rows 17–20).

CREATE TYPE smart.device_kind AS ENUM ('gateway', 'electric_meter', 'water_meter', 'lock', 'breaker', 'sensor', 'door_controller', 'camera');
CREATE TYPE smart.device_ownership AS ENUM ('platform_haas', 'tenant_owned');
CREATE TYPE smart.device_status AS ENUM ('inventory', 'assigned', 'provisioned', 'online', 'degraded', 'offline', 'retired');
CREATE TYPE smart.ota_ring AS ENUM ('canary', 'pilot', 'all');
CREATE TYPE smart.mqtt_permission AS ENUM ('allow', 'deny');
CREATE TYPE smart.mqtt_action AS ENUM ('publish', 'subscribe', 'all');
CREATE TYPE platform.consumption_state AS ENUM ('processed', 'failed', 'dead');

CREATE TABLE smart.device (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  serial                 citext NOT NULL,
  kind                   smart.device_kind NOT NULL,
  model                  text NOT NULL,
  vendor                 text NOT NULL,
  driver                 text,
  firmware_version       text,
  hardware_rev           text,
  ownership              smart.device_ownership NOT NULL DEFAULT 'platform_haas',
  tenant_id              uuid,
  building_id            uuid,
  asset_item_id          uuid,
  gateway_device_id      uuid,
  status                 smart.device_status NOT NULL DEFAULT 'inventory',
  status_changed_at      timestamptz(6) NOT NULL DEFAULT now(),
  last_seen_at           timestamptz(6),
  cert_fingerprint       bytea,
  cert_not_after         timestamptz(6),
  cert_serial            text,
  mqtt_client_id         text,
  last_seq               bigint,
  config_applied_version integer,
  ota_ring               smart.ota_ring NOT NULL DEFAULT 'all',
  retired_at             timestamptz(6),
  retired_reason         text,
  notes                  text,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer NOT NULL DEFAULT 1,
  CONSTRAINT device_pkey PRIMARY KEY (id),
  CONSTRAINT device_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_gateway_parent_check CHECK (kind <> 'gateway' OR gateway_device_id IS NULL),
  CONSTRAINT device_inventory_tenant_check CHECK (status = 'inventory' OR tenant_id IS NOT NULL),
  CONSTRAINT device_building_tenant_check CHECK (building_id IS NULL OR tenant_id IS NOT NULL),
  CONSTRAINT device_retired_check CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT device_mqtt_client_id_check CHECK (mqtt_client_id IS NULL OR mqtt_client_id = 'gw-' || id::text),
  CONSTRAINT device_last_seq_check CHECK (last_seq IS NULL OR last_seq >= 0)
);
COMMENT ON TABLE smart.device IS 'Every gateway, meter, lock, breaker, sensor (D-033). Inventory rows (tenant_id NULL) are platform-only; no column or command can cut power (D-024, D-157).';
CREATE UNIQUE INDEX device_serial_key ON smart.device (serial);
CREATE UNIQUE INDEX device_asset_item_id_key ON smart.device (asset_item_id);
CREATE UNIQUE INDEX device_mqtt_client_id_key ON smart.device (mqtt_client_id);
CREATE INDEX device_tenant_id_building_id_kind_status_idx ON smart.device (tenant_id, building_id, kind, status);
CREATE INDEX device_status_last_seen_at_idx ON smart.device (status, last_seen_at);
CREATE INDEX device_gateway_device_id_idx ON smart.device (gateway_device_id);
CREATE INDEX device_building_id_idx ON smart.device (building_id);
CREATE INDEX device_serial_trgm_idx ON smart.device USING gin (serial gin_trgm_ops);

CREATE TABLE smart.device_certificate (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  device_id          uuid NOT NULL,
  serial_number      text NOT NULL,
  fingerprint_sha256 bytea NOT NULL,
  subject_cn         text NOT NULL,
  not_before         timestamptz(6) NOT NULL,
  not_after          timestamptz(6) NOT NULL,
  issued_at          timestamptz(6) NOT NULL DEFAULT now(),
  revoked_at         timestamptz(6),
  revoke_reason      text,
  csr_sha256         bytea NOT NULL,
  certificate_pem    text NOT NULL,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  CONSTRAINT device_certificate_pkey PRIMARY KEY (id),
  CONSTRAINT device_certificate_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_certificate_validity_check CHECK (not_after > not_before),
  CONSTRAINT device_certificate_fingerprint_check CHECK (length(fingerprint_sha256) = 32 AND length(csr_sha256) = 32),
  CONSTRAINT device_certificate_revoked_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE smart.device_certificate IS 'Client certificates issued by the platform device CA at bootstrap (D-130); append-only except a single revocation.';
CREATE UNIQUE INDEX device_certificate_serial_number_key ON smart.device_certificate (serial_number);
CREATE UNIQUE INDEX device_certificate_fingerprint_sha256_key ON smart.device_certificate (fingerprint_sha256);
CREATE INDEX device_certificate_device_id_idx ON smart.device_certificate (device_id);

-- Append-only, except that revoked_at/revoke_reason may be set once.
CREATE OR REPLACE FUNCTION smart.device_certificate_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(OLD) - 'revoked_at' - 'revoke_reason') = (to_jsonb(NEW) - 'revoked_at' - 'revoke_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'core.append_only: smart.device_certificate is append-only (% refused)', TG_OP USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER device_certificate_append_only BEFORE UPDATE OR DELETE ON smart.device_certificate
  FOR EACH ROW EXECUTE FUNCTION smart.device_certificate_guard();

CREATE TABLE smart.provisioning_code (
  id               uuid NOT NULL DEFAULT uuidv7(),
  device_id        uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  building_id      uuid NOT NULL,
  code_hash        bytea NOT NULL,
  expires_at       timestamptz(6) NOT NULL,
  consumed_at      timestamptz(6),
  consumed_from_ip inet,
  issued_by        uuid,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_code_pkey PRIMARY KEY (id),
  CONSTRAINT provisioning_code_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT provisioning_code_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT provisioning_code_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT provisioning_code_hash_check CHECK (length(code_hash) = 32),
  CONSTRAINT provisioning_code_expiry_check CHECK (expires_at > created_at)
);
COMMENT ON TABLE smart.provisioning_code IS 'One-time provisioning codes printed on the gateway QR (D-033); stored as HMAC only, consumed by POST /v1/device/bootstrap.';
CREATE UNIQUE INDEX provisioning_code_code_hash_key ON smart.provisioning_code (code_hash);
CREATE INDEX provisioning_code_expires_at_idx ON smart.provisioning_code (expires_at) WHERE (consumed_at IS NULL);
CREATE INDEX provisioning_code_device_id_idx ON smart.provisioning_code (device_id);
CREATE INDEX provisioning_code_tenant_id_building_id_idx ON smart.provisioning_code (tenant_id, building_id);

CREATE TABLE smart.mqtt_acl (
  id          uuid NOT NULL DEFAULT uuidv7(),
  device_id   uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  username    text NOT NULL,
  permission  smart.mqtt_permission NOT NULL DEFAULT 'allow',
  action      smart.mqtt_action NOT NULL,
  topic       text NOT NULL,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  revoked_at  timestamptz(6),
  CONSTRAINT mqtt_acl_pkey PRIMARY KEY (id),
  CONSTRAINT mqtt_acl_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT mqtt_acl_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT mqtt_acl_topic_check CHECK (topic LIKE 'gp/v1/%')
);
COMMENT ON TABLE smart.mqtt_acl IS 'EMQX PostgreSQL authorization source (device protocol §1). EMQX query: SELECT permission, action, topic FROM smart.mqtt_acl WHERE username = ${username} AND revoked_at IS NULL (username = certificate CN gw-<deviceId>).';
CREATE UNIQUE INDEX mqtt_acl_username_action_topic_key ON smart.mqtt_acl (username, action, topic) WHERE (revoked_at IS NULL);
CREATE INDEX mqtt_acl_device_id_idx ON smart.mqtt_acl (device_id);

CREATE TABLE platform.event_consumption (
  id               uuid NOT NULL DEFAULT uuidv7(),
  event_id         uuid NOT NULL,
  subscriber       text NOT NULL,
  state            platform.consumption_state NOT NULL,
  attempts         smallint NOT NULL DEFAULT 1,
  last_error       text,
  first_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  processed_at     timestamptz(6),
  replayed_at      timestamptz(6),
  replayed_by      uuid,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT event_consumption_pkey PRIMARY KEY (id),
  CONSTRAINT event_consumption_event_id_fkey FOREIGN KEY (event_id) REFERENCES platform.domain_event (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT event_consumption_subscriber_check CHECK (subscriber ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT event_consumption_processed_check CHECK ((state = 'processed') = (processed_at IS NOT NULL)),
  CONSTRAINT event_consumption_attempts_check CHECK (attempts >= 1)
);
COMMENT ON TABLE platform.event_consumption IS 'Per-subscriber inbox of the outbox relay: a processed row makes a redelivered event a no-op (exactly-once effects); dead rows are the dead-letter list replayed by the platform admin.';
CREATE UNIQUE INDEX event_consumption_event_id_subscriber_key ON platform.event_consumption (event_id, subscriber);
CREATE INDEX event_consumption_state_updated_at_idx ON platform.event_consumption (state, updated_at) WHERE (state <> 'processed'::platform.consumption_state);

CREATE TRIGGER device_set_updated_at BEFORE UPDATE ON smart.device FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER event_consumption_set_updated_at BEFORE UPDATE ON platform.event_consumption FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE platform.auth_session
  ADD CONSTRAINT auth_session_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX auth_session_device_id_idx ON platform.auth_session (device_id);

-- Row-level security (schema-design §4.5).
SELECT platform.apply_rls('smart.device', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.device_certificate', 'platform_only');
SELECT platform.apply_rls('smart.provisioning_code', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.mqtt_acl', 'platform_only');
SELECT platform.apply_rls('platform.event_consumption', 'platform_only');

-- The broker's database login is a member of gp_mqtt: it reads the ACL rows and nothing else.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gp_mqtt') THEN
    CREATE ROLE gp_mqtt NOLOGIN NOBYPASSRLS;
  END IF;
END
$roles$;
GRANT USAGE ON SCHEMA smart TO gp_mqtt;
GRANT SELECT ON smart.mqtt_acl TO gp_mqtt;
CREATE POLICY mqtt_acl_rls_broker ON smart.mqtt_acl FOR SELECT TO gp_mqtt USING (revoked_at IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON smart.device, smart.device_certificate, smart.provisioning_code, smart.mqtt_acl,
  platform.event_consumption TO gp_app, gp_platform;
GRANT SELECT ON smart.device, smart.provisioning_code TO gp_reporting;
REVOKE ALL ON smart.device_certificate, smart.mqtt_acl, platform.event_consumption FROM gp_reporting;
-- Codes and certificates are issued by the platform surface; the app role cannot read the code hashes.
REVOKE ALL ON smart.provisioning_code FROM gp_app;
