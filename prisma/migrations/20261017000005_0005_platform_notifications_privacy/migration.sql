-- getproperty-api 0005 — notification templates/routes/preferences/delivery log, web push, privacy
-- (consent purposes + versions, consent log, data subject requests, retention policies) — D-025,
-- schema-design v2 §3.2.6, §3.2.7.

CREATE TYPE platform.notification_channel AS ENUM ('line', 'sms', 'email', 'in_app', 'web_push');
CREATE TYPE platform.notification_audience AS ENUM ('resident', 'technician', 'owner', 'manager', 'staff', 'accountant', 'platform');
CREATE TYPE platform.template_format AS ENUM ('handlebars_text', 'line_flex_json', 'mjml', 'plain');
CREATE TYPE platform.template_version_state AS ENUM ('draft', 'published', 'retired');
CREATE TYPE platform.notification_recipient AS ENUM ('user', 'party', 'phone', 'email', 'line_user');
CREATE TYPE platform.notification_state AS ENUM ('queued', 'held_quiet_hours', 'held_no_consent', 'sent', 'delivered', 'failed', 'read', 'cancelled');
CREATE TYPE platform.consent_subject AS ENUM ('party', 'user');
CREATE TYPE platform.consent_channel AS ENUM ('liff', 'web', 'paper', 'sms');
CREATE TYPE platform.dsr_kind AS ENUM ('access', 'rectification', 'erasure', 'portability', 'objection', 'restriction');
CREATE TYPE platform.dsr_state AS ENUM ('received', 'verifying', 'in_progress', 'fulfilled', 'rejected', 'withdrawn');
CREATE TYPE platform.retention_target AS ENUM ('document_class', 'table');
CREATE TYPE platform.retention_action AS ENUM ('delete', 'anonymise', 'archive');

CREATE TABLE platform.notification_template (
  id          uuid NOT NULL DEFAULT uuidv7(),
  key         text NOT NULL,
  channel     platform.notification_channel NOT NULL,
  audience    platform.notification_audience NOT NULL,
  description text NOT NULL,
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT notification_template_pkey PRIMARY KEY (id),
  CONSTRAINT notification_template_key_check CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$')
);
CREATE UNIQUE INDEX notification_template_key_channel_audience_key ON platform.notification_template (key, channel, audience);

