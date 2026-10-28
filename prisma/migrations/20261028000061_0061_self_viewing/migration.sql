-- getproperty-api 0061 — G7 (pack G module E8): self-viewing with time-boxed door codes
-- (D-289 (1), D-295; schema-design §7.5 rows 165–169). Insurance / visitor terms open (O-024), agency listings on the
-- owner's lock and log retention open (O-031).
--   * ops.listing_viewing.mode / identity_verification_id / visitor_terms_version: B7.3 viewings gain a mode — no
--     parallel viewing table.
--   * ops.viewing_access: the access window of one self viewing (one open window per person at a time).
--   * smart.access_credential.viewing_id: the visitor credentials of a viewing (unit lock + building doors, one PIN).
--   * smart.viewing_credential_vacancy_guard: the database refuses a viewing credential for an occupied unit.

CREATE TYPE ops.viewing_mode AS ENUM ('accompanied', 'self');
CREATE TYPE ops.viewing_access_state AS ENUM ('issued', 'entered', 'exited', 'expired', 'no_show', 'cancelled');

-- Viewings gain a mode ---------------------------------------------------------------------------------------------
ALTER TABLE ops.listing_viewing
  ADD COLUMN mode ops.viewing_mode NOT NULL DEFAULT 'accompanied',
  ADD COLUMN identity_verification_id uuid,
  ADD COLUMN visitor_terms_version smallint,
  ADD CONSTRAINT listing_viewing_identity_verification_id_fkey FOREIGN KEY (identity_verification_id) REFERENCES platform.identity_verification (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT listing_viewing_self_check CHECK (mode = 'accompanied' OR (identity_verification_id IS NOT NULL AND visitor_terms_version IS NOT NULL)),
  ADD CONSTRAINT listing_viewing_visitor_terms_version_check CHECK (visitor_terms_version IS NULL OR visitor_terms_version > 0);
CREATE INDEX listing_viewing_identity_verification_id_idx ON ops.listing_viewing (identity_verification_id);
COMMENT ON COLUMN ops.listing_viewing.mode IS 'D-289 (1) / D-295: accompanied (B7.3) or self — a verified prospect enters alone with a time-boxed door code.';

-- The access window of a self viewing -------------------------------------------------------------------------------
CREATE TABLE ops.viewing_access (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  viewing_id          uuid NOT NULL,
  listing_id          uuid NOT NULL,
  unit_id             uuid NOT NULL,
  building_id         uuid NOT NULL,
  prospect_user_id    uuid NOT NULL,
  lock_id             uuid NOT NULL,
  state               ops.viewing_access_state NOT NULL DEFAULT 'issued',
  valid_from          timestamptz(6) NOT NULL,
  valid_to            timestamptz(6) NOT NULL,
  entered_at          timestamptz(6),
  entered_source      text,
  exited_at           timestamptz(6),
  closed_at           timestamptz(6),
  close_reason        text,
  code_revealed_at    timestamptz(6),
  reveal_count        integer NOT NULL DEFAULT 0,
  incident_note       text,
  incident_at         timestamptz(6),
  work_order_id       uuid,
  overstay_alerted_at timestamptz(6),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT viewing_access_pkey PRIMARY KEY (id),
  CONSTRAINT viewing_access_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_viewing_id_fkey FOREIGN KEY (viewing_id) REFERENCES ops.listing_viewing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES ops.listing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_prospect_user_id_fkey FOREIGN KEY (prospect_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES smart.lock (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES ops.work_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT viewing_access_window_check CHECK (valid_to > valid_from),
  CONSTRAINT viewing_access_entered_source_check CHECK (entered_source IS NULL OR entered_source IN ('prospect', 'lock_log')),
  CONSTRAINT viewing_access_entered_check CHECK ((entered_at IS NULL) = (entered_source IS NULL)),
  CONSTRAINT viewing_access_closed_check CHECK ((closed_at IS NULL) = (state IN ('issued', 'entered'))),
  CONSTRAINT viewing_access_close_reason_check CHECK (close_reason IS NULL OR length(close_reason) <= 200),
  CONSTRAINT viewing_access_incident_note_check CHECK (incident_note IS NULL OR length(incident_note) <= 2000),
  CONSTRAINT viewing_access_incident_check CHECK ((incident_note IS NULL) = (incident_at IS NULL)),
  CONSTRAINT viewing_access_reveal_count_check CHECK (reveal_count >= 0),
  CONSTRAINT viewing_access_one_open_window EXCLUDE USING gist (prospect_user_id WITH =, tstzrange(valid_from, valid_to) WITH &&) WHERE (closed_at IS NULL)
);
CREATE UNIQUE INDEX viewing_access_viewing_id_key ON ops.viewing_access (viewing_id);
CREATE INDEX viewing_access_tenant_id_state_idx ON ops.viewing_access (tenant_id, state);
CREATE INDEX viewing_access_listing_id_idx ON ops.viewing_access (listing_id);
CREATE INDEX viewing_access_unit_id_idx ON ops.viewing_access (unit_id);
CREATE INDEX viewing_access_building_id_idx ON ops.viewing_access (building_id);
CREATE INDEX viewing_access_prospect_user_id_idx ON ops.viewing_access (prospect_user_id);
CREATE INDEX viewing_access_lock_id_idx ON ops.viewing_access (lock_id);
CREATE INDEX viewing_access_work_order_id_idx ON ops.viewing_access (work_order_id);
CREATE INDEX viewing_access_open_idx ON ops.viewing_access (valid_to) WHERE closed_at IS NULL;
CREATE INDEX viewing_access_closed_at_idx ON ops.viewing_access (closed_at) WHERE closed_at IS NOT NULL;
CREATE TRIGGER viewing_access_set_updated_at BEFORE UPDATE ON ops.viewing_access FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
COMMENT ON TABLE ops.viewing_access IS 'D-289 (1) / D-295: the door-code window of one self viewing. The code itself lives only encrypted in smart.access_credential.pin_enc; this row never holds it.';

-- Visitor credentials of a viewing ---------------------------------------------------------------------------------
ALTER TABLE smart.access_credential
  ADD COLUMN viewing_id uuid,
  ADD CONSTRAINT access_credential_viewing_id_fkey FOREIGN KEY (viewing_id) REFERENCES ops.listing_viewing (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT access_credential_viewing_check CHECK (viewing_id IS NULL OR (holder_kind = 'visitor' AND valid_to IS NOT NULL AND lease_id IS NULL AND work_order_id IS NULL));
CREATE INDEX access_credential_viewing_id_idx ON smart.access_credential (viewing_id);

-- A viewing credential is never issued for an occupied unit (D-289 (1), D-071) -------------------------------------
CREATE OR REPLACE FUNCTION smart.viewing_credential_vacancy_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  v_unit uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  IF NEW.viewing_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT l.unit_id INTO v_unit
    FROM ops.listing_viewing v JOIN ops.listing l ON l.id = v.listing_id
   WHERE v.id = NEW.viewing_id;
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'access.unit_occupied: the viewing of this credential is not visible' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM core.occupancy o
              WHERE o.unit_id = v_unit AND o.valid_from <= v_today AND (o.valid_to IS NULL OR o.valid_to > v_today)
                AND o.moved_out_at IS NULL)
     OR EXISTS (SELECT 1 FROM ops.lease l
                 WHERE l.unit_id = v_unit AND l.status IN ('active', 'notice_given', 'ending')) THEN
    RAISE EXCEPTION 'access.unit_occupied: a viewing door code is never issued for an occupied unit' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER access_credential_viewing_vacancy_guard BEFORE INSERT ON smart.access_credential
  FOR EACH ROW WHEN (NEW.viewing_id IS NOT NULL) EXECUTE FUNCTION smart.viewing_credential_vacancy_guard();

-- RLS ---------------------------------------------------------------------------------------------------------------
SELECT platform.apply_rls('ops.viewing_access', 'tenant');
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.viewing_access TO gp_app, gp_platform;
GRANT SELECT ON ops.viewing_access TO gp_reporting;
