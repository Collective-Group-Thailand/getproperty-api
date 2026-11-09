-- getproperty-api 0081 — PM company portfolio: management contracts, management fee charges, PM staff assignments
-- (Phase J step J3.3, D-150 C3, D-334). schema-design §7.5 rows 290–293 (§7.6 J3-c refined).
--   * juristic.management_contract — a pm_company tenant manages a building of a juristic tenant; the juristic stays
--     owner and operator; the PM's access is a building-scope READ grant (reason pm_contract, module juristic) that
--     lives exactly as long as the contract. RLS "tenant pair": the juristic and the PM read and update, only the
--     juristic inserts; the PM can never change the terms (trigger).
--   * juristic.management_fee_charge — one row per (contract, billing period) = the job's idempotency key; each is one
--     submitted J2.1 expense request of the juristic (never paid automatically).
--   * juristic.pm_staff_assignment — PM members assigned to the buildings it manages (staff board).
--   * juristic.expense_request.management_contract_id.
-- DDL only (no DML on RLS tables); no core.* change.

CREATE TYPE juristic.management_contract_state AS ENUM ('draft', 'offered', 'active', 'declined', 'cancelled', 'ended', 'terminated');
CREATE TYPE juristic.management_fee_period AS ENUM ('monthly', 'quarterly', 'annual');
CREATE TYPE juristic.pm_assignment_role AS ENUM ('building_manager', 'assistant_manager', 'accountant', 'technician',
  'admin_officer', 'security_supervisor', 'other');

