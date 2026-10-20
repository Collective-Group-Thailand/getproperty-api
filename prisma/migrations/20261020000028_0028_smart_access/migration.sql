-- getproperty-api 0028 — B5.2 access control (D-070, D-071, D-024, D-157, D-162, D-025):
--   smart.lock                a lock / door controller (core.asset_item category lock + smart.device kind lock) with its
--                             vendor id, place (unit / building door / common area) and battery;
--   smart.access_credential   app keys, PIN codes, cards of residents (follow the LEASE only), owners, staff,
--                             technicians (work-order window) and visitors (time-boxed); PINs encrypted per tenant;
--   smart.access_event        unlock events, native monthly range partitions (D-162) like smart.telemetry_point.
-- D-071 / D-024: nothing here references receivables or invoices — access ends with the lease, never for arrears.
-- Deviations (schema-design §7.5 rows 81–83): smart.lock (new); credential + lock_id, unit_id, holder_user_id,
-- holder_name, nullable holder_party_id (visitors / staff logins), pin_enc, vendor sync columns; event + id, unit_id,
-- lock_id, received_at, detail; access_source + fingerprint; lock_vendor without hikvision/zkteco adapters yet.

CREATE TYPE smart.lock_vendor AS ENUM ('ttlock', 'tuya', 'hikvision', 'zkteco', 'other');
CREATE TYPE smart.lock_scope AS ENUM ('unit', 'building_door', 'common_area');
CREATE TYPE smart.access_holder_kind AS ENUM ('resident', 'staff', 'visitor', 'owner', 'technician');
CREATE TYPE smart.credential_type AS ENUM ('app', 'pin', 'card', 'fingerprint', 'face', 'qr');
CREATE TYPE smart.credential_status AS ENUM ('pending', 'active', 'revoked', 'expired', 'failed');
CREATE TYPE smart.access_result AS ENUM ('success', 'denied', 'error');
CREATE TYPE smart.access_source AS ENUM ('app', 'pin', 'card', 'remote', 'vendor_sync', 'face', 'qr', 'fingerprint');

