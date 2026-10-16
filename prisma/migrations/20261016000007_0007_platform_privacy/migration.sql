-- 0007_platform_privacy — PDPA (D-025): consent purposes (+versions), consent log, data subject requests,
-- retention policies, the v_consent_state view (schema-design §3.1.6) — and the compliance registry mirror
-- + Owner acknowledgements that D-021a / D-149 pulled forward from B4.1 into B1.2 (§3.6; the rules are seeded
-- `pending_legal_verification` with legal_ref clause ids from docs/compliance/legal-reference.md).

CREATE TABLE consent_purposes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text NOT NULL,
  audience   notification_audience NOT NULL,
  required   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint,
  CONSTRAINT consent_purposes_key_key UNIQUE (key),
  CONSTRAINT consent_purposes_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE TABLE consent_purpose_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose_id     bigint NOT NULL REFERENCES consent_purposes (id) ON DELETE CASCADE,
  version        integer NOT NULL,
  language       char(2) NOT NULL,
  title          text NOT NULL,
  body_markdown  text NOT NULL,
  effective_from timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint,
  CONSTRAINT consent_purpose_versions_purpose_id_language_version_key UNIQUE (purpose_id, language, version),
  CONSTRAINT consent_purpose_versions_version_check CHECK (version >= 1)
);

-- consents ⟲ — consent log; withdrawal = a new row with granted=false (append-only trigger in 0008).
-- subject_id references tenants (B2.2) or users depending on subject_type; checked in code until B2.2.
CREATE TABLE consents (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id          uuid NOT NULL DEFAULT uuidv7(),
  org_id             bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  subject_type       consent_subject NOT NULL,
  subject_id         bigint NOT NULL,
  purpose_version_id bigint NOT NULL REFERENCES consent_purpose_versions (id) ON DELETE RESTRICT,
  granted            boolean NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  channel            consent_channel NOT NULL,
  ip                 inet,
  user_agent         text,
  evidence_file_id   bigint REFERENCES file_objects (id) ON DELETE SET NULL,
  CONSTRAINT consents_public_id_key UNIQUE (public_id)
);
CREATE INDEX consents_subject_captured_at_idx ON consents (subject_type, subject_id, captured_at DESC);
CREATE INDEX consents_purpose_version_id_idx ON consents (purpose_version_id);
CREATE INDEX consents_org_id_idx ON consents (org_id);

-- data_subject_requests — DSR workflow; the org is joint controller (D-025). requester_contact is field-encrypted (§4.6).
CREATE TABLE data_subject_requests (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id             uuid NOT NULL DEFAULT uuidv7(),
  org_id                bigint REFERENCES orgs (id) ON DELETE RESTRICT,
  subject_type          consent_subject NOT NULL,
  subject_id            bigint,
  requester_contact_enc bytea NOT NULL,
  kind                  dsr_kind NOT NULL,
  state                 dsr_state NOT NULL DEFAULT 'received',
  received_at           timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz NOT NULL,
  fulfilled_at          timestamptz,
  handled_by            bigint REFERENCES users (id) ON DELETE SET NULL,
  export_file_id        bigint REFERENCES file_objects (id) ON DELETE SET NULL,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            bigint,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            bigint,
  CONSTRAINT data_subject_requests_public_id_key UNIQUE (public_id),
  CONSTRAINT data_subject_requests_due_check CHECK (due_at > received_at),
  CONSTRAINT data_subject_requests_fulfilled_check CHECK ((state = 'fulfilled') = (fulfilled_at IS NOT NULL))
);
CREATE INDEX data_subject_requests_state_due_at_idx ON data_subject_requests (state, due_at);
CREATE INDEX data_subject_requests_org_id_idx ON data_subject_requests (org_id);

-- retention_policies — one row per retention class / table; the retention job (B1.3) applies the version in force.
-- `retain_for` is a Postgres interval (Prisma: Unsupported("interval") — read through raw SQL).
CREATE TABLE retention_policies (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target         retention_target NOT NULL,
  target_key     text NOT NULL,
  retain_for     interval NOT NULL,
  basis          text NOT NULL,
  action         retention_action NOT NULL,
  legal_ref      text,
  notes          text,
  effective_from date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint,
  CONSTRAINT retention_policies_target_target_key_effective_from_key UNIQUE (target, target_key, effective_from),
  CONSTRAINT retention_policies_retain_for_check CHECK (retain_for > interval '0')
);

-- Current consent state = latest row per (subject, purpose) (schema-design §3.1.6).
CREATE VIEW v_consent_state AS
SELECT DISTINCT ON (c.subject_type, c.subject_id, cp.id)
       c.subject_type, c.subject_id, cp.id AS purpose_id, cp.key AS purpose_key,
       c.purpose_version_id, c.granted, c.captured_at, c.channel, c.org_id
  FROM consents c
  JOIN consent_purpose_versions cpv ON cpv.id = c.purpose_version_id
  JOIN consent_purposes cp ON cp.id = cpv.purpose_id
 ORDER BY c.subject_type, c.subject_id, cp.id, c.captured_at DESC, c.id DESC;

-- §3.6 compliance_rules — mirror of the code registry (code is the truth; the table is for reporting/joins and
-- docs/compliance.md). legal_ref points at docs/compliance/legal-reference.md clause ids (D-149).
CREATE TABLE compliance_rules (
  id             text PRIMARY KEY,
  legal_ref      text NOT NULL,
  severity       compliance_severity NOT NULL,
  applies_to     text[] NOT NULL DEFAULT '{}',
  description_th text NOT NULL,
  description_en text NOT NULL,
  settings_used  text[] NOT NULL DEFAULT '{}',
  status         rule_status NOT NULL DEFAULT 'pending_legal_verification',
  synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_rules_id_check CHECK (id ~ '^compliance\.[a-z][a-z0-9_]*$')
);

-- compliance_acknowledgements ⟲ — the Owner's acknowledgement of a legal warning (D-021a): who, when, IP, the
-- rate they set and the cap shown, the exact warning text. Evidence for สคบ. disputes; append-only (0008).
-- property_id FK in B2.1; `bill_lines.above_cap` follows in B4.2.
CREATE TABLE compliance_acknowledgements (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         uuid NOT NULL DEFAULT uuidv7(),
  org_id            bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  property_id       bigint,
  rule_id           text NOT NULL REFERENCES compliance_rules (id) ON DELETE RESTRICT,
  subject_type      text NOT NULL,
  subject_id        bigint,
  acknowledged_by   bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  acknowledged_at   timestamptz NOT NULL DEFAULT now(),
  ip                inet,
  user_agent        text,
  utility           utility,
  org_rate          numeric(14, 4),
  cap_per_unit      numeric(14, 4),
  tariff_version_id bigint REFERENCES tariff_versions (id) ON DELETE RESTRICT,
  legal_ref         text NOT NULL,
  warning_text      text NOT NULL,
  context           jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_acknowledgements_public_id_key UNIQUE (public_id),
  CONSTRAINT compliance_acknowledgements_rates_check CHECK (
    (org_rate IS NULL AND cap_per_unit IS NULL) OR (org_rate > 0 AND cap_per_unit > 0))
);
CREATE INDEX compliance_acknowledgements_org_rule_at_idx ON compliance_acknowledgements (org_id, rule_id, acknowledged_at DESC);
CREATE INDEX compliance_acknowledgements_subject_idx ON compliance_acknowledgements (subject_type, subject_id);
CREATE INDEX compliance_acknowledgements_acknowledged_by_idx ON compliance_acknowledgements (acknowledged_by);
