-- getproperty-api 0006 — compliance rule registry mirror, evaluations and owner acknowledgements
-- (D-020, D-021a, D-149; schema-design v2 §3.2.8). compliance_score waits for B4.1.

CREATE TYPE platform.compliance_severity AS ENUM ('block', 'warn');
CREATE TYPE platform.rule_status AS ENUM ('active', 'pending_legal_verification', 'verified', 'retired');
CREATE TYPE platform.compliance_outcome AS ENUM ('pass', 'warn', 'block');

CREATE TABLE platform.compliance_rule (
  id               text NOT NULL,
  legal_ref        text NOT NULL,
  default_severity platform.compliance_severity NOT NULL,
  applies_to       text[] NOT NULL,
  description_th   text NOT NULL,
  description_en   text NOT NULL,
  settings_used    text[] NOT NULL DEFAULT '{}',
  status           platform.rule_status NOT NULL DEFAULT 'pending_legal_verification',
  synced_at        timestamptz(6) NOT NULL DEFAULT now(),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT compliance_rule_pkey PRIMARY KEY (id),
  CONSTRAINT compliance_rule_id_check CHECK (id ~ '^compliance\.[a-z_]+$'),
  CONSTRAINT compliance_rule_applies_to_check CHECK (cardinality(applies_to) > 0
    AND applies_to <@ ARRAY['tenant', 'lease', 'rate_plan', 'invoice', 'deposit', 'access', 'notice']::text[])
);
COMMENT ON TABLE platform.compliance_rule IS 'Mirror of the code registry (code is the truth). legal_ref = clause ids of docs/compliance/legal-reference.md; seeded pending_legal_verification until legal flips them (D-149). Effective severity = setting compliance.<rule>.severity (D-021a).';

CREATE TABLE platform.compliance_evaluation (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid,
  rule_id          text NOT NULL,
  subject_type     text NOT NULL,
  subject_id       uuid NOT NULL,
  outcome          platform.compliance_outcome NOT NULL,
  severity_applied platform.compliance_severity NOT NULL,
  context          jsonb NOT NULL,
  legal_ref        text NOT NULL,
  actor            jsonb NOT NULL,
  occurred_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT compliance_evaluation_pkey PRIMARY KEY (id),
  CONSTRAINT compliance_evaluation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_evaluation_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_evaluation_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES platform.compliance_rule (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.compliance_evaluation IS 'Every warn/block decision with the values compared (evidence for สคบ. disputes). Append-only.';
CREATE INDEX compliance_evaluation_tenant_id_rule_id_occurred_at_idx ON platform.compliance_evaluation (tenant_id, rule_id, occurred_at DESC);
CREATE INDEX compliance_evaluation_subject_type_subject_id_idx ON platform.compliance_evaluation (subject_type, subject_id);

CREATE TABLE platform.compliance_acknowledgement (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  building_id        uuid,
  rule_id            text NOT NULL,
  evaluation_id      uuid NOT NULL,
  subject_type       text NOT NULL,
  subject_id         uuid NOT NULL,
  acknowledged_by    uuid NOT NULL,
  acknowledged_at    timestamptz(6) NOT NULL DEFAULT now(),
  ip                 inet,
  user_agent         text,
  shown              jsonb NOT NULL,
  legal_text_key     text NOT NULL,
  legal_text_version integer NOT NULL,
  language           char(2) NOT NULL,
  CONSTRAINT compliance_acknowledgement_pkey PRIMARY KEY (id),
  CONSTRAINT compliance_acknowledgement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_acknowledgement_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_acknowledgement_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES platform.compliance_rule (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_acknowledgement_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES platform.compliance_evaluation (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_acknowledgement_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT compliance_acknowledgement_shown_check CHECK (jsonb_typeof(shown) = 'object'),
  CONSTRAINT compliance_acknowledgement_legal_text_version_check CHECK (legal_text_version >= 1)
);
COMMENT ON TABLE platform.compliance_acknowledgement IS 'The Owner''s acknowledgement of a warning (D-021a; legal-reference §4): who, when, IP, the values shown. Append-only.';
CREATE INDEX compliance_ack_tenant_id_rule_id_acknowledged_at_idx ON platform.compliance_acknowledgement (tenant_id, rule_id, acknowledged_at DESC);
CREATE INDEX compliance_acknowledgement_subject_type_subject_id_idx ON platform.compliance_acknowledgement (subject_type, subject_id);

CREATE TRIGGER compliance_rule_set_updated_at BEFORE UPDATE ON platform.compliance_rule FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER compliance_evaluation_append_only BEFORE UPDATE OR DELETE ON platform.compliance_evaluation FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER compliance_acknowledgement_append_only BEFORE UPDATE OR DELETE ON platform.compliance_acknowledgement FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
CREATE TRIGGER compliance_evaluation_no_truncate BEFORE TRUNCATE ON platform.compliance_evaluation FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
CREATE TRIGGER compliance_acknowledgement_no_truncate BEFORE TRUNCATE ON platform.compliance_acknowledgement FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