-- ------------------------------------------------------------------------------------------------------- locks
CREATE TABLE smart.lock (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  unit_id              uuid,
  device_id            uuid NOT NULL,
  asset_item_id        uuid NOT NULL,
  scope                smart.lock_scope NOT NULL,
  vendor               smart.lock_vendor NOT NULL,
  vendor_lock_id       text NOT NULL,
  name                 text NOT NULL,
  battery_pct          smallint,
  battery_checked_at   timestamptz(6),
  battery_low_since    timestamptz(6),
  online               boolean,
  last_log_sync_at     timestamptz(6),
  is_active            boolean NOT NULL DEFAULT true,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT lock_pkey PRIMARY KEY (id),
  CONSTRAINT lock_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lock_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lock_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lock_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lock_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT lock_scope_check CHECK ((scope = 'unit') = (unit_id IS NOT NULL)),
  CONSTRAINT lock_battery_check CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100)
);
COMMENT ON TABLE smart.lock IS 'A smart lock / door controller (D-070): the asset item (category lock) and device (kind lock) with the vendor''s lock id, its place (a unit, a building door, a common area) and battery. No column or command can lock a resident out for arrears (D-024, D-071).';
CREATE UNIQUE INDEX lock_device_id_key ON smart.lock (device_id);
CREATE UNIQUE INDEX lock_asset_item_id_key ON smart.lock (asset_item_id);
CREATE UNIQUE INDEX lock_vendor_vendor_lock_id_key ON smart.lock (vendor, vendor_lock_id);
CREATE INDEX lock_tenant_id_building_id_idx ON smart.lock (tenant_id, building_id);
CREATE INDEX lock_building_id_idx ON smart.lock (building_id);
CREATE INDEX lock_unit_id_idx ON smart.lock (unit_id);
CREATE TRIGGER lock_set_updated_at BEFORE UPDATE ON smart.lock FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------------- credentials
CREATE TABLE smart.access_credential (
  id                      uuid NOT NULL DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  building_id             uuid NOT NULL,
  unit_id                 uuid,
  lock_id                 uuid NOT NULL,
  device_id               uuid NOT NULL,
  holder_kind             smart.access_holder_kind NOT NULL,
  holder_party_id         uuid,
  holder_user_id          uuid,
  holder_name             text NOT NULL,
  lease_id                uuid,
  work_order_id           uuid,
  type                    smart.credential_type NOT NULL,
  vendor                  smart.lock_vendor NOT NULL,
  vendor_credential_ref   text,
  pin_enc                 bytea,
  valid_from              timestamptz(6) NOT NULL,
  valid_to                timestamptz(6),
  status                  smart.credential_status NOT NULL DEFAULT 'pending',
  vendor_synced_at        timestamptz(6),
  vendor_error            text,
  revoked_at              timestamptz(6),
  revoked_by              uuid,
  revoke_reason           text,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  CONSTRAINT access_credential_pkey PRIMARY KEY (id),
  CONSTRAINT access_credential_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES smart.lock (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_device_id_fkey FOREIGN KEY (device_id) REFERENCES smart.device (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_holder_party_id_fkey FOREIGN KEY (holder_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_holder_user_id_fkey FOREIGN KEY (holder_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES ops.work_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT access_credential_resident_check CHECK (holder_kind <> 'resident' OR (lease_id IS NOT NULL AND holder_party_id IS NOT NULL)),
  CONSTRAINT access_credential_technician_check CHECK (holder_kind <> 'technician' OR work_order_id IS NOT NULL),
  CONSTRAINT access_credential_timeboxed_check CHECK (holder_kind IN ('resident', 'owner') OR valid_to IS NOT NULL),
  CONSTRAINT access_credential_window_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT access_credential_revoked_check CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
COMMENT ON TABLE smart.access_credential IS 'Access credentials (D-070, D-071): residents for the lease period (created at activation, revoked at lease end or by an owner with a reason — never for arrears, D-024), staff / technicians (work-order window) and visitors time-boxed. PINs are encrypted with the tenant key; vendor calls run after the commit (pending → active / failed, retried).';
CREATE INDEX access_credential_device_id_status_idx ON smart.access_credential (device_id, status);
CREATE INDEX access_credential_lease_id_idx ON smart.access_credential (lease_id);
CREATE INDEX access_credential_work_order_id_idx ON smart.access_credential (work_order_id);
CREATE INDEX access_credential_lock_id_idx ON smart.access_credential (lock_id);
CREATE INDEX access_credential_tenant_id_building_id_status_idx ON smart.access_credential (tenant_id, building_id, status);
CREATE INDEX access_credential_building_id_idx ON smart.access_credential (building_id);
CREATE INDEX access_credential_unit_id_idx ON smart.access_credential (unit_id);
CREATE INDEX access_credential_holder_party_id_idx ON smart.access_credential (holder_party_id);
CREATE INDEX access_credential_holder_user_id_idx ON smart.access_credential (holder_user_id);
CREATE TRIGGER access_credential_set_updated_at BEFORE UPDATE ON smart.access_credential FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- -------------------------------------------------------------------------------- unlock events (partitioned)
CREATE TABLE smart.access_event (
  id                uuid NOT NULL DEFAULT uuidv7(),
  time              timestamptz(6) NOT NULL,
  received_at       timestamptz(6) NOT NULL DEFAULT now(),
  tenant_id         uuid NOT NULL,
  building_id       uuid NOT NULL,
  unit_id           uuid,
  lock_id           uuid NOT NULL,
  device_id         uuid NOT NULL,
  credential_id     uuid,
  holder_party_id   uuid,
  result            smart.access_result NOT NULL,
  source            smart.access_source NOT NULL,
  vendor_event_id   text,
  detail            jsonb,
  CONSTRAINT access_event_pkey PRIMARY KEY (id, time)
) PARTITION BY RANGE (time);
COMMENT ON TABLE smart.access_event IS 'Unlock events (D-070) read from the vendors; monthly range partitions (D-162), no FKs on the write path. Residents read only their own unit''s events through the API (D-025).';
CREATE UNIQUE INDEX access_event_device_id_vendor_event_id_time_key ON smart.access_event (device_id, vendor_event_id, time);
CREATE INDEX access_event_device_id_time_idx ON smart.access_event (device_id, time DESC);
CREATE INDEX access_event_unit_id_time_idx ON smart.access_event (unit_id, time DESC);
CREATE INDEX access_event_tenant_id_building_id_time_idx ON smart.access_event (tenant_id, building_id, time DESC);
CREATE INDEX access_event_credential_id_idx ON smart.access_event (credential_id);

-- the partition helpers of 0016 now also serve smart.access_event
CREATE OR REPLACE FUNCTION smart.ensure_month_partition(parent regclass, at timestamptz) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  first_day date := date_trunc('month', at AT TIME ZONE 'UTC')::date;
  part text;
BEGIN
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass, 'smart.access_event'::regclass) THEN
    RAISE EXCEPTION 'ensure_month_partition: % is not a partitioned smart table', parent;
  END IF;
  part := (SELECT relname FROM pg_class WHERE oid = parent) || '_' || to_char(first_day, 'YYYYMM');
  IF to_regclass('smart.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE smart.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', part, parent,
                   (first_day::timestamp AT TIME ZONE 'UTC'), ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
    EXECUTE format('ALTER TABLE smart.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE smart.%I FORCE ROW LEVEL SECURITY', part);
  END IF;
  RETURN part;
END
$$;

CREATE OR REPLACE FUNCTION smart.drop_month_partitions_before(parent regclass, cutoff timestamptz) RETURNS text[]
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  base text;
  r record;
  dropped text[] := '{}';
BEGIN
  IF parent NOT IN ('smart.telemetry_point'::regclass, 'smart.device_health_sample'::regclass, 'smart.access_event'::regclass) THEN
    RAISE EXCEPTION 'drop_month_partitions_before: % is not a partitioned smart table', parent;
  END IF;
  base := (SELECT relname FROM pg_class WHERE oid = parent);
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = parent AND c.relname ~ ('^' || base || '_\d{6}$')
  LOOP
    IF (to_date(right(r.relname, 6), 'YYYYMM') + interval '1 month')::timestamp AT TIME ZONE 'UTC' <= cutoff THEN
      EXECUTE format('DROP TABLE smart.%I', r.relname);
      dropped := dropped || r.relname;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('smart.lock', 'unit', 'smart.access');
SELECT platform.apply_rls('smart.access_credential', 'unit', 'smart.access');
SELECT platform.apply_rls('smart.access_event', 'unit', 'smart.access');

GRANT SELECT, INSERT, UPDATE, DELETE ON smart.lock, smart.access_credential TO gp_app, gp_platform;
GRANT SELECT, INSERT ON smart.access_event TO gp_app, gp_platform;
GRANT SELECT ON smart.lock, smart.access_credential, smart.access_event TO gp_reporting;
