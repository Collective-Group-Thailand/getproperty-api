-- getproperty-api 0071 — co-owner register, bill-to, budgets and resolutions, charge bases (Phase J step J1.1b,
-- D-302, D-304, D-307, D-320, D-324). schema-design §7.5 rows 207–214 (§7.6 J1-b … J1-g, J1-i).
--   * ops.rate_basis + per_sqwa (land area) and budget_split (a budget split over ratio / m² / ตร.วา / per unit).
--   * ops.note_reason + ownership_transfer (credit notes of a transfer after an advance invoice).
--   * ops.rate_plan_version.resolution_id → juristic.resolution (juristic.rate_requires_resolution).
--   * platform.invitation.access_until (time-boxed auditor memberships, D-320).
--   * juristic.resolution, resolution_document, budget, budget_line, bill_to, ownership_transfer (RLS tenant).
-- DDL only (no DML on RLS tables); no core.* change.

ALTER TYPE ops.rate_basis ADD VALUE IF NOT EXISTS 'per_sqwa';
ALTER TYPE ops.rate_basis ADD VALUE IF NOT EXISTS 'budget_split';
ALTER TYPE ops.note_reason ADD VALUE IF NOT EXISTS 'ownership_transfer';

ALTER TABLE platform.invitation ADD COLUMN access_until timestamptz(6);
COMMENT ON COLUMN platform.invitation.access_until IS 'D-320 / D-324 (J1.1b): end of a time-boxed membership (role auditor); copied to core.membership.module_scopes.accessUntil on acceptance.';

CREATE TYPE juristic.meeting_kind AS ENUM ('agm', 'egm', 'committee');
CREATE TYPE juristic.resolution_state AS ENUM ('draft', 'adopted', 'void');
CREATE TYPE juristic.resolution_document_kind AS ENUM ('minutes', 'attachment', 'notice');
CREATE TYPE juristic.budget_state AS ENUM ('draft', 'approved', 'superseded');
CREATE TYPE juristic.budget_line_kind AS ENUM ('income', 'expense', 'fund');
CREATE TYPE juristic.bill_to_kind AS ENUM ('named_party', 'agency');
CREATE TYPE juristic.transfer_proration AS ENUM ('carry_to_buyer', 'refund_seller');

CREATE TABLE juristic.resolution (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  building_id    uuid NOT NULL,
  meeting_kind   juristic.meeting_kind NOT NULL,
  meeting_date   date NOT NULL,
  number         text NOT NULL,
  title          text NOT NULL,
  text           text NOT NULL,
  votes_summary  text,
  state          juristic.resolution_state NOT NULL DEFAULT 'draft',
  adopted_at     timestamptz(6),
  adopted_by     uuid,
  voided_at      timestamptz(6),
  void_reason    text,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT resolution_pkey PRIMARY KEY (id),
  CONSTRAINT resolution_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resolution_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resolution_number_check CHECK (length(number) BETWEEN 1 AND 50),
  CONSTRAINT resolution_title_check CHECK (length(title) BETWEEN 1 AND 300),
  CONSTRAINT resolution_text_check CHECK (length(text) BETWEEN 1 AND 20000),
  CONSTRAINT resolution_votes_summary_check CHECK (votes_summary IS NULL OR length(votes_summary) <= 2000),
  CONSTRAINT resolution_adopted_check CHECK ((state = 'draft') = (adopted_at IS NULL) OR state = 'void'),
  CONSTRAINT resolution_void_check CHECK ((state = 'void') = (voided_at IS NOT NULL))
);
COMMENT ON TABLE juristic.resolution IS 'D-304 (J1.1b): a meeting resolution (AGM / EGM / committee) that justifies a budget or a common-fee / fund rate version; draft → adopted → void. Kept for the life of the building + 10 years.';
CREATE UNIQUE INDEX resolution_building_id_meeting_kind_number_key ON juristic.resolution (building_id, meeting_kind, number) WHERE (state <> 'void');
CREATE INDEX resolution_tenant_id_building_id_meeting_date_idx ON juristic.resolution (tenant_id, building_id, meeting_date DESC);
SELECT platform.apply_rls('juristic.resolution', 'tenant');

