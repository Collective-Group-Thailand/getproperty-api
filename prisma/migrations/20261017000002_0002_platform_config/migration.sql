-- getproperty-api 0002 — platform configuration: settings + effective-dated versions at platform, tenant and
-- property scope (ADR-0004, D-144), feature flags, utility tariffs = the สคบ. cap reference (D-021, D-021a,
-- D-140), business calendar (schema-design v2 §3.2.1, §3.2.2, §3.2.9). RLS in 0009.

CREATE TYPE platform.setting_value_type AS ENUM ('string', 'int', 'decimal', 'bool', 'json', 'duration', 'money', 'date', 'time');
CREATE TYPE platform.setting_scope AS ENUM ('platform', 'tenant', 'property');
CREATE TYPE platform.utility_provider AS ENUM ('mea', 'pea', 'mwa', 'pwa');
CREATE TYPE platform.tariff_version_state AS ENUM ('draft', 'entered', 'verified', 'published', 'superseded');
CREATE TYPE platform.calendar_kind AS ENUM ('th_public', 'th_bank');

CREATE TABLE platform.setting (
  id            uuid NOT NULL DEFAULT uuidv7(),
  key           text NOT NULL,
  value_type    platform.setting_value_type NOT NULL,
  scope_allowed platform.setting_scope[] NOT NULL,
  description   text NOT NULL,
  editable_by   text[] NOT NULL DEFAULT '{}',
  json_schema   jsonb,
  is_secret     boolean NOT NULL DEFAULT false,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_by    uuid,
  CONSTRAINT setting_pkey PRIMARY KEY (id),
  CONSTRAINT setting_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  CONSTRAINT setting_description_check CHECK (description ~ '[DO]-[0-9]{3}'),
  CONSTRAINT setting_scope_allowed_check CHECK (cardinality(scope_allowed) > 0)
);
COMMENT ON TABLE platform.setting IS 'Setting catalogue, one row per key (D-144). description MUST cite the decision id.';
CREATE UNIQUE INDEX setting_key_key ON platform.setting (key);

