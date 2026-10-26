-- getproperty-api 0056 — portable rent record (B7 deliverable 7.11, D-256): a resident's on-time payment history,
-- confirmed by getproperty (gateway callback, settlement file or verified slip), is computed on read from their
-- invoices; this table only keeps what the resident chose to share — with one enquiry (the owner sees it on the lead)
-- or as a letter with a verification code — revocable at any time. Facts only, no score. schema-design §7.5 row 140.

CREATE TYPE platform.rent_record_share_kind AS ENUM ('enquiry', 'letter');

CREATE TABLE platform.rent_record_share (
  id           uuid NOT NULL DEFAULT uuidv7(),
  user_id      uuid NOT NULL,
  kind         platform.rent_record_share_kind NOT NULL,
  lead_id      uuid,
  code_hash    bytea,
  code_hint    text,
  expires_at   timestamptz(6),
  revoked_at   timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT rent_record_share_pkey PRIMARY KEY (id),
  CONSTRAINT rent_record_share_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT rent_record_share_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ops.listing_lead (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT rent_record_share_kind_check CHECK (
    (kind = 'enquiry' AND lead_id IS NOT NULL AND code_hash IS NULL)
    OR (kind = 'letter' AND lead_id IS NULL AND code_hash IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT rent_record_share_code_hint_check CHECK (code_hint IS NULL OR length(code_hint) <= 8)
);
COMMENT ON TABLE platform.rent_record_share IS 'D-256: what a resident chose to share of their rent record (an enquiry, or a letter with a verification code, sha256 only); revocable. The record itself is computed from confirmed payments.';
CREATE INDEX rent_record_share_user_id_idx ON platform.rent_record_share (user_id, created_at DESC);
CREATE UNIQUE INDEX rent_record_share_lead_live_key ON platform.rent_record_share (lead_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX rent_record_share_code_hash_key ON platform.rent_record_share (code_hash) WHERE code_hash IS NOT NULL;
CREATE TRIGGER rent_record_share_set_updated_at BEFORE UPDATE ON platform.rent_record_share FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('platform.rent_record_share', 'platform');
GRANT SELECT, INSERT, UPDATE ON platform.rent_record_share TO gp_platform;
GRANT SELECT ON platform.rent_record_share TO gp_reporting;

-- D-261 (no empty months): a landlord's lease in force reminds the resident (and the owner, when the lease did not
-- come from a listing — B7.4 covers those) once, `lease.end.remind_days_before` before it ends.
ALTER TABLE ops.lease ADD COLUMN end_reminded_at timestamptz(6);
COMMENT ON COLUMN ops.lease.end_reminded_at IS 'D-261: when the lease-end reminder went out (once).';
