-- getproperty-api 0032 — consumer contract requests before release (docs/contract-requests-triage.md F6, D-218):
--   LIFF #23  ops.service_message: the message thread of a repair request (resident ↔ office ↔ technician) or of a
--             work order without a request (office ↔ technician) — nobody exchanges phone numbers (D-072);
--   LIFF #24  ops.service_request.preferred_visit (when the technician may come) and the resident's confirmation of
--             the scheduled visit (visit_confirmed_at + the visit start it confirmed: a rescheduled visit asks again).
-- Deviations (schema-design §7.5 rows 96–97): one ops table and three service_request columns the v2 design did not
-- list.

CREATE TYPE ops.visit_preference AS ENUM ('anytime', 'morning', 'afternoon', 'evening');
CREATE TYPE ops.service_message_author AS ENUM ('resident', 'office', 'technician', 'system');

-- ------------------------------------------------------------------------------------------------ preferred visit
ALTER TABLE ops.service_request
  ADD COLUMN preferred_visit      ops.visit_preference,
  ADD COLUMN visit_confirmed_at   timestamptz(6),
  ADD COLUMN visit_confirmed_for  timestamptz(6),
  ADD CONSTRAINT service_request_visit_confirmed_check CHECK ((visit_confirmed_at IS NULL) = (visit_confirmed_for IS NULL));
COMMENT ON COLUMN ops.service_request.preferred_visit IS 'When the resident prefers the visit (LIFF #24, D-218): anytime, morning, afternoon, evening.';
COMMENT ON COLUMN ops.service_request.visit_confirmed_for IS 'The scheduled visit start the resident confirmed; a confirmation counts only while the visit keeps that start.';

-- ----------------------------------------------------------------------------------------------------- messages
CREATE TABLE ops.service_message (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  service_request_id  uuid,
  work_order_id       uuid,
  author_kind         ops.service_message_author NOT NULL,
  author_user_id      uuid,
  author_party_id     uuid,
  author_name         text NOT NULL,
  body                text NOT NULL,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT service_message_pkey PRIMARY KEY (id),
  CONSTRAINT service_message_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES ops.work_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_author_party_id_fkey FOREIGN KEY (author_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_message_subject_check CHECK (service_request_id IS NOT NULL OR work_order_id IS NOT NULL),
  CONSTRAINT service_message_body_check CHECK (length(body) BETWEEN 1 AND 2000),
  CONSTRAINT service_message_author_name_check CHECK (length(author_name) BETWEEN 1 AND 200),
  CONSTRAINT service_message_author_check CHECK (author_kind = 'system' OR author_user_id IS NOT NULL OR author_party_id IS NOT NULL)
);
COMMENT ON TABLE ops.service_message IS 'Message thread of a repair request (resident, office, technician) or of a work order without a request (D-072, D-218): append-only, no phone numbers exchanged; a technician''s message on a request''s work order joins the request thread (work_order_id kept).';
CREATE INDEX service_message_service_request_id_created_at_idx ON ops.service_message (service_request_id, created_at);
CREATE INDEX service_message_work_order_id_created_at_idx ON ops.service_message (work_order_id, created_at);
CREATE INDEX service_message_tenant_id_building_id_idx ON ops.service_message (tenant_id, building_id);
CREATE INDEX service_message_building_id_idx ON ops.service_message (building_id);
CREATE INDEX service_message_author_user_id_idx ON ops.service_message (author_user_id);
CREATE INDEX service_message_author_party_id_idx ON ops.service_message (author_party_id);

SELECT platform.apply_rls('ops.service_message', 'building', 'ops.service');
-- append-only for the application (a message is never edited: the thread is evidence of what was agreed); the
-- platform role keeps UPDATE for PDPA anonymisation of an author (D-025)
GRANT SELECT, INSERT ON ops.service_message TO gp_app;
GRANT SELECT, INSERT, UPDATE ON ops.service_message TO gp_platform;
GRANT SELECT ON ops.service_message TO gp_reporting;
