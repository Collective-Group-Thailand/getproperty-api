-- getproperty-api 0024 — consumer contract requests before B6 (docs/contract-requests-triage.md, D-203):
--   LIFF #8  building-rules acknowledgement per lease party (ops.lease_party.rules_acknowledged_at/_by);
--   LIFF #9  dispute photos on the deposit settlement (ops.deposit_settlement.dispute_document_ids);
--   LIFF #10 notification preferences per resident login × topic × channel (platform.notification_topic_preference).
-- Deviations (schema-design §7.5 rows 65–67): additive columns on two ops tables and one new platform table that the
-- v2 design did not list (it modelled preferences per channel only).

-- ------------------------------------------------------------------------------------------- lease rules
ALTER TABLE ops.lease_party
  ADD COLUMN rules_acknowledged_at timestamptz(6),
  ADD COLUMN rules_acknowledged_by uuid,
  ADD CONSTRAINT lease_party_rules_acknowledged_by_fkey FOREIGN KEY (rules_acknowledged_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT lease_party_rules_acknowledged_check CHECK ((rules_acknowledged_at IS NULL) = (rules_acknowledged_by IS NULL));
CREATE INDEX lease_party_rules_acknowledged_by_idx ON ops.lease_party (rules_acknowledged_by);
COMMENT ON COLUMN ops.lease_party.rules_acknowledged_at IS 'The party confirmed in the LIFF that they read the building rules of the lease addendum (audited).';

-- ------------------------------------------------------------------------------------------- dispute photos
ALTER TABLE ops.deposit_settlement
  ADD COLUMN dispute_document_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT deposit_settlement_dispute_documents_check CHECK (cardinality(dispute_document_ids) <= 6);
COMMENT ON COLUMN ops.deposit_settlement.dispute_document_ids IS 'Photos the resident attached to a dispute (core.document, kind inspection_photo, uploaded by the resident).';

-- ------------------------------------------------------------------------------------------- topic preferences
CREATE TYPE platform.notification_topic AS ENUM ('billing', 'lease', 'service_requests', 'announcements', 'parcels');

CREATE TABLE platform.notification_topic_preference (
  id          uuid NOT NULL DEFAULT uuidv7(),
  user_id     uuid NOT NULL,
  topic       platform.notification_topic NOT NULL,
  channel     platform.notification_channel NOT NULL,
  enabled     boolean NOT NULL,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT notification_topic_preference_pkey PRIMARY KEY (id),
  CONSTRAINT notification_topic_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  -- billing and lease notices must reach the resident (D-042, D-061): never stored as switched off
  CONSTRAINT notification_topic_preference_locked_check CHECK (enabled OR topic NOT IN ('billing', 'lease'))
);
COMMENT ON TABLE platform.notification_topic_preference IS 'A resident login''s choice per topic × channel (LIFF profile); absent = on. Billing and lease topics are locked on.';
CREATE UNIQUE INDEX notification_topic_preference_user_id_topic_channel_key ON platform.notification_topic_preference (user_id, topic, channel);
CREATE TRIGGER notification_topic_preference_set_updated_at BEFORE UPDATE ON platform.notification_topic_preference FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- identity-like rows of one login (no tenant): read and written through gp_platform only, like
-- platform.notification_preference's user rows
SELECT platform.apply_rls('platform.notification_topic_preference', 'platform_only');
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.notification_topic_preference TO gp_platform;