CREATE TABLE juristic.resolution_document (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  resolution_id  uuid NOT NULL,
  document_id    uuid NOT NULL,
  kind           juristic.resolution_document_kind NOT NULL DEFAULT 'attachment',
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT resolution_document_pkey PRIMARY KEY (id),
  CONSTRAINT resolution_document_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT resolution_document_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT resolution_document_document_id_fkey FOREIGN KEY (document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE juristic.resolution_document IS 'D-304 (J1.1b): minutes, notices and attachments of a resolution (core.document of the tenant).';
CREATE UNIQUE INDEX resolution_document_resolution_id_document_id_key ON juristic.resolution_document (resolution_id, document_id);
CREATE INDEX resolution_document_document_id_idx ON juristic.resolution_document (document_id);
SELECT platform.apply_rls('juristic.resolution_document', 'tenant');

CREATE TABLE juristic.budget (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  building_id    uuid NOT NULL,
  fiscal_year    smallint NOT NULL,
  name           text NOT NULL,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  state          juristic.budget_state NOT NULL DEFAULT 'draft',
  resolution_id  uuid,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  approved_at    timestamptz(6),
  approved_by    uuid,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT budget_pkey PRIMARY KEY (id),
  CONSTRAINT budget_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT budget_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT budget_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT budget_fiscal_year_check CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CONSTRAINT budget_period_check CHECK (period_end > period_start AND period_end - period_start <= 366),
  CONSTRAINT budget_name_check CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT budget_total_check CHECK (total >= 0),
  CONSTRAINT budget_approved_check CHECK ((state = 'draft') = (approved_at IS NULL)),
  CONSTRAINT budget_resolution_check CHECK (state = 'draft' OR resolution_id IS NOT NULL)
);
COMMENT ON TABLE juristic.budget IS 'D-304 (J1.1b): the annual budget of a building (fiscal year), approved with an adopted resolution; a new approval supersedes the previous one. 10 years (⚖ O-025 (b)).';
CREATE UNIQUE INDEX budget_building_id_fiscal_year_approved_key ON juristic.budget (building_id, fiscal_year) WHERE (state = 'approved');
CREATE UNIQUE INDEX budget_building_id_fiscal_year_draft_key ON juristic.budget (building_id, fiscal_year) WHERE (state = 'draft');
CREATE INDEX budget_tenant_id_building_id_idx ON juristic.budget (tenant_id, building_id, fiscal_year DESC);
CREATE INDEX budget_resolution_id_idx ON juristic.budget (resolution_id);
SELECT platform.apply_rls('juristic.budget', 'tenant');

CREATE TABLE juristic.budget_line (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  budget_id   uuid NOT NULL,
  account_id  uuid,
  kind        juristic.budget_line_kind NOT NULL DEFAULT 'expense',
  label       text NOT NULL,
  amount      numeric(14,2) NOT NULL,
  sort        smallint NOT NULL DEFAULT 0,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT budget_line_pkey PRIMARY KEY (id),
  CONSTRAINT budget_line_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT budget_line_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES juristic.budget (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT budget_line_label_check CHECK (length(label) BETWEEN 1 AND 200),
  CONSTRAINT budget_line_amount_check CHECK (amount >= 0)
);
COMMENT ON TABLE juristic.budget_line IS 'D-304 (J1.1b): a line of a budget (income / expense / fund); account_id links the J2.1 chart of accounts (no FK until then).';
CREATE INDEX budget_line_budget_id_idx ON juristic.budget_line (budget_id, sort);
SELECT platform.apply_rls('juristic.budget_line', 'tenant');

CREATE TABLE juristic.bill_to (
  id                   uuid NOT NULL DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  building_id          uuid NOT NULL,
  unit_id              uuid NOT NULL,
  owner_party_id       uuid NOT NULL,
  bill_to_party_id     uuid NOT NULL,
  kind                 juristic.bill_to_kind NOT NULL DEFAULT 'named_party',
  consent_document_id  uuid NOT NULL,
  consent_note         text,
  valid_from           date NOT NULL,
  valid_to             date,
  ended_reason         text,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT bill_to_pkey PRIMARY KEY (id),
  CONSTRAINT bill_to_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_bill_to_party_id_fkey FOREIGN KEY (bill_to_party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_consent_document_id_fkey FOREIGN KEY (consent_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT bill_to_parties_check CHECK (owner_party_id <> bill_to_party_id),
  CONSTRAINT bill_to_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT bill_to_consent_note_check CHECK (consent_note IS NULL OR length(consent_note) <= 1000),
  CONSTRAINT bill_to_no_overlap EXCLUDE USING gist (unit_id WITH =, owner_party_id WITH =, daterange(valid_from, valid_to) WITH &&)
);
COMMENT ON TABLE juristic.bill_to IS 'D-307 (J1.1b): a co-owner names another party (relative, agency) who receives and pays the unit''s invoices, with the owner''s written consent (document); valid_to exclusive.';
CREATE INDEX bill_to_unit_id_idx ON juristic.bill_to (unit_id, valid_from);
CREATE INDEX bill_to_bill_to_party_id_idx ON juristic.bill_to (bill_to_party_id);
CREATE INDEX bill_to_owner_party_id_idx ON juristic.bill_to (owner_party_id);
SELECT platform.apply_rls('juristic.bill_to', 'tenant');

CREATE TABLE juristic.ownership_transfer (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  building_id         uuid NOT NULL,
  unit_id             uuid NOT NULL,
  transfer_date       date NOT NULL,
  from_ownership_ids  uuid[] NOT NULL,
  to_ownership_ids    uuid[] NOT NULL,
  policy              juristic.transfer_proration NOT NULL,
  credit_note_ids     uuid[] NOT NULL DEFAULT '{}',
  charge_ids          uuid[] NOT NULL DEFAULT '{}',
  note                text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT ownership_transfer_pkey PRIMARY KEY (id),
  CONSTRAINT ownership_transfer_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ownership_transfer_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ownership_transfer_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ownership_transfer_note_check CHECK (note IS NULL OR length(note) <= 1000)
);
COMMENT ON TABLE juristic.ownership_transfer IS 'D-303 / D-324 (J1.1b): a recorded change of ownership of a unit (closed and opened core.unit_ownership rows, the proration policy, credit notes and buyer charges); source of the internal event unit_ownership.transferred. Append-only.';
CREATE INDEX ownership_transfer_unit_id_transfer_date_idx ON juristic.ownership_transfer (unit_id, transfer_date);
CREATE INDEX ownership_transfer_tenant_id_idx ON juristic.ownership_transfer (tenant_id, created_at DESC);
SELECT platform.apply_rls('juristic.ownership_transfer', 'tenant');
REVOKE UPDATE, DELETE ON juristic.ownership_transfer FROM gp_app;

ALTER TABLE ops.rate_plan_version ADD COLUMN resolution_id uuid;
ALTER TABLE ops.rate_plan_version ADD CONSTRAINT rate_plan_version_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES juristic.resolution (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX rate_plan_version_resolution_id_idx ON ops.rate_plan_version (resolution_id) WHERE (resolution_id IS NOT NULL);
COMMENT ON COLUMN ops.rate_plan_version.resolution_id IS 'D-304 (J1.1b): the adopted resolution that justifies a common-fee / fund version of a juristic building (required while juristic.rate_requires_resolution is true).';
