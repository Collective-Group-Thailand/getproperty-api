-- getproperty-api 0055 — verified people (B7 deliverable 7.10 part 2, D-267): identity verification of a person
-- through a licensed e-KYC provider (O-021: provider not chosen; a fake adapter for tests and demos). One row per
-- attempt; the provider's result arrives by a signed webhook. No ID number, photo or date of birth is stored here —
-- only the outcome. schema-design §7.5 row 139.

CREATE TYPE platform.identity_verification_state AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE platform.identity_verification (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  user_id              uuid NOT NULL,
  audience             platform.audience NOT NULL,
  provider             text NOT NULL,
  provider_session_id  text NOT NULL,
  state                platform.identity_verification_state NOT NULL DEFAULT 'pending',
  verification_url     text,
  failure_reason       text,
  decided_at           timestamptz(6),
  expires_at           timestamptz(6) NOT NULL,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT identity_verification_pkey PRIMARY KEY (id),
  CONSTRAINT identity_verification_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT identity_verification_provider_session_key UNIQUE (provider, provider_session_id),
  CONSTRAINT identity_verification_decided_check CHECK ((state IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT identity_verification_reason_check CHECK (failure_reason IS NULL OR length(failure_reason) <= 500)
);
COMMENT ON TABLE platform.identity_verification IS 'D-267: identity verification attempts of a person (owner, resident or prospect) at a licensed e-KYC provider; only the outcome is kept (no ID data). Approved once = the "identity verified" badge.';
CREATE INDEX identity_verification_user_id_idx ON platform.identity_verification (user_id, created_at DESC);
CREATE UNIQUE INDEX identity_verification_user_pending_key ON platform.identity_verification (user_id) WHERE state = 'pending';
CREATE TRIGGER identity_verification_set_updated_at BEFORE UPDATE ON platform.identity_verification FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('platform.identity_verification', 'platform');
GRANT SELECT, INSERT, UPDATE ON platform.identity_verification TO gp_platform;
GRANT SELECT ON platform.identity_verification TO gp_reporting;
