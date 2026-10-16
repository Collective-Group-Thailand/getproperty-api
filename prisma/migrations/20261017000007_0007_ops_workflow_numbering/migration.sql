-- getproperty-api 0007 — workflow engine tables (D-159, built in B1.3) and gapless document series
-- (D-050, D-146; schema-design v2 §3.3.1, §3.3.7, §4.4).

CREATE TYPE ops.workflow_timer_kind AS ENUM ('sla_warn', 'sla_breach', 'step', 'reminder');
CREATE TYPE ops.document_type AS ENUM (
  'invoice', 'receipt', 'deposit_receipt', 'tax_invoice', 'receipt_tax_invoice', 'credit_note', 'debit_note',
  'deposit_statement', 'contract', 'inspection_report', 'platform_invoice', 'platform_receipt', 'platform_credit_note');

CREATE TABLE ops.workflow_definition (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid,
  key         text NOT NULL,
  version     integer NOT NULL,
  states      jsonb NOT NULL,
  transitions jsonb NOT NULL,
  sla         jsonb NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT workflow_definition_pkey PRIMARY KEY (id),
  CONSTRAINT workflow_definition_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workflow_definition_version_check CHECK (version >= 1),
  CONSTRAINT workflow_definition_shape_check CHECK (jsonb_typeof(states) = 'array' AND jsonb_typeof(transitions) = 'array' AND jsonb_typeof(sla) = 'object')
);
COMMENT ON TABLE ops.workflow_definition IS 'State machine + SLA policy, versioned, defined in code and seeded (D-159); tenant_id null = platform definition.';
CREATE UNIQUE INDEX workflow_definition_tenant_id_key_version_key ON ops.workflow_definition (tenant_id, key, version) NULLS NOT DISTINCT;

CREATE TABLE ops.workflow_instance (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid,
  definition_id    uuid NOT NULL,
  subject_type     text NOT NULL,
  subject_id       uuid NOT NULL,
  state            text NOT NULL,
  state_entered_at timestamptz(6) NOT NULL DEFAULT now(),
  sla_due_at       timestamptz(6),
  sla_warned_at    timestamptz(6),
  sla_breached_at  timestamptz(6),
  started_at       timestamptz(6) NOT NULL DEFAULT now(),
  closed_at        timestamptz(6),
  context          jsonb NOT NULL DEFAULT '{}',
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT workflow_instance_pkey PRIMARY KEY (id),
  CONSTRAINT workflow_instance_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workflow_instance_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workflow_instance_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES ops.workflow_definition (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.workflow_instance IS 'One per subject with a lifecycle/SLA (deposit settlement, dunning, service request, inspection).';
CREATE UNIQUE INDEX workflow_instance_subject_type_subject_id_definition_id_key ON ops.workflow_instance (subject_type, subject_id, definition_id) WHERE (closed_at IS NULL);
CREATE INDEX workflow_instance_tenant_id_definition_id_state_idx ON ops.workflow_instance (tenant_id, definition_id, state);
CREATE INDEX workflow_instance_sla_due_at_idx ON ops.workflow_instance (sla_due_at) WHERE (closed_at IS NULL);
CREATE INDEX workflow_instance_building_id_idx ON ops.workflow_instance (building_id);

CREATE TABLE ops.workflow_event (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  instance_id     uuid NOT NULL,
  from_state      text,
  to_state        text NOT NULL,
  event           text NOT NULL,
  actor           jsonb NOT NULL,
  occurred_at     timestamptz(6) NOT NULL DEFAULT now(),
  data            jsonb NOT NULL DEFAULT '{}',
  domain_event_id uuid,
  CONSTRAINT workflow_event_pkey PRIMARY KEY (id),
  CONSTRAINT workflow_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workflow_event_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES ops.workflow_instance (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE ops.workflow_event IS 'Append-only history of a workflow instance; domain_event_id ⇢ platform.domain_event.';
CREATE INDEX workflow_event_instance_id_occurred_at_idx ON ops.workflow_event (instance_id, occurred_at);
CREATE INDEX workflow_event_tenant_id_idx ON ops.workflow_event (tenant_id);

CREATE TABLE ops.workflow_timer (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  instance_id  uuid NOT NULL,
  kind         ops.workflow_timer_kind NOT NULL,
  fire_at      timestamptz(6) NOT NULL,
  fired_at     timestamptz(6),
  cancelled_at timestamptz(6),
  attempt      smallint NOT NULL DEFAULT 0,
  CONSTRAINT workflow_timer_pkey PRIMARY KEY (id),
  CONSTRAINT workflow_timer_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT workflow_timer_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES ops.workflow_instance (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT workflow_timer_once_check CHECK (fired_at IS NULL OR cancelled_at IS NULL)
);
COMMENT ON TABLE ops.workflow_timer IS 'SLA/step timers fired exactly once by the worker (D-159).';
CREATE INDEX workflow_timer_fire_at_idx ON ops.workflow_timer (fire_at) WHERE ((fired_at IS NULL) AND (cancelled_at IS NULL));
CREATE INDEX workflow_timer_instance_id_idx ON ops.workflow_timer (instance_id);
CREATE INDEX workflow_timer_tenant_id_idx ON ops.workflow_timer (tenant_id);

CREATE TABLE ops.document_series (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid,
  doc_type    ops.document_type NOT NULL,
  fiscal_year smallint NOT NULL,
  prefix      text NOT NULL,
  next_number integer NOT NULL DEFAULT 1,
  width       smallint NOT NULL DEFAULT 5,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT document_series_pkey PRIMARY KEY (id),
  CONSTRAINT document_series_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT document_series_next_number_check CHECK (next_number >= 1),
  CONSTRAINT document_series_width_check CHECK (width BETWEEN 3 AND 10),
  CONSTRAINT document_series_fiscal_year_check CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CONSTRAINT document_series_platform_check CHECK ((tenant_id IS NULL) = (doc_type IN ('platform_invoice', 'platform_receipt', 'platform_credit_note')))
);
COMMENT ON TABLE ops.document_series IS 'Gapless counters per tenant × document type × Bangkok fiscal year (§4.4); tenant_id NULL = Collective Group''s own documents (D-146).';
CREATE UNIQUE INDEX document_series_tenant_id_doc_type_fiscal_year_key ON ops.document_series (tenant_id, doc_type, fiscal_year) NULLS NOT DISTINCT;

CREATE TRIGGER workflow_definition_set_updated_at BEFORE UPDATE ON ops.workflow_definition FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER workflow_instance_set_updated_at BEFORE UPDATE ON ops.workflow_instance FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER document_series_set_updated_at BEFORE UPDATE ON ops.document_series FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER workflow_event_append_only BEFORE UPDATE OR DELETE ON ops.workflow_event FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
