-- getproperty-api 0066 — verified reviews, listing assistant, energy insight → getenergy (pack G step G9, modules E13,
-- E15; D-289 (6), D-161, D-238, D-301). schema-design §7.5 rows 195–200.
--   * ops.building_review: one review per lease by a party who lived under it (verified tenure), moderated by the
--     platform, with the owner's public reply; the owner can never delete one (no DELETE grant + trigger).
--   * platform.ai_feature + `listing_assistant` (usage per tenant in platform.ai_usage_record, D-161).
--   * platform.energy_insight_optin: the building owner's opt-in to share aggregate energy figures with getenergy.
--   * bridge.integration_platform + `getenergy`; integration event types `energy.insight.shared` / `.withdrawn`
--     (provisional local contract until collective-asset-core carries it, O-028).
-- No core.* change.

CREATE TYPE ops.building_review_state AS ENUM ('pending_moderation', 'published', 'rejected', 'hidden', 'withdrawn');
CREATE TYPE platform.energy_insight_state AS ENUM ('opted_in', 'opted_out');
ALTER TYPE platform.ai_feature ADD VALUE IF NOT EXISTS 'listing_assistant';
ALTER TYPE bridge.integration_platform ADD VALUE IF NOT EXISTS 'getenergy';

-- Reviews -------------------------------------------------------------------------------------------------------------
CREATE TABLE ops.building_review (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  building_id        uuid NOT NULL,
  unit_id            uuid NOT NULL,
  lease_id           uuid NOT NULL,
  author_party_id    uuid NOT NULL,
  author_user_id     uuid,
  consent_id         uuid,
  rating             smallint NOT NULL,
  body               text,
  language           char(2) NOT NULL DEFAULT 'th',
  tenure_from        date NOT NULL,
  tenure_to          date,
  state              ops.building_review_state NOT NULL,
  submitted_at       timestamptz(6) NOT NULL,
  published_at       timestamptz(6),
  moderated_at       timestamptz(6),
  moderated_by       uuid,
  moderation_reason  text,
  owner_reply        text,
  owner_replied_at   timestamptz(6),
  owner_replied_by   uuid,
  reported_at        timestamptz(6),
  report_reason      text,
  withdrawn_at       timestamptz(6),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT building_review_pkey PRIMARY KEY (id),
  CONSTRAINT building_review_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_review_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_review_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_review_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_review_author_party_id_fkey FOREIGN KEY (author_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT building_review_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT building_review_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES platform.consent (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT building_review_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT building_review_owner_replied_by_fkey FOREIGN KEY (owner_replied_by) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT building_review_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT building_review_body_check CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
  CONSTRAINT building_review_language_check CHECK (language IN ('th', 'en', 'my', 'km', 'lo', 'zh')),
  CONSTRAINT building_review_tenure_check CHECK (tenure_to IS NULL OR tenure_to >= tenure_from),
  CONSTRAINT building_review_withdrawn_check CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (state <> 'withdrawn' OR body IS NULL)),
  CONSTRAINT building_review_body_present_check CHECK (state = 'withdrawn' OR body IS NOT NULL),
  CONSTRAINT building_review_published_check CHECK (state NOT IN ('published', 'hidden') OR published_at IS NOT NULL),
  CONSTRAINT building_review_reason_check CHECK ((state NOT IN ('rejected', 'hidden') OR moderation_reason IS NOT NULL) AND (moderation_reason IS NULL OR length(moderation_reason) BETWEEN 1 AND 1000)),
  CONSTRAINT building_review_reply_check CHECK ((owner_reply IS NULL) = (owner_replied_at IS NULL) AND (owner_reply IS NULL OR length(owner_reply) BETWEEN 1 AND 1000)),
  CONSTRAINT building_review_report_check CHECK ((reported_at IS NULL) = (report_reason IS NULL) AND (report_reason IS NULL OR length(report_reason) BETWEEN 1 AND 1000))
);
COMMENT ON TABLE ops.building_review IS 'D-301 (G9, E13): one review per lease by a party who lived under it (after move-out or after review.min_tenure_months of tenure), consent review.publish, moderated by the platform; the owner replies and reports but never deletes; shown without the reviewer''s identity (tenure as months).';
CREATE UNIQUE INDEX building_review_lease_id_key ON ops.building_review (lease_id);
CREATE INDEX building_review_building_id_state_idx ON ops.building_review (building_id, state, published_at DESC);
CREATE INDEX building_review_tenant_id_state_idx ON ops.building_review (tenant_id, state, submitted_at DESC);
CREATE INDEX building_review_state_submitted_at_idx ON ops.building_review (state, submitted_at) WHERE state = 'pending_moderation' OR reported_at IS NOT NULL;
CREATE INDEX building_review_unit_id_idx ON ops.building_review (unit_id);
CREATE INDEX building_review_author_party_id_idx ON ops.building_review (author_party_id);
CREATE INDEX building_review_author_user_id_idx ON ops.building_review (author_user_id);
CREATE INDEX building_review_consent_id_idx ON ops.building_review (consent_id);
CREATE INDEX building_review_moderated_by_idx ON ops.building_review (moderated_by);
CREATE INDEX building_review_owner_replied_by_idx ON ops.building_review (owner_replied_by);
CREATE TRIGGER building_review_set_updated_at BEFORE UPDATE ON ops.building_review FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- A review is never deleted (the owner cannot remove it; DSR erasure withdraws it); what the author wrote and when they
-- lived there never change — only moderation, the reply, the report and the withdrawal (which erases the body).
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
  RETURN NEW;
END
$$;
CREATE TRIGGER building_review_guard BEFORE UPDATE OR DELETE ON ops.building_review FOR EACH ROW EXECUTE FUNCTION ops.building_review_guard();
CREATE TRIGGER building_review_no_truncate BEFORE TRUNCATE ON ops.building_review FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_truncate();
SELECT platform.apply_rls('ops.building_review', 'tenant');
GRANT SELECT, INSERT, UPDATE ON ops.building_review TO gp_app, gp_platform;
GRANT SELECT ON ops.building_review TO gp_reporting;

-- Energy insight opt-in -----------------------------------------------------------------------------------------------
CREATE TABLE platform.energy_insight_optin (
  id                          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL,
  building_id                 uuid NOT NULL,
  state                       platform.energy_insight_state NOT NULL,
  consent_id                  uuid,
  consent_purpose_version_id  uuid,
  opted_in_at                 timestamptz(6) NOT NULL,
  opted_in_by                 uuid,
  opted_out_at                timestamptz(6),
  opted_out_by                uuid,
  last_shared_at              timestamptz(6),
  last_score                  smallint,
  last_integration_event_id   uuid,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                  uuid,
  CONSTRAINT energy_insight_optin_pkey PRIMARY KEY (id),
  CONSTRAINT energy_insight_optin_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES platform.consent (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_consent_purpose_version_id_fkey FOREIGN KEY (consent_purpose_version_id) REFERENCES platform.consent_purpose_version (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_opted_in_by_fkey FOREIGN KEY (opted_in_by) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_opted_out_by_fkey FOREIGN KEY (opted_out_by) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_last_integration_event_id_fkey FOREIGN KEY (last_integration_event_id) REFERENCES bridge.integration_event (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT energy_insight_optin_out_check CHECK ((state = 'opted_out') = (opted_out_at IS NOT NULL)),
  CONSTRAINT energy_insight_optin_score_check CHECK (last_score IS NULL OR last_score BETWEEN 0 AND 100)
);
COMMENT ON TABLE platform.energy_insight_optin IS 'D-289 (6) / D-301 (G9, E15): the building owner''s opt-in (consent energy.insight) to share aggregate energy figures and a score with getenergy (Collective) as a lead; nothing leaves before it; opting out sends energy.insight.withdrawn.';
CREATE UNIQUE INDEX energy_insight_optin_building_id_key ON platform.energy_insight_optin (building_id);
CREATE INDEX energy_insight_optin_tenant_id_idx ON platform.energy_insight_optin (tenant_id);
CREATE INDEX energy_insight_optin_state_last_shared_at_idx ON platform.energy_insight_optin (state, last_shared_at) WHERE state = 'opted_in';
CREATE INDEX energy_insight_optin_consent_id_idx ON platform.energy_insight_optin (consent_id);
CREATE INDEX energy_insight_optin_consent_purpose_version_id_idx ON platform.energy_insight_optin (consent_purpose_version_id);
CREATE INDEX energy_insight_optin_opted_in_by_idx ON platform.energy_insight_optin (opted_in_by);
CREATE INDEX energy_insight_optin_opted_out_by_idx ON platform.energy_insight_optin (opted_out_by);
CREATE INDEX energy_insight_optin_last_integration_event_id_idx ON platform.energy_insight_optin (last_integration_event_id);
CREATE TRIGGER energy_insight_optin_set_updated_at BEFORE UPDATE ON platform.energy_insight_optin FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT platform.apply_rls('platform.energy_insight_optin', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.energy_insight_optin TO gp_app, gp_platform;
GRANT SELECT ON platform.energy_insight_optin TO gp_reporting;

-- getenergy integration events (provisional contract, O-028) ----------------------------------------------------------
ALTER TABLE bridge.integration_event DROP CONSTRAINT integration_event_event_type_check;
ALTER TABLE bridge.integration_event ADD CONSTRAINT integration_event_event_type_check CHECK (event_type IN (
  'building.handover.requested', 'unit.transferred', 'warranty.defect.reported', 'warranty.defect.closed',
  'juristic.formed', 'procurement.rfq.requested', 'procurement.order.updated', 'identity.party.linked',
  'energy.insight.shared', 'energy.insight.withdrawn'));
