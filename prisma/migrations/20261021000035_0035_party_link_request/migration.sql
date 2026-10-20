-- getproperty-api 0035 — release review #6 (D-226): a phone number an operator typed is not a proof of identity.
-- A resident / technician who signs in with SMS OTP is no longer linked to every party carrying that phone: each
-- match becomes a link request the tenant's Owner confirms (or rejects); confirmed links are `core.party_user_link`
-- rows `linked_via = admin`. LINE invitations (D-175) and LINE-id matches keep linking at once.
-- Existing `phone_match` links (created before this release) are turned into pending requests and unlinked, so no
-- bill, bank account or door code is reachable through an unconfirmed phone match.
-- Deviation (schema-design §7.5 row 100): one ops table the v2 design did not list.

CREATE TYPE ops.party_link_request_state AS ENUM ('pending', 'confirmed', 'rejected');

CREATE TABLE ops.party_link_request (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  party_id       uuid NOT NULL,
  user_id        uuid NOT NULL,
  via            text NOT NULL DEFAULT 'phone_match',
  state          ops.party_link_request_state NOT NULL DEFAULT 'pending',
  requested_at   timestamptz(6) NOT NULL DEFAULT now(),
  decided_at     timestamptz(6),
  decided_by     uuid,
  reject_reason  text,
  link_id        uuid,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT party_link_request_pkey PRIMARY KEY (id),
  CONSTRAINT party_link_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT party_link_request_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT party_link_request_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT party_link_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT party_link_request_link_id_fkey FOREIGN KEY (link_id) REFERENCES core.party_user_link (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT party_link_request_via_check CHECK (via IN ('phone_match')),
  CONSTRAINT party_link_request_decided_check CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT party_link_request_reject_check CHECK (state <> 'rejected' OR reject_reason IS NOT NULL)
);
COMMENT ON TABLE ops.party_link_request IS 'D-226: an SMS-OTP login whose verified phone matches a party an operator entered — linked only once the tenant''s Owner confirms (review #6).';
CREATE UNIQUE INDEX party_link_request_pending_key ON ops.party_link_request (party_id, user_id) WHERE state = 'pending';
CREATE INDEX party_link_request_tenant_id_state_idx ON ops.party_link_request (tenant_id, state);
CREATE INDEX party_link_request_user_id_idx ON ops.party_link_request (user_id);
CREATE INDEX party_link_request_decided_by_idx ON ops.party_link_request (decided_by);
CREATE INDEX party_link_request_link_id_idx ON ops.party_link_request (link_id);
CREATE TRIGGER party_link_request_set_updated_at BEFORE UPDATE ON ops.party_link_request FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('ops.party_link_request', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.party_link_request TO gp_app, gp_platform;
GRANT SELECT ON ops.party_link_request TO gp_reporting;

-- existing unconfirmed phone matches: pending requests, links ended
INSERT INTO ops.party_link_request (tenant_id, party_id, user_id, requested_at)
SELECT l.tenant_id, l.party_id, l.user_id, l.linked_at
  FROM core.party_user_link l
 WHERE l.state = 'active' AND l.linked_via = 'phone_match';
UPDATE core.party_user_link
   SET state = 'unlinked', unlinked_at = now(),
       unlink_reason = 'D-226: phone match waits for the owner''s confirmation'
 WHERE state = 'active' AND linked_via = 'phone_match';
