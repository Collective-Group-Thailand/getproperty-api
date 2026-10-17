-- getproperty-api 0015 (B3.1) — device registry completion: meter channels (gateway bus wiring over time), compiled
-- gateway configs (retained on MQTT), meter swaps, OTA releases / rollouts per ring, device commands and the
-- current health of each meter (schema-design v2 §3.4.1, §7.3). smart.device / device_certificate /
-- provisioning_code / mqtt_acl exist since 0010 (B1.3). Reading FKs of meter_swap / meter_status arrive with 0017
-- (B3.3). No command, column or enum value can cut power (D-024, D-157). Deviations: schema-design §7.5 rows 31–35.

CREATE TYPE smart.bus_type AS ENUM ('modbus_rtu', 'gpio', 'lorawan', 'nb_iot', 'vendor_cloud');
CREATE TYPE smart.register_map AS ENUM ('driver_default', 'custom');
CREATE TYPE smart.ota_channel AS ENUM ('stable', 'beta', 'canary');
CREATE TYPE smart.rollout_status AS ENUM ('planned', 'running', 'paused', 'completed', 'rolled_back', 'aborted');
CREATE TYPE smart.ota_device_status AS ENUM ('queued', 'commanded', 'started', 'applied', 'rolled_back', 'failed');
CREATE TYPE smart.command_type AS ENUM ('read_now', 'restart', 'ota_apply', 'upload_logs', 'set_log_level', 'identify');
CREATE TYPE smart.command_status AS ENUM ('queued', 'sent', 'accepted', 'done', 'failed', 'expired');
CREATE TYPE smart.meter_health AS ENUM ('ok', 'stale', 'silent', 'no_device', 'unknown');

-- The gateway's CPU architecture (OTA artefacts are per architecture) and its bus settings (GatewayConfig.buses).
ALTER TABLE smart.device
  ADD COLUMN arch text,
  ADD COLUMN bus_config jsonb NOT NULL DEFAULT '[]',
  ADD CONSTRAINT device_arch_check CHECK (arch IS NULL OR arch IN ('arm64', 'x64', 'armv7')),
  ADD CONSTRAINT device_bus_config_check CHECK (jsonb_typeof(bus_config) = 'array');
-- An inventory device may be retired without ever leaving the platform inventory.
ALTER TABLE smart.device DROP CONSTRAINT device_inventory_tenant_check;
ALTER TABLE smart.device ADD CONSTRAINT device_inventory_tenant_check CHECK (status IN ('inventory', 'retired') OR tenant_id IS NOT NULL);
COMMENT ON COLUMN smart.device.bus_config IS 'Gateways only: BusConfig[] of the device protocol (id, type, device, baud, parity); buses referenced by channels but missing here get the protocol defaults.';