-- ------------------------------------------------------------------------------- management contracts (§7.6 J3-c)
CREATE TABLE juristic.management_contract (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  pm_tenant_id          uuid NOT NULL,
  building_id           uuid NOT NULL,
  vendor_id             uuid NOT NULL,
  title                 text NOT NULL,
  scope                 text,
  fee                   numeric(14,2) NOT NULL,
  vat_amount            numeric(14,2) NOT NULL DEFAULT 0,
  fee_period            juristic.management_fee_period NOT NULL DEFAULT 'monthly',
  due_day               smallint NOT NULL DEFAULT 5,
  starts_on             date NOT NULL,
  ends_on               date NOT NULL,
  expense_account_id    uuid,
  wht_key               text,
  resolution_id         uuid,
  document_id           uuid,
  grant_id              uuid,
  state                 juristic.management_contract_state NOT NULL DEFAULT 'draft',
  offered_at            timestamptz(6),
  offered_by            uuid,
  accepted_at           timestamptz(6),
  accepted_by           uuid,
  declined_at           timestamptz(6),
  decline_reason        text,
  cancelled_at          timestamptz(6),
  cancel_reason         text,
  terminated_on         date,
  terminated_at         timestamptz(6),
  terminated_by         uuid,
  terminated_by_tenant_id uuid,
  termination_reason    text,
  ended_at              timestamptz(6),
  note                  text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT management_contract_pkey PRIMARY KEY (id),
  CONSTRAINT management_contract_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_pm_tenant_id_fkey FOREIGN KEY (pm_tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES juristic.vendor (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_expense_account_id_fkey FOREIGN KEY (expense_account_id) REFERENCES juristic.account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES core.asset_access_grant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_offered_by_fkey FOREIGN KEY (offered_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_terminated_by_fkey FOREIGN KEY (terminated_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_contract_pair_check CHECK (pm_tenant_id <> tenant_id),
  CONSTRAINT management_contract_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT management_contract_texts_check CHECK ((scope IS NULL OR length(scope) <= 8000) AND (note IS NULL OR length(note) <= 2000)
    AND (decline_reason IS NULL OR length(decline_reason) <= 1000) AND (cancel_reason IS NULL OR length(cancel_reason) <= 1000)
    AND (termination_reason IS NULL OR length(termination_reason) <= 1000) AND (wht_key IS NULL OR length(wht_key) <= 50)),
  CONSTRAINT management_contract_fee_check CHECK (fee > 0 AND vat_amount >= 0 AND vat_amount <= fee),
  CONSTRAINT management_contract_due_day_check CHECK (due_day BETWEEN 1 AND 28),
  CONSTRAINT management_contract_period_check CHECK (ends_on >= starts_on),
  -- D-334: an offer carries everything the fee requests need, the resolution that appointed the manager included
  CONSTRAINT management_contract_offer_check CHECK (state IN ('draft', 'cancelled') OR (offered_at IS NOT NULL AND offered_by IS NOT NULL
    AND resolution_id IS NOT NULL AND expense_account_id IS NOT NULL)),
  CONSTRAINT management_contract_active_check CHECK (state NOT IN ('active', 'ended', 'terminated') OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND grant_id IS NOT NULL)),
  CONSTRAINT management_contract_declined_check CHECK ((state = 'declined') = (declined_at IS NOT NULL)),
  CONSTRAINT management_contract_terminated_check CHECK ((state = 'terminated') = (terminated_at IS NOT NULL AND terminated_on IS NOT NULL
    AND termination_reason IS NOT NULL AND terminated_by_tenant_id IS NOT NULL)),
  CONSTRAINT management_contract_terminated_on_check CHECK (terminated_on IS NULL OR (terminated_on >= starts_on AND terminated_on <= ends_on + 1)),
  CONSTRAINT management_contract_terminated_by_tenant_check CHECK (terminated_by_tenant_id IS NULL OR terminated_by_tenant_id IN (tenant_id, pm_tenant_id))
);
COMMENT ON TABLE juristic.management_contract IS 'D-150 C3 / D-334 (J3.3): a pm_company tenant manages a building of a juristic tenant (fee per period → submitted expense requests of the juristic, never paid automatically); the PM sees the building through a read grant (module juristic) valid for the term. Tenant pair RLS. Kept 10 years.';
CREATE UNIQUE INDEX management_contract_building_pm_starts_key ON juristic.management_contract (building_id, pm_tenant_id, starts_on);
CREATE INDEX management_contract_tenant_id_state_idx ON juristic.management_contract (tenant_id, state);
CREATE INDEX management_contract_pm_tenant_id_state_idx ON juristic.management_contract (pm_tenant_id, state);
CREATE INDEX management_contract_ends_on_idx ON juristic.management_contract (ends_on) WHERE (state = 'active');
-- one manager at a time: live (offered / active) contracts of a building never overlap
ALTER TABLE juristic.management_contract ADD CONSTRAINT management_contract_no_overlap EXCLUDE USING gist
  (building_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&) WHERE (state IN ('offered', 'active'));
CREATE TRIGGER management_contract_set_updated_at BEFORE UPDATE ON juristic.management_contract FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE juristic.management_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE juristic.management_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY management_contract_rls_read ON juristic.management_contract FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id()) OR pm_tenant_id = (SELECT core.current_tenant_id()));
CREATE POLICY management_contract_rls_insert ON juristic.management_contract FOR INSERT
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
CREATE POLICY management_contract_rls_update ON juristic.management_contract FOR UPDATE
  USING (tenant_id = (SELECT core.current_tenant_id()) OR pm_tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR pm_tenant_id = (SELECT core.current_tenant_id()));
REVOKE DELETE ON juristic.management_contract FROM gp_app;

-- The PM side may accept, decline and terminate — never change the terms the juristic offered.
CREATE FUNCTION juristic.management_contract_pm_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF core.current_tenant_id() IS NOT NULL AND core.current_tenant_id() = OLD.pm_tenant_id
     AND (NEW.tenant_id, NEW.pm_tenant_id, NEW.building_id, NEW.vendor_id, NEW.title, NEW.scope, NEW.fee, NEW.vat_amount,
          NEW.fee_period, NEW.due_day, NEW.starts_on, NEW.ends_on, NEW.expense_account_id, NEW.wht_key, NEW.resolution_id,
          NEW.document_id, NEW.offered_at, NEW.offered_by)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.pm_tenant_id, OLD.building_id, OLD.vendor_id, OLD.title, OLD.scope, OLD.fee, OLD.vat_amount,
          OLD.fee_period, OLD.due_day, OLD.starts_on, OLD.ends_on, OLD.expense_account_id, OLD.wht_key, OLD.resolution_id,
          OLD.document_id, OLD.offered_at, OLD.offered_by) THEN
    RAISE EXCEPTION 'management_contract: the PM company cannot change the terms' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER management_contract_pm_guard BEFORE UPDATE ON juristic.management_contract
  FOR EACH ROW EXECUTE FUNCTION juristic.management_contract_pm_guard();

