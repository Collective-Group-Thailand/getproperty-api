-- getproperty-api 0027 — B5.1 service requests & work orders (blueprint A4, D-072, D-034, D-153, D-159):
--   ops.service_category      platform defaults (tenant_id NULL) + tenant overrides with the default SLA hours;
--   ops.service_request       resident / staff / owner / system requests with photos (platform.attachment), an SLA
--                             on the workflow engine (definition `service_request`), rating, warranty flag;
--   ops.work_order            repair / preventive / install / deinstall / inspection, assigned to a staff login or
--                             an external technician party (technician tokens are scoped by work order id);
--   ops.work_order_cost_line  parts / labour / travel feeding the income & expense summary (B4.5);
--   ops.maintenance_plan      preventive maintenance of a core.asset_item every N days (generates work orders).
-- Deviations (schema-design §7.5 rows 77–80): service_request + asset_item_id, reporter_user_id, sla_hours,
-- auto_reason, warranty_resolution, timestamps per state; work_order + unit_id, maintenance_plan_id, title,
-- priority, scheduled_until, state timestamps; cost line kind / unit price; ops.maintenance_plan (new).

CREATE TYPE ops.service_reporter_kind AS ENUM ('resident', 'staff', 'owner', 'system');
CREATE TYPE ops.service_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE ops.service_request_status AS ENUM ('new', 'triaged', 'assigned', 'in_progress', 'waiting_parts', 'done', 'closed', 'cancelled');
CREATE TYPE ops.work_order_kind AS ENUM ('repair', 'preventive', 'install', 'deinstall', 'inspection');
CREATE TYPE ops.work_order_status AS ENUM ('open', 'assigned', 'accepted', 'in_progress', 'done', 'verified', 'cancelled');
CREATE TYPE ops.work_order_cost_kind AS ENUM ('part', 'labour', 'travel', 'other');