CREATE TABLE smart.meter_channel (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  meter_asset_item_id uuid NOT NULL,
  meter_device_id     uuid,
  gateway_device_id   uuid NOT NULL,
  driver              text NOT NULL,
  bus_id              text NOT NULL,
  bus_type            smart.bus_type NOT NULL,
  address             smallint,
  pin                 smallint,
  register_map        smart.register_map NOT NULL DEFAULT 'driver_default',
  custom_register_map jsonb,
  scale               numeric(12,6) NOT NULL DEFAULT 1,
  litres_per_pulse    numeric(8,3),
  valid_from          timestamptz(6) NOT NULL,
  valid_to            timestamptz(6),
  unbound_reason      text,
  bound_by            uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT meter_channel_pkey PRIMARY KEY (id),
  CONSTRAINT meter_channel_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_channel_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_channel_meter_asset_item_id_fkey FOREIGN KEY (meter_asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_channel_meter_device_id_fkey FOREIGN KEY (meter_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_channel_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_channel_driver_check CHECK (driver ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT meter_channel_bus_id_check CHECK (bus_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  CONSTRAINT meter_channel_wiring_check CHECK (
    (bus_type = 'modbus_rtu' AND address BETWEEN 1 AND 247 AND pin IS NULL)
    OR (bus_type = 'gpio' AND pin BETWEEN 0 AND 255 AND address IS NULL AND litres_per_pulse > 0)
    OR bus_type IN ('lorawan', 'nb_iot', 'vendor_cloud')),
  CONSTRAINT meter_channel_custom_map_check CHECK ((register_map = 'custom') = (custom_register_map IS NOT NULL)),
  CONSTRAINT meter_channel_scale_check CHECK (scale > 0),
  CONSTRAINT meter_channel_period_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT meter_channel_unbound_check CHECK (valid_to IS NULL OR unbound_reason IS NOT NULL),
  CONSTRAINT meter_channel_meter_period_excl EXCLUDE USING gist (meter_asset_item_id WITH =, tstzrange(valid_from, valid_to) WITH &&),
  CONSTRAINT meter_channel_device_period_excl EXCLUDE USING gist (meter_device_id WITH =, tstzrange(valid_from, valid_to) WITH &&) WHERE (meter_device_id IS NOT NULL),
  -- one meter per bus address / GPIO pin of a gateway at a time (the gateway would read the wrong meter otherwise)
  CONSTRAINT meter_channel_bus_address_excl EXCLUDE USING gist (gateway_device_id WITH =, bus_id WITH =, address WITH =, tstzrange(valid_from, valid_to) WITH &&) WHERE (address IS NOT NULL),
  CONSTRAINT meter_channel_bus_pin_excl EXCLUDE USING gist (gateway_device_id WITH =, bus_id WITH =, pin WITH =, tstzrange(valid_from, valid_to) WITH &&) WHERE (pin IS NOT NULL)
);
COMMENT ON TABLE smart.meter_channel IS 'How a gateway reads a meter over time (D-131): bus, address/pin, driver, register map, scale, litres per pulse; one open channel per meter asset item and per meter device.';
CREATE INDEX meter_channel_gateway_device_id_idx ON smart.meter_channel (gateway_device_id) WHERE (valid_to IS NULL);
CREATE INDEX meter_channel_tenant_id_building_id_idx ON smart.meter_channel (tenant_id, building_id);
CREATE INDEX meter_channel_meter_asset_item_id_idx ON smart.meter_channel (meter_asset_item_id);
CREATE INDEX meter_channel_meter_device_id_idx ON smart.meter_channel (meter_device_id);

CREATE TABLE smart.gateway_config (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  gateway_device_id uuid NOT NULL,
  version           integer NOT NULL,
  document          jsonb NOT NULL,
  document_sha256   bytea NOT NULL,
  compiled_at       timestamptz(6) NOT NULL DEFAULT now(),
  published_at      timestamptz(6),
  applied_at        timestamptz(6),
  rejected_at       timestamptz(6),
  reject_error      text,
  drift_flagged_at  timestamptz(6),
  created_by        uuid,
  CONSTRAINT gateway_config_pkey PRIMARY KEY (id),
  CONSTRAINT gateway_config_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gateway_config_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gateway_config_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT gateway_config_version_check CHECK (version >= 1),
  CONSTRAINT gateway_config_sha_check CHECK (length(document_sha256) = 32),
  CONSTRAINT gateway_config_document_check CHECK ((document ->> 'version')::int = version)
);
COMMENT ON TABLE smart.gateway_config IS 'Compiled GatewayConfig documents (D-131): published retained on gp/v1/<gatewayId>/config, applied when the gateway reports config_applied.';
CREATE UNIQUE INDEX gateway_config_gateway_device_id_version_key ON smart.gateway_config (gateway_device_id, version);
CREATE INDEX gateway_config_tenant_id_building_id_idx ON smart.gateway_config (tenant_id, building_id);

CREATE TABLE smart.meter_swap (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  unit_id               uuid,
  old_assignment_id     uuid NOT NULL,
  new_assignment_id     uuid NOT NULL,
  old_device_id         uuid,
  new_device_id         uuid,
  old_last_register     numeric(12,3) NOT NULL,
  old_last_reading_id   uuid,
  new_first_register    numeric(12,3) NOT NULL,
  new_first_reading_id  uuid,
  swapped_at            timestamptz(6) NOT NULL,
  performed_by          uuid,
  reason                text NOT NULL,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  CONSTRAINT meter_swap_pkey PRIMARY KEY (id),
  CONSTRAINT meter_swap_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_old_assignment_id_fkey FOREIGN KEY (old_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_new_assignment_id_fkey FOREIGN KEY (new_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_old_device_id_fkey FOREIGN KEY (old_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_new_device_id_fkey FOREIGN KEY (new_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_swap_registers_check CHECK (old_last_register >= 0 AND new_first_register >= 0),
  CONSTRAINT meter_swap_assignments_check CHECK (old_assignment_id <> new_assignment_id),
  CONSTRAINT meter_swap_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500)
);
COMMENT ON TABLE smart.meter_swap IS 'A meter replacement keeps history (D-033): closes one core.meter_assignment with the last old register and opens the next with the first new register at the same instant; both readings carry photos.';
CREATE UNIQUE INDEX meter_swap_old_assignment_id_key ON smart.meter_swap (old_assignment_id);
CREATE UNIQUE INDEX meter_swap_new_assignment_id_key ON smart.meter_swap (new_assignment_id);
CREATE INDEX meter_swap_tenant_id_building_id_idx ON smart.meter_swap (tenant_id, building_id);
CREATE INDEX meter_swap_unit_id_idx ON smart.meter_swap (unit_id);

CREATE TABLE smart.ota_release (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  version              text NOT NULL,
  arch                 text NOT NULL,
  channel              smart.ota_channel NOT NULL DEFAULT 'stable',
  artifact_url         text NOT NULL,
  artifact_document_id uuid,
  artifact_sha256      bytea NOT NULL,
  size_bytes           bigint NOT NULL,
  min_agent_version    text,
  manifest             jsonb NOT NULL,
  signature_key_id     text NOT NULL,
  signature            bytea NOT NULL,
  release_notes        text,
  released_at          timestamptz(6) NOT NULL,
  published_at         timestamptz(6),
  deprecated_at        timestamptz(6),
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT ota_release_pkey PRIMARY KEY (id),
  CONSTRAINT ota_release_artifact_document_id_fkey FOREIGN KEY (artifact_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ota_release_version_check CHECK (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  CONSTRAINT ota_release_arch_check CHECK (arch IN ('arm64', 'x64', 'armv7')),
  CONSTRAINT ota_release_url_check CHECK (artifact_url LIKE 'https://%'),
  CONSTRAINT ota_release_sha_check CHECK (length(artifact_sha256) = 32),
  CONSTRAINT ota_release_size_check CHECK (size_bytes > 0)
);
COMMENT ON TABLE smart.ota_release IS 'Signed agent releases (D-131): the ed25519-signed manifest of getproperty-edge per version and architecture, served by GET /v1/device/ota/manifest.';
CREATE UNIQUE INDEX ota_release_version_arch_key ON smart.ota_release (version, arch);

CREATE TABLE smart.ota_rollout (
  id               uuid NOT NULL DEFAULT uuidv7(),
  release_id       uuid NOT NULL,
  ring             smart.ota_ring NOT NULL,
  status           smart.rollout_status NOT NULL DEFAULT 'planned',
  started_at       timestamptz(6),
  finished_at      timestamptz(6),
  max_failures_pct numeric(5,2) NOT NULL DEFAULT 10,
  notes            text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT ota_rollout_pkey PRIMARY KEY (id),
  CONSTRAINT ota_rollout_release_id_fkey FOREIGN KEY (release_id) REFERENCES smart.ota_release (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ota_rollout_failures_check CHECK (max_failures_pct BETWEEN 0 AND 100),
  CONSTRAINT ota_rollout_started_check CHECK (status = 'planned' OR started_at IS NOT NULL)
);
COMMENT ON TABLE smart.ota_rollout IS 'A release rolled out to one fleet ring (canary → pilot → all, D-131); pauses itself above max_failures_pct.';
CREATE INDEX ota_rollout_release_id_idx ON smart.ota_rollout (release_id);

CREATE TABLE smart.device_command (
  id                uuid NOT NULL,
  tenant_id         uuid,
  building_id       uuid,
  gateway_device_id uuid NOT NULL,
  type              smart.command_type NOT NULL,
  args              jsonb NOT NULL DEFAULT '{}',
  issued_at         timestamptz(6) NOT NULL,
  ttl_s             integer NOT NULL DEFAULT 300,
  expires_at        timestamptz(6) NOT NULL,
  attempts          smallint NOT NULL DEFAULT 0,
  issued_by         uuid,
  status            smart.command_status NOT NULL DEFAULT 'queued',
  sent_at           timestamptz(6),
  acked_at          timestamptz(6),
  finished_at       timestamptz(6),
  result            jsonb,
  error             text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT device_command_pkey PRIMARY KEY (id),
  CONSTRAINT device_command_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_command_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_command_gateway_device_id_fkey FOREIGN KEY (gateway_device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT device_command_ttl_check CHECK (ttl_s BETWEEN 1 AND 86400 AND expires_at > issued_at),
  CONSTRAINT device_command_attempts_check CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT device_command_args_check CHECK (jsonb_typeof(args) = 'object'),
  CONSTRAINT device_command_finished_check CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL) OR status = 'expired')
);
COMMENT ON TABLE smart.device_command IS 'Command / CommandAck of the device protocol (§2, §4): expires after ttl_s, re-sent up to 3 times while unacknowledged. There is no cut-off command (D-024, D-157).';
CREATE INDEX device_command_gateway_device_id_status_idx ON smart.device_command (gateway_device_id, status);
CREATE INDEX device_command_status_expires_at_idx ON smart.device_command (status, expires_at) WHERE (status = ANY (ARRAY['queued'::smart.command_status, 'sent'::smart.command_status, 'accepted'::smart.command_status]));
CREATE INDEX device_command_tenant_id_building_id_idx ON smart.device_command (tenant_id, building_id);

CREATE TABLE smart.ota_rollout_device (
  id           uuid NOT NULL DEFAULT uuidv7(),
  rollout_id   uuid NOT NULL,
  device_id    uuid NOT NULL,
  command_id   uuid,
  status       smart.ota_device_status NOT NULL DEFAULT 'queued',
  from_version text,
  to_version   text NOT NULL,
  error        text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT ota_rollout_device_pkey PRIMARY KEY (id),
  CONSTRAINT ota_rollout_device_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES smart.ota_rollout (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT ota_rollout_device_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ota_rollout_device_command_id_fkey FOREIGN KEY (command_id) REFERENCES smart.device_command (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX ota_rollout_device_rollout_id_device_id_key ON smart.ota_rollout_device (rollout_id, device_id);
CREATE INDEX ota_rollout_device_device_id_idx ON smart.ota_rollout_device (device_id);
CREATE INDEX ota_rollout_device_command_id_idx ON smart.ota_rollout_device (command_id);

CREATE TABLE smart.meter_status (
  asset_item_id     uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  health            smart.meter_health NOT NULL DEFAULT 'unknown',
  health_changed_at timestamptz(6) NOT NULL DEFAULT now(),
  last_reading_at   timestamptz(6),
  last_reading_id   uuid,
  last_telemetry_at timestamptz(6),
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT meter_status_pkey PRIMARY KEY (asset_item_id),
  CONSTRAINT meter_status_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_status_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT meter_status_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE smart.meter_status IS 'Current health of each meter asset item (D-034): ok | stale | silent | no_device, computed every 5 minutes by the meter-health job.';
CREATE INDEX meter_status_tenant_id_building_id_health_idx ON smart.meter_status (tenant_id, building_id, health);

CREATE TRIGGER meter_channel_set_updated_at BEFORE UPDATE ON smart.meter_channel FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER ota_release_set_updated_at BEFORE UPDATE ON smart.ota_release FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER ota_rollout_set_updated_at BEFORE UPDATE ON smart.ota_rollout FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER ota_rollout_device_set_updated_at BEFORE UPDATE ON smart.ota_rollout_device FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER device_command_set_updated_at BEFORE UPDATE ON smart.device_command FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER meter_status_set_updated_at BEFORE UPDATE ON smart.meter_status FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Row-level security (schema-design §4.5).
SELECT platform.apply_rls('smart.meter_channel', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.gateway_config', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.meter_swap', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.device_command', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.meter_status', 'building', 'smart.metering');
SELECT platform.apply_rls('smart.ota_release', 'platform');
SELECT platform.apply_rls('smart.ota_rollout', 'platform_only');
SELECT platform.apply_rls('smart.ota_rollout_device', 'platform_only');

GRANT SELECT, INSERT, UPDATE, DELETE ON smart.meter_channel, smart.gateway_config, smart.meter_swap, smart.device_command,
  smart.meter_status, smart.ota_release, smart.ota_rollout, smart.ota_rollout_device TO gp_app, gp_platform;
GRANT SELECT ON smart.meter_channel, smart.gateway_config, smart.meter_swap, smart.meter_status TO gp_reporting;
REVOKE INSERT, UPDATE, DELETE ON smart.ota_release FROM gp_app;
