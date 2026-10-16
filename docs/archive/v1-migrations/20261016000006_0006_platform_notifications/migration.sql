-- 0006_platform_notifications — templates (+ versions), routing matrix, recipient preferences, delivery log,
-- web push subscriptions (schema-design §3.1.5; D-011, D-045, D-064). `notification_preferences.tenant_id` and
-- `notifications.property_id` get their FKs in B2.2 / B2.1.

-- notification_templates — one per (key, channel, audience); content lives in versions
CREATE TABLE notification_templates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL,
  channel     notification_channel NOT NULL,
  audience    notification_audience NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  CONSTRAINT notification_templates_key_channel_audience_key UNIQUE (key, channel, audience),
  CONSTRAINT notification_templates_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

-- notification_template_versions — versioned Handlebars bodies th/en (R2: my/km/lo/zh)
CREATE TABLE notification_template_versions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id  bigint NOT NULL REFERENCES notification_templates (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  language     char(2) NOT NULL,
  subject      text,
  body         text NOT NULL,
  format       template_format NOT NULL,
  state        template_version_state NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  published_by bigint REFERENCES users (id) ON DELETE SET NULL,
  sample_data  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint,
  CONSTRAINT notification_template_versions_template_id_language_version_key UNIQUE (template_id, language, version),
  CONSTRAINT notification_template_versions_version_check CHECK (version >= 1),
  CONSTRAINT notification_template_versions_published_check CHECK ((state = 'published') = (published_at IS NOT NULL))
);
CREATE UNIQUE INDEX notification_template_versions_one_published_uq
  ON notification_template_versions (template_id, language) WHERE state = 'published';

-- notification_routes — routing matrix event × audience × channel (org_id NULL = platform default)
CREATE TABLE notification_routes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint REFERENCES orgs (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  audience   notification_audience NOT NULL,
  channel    notification_channel NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  urgent     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);
CREATE UNIQUE INDEX notification_routes_matrix_uq ON notification_routes (coalesce(org_id, 0), event_type, audience, channel);
CREATE INDEX notification_routes_org_id_event_type_idx ON notification_routes (org_id, event_type);

-- notification_preferences — per recipient (user or tenant). tenant_id FK in B2.2.
CREATE TABLE notification_preferences (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint REFERENCES orgs (id) ON DELETE CASCADE,
  user_id           bigint REFERENCES users (id) ON DELETE CASCADE,
  tenant_id         bigint,
  channel           notification_channel NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  quiet_hours_start time,
  quiet_hours_end   time,
  language          char(2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        bigint,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        bigint,
  CONSTRAINT notification_preferences_user_id_channel_key UNIQUE (user_id, channel),
  CONSTRAINT notification_preferences_tenant_id_channel_key UNIQUE (tenant_id, channel),
  CONSTRAINT notification_preferences_recipient_check CHECK ((user_id IS NULL) <> (tenant_id IS NULL)),
  CONSTRAINT notification_preferences_quiet_hours_pair_check CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))
);

-- notifications — delivery log; idempotent per (event, recipient, channel). property_id FK in B2.1.
CREATE TABLE notifications (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid NOT NULL DEFAULT uuidv7(),
  org_id              bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  property_id         bigint,
  event_id            bigint REFERENCES domain_events (id) ON DELETE RESTRICT,
  template_version_id bigint REFERENCES notification_template_versions (id) ON DELETE RESTRICT,
  recipient_type      notification_recipient NOT NULL,
  recipient_id        bigint,
  recipient_address   text,
  channel             notification_channel NOT NULL,
  state               notification_state NOT NULL DEFAULT 'queued',
  scheduled_for       timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_reason       text,
  provider            text,
  provider_message_id text,
  rendered            jsonb,
  attempts            smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_public_id_key UNIQUE (public_id),
  CONSTRAINT notifications_recipient_check CHECK (recipient_id IS NOT NULL OR recipient_address IS NOT NULL),
  CONSTRAINT notifications_attempts_check CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX notifications_event_recipient_channel_uq
  ON notifications (event_id, recipient_type, recipient_id, channel) WHERE event_id IS NOT NULL;
CREATE INDEX notifications_org_recipient_created_idx ON notifications (org_id, recipient_type, recipient_id, created_at DESC);
CREATE INDEX notifications_state_scheduled_for_idx ON notifications (state, scheduled_for);
CREATE INDEX notifications_provider_provider_message_id_idx ON notifications (provider, provider_message_id);

-- web_push_subscriptions — VAPID
CREATE TABLE web_push_subscriptions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint,
  CONSTRAINT web_push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX web_push_subscriptions_user_id_idx ON web_push_subscriptions (user_id);
