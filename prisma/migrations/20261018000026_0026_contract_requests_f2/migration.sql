-- getproperty-api 0026 — consumer contract requests before B5 (docs/contract-requests-triage.md, D-208):
--   web F2 2.5  ExportKind loss_report_csv (the loss report as a server export);
--   web F2 2.3  "request reading → staff task" per meter: smart.reading_request (an open request per meter
--               assignment, optionally assigned to a staff login, fulfilled by the next accepted / pending reading;
--               the reading round shows its assignee and B5.4 staff tasks list it).
-- Deviations (schema-design §7.5 rows 75–76): one enum value and one smart table the v2 design did not list.

ALTER TYPE ops.export_kind ADD VALUE IF NOT EXISTS 'loss_report_csv';

-- ------------------------------------------------------------------------------------------- reading requests
CREATE TYPE smart.reading_request_status AS ENUM ('open', 'fulfilled', 'cancelled');

CREATE TABLE smart.reading_request (
  id                    uuid NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  building_id           uuid NOT NULL,
  billing_cycle_id      uuid,
  meter_assignment_id   uuid NOT NULL,
  asset_item_id         uuid NOT NULL,
  assignee_user_id      uuid,
  status                smart.reading_request_status NOT NULL DEFAULT 'open',
  requested_at          timestamptz(6) NOT NULL DEFAULT now(),
  due_at                timestamptz(6),
  fulfilled_reading_id  uuid,
  fulfilled_at          timestamptz(6),
  cancelled_at          timestamptz(6),
  note                  text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT reading_request_pkey PRIMARY KEY (id),
  CONSTRAINT reading_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_billing_cycle_id_fkey FOREIGN KEY (billing_cycle_id) REFERENCES ops.billing_cycle (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_meter_assignment_id_fkey FOREIGN KEY (meter_assignment_id) REFERENCES core.meter_assignment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_asset_item_id_fkey FOREIGN KEY (asset_item_id) REFERENCES core.asset_item (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_fulfilled_reading_id_fkey FOREIGN KEY (fulfilled_reading_id) REFERENCES smart.meter_reading (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT reading_request_state_check CHECK (
    (status = 'open' AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'fulfilled' AND fulfilled_at IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL))
);
COMMENT ON TABLE smart.reading_request IS 'The owner asked staff to read a meter (web F2, D-208): one open request per meter assignment, optionally assigned; fulfilled by the next accepted or pending-review reading of the assignment.';
CREATE UNIQUE INDEX reading_request_open_key ON smart.reading_request (meter_assignment_id) WHERE status = 'open';
CREATE INDEX reading_request_tenant_id_building_id_status_idx ON smart.reading_request (tenant_id, building_id, status);
CREATE INDEX reading_request_building_id_idx ON smart.reading_request (building_id);
CREATE INDEX reading_request_billing_cycle_id_idx ON smart.reading_request (billing_cycle_id);
CREATE INDEX reading_request_asset_item_id_idx ON smart.reading_request (asset_item_id);
CREATE INDEX reading_request_assignee_user_id_status_idx ON smart.reading_request (assignee_user_id, status);
CREATE INDEX reading_request_fulfilled_reading_id_idx ON smart.reading_request (fulfilled_reading_id);
CREATE TRIGGER reading_request_set_updated_at BEFORE UPDATE ON smart.reading_request FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('smart.reading_request', 'building', 'smart.metering');
GRANT SELECT, INSERT, UPDATE, DELETE ON smart.reading_request TO gp_app, gp_platform;
GRANT SELECT ON smart.reading_request TO gp_reporting;
