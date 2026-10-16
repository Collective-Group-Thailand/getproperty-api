-- 0004_platform_config — settings catalogue + versions, feature flags (+ per-org overrides), platform tariffs
-- with maker-checker versions, business calendars (schema-design §3.1.1, §3.1.2, §3.1.7; ADR-0004, D-021, D-144).

-- §3.1.1 settings — one catalogue for platform/org/property scopes (D-144, ADR-0004); descriptions cite D-###.
CREATE TABLE settings (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text NOT NULL,
  value_type    setting_value_type NOT NULL,
  scope_allowed setting_scope[] NOT NULL DEFAULT '{platform}',
  description   text NOT NULL,
  editable_by   text[] NOT NULL DEFAULT '{}',
  json_schema   jsonb,
  is_secret     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint,
  CONSTRAINT settings_key_key UNIQUE (key),
  CONSTRAINT settings_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  CONSTRAINT settings_description_cites_decision_check CHECK (description ~ '(D|O|ADR)-[0-9]{3,4}'),
  CONSTRAINT settings_scope_has_platform_check CHECK ('platform' = ANY (scope_allowed))
);

-- setting_versions — effective-dated platform-scope values; the previous version is closed by trigger (0008).
-- No backdating by people (ADR-0004 `settings.backdated`); system seeds (created_by IS NULL) may insert the
-- baseline version at the epoch.
CREATE TABLE setting_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setting_id     bigint NOT NULL REFERENCES settings (id) ON DELETE CASCADE,
  value          jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  CONSTRAINT setting_versions_setting_id_effective_from_key UNIQUE (setting_id, effective_from),
  CONSTRAINT setting_versions_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT setting_versions_no_backdating_check CHECK (created_by IS NULL OR effective_from >= created_at - interval '5 minutes'),
  CONSTRAINT setting_versions_no_overlap_excl EXCLUDE USING gist (
    setting_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);

ALTER TABLE org_setting_versions ADD CONSTRAINT org_setting_versions_setting_id_fkey
  FOREIGN KEY (setting_id) REFERENCES settings (id) ON DELETE CASCADE;

-- feature_flags — platform flags (provider rollouts, R2 features) + per-org overrides (B6.4)
CREATE TABLE feature_flags (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key             text NOT NULL,
  description     text NOT NULL,
  default_enabled boolean NOT NULL DEFAULT false,
  rollout_pct     smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint,
  CONSTRAINT feature_flags_key_key UNIQUE (key),
  CONSTRAINT feature_flags_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  CONSTRAINT feature_flags_rollout_pct_check CHECK (rollout_pct BETWEEN 0 AND 100)
);

CREATE TABLE feature_flag_overrides (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feature_flag_id bigint NOT NULL REFERENCES feature_flags (id) ON DELETE CASCADE,
  org_id          bigint NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint,
  CONSTRAINT feature_flag_overrides_feature_flag_id_org_id_key UNIQUE (feature_flag_id, org_id)
);
CREATE INDEX feature_flag_overrides_org_id_idx ON feature_flag_overrides (org_id);

-- §3.1.2 tariffs — one row per (utility, provider, customer class); platform-level, no org
CREATE TABLE tariffs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid NOT NULL DEFAULT uuidv7(),
  utility     utility NOT NULL,
  provider    utility_provider NOT NULL,
  tariff_code text NOT NULL,
  name_th     text NOT NULL,
  name_en     text NOT NULL,
  unit        meter_unit NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  CONSTRAINT tariffs_public_id_key UNIQUE (public_id),
  CONSTRAINT tariffs_provider_tariff_code_key UNIQUE (provider, tariff_code),
  CONSTRAINT tariffs_provider_utility_check CHECK (
    (utility = 'electric' AND provider IN ('mea', 'pea') AND unit = 'kwh')
    OR (utility = 'water' AND provider IN ('mwa', 'pwa') AND unit = 'm3'))
);

-- tariff_versions — effective-dated published rate tables (structure §4.2.1). Maker-checker: enter → verify
-- (another platform user) → publish (B6.4). Only published/superseded versions may not overlap; drafts and
-- entered rows may coexist. source_document_file_id FK is added in 0005 (file_objects).
CREATE TABLE tariff_versions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id               uuid NOT NULL DEFAULT uuidv7(),
  tariff_id               bigint NOT NULL REFERENCES tariffs (id) ON DELETE RESTRICT,
  effective_from          date NOT NULL,
  effective_to            date,
  structure               jsonb NOT NULL,
  cap_per_unit            numeric(14, 4) NOT NULL,
  cap_basis               text NOT NULL,
  source_url              text NOT NULL,
  source_document_file_id bigint,
  source_published_at     date NOT NULL,
  state                   tariff_version_state NOT NULL DEFAULT 'draft',
  entered_by              bigint REFERENCES users (id) ON DELETE SET NULL,
  verified_by             bigint REFERENCES users (id) ON DELETE SET NULL,
  verified_at             timestamptz,
  published_by            bigint REFERENCES users (id) ON DELETE SET NULL,
  published_at            timestamptz,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              bigint,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              bigint,
  CONSTRAINT tariff_versions_public_id_key UNIQUE (public_id),
  CONSTRAINT tariff_versions_tariff_id_effective_from_key UNIQUE (tariff_id, effective_from),
  CONSTRAINT tariff_versions_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT tariff_versions_cap_check CHECK (cap_per_unit > 0),
  CONSTRAINT tariff_versions_four_eyes_check CHECK (verified_by IS NULL OR entered_by IS NULL OR verified_by <> entered_by),
  CONSTRAINT tariff_versions_verified_pair_check CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  CONSTRAINT tariff_versions_published_pair_check CHECK ((published_by IS NULL) = (published_at IS NULL)),
  CONSTRAINT tariff_versions_state_check CHECK (
    (state IN ('draft', 'entered') AND published_at IS NULL)
    OR (state = 'verified' AND verified_at IS NOT NULL AND published_at IS NULL)
    OR (state IN ('published', 'superseded') AND verified_at IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT tariff_versions_no_overlap_excl EXCLUDE USING gist (
    tariff_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
    WHERE (state IN ('published', 'superseded'))
);
CREATE INDEX tariff_versions_tariff_id_state_effective_from_idx ON tariff_versions (tariff_id, state, effective_from DESC);

-- §3.1.7 business_calendars — Thai public & bank holidays (due dates, reminders, deposit deadlines)
CREATE TABLE business_calendars (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calendar     calendar_kind NOT NULL,
  holiday_date date NOT NULL,
  name_th      text NOT NULL,
  name_en      text NOT NULL,
  source_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint,
  CONSTRAINT business_calendars_calendar_holiday_date_key UNIQUE (calendar, holiday_date)
);