-- ------------------------------------------------------------------------------- management fee charges
CREATE TABLE juristic.management_fee_charge (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  contract_id         uuid NOT NULL,
  period_key          text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  service_days        smallint NOT NULL,
  period_days         smallint NOT NULL,
  amount              numeric(14,2) NOT NULL,
  vat_amount          numeric(14,2) NOT NULL DEFAULT 0,
  due_on              date NOT NULL,
  expense_request_id  uuid NOT NULL,
  requested_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT management_fee_charge_pkey PRIMARY KEY (id),
  CONSTRAINT management_fee_charge_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_fee_charge_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.management_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_fee_charge_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES juristic.expense_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_fee_charge_period_key_check CHECK (period_key ~ '^[0-9]{4}(-[0-9]{2}|-Q[1-4])?$'),
  CONSTRAINT management_fee_charge_period_check CHECK (period_end >= period_start),
  CONSTRAINT management_fee_charge_days_check CHECK (service_days BETWEEN 1 AND period_days AND period_days BETWEEN 1 AND 366),
  CONSTRAINT management_fee_charge_amount_check CHECK (amount > 0 AND vat_amount >= 0 AND vat_amount <= amount)
);
COMMENT ON TABLE juristic.management_fee_charge IS 'D-334 (J3.3): the management fee of one billing period of a contract (prorated by calendar days of service), requested as one submitted expense request of the juristic; UQ (contract, period) makes the job idempotent. Append-only.';
CREATE UNIQUE INDEX management_fee_charge_contract_id_period_key_key ON juristic.management_fee_charge (contract_id, period_key);
CREATE UNIQUE INDEX management_fee_charge_expense_request_id_key ON juristic.management_fee_charge (expense_request_id);
CREATE INDEX management_fee_charge_tenant_id_idx ON juristic.management_fee_charge (tenant_id, period_start DESC);
ALTER TABLE juristic.management_fee_charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE juristic.management_fee_charge FORCE ROW LEVEL SECURITY;
CREATE POLICY management_fee_charge_rls_t ON juristic.management_fee_charge FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
-- the PM reads what it billed (its contracts' charges); never writes
CREATE POLICY management_fee_charge_rls_pm_read ON juristic.management_fee_charge FOR SELECT
  USING (EXISTS (SELECT 1 FROM juristic.management_contract c WHERE c.id = contract_id AND c.pm_tenant_id = (SELECT core.current_tenant_id())));
REVOKE UPDATE, DELETE ON juristic.management_fee_charge FROM gp_app;

-- ------------------------------------------------------------------------------- PM staff assignments
CREATE TABLE juristic.pm_staff_assignment (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  contract_id   uuid NOT NULL,
  building_id   uuid NOT NULL,
  user_id       uuid NOT NULL,
  role          juristic.pm_assignment_role NOT NULL,
  shift         text,
  starts_on     date NOT NULL,
  ends_on       date,
  ended_at      timestamptz(6),
  ended_by      uuid,
  note          text,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT pm_staff_assignment_pkey PRIMARY KEY (id),
  CONSTRAINT pm_staff_assignment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pm_staff_assignment_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES juristic.management_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pm_staff_assignment_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pm_staff_assignment_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pm_staff_assignment_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT pm_staff_assignment_range_check CHECK (ends_on IS NULL OR ends_on > starts_on),
  CONSTRAINT pm_staff_assignment_texts_check CHECK ((shift IS NULL OR length(shift) <= 100) AND (note IS NULL OR length(note) <= 1000))
);
COMMENT ON TABLE juristic.pm_staff_assignment IS 'D-334 (J3.3): a member of a pm_company tenant assigned to a building it manages (role, shift, from / to exclusive) inside the management contract term; the staff board of the PM. The juristic reads the rows of its own contracts.';
ALTER TABLE juristic.pm_staff_assignment ADD CONSTRAINT pm_staff_assignment_no_overlap EXCLUDE USING gist
  (user_id WITH =, building_id WITH =, daterange(starts_on, ends_on, '[)') WITH &&);
CREATE INDEX pm_staff_assignment_tenant_id_idx ON juristic.pm_staff_assignment (tenant_id, building_id);
CREATE INDEX pm_staff_assignment_contract_id_idx ON juristic.pm_staff_assignment (contract_id);
CREATE INDEX pm_staff_assignment_user_id_idx ON juristic.pm_staff_assignment (user_id);
CREATE TRIGGER pm_staff_assignment_set_updated_at BEFORE UPDATE ON juristic.pm_staff_assignment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
ALTER TABLE juristic.pm_staff_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE juristic.pm_staff_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY pm_staff_assignment_rls_t ON juristic.pm_staff_assignment FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
CREATE POLICY pm_staff_assignment_rls_juristic_read ON juristic.pm_staff_assignment FOR SELECT
  USING (EXISTS (SELECT 1 FROM juristic.management_contract c WHERE c.id = contract_id AND c.tenant_id = (SELECT core.current_tenant_id())));
REVOKE DELETE ON juristic.pm_staff_assignment FROM gp_app;

-- ------------------------------------------------------------------------------- expense requests of a management contract
ALTER TABLE juristic.expense_request ADD COLUMN management_contract_id uuid;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_management_contract_id_fkey
  FOREIGN KEY (management_contract_id) REFERENCES juristic.management_contract (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE juristic.expense_request ADD CONSTRAINT expense_request_management_link_check
  CHECK (management_contract_id IS NULL OR (vendor_id IS NOT NULL AND vendor_contract_id IS NULL));
CREATE INDEX expense_request_management_contract_id_idx ON juristic.expense_request (management_contract_id) WHERE (management_contract_id IS NOT NULL);