CREATE TABLE platform.notification_template_version (
  id           uuid NOT NULL DEFAULT uuidv7(),
  template_id  uuid NOT NULL,
  version      integer NOT NULL,
  language     char(2) NOT NULL,
  subject      text,
  body         text NOT NULL,
  format       platform.template_format NOT NULL,
  state        platform.template_version_state NOT NULL DEFAULT 'draft',
  published_at timestamptz(6),
  published_by uuid,
  sample_data  jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT notification_template_version_pkey PRIMARY KEY (id),
  CONSTRAINT notification_template_version_template_id_fkey FOREIGN KEY (template_id) REFERENCES platform.notification_template (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT notification_template_version_version_check CHECK (version >= 1),
  CONSTRAINT notification_template_version_published_check CHECK (state <> 'published' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX notification_template_version_template_id_language_version_key ON platform.notification_template_version (template_id, language, version);
CREATE UNIQUE INDEX notification_template_version_published_key ON platform.notification_template_version (template_id, language) WHERE (state = 'published'::platform.template_version_state);

CREATE TABLE platform.notification_route (
  id         uuid NOT NULL DEFAULT uuidv7(),
  tenant_id  uuid,
  event_type text NOT NULL,
  audience   platform.notification_audience NOT NULL,
  channel    platform.notification_channel NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  urgent     boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT notification_route_pkey PRIMARY KEY (id),
  CONSTRAINT notification_route_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.notification_route IS 'Routing matrix event × audience × channel; tenant_id null = platform default (unique with NULLS NOT DISTINCT).';
CREATE UNIQUE INDEX notification_route_tenant_id_event_type_audience_channel_key ON platform.notification_route (tenant_id, event_type, audience, channel) NULLS NOT DISTINCT;

CREATE TABLE platform.notification_preference (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid,
  user_id           uuid,
  party_id          uuid,
  channel           platform.notification_channel NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  quiet_hours_start time(6),
  quiet_hours_end   time(6),
  language          char(2),
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  updated_by        uuid,
  CONSTRAINT notification_preference_pkey PRIMARY KEY (id),
  CONSTRAINT notification_preference_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT notification_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT notification_preference_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT notification_preference_subject_check CHECK ((user_id IS NULL) <> (party_id IS NULL)),
  CONSTRAINT notification_preference_party_tenant_check CHECK (party_id IS NULL OR tenant_id IS NOT NULL),
  CONSTRAINT notification_preference_quiet_hours_check CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))
);
CREATE UNIQUE INDEX notification_preference_user_id_channel_key ON platform.notification_preference (user_id, channel);
CREATE UNIQUE INDEX notification_preference_party_id_channel_key ON platform.notification_preference (party_id, channel);
CREATE INDEX notification_preference_tenant_id_idx ON platform.notification_preference (tenant_id);

CREATE TABLE platform.notification (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid,
  building_id         uuid,
  event_id            uuid,
  template_version_id uuid,
  recipient_type      platform.notification_recipient NOT NULL,
  recipient_id        uuid,
  recipient_address   text,
  channel             platform.notification_channel NOT NULL,
  state               platform.notification_state NOT NULL DEFAULT 'queued',
  scheduled_for       timestamptz(6) NOT NULL DEFAULT now(),
  sent_at             timestamptz(6),
  delivered_at        timestamptz(6),
  read_at             timestamptz(6),
  failed_reason       text,
  provider            text,
  provider_message_id text,
  rendered            jsonb,
  attempts            smallint NOT NULL DEFAULT 0,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT notification_pkey PRIMARY KEY (id),
  CONSTRAINT notification_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT notification_event_id_fkey FOREIGN KEY (event_id) REFERENCES platform.domain_event (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT notification_template_version_id_fkey FOREIGN KEY (template_version_id) REFERENCES platform.notification_template_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT notification_recipient_check CHECK (recipient_id IS NOT NULL OR recipient_address IS NOT NULL)
);
COMMENT ON TABLE platform.notification IS 'Delivery log, idempotent per (event, recipient, channel). recipient_address is redacted in logs.';
CREATE UNIQUE INDEX notification_event_id_recipient_type_recipient_id_channel_key ON platform.notification (event_id, recipient_type, recipient_id, channel) WHERE (event_id IS NOT NULL);
CREATE INDEX notification_tenant_recipient_created_at_idx ON platform.notification (tenant_id, recipient_type, recipient_id, created_at DESC);
CREATE INDEX notification_state_scheduled_for_idx ON platform.notification (state, scheduled_for);

CREATE TABLE platform.web_push_subscription (
  id           uuid NOT NULL DEFAULT uuidv7(),
  user_id      uuid NOT NULL,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  expires_at   timestamptz(6),
  last_used_at timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT web_push_subscription_pkey PRIMARY KEY (id),
  CONSTRAINT web_push_subscription_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX web_push_subscription_endpoint_key ON platform.web_push_subscription (endpoint);
CREATE INDEX web_push_subscription_user_id_idx ON platform.web_push_subscription (user_id);

CREATE TABLE platform.consent_purpose (
  id         uuid NOT NULL DEFAULT uuidv7(),
  key        text NOT NULL,
  audience   platform.notification_audience NOT NULL,
  required   boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT consent_purpose_pkey PRIMARY KEY (id),
  CONSTRAINT consent_purpose_key_check CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$')
);
CREATE UNIQUE INDEX consent_purpose_key_key ON platform.consent_purpose (key);

CREATE TABLE platform.consent_purpose_version (
  id             uuid NOT NULL DEFAULT uuidv7(),
  purpose_id     uuid NOT NULL,
  version        integer NOT NULL,
  language       char(2) NOT NULL,
  title          text NOT NULL,
  body_markdown  text NOT NULL,
  effective_from timestamptz(6) NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT consent_purpose_version_pkey PRIMARY KEY (id),
  CONSTRAINT consent_purpose_version_purpose_id_fkey FOREIGN KEY (purpose_id) REFERENCES platform.consent_purpose (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT consent_purpose_version_version_check CHECK (version >= 1)
);
CREATE UNIQUE INDEX consent_purpose_version_purpose_id_language_version_key ON platform.consent_purpose_version (purpose_id, language, version);

CREATE TABLE platform.consent (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid,
  subject_type         platform.consent_subject NOT NULL,
  subject_id           uuid NOT NULL,
  purpose_version_id   uuid NOT NULL,
  granted              boolean NOT NULL,
  captured_at          timestamptz(6) NOT NULL DEFAULT now(),
  channel              platform.consent_channel NOT NULL,
  ip                   inet,
  user_agent           text,
  evidence_document_id uuid,
  CONSTRAINT consent_pkey PRIMARY KEY (id),
  CONSTRAINT consent_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT consent_purpose_version_id_fkey FOREIGN KEY (purpose_version_id) REFERENCES platform.consent_purpose_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT consent_evidence_document_id_fkey FOREIGN KEY (evidence_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT consent_party_tenant_check CHECK (subject_type <> 'party' OR tenant_id IS NOT NULL)
);
COMMENT ON TABLE platform.consent IS 'Consent log (D-025): append-only; a withdrawal is a new row with granted = false. Current state: platform.v_consent_state.';
CREATE INDEX consent_subject_type_subject_id_captured_at_idx ON platform.consent (subject_type, subject_id, captured_at DESC);
CREATE INDEX consent_tenant_id_idx ON platform.consent (tenant_id);

-- Current consent per (subject, purpose): the latest row. security_invoker so the caller's RLS applies.
CREATE VIEW platform.v_consent_state WITH (security_invoker = true) AS
  SELECT DISTINCT ON (c.subject_type, c.subject_id, v.purpose_id)
         c.tenant_id, c.subject_type, c.subject_id, v.purpose_id, p.key AS purpose_key, v.version AS purpose_version,
         v.language, c.granted, c.captured_at, c.channel, c.id AS consent_id
    FROM platform.consent c
    JOIN platform.consent_purpose_version v ON v.id = c.purpose_version_id
    JOIN platform.consent_purpose p ON p.id = v.purpose_id
   ORDER BY c.subject_type, c.subject_id, v.purpose_id, c.captured_at DESC, c.id DESC;
COMMENT ON VIEW platform.v_consent_state IS 'Latest consent row per subject and purpose (D-025).';

CREATE TABLE platform.data_subject_request (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid,
  subject_type          platform.consent_subject NOT NULL,
  subject_id            uuid,
  requester_contact_enc bytea NOT NULL,
  kind                  platform.dsr_kind NOT NULL,
  state                 platform.dsr_state NOT NULL DEFAULT 'received',
  received_at           timestamptz(6) NOT NULL DEFAULT now(),
  due_at                timestamptz(6) NOT NULL,
  fulfilled_at          timestamptz(6),
  handled_by            uuid,
  export_document_id    uuid,
  notes                 text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT data_subject_request_pkey PRIMARY KEY (id),
  CONSTRAINT data_subject_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT data_subject_request_export_document_id_fkey FOREIGN KEY (export_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT data_subject_request_due_check CHECK (due_at > received_at),
  CONSTRAINT data_subject_request_fulfilled_check CHECK ((state = 'fulfilled') = (fulfilled_at IS NOT NULL))
);
COMMENT ON TABLE platform.data_subject_request IS 'PDPA DSR workflow; tenant = controller, Collective = processor. due_at = received_at + 30 days (setting privacy.dsr_due_days).';
CREATE INDEX data_subject_request_tenant_id_state_idx ON platform.data_subject_request (tenant_id, state);

CREATE TABLE platform.retention_policy (
  id             uuid NOT NULL DEFAULT uuidv7(),
  target         platform.retention_target NOT NULL,
  target_key     text NOT NULL,
  retain_for     interval NOT NULL,
  basis          text NOT NULL,
  action         platform.retention_action NOT NULL,
  legal_ref      text,
  effective_from date NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT retention_policy_pkey PRIMARY KEY (id),
  CONSTRAINT retention_policy_retain_for_check CHECK (retain_for > interval '0')
);
COMMENT ON TABLE platform.retention_policy IS 'Retention per document class or table (D-025); the retention job deletes/anonymises/archives after retain_for counted from basis.';
CREATE UNIQUE INDEX retention_policy_target_target_key_effective_from_key ON platform.retention_policy (target, target_key, effective_from);

CREATE TRIGGER notification_template_set_updated_at BEFORE UPDATE ON platform.notification_template FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER notification_template_version_set_updated_at BEFORE UPDATE ON platform.notification_template_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER notification_route_set_updated_at BEFORE UPDATE ON platform.notification_route FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER notification_preference_set_updated_at BEFORE UPDATE ON platform.notification_preference FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER notification_set_updated_at BEFORE UPDATE ON platform.notification FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER web_push_subscription_set_updated_at BEFORE UPDATE ON platform.web_push_subscription FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER consent_purpose_set_updated_at BEFORE UPDATE ON platform.consent_purpose FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER consent_purpose_version_set_updated_at BEFORE UPDATE ON platform.consent_purpose_version FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER data_subject_request_set_updated_at BEFORE UPDATE ON platform.data_subject_request FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER retention_policy_set_updated_at BEFORE UPDATE ON platform.retention_policy FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER consent_append_only BEFORE UPDATE OR DELETE ON platform.consent FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER consent_no_truncate BEFORE TRUNCATE ON platform.consent FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
