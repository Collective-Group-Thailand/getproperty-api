-- getproperty-api 0067 — fixes of the independent review of pack G (G review). schema-design §7.5 rows 201–202.
--   * ops.building_review_guard: only the platform role changes a review's state or moderation (approve / reject /
--     hide / restore, the author's withdrawal and DSR erasure all run as gp_platform). The owner tenant's role keeps
--     only its reply and report (D-301 (3): the owner never hides or removes a review).
--   * platform.ai_usage_reservation: an AI call reserves its place in a monthly limit before it is made, so
--     concurrent calls cannot exceed the limit (listing assistant, D-301 (6) / O-009).
-- No core.* change.

CREATE OR REPLACE FUNCTION ops.building_review_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'core.append_only: a building review cannot be deleted (it is withdrawn or hidden)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.building_id <> OLD.building_id OR NEW.unit_id <> OLD.unit_id
     OR NEW.lease_id <> OLD.lease_id OR NEW.author_party_id <> OLD.author_party_id OR NEW.rating <> OLD.rating
     OR NEW.tenure_from <> OLD.tenure_from OR NEW.tenure_to IS DISTINCT FROM OLD.tenure_to
     OR NEW.submitted_at <> OLD.submitted_at OR NEW.language <> OLD.language
     OR (NEW.body IS DISTINCT FROM OLD.body AND NEW.state <> 'withdrawn') THEN
    RAISE EXCEPTION 'core.append_only: what a reviewer wrote cannot change (only moderation, reply, report or withdrawal)' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state = 'withdrawn' AND NEW.state <> 'withdrawn' THEN
    RAISE EXCEPTION 'core.append_only: a withdrawn review stays withdrawn' USING ERRCODE = 'P0001';
  END IF;
  -- G review #9: state and moderation columns change only through the platform role (moderators, the author's
  -- withdrawal, DSR) — never through the owner tenant's role, whatever its RLS policy lets it update
  IF (NEW.state IS DISTINCT FROM OLD.state OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.moderated_at IS DISTINCT FROM OLD.moderated_at OR NEW.moderated_by IS DISTINCT FROM OLD.moderated_by
      OR NEW.moderation_reason IS DISTINCT FROM OLD.moderation_reason
      OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
     AND NOT pg_has_role(current_user, 'gp_platform', 'MEMBER') THEN
    RAISE EXCEPTION 'core.append_only: only the platform moderation role changes a review''s state or moderation' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- AI usage reservations ------------------------------------------------------------------------------------------------
CREATE TABLE platform.ai_usage_reservation (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  feature      platform.ai_feature NOT NULL,
  request_ref  text,
  reserved_at  timestamptz(6) NOT NULL,
  expires_at   timestamptz(6) NOT NULL,
  CONSTRAINT ai_usage_reservation_pkey PRIMARY KEY (id),
  CONSTRAINT ai_usage_reservation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ai_usage_reservation_expiry_check CHECK (expires_at > reserved_at)
);
COMMENT ON TABLE platform.ai_usage_reservation IS 'G review #6 (D-301 (6), O-009): a place in a monthly AI limit taken before the call (counted with the ok usage records while it lives), removed when the call is recorded; a crashed call frees it at expires_at.';
CREATE INDEX ai_usage_reservation_tenant_id_feature_expires_at_idx ON platform.ai_usage_reservation (tenant_id, feature, expires_at);
SELECT platform.apply_rls('platform.ai_usage_reservation', 'platform_only');
GRANT SELECT, INSERT, DELETE ON platform.ai_usage_reservation TO gp_platform;