-- ------------------------------------------------------------------------------------------- service categories
CREATE TABLE ops.service_category (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid,
  key                text NOT NULL,
  name_th            text NOT NULL,
  name_en            text NOT NULL,
  default_sla_hours  integer NOT NULL,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz(6),
  deleted_by         uuid,
  CONSTRAINT service_category_pkey PRIMARY KEY (id),
  CONSTRAINT service_category_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_category_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT service_category_sla_check CHECK (default_sla_hours BETWEEN 1 AND 2160)
);
COMMENT ON TABLE ops.service_category IS 'Repair categories with their default SLA hours (D-072): platform defaults (tenant_id NULL) and tenant overrides of the same key (unique with NULLS NOT DISTINCT).';
CREATE UNIQUE INDEX service_category_tenant_id_key_key ON ops.service_category (tenant_id, key) NULLS NOT DISTINCT;
CREATE TRIGGER service_category_set_updated_at BEFORE UPDATE ON ops.service_category FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- --------------------------------------------------------------------------------------------- service requests
CREATE TABLE ops.service_request (
  id                             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                      uuid NOT NULL,
  building_id                    uuid NOT NULL,
  unit_id                        uuid,
  asset_item_id                  uuid,
  requester_party_id             uuid,
  reporter_kind                  ops.service_reporter_kind NOT NULL,
  reporter_user_id               uuid,
  category_id                    uuid NOT NULL,
  description                    text NOT NULL,
  priority                       ops.service_priority NOT NULL DEFAULT 'normal',
  status                         ops.service_request_status NOT NULL DEFAULT 'new',
  sla_hours                      integer NOT NULL,
  workflow_instance_id           uuid,
  in_warranty                    boolean NOT NULL DEFAULT false,
  warranty_integration_event_id  uuid,
  warranty_resolution            text,
  source_device_event_id         uuid,
  auto_reason                    text,
  triaged_at                     timestamptz(6),
  done_at                        timestamptz(6),
  closed_at                      timestamptz(6),
  cancelled_at                   timestamptz(6),
  cancel_reason                  text,
  rating                         smallint,
  rating_comment                 text,
  rated_at                       timestamptz(6),
  version                        integer NOT NULL DEFAULT 1,
  created_at                     timestamptz(6) NOT NULL DEFAULT now(),
  created_by                     uuid,
  updated_at                     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                     uuid,
  CONSTRAINT service_request_pkey PRIMARY KEY (id),
  CONSTRAINT service_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_requester_party_id_fkey FOREIGN KEY (requester_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_category_id_fkey FOREIGN KEY (category_id) REFERENCES ops.service_category (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_workflow_instance_id_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT service_request_description_check CHECK (length(description) BETWEEN 1 AND 5000),
  CONSTRAINT service_request_sla_check CHECK (sla_hours > 0),
  CONSTRAINT service_request_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT service_request_rated_check CHECK ((rating IS NULL) = (rated_at IS NULL)),
  CONSTRAINT service_request_closed_check CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  CONSTRAINT service_request_cancelled_check CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CONSTRAINT service_request_system_check CHECK (reporter_kind <> 'system' OR auto_reason IS NOT NULL)
);
COMMENT ON TABLE ops.service_request IS 'A repair request (D-072): photos in platform.attachment (role report), SLA timers on the workflow engine (D-159), in_warranty requests referred to getbuild through bridge.integration_event (D-153), auto-requests from meter / gateway / lock health (D-034, 24 h dedup per asset item).';
CREATE INDEX service_request_tenant_id_building_id_status_idx ON ops.service_request (tenant_id, building_id, status);
CREATE INDEX service_request_building_id_idx ON ops.service_request (building_id);
CREATE INDEX service_request_unit_id_idx ON ops.service_request (unit_id);
CREATE INDEX service_request_asset_item_id_created_at_idx ON ops.service_request (asset_item_id, created_at);
CREATE INDEX service_request_requester_party_id_idx ON ops.service_request (requester_party_id);
CREATE INDEX service_request_category_id_idx ON ops.service_request (category_id);
CREATE INDEX service_request_workflow_instance_id_idx ON ops.service_request (workflow_instance_id);
CREATE TRIGGER service_request_set_updated_at BEFORE UPDATE ON ops.service_request FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------------------- work orders
CREATE TABLE ops.work_order (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  service_request_id    uuid,
  asset_item_id         uuid,
  unit_id               uuid,
  maintenance_plan_id   uuid,
  kind                  ops.work_order_kind NOT NULL,
  title                 text NOT NULL,
  description           text,
  priority              ops.service_priority NOT NULL DEFAULT 'normal',
  assignee_party_id     uuid,
  assignee_user_id      uuid,
  scheduled_at          timestamptz(6),
  scheduled_until       timestamptz(6),
  status                ops.work_order_status NOT NULL DEFAULT 'open',
  assigned_at           timestamptz(6),
  accepted_at           timestamptz(6),
  checked_in_at         timestamptz(6),
  completed_at          timestamptz(6),
  verified_at           timestamptz(6),
  cancelled_at          timestamptz(6),
  cancel_reason         text,
  completion_note       text,
  cost_total            numeric(14, 2) NOT NULL DEFAULT 0,
  procurement_ref       text,
  workflow_instance_id  uuid,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT work_order_pkey PRIMARY KEY (id),
  CONSTRAINT work_order_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES ops.service_request (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_assignee_party_id_fkey FOREIGN KEY (assignee_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_workflow_instance_id_fkey FOREIGN KEY (workflow_instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT work_order_one_assignee_check CHECK (assignee_party_id IS NULL OR assignee_user_id IS NULL),
  CONSTRAINT work_order_assigned_check CHECK (status IN ('open', 'cancelled') OR assignee_party_id IS NOT NULL OR assignee_user_id IS NOT NULL),
  CONSTRAINT work_order_window_check CHECK (scheduled_until IS NULL OR scheduled_at IS NULL OR scheduled_until > scheduled_at),
  CONSTRAINT work_order_cost_check CHECK (cost_total >= 0 AND cost_total = round(cost_total, 2)),
  CONSTRAINT work_order_done_check CHECK (status NOT IN ('done', 'verified') OR completed_at IS NOT NULL),
  CONSTRAINT work_order_cancelled_check CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
COMMENT ON TABLE ops.work_order IS 'Work on a request, an asset item or a unit (D-072): assigned to a staff login (assignee_user_id) or an external technician party (assignee_party_id → technician LIFF, scope work_order:<id>); before/after photos in platform.attachment; costs in ops.work_order_cost_line (B4.5 expenses).';
CREATE INDEX work_order_tenant_id_building_id_status_idx ON ops.work_order (tenant_id, building_id, status);
CREATE INDEX work_order_building_id_idx ON ops.work_order (building_id);
CREATE INDEX work_order_assignee_party_id_status_idx ON ops.work_order (assignee_party_id, status);
CREATE INDEX work_order_assignee_user_id_status_idx ON ops.work_order (assignee_user_id, status);
CREATE INDEX work_order_service_request_id_idx ON ops.work_order (service_request_id);
CREATE INDEX work_order_asset_item_id_idx ON ops.work_order (asset_item_id);
CREATE INDEX work_order_unit_id_idx ON ops.work_order (unit_id);
CREATE INDEX work_order_maintenance_plan_id_idx ON ops.work_order (maintenance_plan_id);
CREATE INDEX work_order_tenant_id_completed_at_idx ON ops.work_order (tenant_id, completed_at);
CREATE TRIGGER work_order_set_updated_at BEFORE UPDATE ON ops.work_order FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE ops.work_order_cost_line (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  work_order_id        uuid NOT NULL,
  kind                 ops.work_order_cost_kind NOT NULL DEFAULT 'part',
  description          text NOT NULL,
  quantity             numeric(12, 3) NOT NULL DEFAULT 1,
  unit_price           numeric(14, 2) NOT NULL,
  amount               numeric(14, 2) NOT NULL,
  vendor_party_id      uuid,
  receipt_document_id  uuid,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT work_order_cost_line_pkey PRIMARY KEY (id),
  CONSTRAINT work_order_cost_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_cost_line_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES ops.work_order (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT work_order_cost_line_vendor_party_id_fkey FOREIGN KEY (vendor_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_cost_line_receipt_document_id_fkey FOREIGN KEY (receipt_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_cost_line_description_check CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT work_order_cost_line_quantity_check CHECK (quantity > 0),
  CONSTRAINT work_order_cost_line_price_check CHECK (unit_price >= 0 AND unit_price = round(unit_price, 2)),
  CONSTRAINT work_order_cost_line_amount_check CHECK (amount = round(quantity * unit_price, 2))
);
COMMENT ON TABLE ops.work_order_cost_line IS 'Parts, labour and travel of a work order (THB, decimal); the work order keeps cost_total in step; summed into the income & expense export by completion month (B4.5).';
CREATE INDEX work_order_cost_line_work_order_id_idx ON ops.work_order_cost_line (work_order_id);
CREATE INDEX work_order_cost_line_tenant_id_idx ON ops.work_order_cost_line (tenant_id);
CREATE TRIGGER work_order_cost_line_set_updated_at BEFORE UPDATE ON ops.work_order_cost_line FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ------------------------------------------------------------------------------------- preventive maintenance
CREATE TABLE ops.maintenance_plan (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  asset_item_id        uuid NOT NULL,
  category_id          uuid,
  title                text NOT NULL,
  description          text,
  interval_days        integer NOT NULL,
  lead_days            integer NOT NULL DEFAULT 7,
  next_due_on          date NOT NULL,
  assignee_party_id    uuid,
  assignee_user_id     uuid,
  is_active            boolean NOT NULL DEFAULT true,
  last_work_order_id   uuid,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT maintenance_plan_pkey PRIMARY KEY (id),
  CONSTRAINT maintenance_plan_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_category_id_fkey FOREIGN KEY (category_id) REFERENCES ops.service_category (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_assignee_party_id_fkey FOREIGN KEY (assignee_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_last_work_order_id_fkey FOREIGN KEY (last_work_order_id) REFERENCES ops.work_order (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT maintenance_plan_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT maintenance_plan_interval_check CHECK (interval_days BETWEEN 1 AND 3660),
  CONSTRAINT maintenance_plan_lead_check CHECK (lead_days BETWEEN 0 AND 90),
  CONSTRAINT maintenance_plan_one_assignee_check CHECK (assignee_party_id IS NULL OR assignee_user_id IS NULL)
);
COMMENT ON TABLE ops.maintenance_plan IS 'Preventive maintenance of an asset item every interval_days (B5.1): the worker opens a preventive work order lead_days before next_due_on, then moves next_due_on one interval on.';
ALTER TABLE ops.work_order ADD CONSTRAINT work_order_maintenance_plan_id_fkey FOREIGN KEY (maintenance_plan_id) REFERENCES ops.maintenance_plan (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX maintenance_plan_tenant_id_building_id_idx ON ops.maintenance_plan (tenant_id, building_id);
CREATE INDEX maintenance_plan_building_id_idx ON ops.maintenance_plan (building_id);
CREATE INDEX maintenance_plan_asset_item_id_idx ON ops.maintenance_plan (asset_item_id);
CREATE INDEX maintenance_plan_next_due_on_idx ON ops.maintenance_plan (next_due_on) WHERE is_active;
CREATE TRIGGER maintenance_plan_set_updated_at BEFORE UPDATE ON ops.maintenance_plan FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ----------------------------------------------------------------------------------------------------------- RLS
SELECT platform.apply_rls('ops.service_category', 'tenant_or_shared');
SELECT platform.apply_rls('ops.service_request', 'unit', 'ops.service');
SELECT platform.apply_rls('ops.work_order', 'building', 'ops.service');
SELECT platform.apply_rls('ops.maintenance_plan', 'building', 'ops.service');
-- cost lines: visible and writable with their work order (schema-design §3.3.9 "via work order")
SELECT platform.apply_rls('ops.work_order_cost_line', 'platform_only');
CREATE POLICY work_order_cost_line_rls_read ON ops.work_order_cost_line FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.work_order w WHERE w.id = work_order_id));
CREATE POLICY work_order_cost_line_rls_write ON ops.work_order_cost_line FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id())
              AND EXISTS (SELECT 1 FROM ops.work_order w WHERE w.id = work_order_id AND w.tenant_id = work_order_cost_line.tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.service_category, ops.service_request, ops.work_order, ops.work_order_cost_line, ops.maintenance_plan TO gp_app, gp_platform;
GRANT SELECT ON ops.service_category, ops.service_request, ops.work_order, ops.work_order_cost_line, ops.maintenance_plan TO gp_reporting;