CREATE TABLE platform.setting_version (
  id             uuid NOT NULL DEFAULT uuidv7(),
  setting_id     uuid NOT NULL,
  value          jsonb NOT NULL,
  effective_from timestamptz(6) NOT NULL,
  effective_to   timestamptz(6),
  reason         text NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT setting_version_pkey PRIMARY KEY (id),
  CONSTRAINT setting_version_setting_id_fkey FOREIGN KEY (setting_id) REFERENCES platform.setting (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT setting_version_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT setting_version_backdated_check CHECK (effective_from >= created_at - interval '5 minutes'),
  CONSTRAINT setting_version_no_overlap EXCLUDE USING gist (setting_id WITH =, tstzrange(effective_from, effective_to) WITH &&)
);
COMMENT ON TABLE platform.setting_version IS 'Effective-dated platform values; effective_to is closed by trigger; never backdated (settings.backdated).';
CREATE UNIQUE INDEX setting_version_setting_id_effective_from_key ON platform.setting_version (setting_id, effective_from);

CREATE TABLE platform.tenant_setting_version (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  setting_id     uuid NOT NULL,
  value          jsonb NOT NULL,
  effective_from timestamptz(6) NOT NULL,
  effective_to   timestamptz(6),
  reason         text NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT tenant_setting_version_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_setting_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tenant_setting_version_setting_id_fkey FOREIGN KEY (setting_id) REFERENCES platform.setting (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT tenant_setting_version_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT tenant_setting_version_backdated_check CHECK (effective_from >= created_at - interval '5 minutes'),
  CONSTRAINT tenant_setting_version_no_overlap EXCLUDE USING gist (tenant_id WITH =, setting_id WITH =, tstzrange(effective_from, effective_to) WITH &&)
);
COMMENT ON TABLE platform.tenant_setting_version IS 'Effective-dated tenant values (billing.cutoff, reminders.schedule, late_fee.enabled, readings.require_photo, …).';
CREATE UNIQUE INDEX tenant_setting_version_tenant_id_setting_id_effective_from_key ON platform.tenant_setting_version (tenant_id, setting_id, effective_from);

CREATE TABLE platform.property_setting_version (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  property_id    uuid NOT NULL,
  setting_id     uuid NOT NULL,
  value          jsonb NOT NULL,
  effective_from timestamptz(6) NOT NULL,
  effective_to   timestamptz(6),
  reason         text NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT property_setting_version_pkey PRIMARY KEY (id),
  CONSTRAINT property_setting_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT property_setting_version_property_id_fkey FOREIGN KEY (property_id) REFERENCES core.property (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT property_setting_version_setting_id_fkey FOREIGN KEY (setting_id) REFERENCES platform.setting (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT property_setting_version_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT property_setting_version_backdated_check CHECK (effective_from >= created_at - interval '5 minutes'),
  CONSTRAINT property_setting_version_no_overlap EXCLUDE USING gist (property_id WITH =, setting_id WITH =, tstzrange(effective_from, effective_to) WITH &&)
);
COMMENT ON TABLE platform.property_setting_version IS 'Effective-dated property values (billing.cutoff, utility.electric_provider, utility.water_provider, health.*).';
CREATE UNIQUE INDEX property_setting_version_property_setting_from_key ON platform.property_setting_version (property_id, setting_id, effective_from);
CREATE INDEX property_setting_version_tenant_id_idx ON platform.property_setting_version (tenant_id);

CREATE TABLE platform.feature_flag (
  id              uuid NOT NULL DEFAULT uuidv7(),
  key             text NOT NULL,
  description     text NOT NULL,
  default_enabled boolean NOT NULL DEFAULT false,
  rollout_pct     smallint NOT NULL DEFAULT 0,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_by      uuid,
  CONSTRAINT feature_flag_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flag_rollout_pct_check CHECK (rollout_pct BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX feature_flag_key_key ON platform.feature_flag (key);

CREATE TABLE platform.feature_flag_override (
  id              uuid NOT NULL DEFAULT uuidv7(),
  feature_flag_id uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  enabled         boolean NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_by      uuid,
  CONSTRAINT feature_flag_override_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flag_override_feature_flag_id_fkey FOREIGN KEY (feature_flag_id) REFERENCES platform.feature_flag (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT feature_flag_override_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX feature_flag_override_feature_flag_id_tenant_id_key ON platform.feature_flag_override (feature_flag_id, tenant_id);
CREATE INDEX feature_flag_override_tenant_id_idx ON platform.feature_flag_override (tenant_id);

CREATE TABLE platform.utility_tariff (
  id          uuid NOT NULL DEFAULT uuidv7(),
  utility     core.utility NOT NULL,
  provider    platform.utility_provider NOT NULL,
  tariff_code text NOT NULL,
  name_th     text NOT NULL,
  name_en     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT utility_tariff_pkey PRIMARY KEY (id),
  CONSTRAINT utility_tariff_provider_utility_check CHECK ((provider IN ('mea', 'pea')) = (utility = 'electric'))
);
COMMENT ON TABLE platform.utility_tariff IS 'One row per (utility, provider, customer class); the สคบ. 2568 cap reference (D-021a).';
CREATE UNIQUE INDEX utility_tariff_provider_tariff_code_key ON platform.utility_tariff (provider, tariff_code);

CREATE TABLE platform.utility_tariff_version (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  utility_tariff_id   uuid NOT NULL,
  effective_from      date NOT NULL,
  effective_to        date,
  structure           jsonb NOT NULL,
  ceiling_per_unit    numeric(14,4) NOT NULL,
  cap_basis           text NOT NULL DEFAULT 'effective_average_rate',
  source_url          text NOT NULL,
  source_document_id  uuid,
  source_published_at date,
  state               platform.tariff_version_state NOT NULL DEFAULT 'draft',
  needs_check         boolean NOT NULL DEFAULT true,
  entered_by          uuid,
  verified_by         uuid,
  verified_at         timestamptz(6),
  published_by        uuid,
  published_at        timestamptz(6),
  notes               text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT utility_tariff_version_pkey PRIMARY KEY (id),
  CONSTRAINT utility_tariff_version_utility_tariff_id_fkey FOREIGN KEY (utility_tariff_id) REFERENCES platform.utility_tariff (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT utility_tariff_version_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT utility_tariff_version_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT utility_tariff_version_ceiling_check CHECK (ceiling_per_unit >= 0),
  CONSTRAINT utility_tariff_version_cap_basis_check CHECK (cap_basis = 'effective_average_rate'),
  CONSTRAINT utility_tariff_version_maker_checker_check CHECK (verified_by IS NULL OR entered_by IS NULL OR verified_by <> entered_by),
  CONSTRAINT utility_tariff_version_verified_check CHECK (state NOT IN ('verified', 'published') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND NOT needs_check)),
  CONSTRAINT utility_tariff_version_structure_check CHECK (jsonb_typeof(structure) = 'object' AND structure ? 'kind'),
  CONSTRAINT utility_tariff_version_no_overlap EXCLUDE USING gist (utility_tariff_id WITH =, daterange(effective_from, effective_to) WITH &&)
    WHERE (state IN ('published', 'superseded'))
);
COMMENT ON TABLE platform.utility_tariff_version IS 'Effective-dated published utility rate tables (structure = schema-design §4.2.1). state entered = unverified; needs_check = at least one value awaits confirmation against the source; maker-checker on verification (B6.4).';
CREATE UNIQUE INDEX utility_tariff_version_utility_tariff_id_effective_from_key ON platform.utility_tariff_version (utility_tariff_id, effective_from);

CREATE TABLE platform.business_calendar (
  id           uuid NOT NULL DEFAULT uuidv7(),
  calendar     platform.calendar_kind NOT NULL,
  holiday_date date NOT NULL,
  name_th      text NOT NULL,
  name_en      text NOT NULL,
  source_url   text NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT business_calendar_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE platform.business_calendar IS 'Thai public / bank holidays used by SLA timers and due dates (D-159).';
CREATE UNIQUE INDEX business_calendar_calendar_holiday_date_key ON platform.business_calendar (calendar, holiday_date);

-- Triggers: updated_at, version closing (§4.1), append-only versions.
CREATE TRIGGER setting_set_updated_at BEFORE UPDATE ON platform.setting FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER feature_flag_set_updated_at BEFORE UPDATE ON platform.feature_flag FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER feature_flag_override_set_updated_at BEFORE UPDATE ON platform.feature_flag_override FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER utility_tariff_set_updated_at BEFORE UPDATE ON platform.utility_tariff FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER utility_tariff_version_set_updated_at BEFORE UPDATE ON platform.utility_tariff_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER business_calendar_set_updated_at BEFORE UPDATE ON platform.business_calendar FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TRIGGER setting_version_close_previous BEFORE INSERT ON platform.setting_version
  FOR EACH ROW EXECUTE FUNCTION core.close_previous_period('setting_id', 'effective_from', 'effective_to');
CREATE TRIGGER setting_version_append_only BEFORE UPDATE OR DELETE ON platform.setting_version
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation('effective_to');
CREATE TRIGGER tenant_setting_version_close_previous BEFORE INSERT ON platform.tenant_setting_version
  FOR EACH ROW EXECUTE FUNCTION core.close_previous_period('tenant_id,setting_id', 'effective_from', 'effective_to');
CREATE TRIGGER tenant_setting_version_append_only BEFORE UPDATE OR DELETE ON platform.tenant_setting_version
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation('effective_to');
CREATE TRIGGER property_setting_version_close_previous BEFORE INSERT ON platform.property_setting_version
  FOR EACH ROW EXECUTE FUNCTION core.close_previous_period('property_id,setting_id', 'effective_from', 'effective_to');
CREATE TRIGGER property_setting_version_append_only BEFORE UPDATE OR DELETE ON platform.property_setting_version
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation('effective_to');
