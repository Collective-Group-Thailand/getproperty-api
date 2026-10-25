-- getproperty-api 0051 — message metering and the shared OA's rates (B7 deliverable 7.7 part 2, D-254).
--   * platform.messaging_rate: effective-dated versions of the shared getproperty OA's charge (free messages per tenant
--     per month, optionally per unit, price per counted message, VAT), entered by one platform user and published by
--     another (maker-checker). No published version = messaging is not charged and has no allowance.
--   * platform.message_usage: one row per LINE message sent (append-only) — the shared OA or an own OA, push or reply,
--     and what LINE counts (replies count 0). The shared OA's counted messages are billed on the monthly platform
--     invoice (with D-250, when it exists); an own OA's are the operator's own (shown, never charged).
--   * platform.messaging_notice: the notices already sent per tenant and month (80 % / 100 % of the allowance, a quota
--     refusal that fell back to SMS) — each once.
-- schema-design §7.5 rows 130–132.

CREATE TYPE platform.messaging_rate_state AS ENUM ('entered', 'published', 'withdrawn');
CREATE TYPE platform.messaging_oa AS ENUM ('shared', 'own');
CREATE TYPE platform.message_kind AS ENUM ('push', 'reply');
CREATE TYPE platform.messaging_notice_kind AS ENUM ('allowance_80', 'allowance_100', 'quota');

CREATE TABLE platform.messaging_rate (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  effective_from     date NOT NULL,
  free_per_tenant    integer NOT NULL,
  free_per_unit      integer NOT NULL DEFAULT 0,
  price_per_message  numeric(10,4) NOT NULL,
  vat_percent        numeric(5,2) NOT NULL,
  notes              text,
  state              platform.messaging_rate_state NOT NULL DEFAULT 'entered',
  entered_by         uuid NOT NULL,
  entered_at         timestamptz(6) NOT NULL DEFAULT now(),
  published_by       uuid,
  published_at       timestamptz(6),
  withdrawn_at       timestamptz(6),
  CONSTRAINT messaging_rate_pkey PRIMARY KEY (id),
  CONSTRAINT messaging_rate_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_rate_published_by_fkey FOREIGN KEY (published_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_rate_values_check CHECK (free_per_tenant >= 0 AND free_per_unit >= 0 AND price_per_message >= 0 AND vat_percent >= 0 AND vat_percent <= 100),
  CONSTRAINT messaging_rate_published_check CHECK ((state = 'entered') = (published_at IS NULL) AND (published_at IS NULL) = (published_by IS NULL)),
  CONSTRAINT messaging_rate_checker_check CHECK (published_by IS NULL OR published_by <> entered_by),
  CONSTRAINT messaging_rate_withdrawn_check CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
COMMENT ON TABLE platform.messaging_rate IS 'The shared getproperty LINE OA''s charge per version (D-254): free messages per tenant per month (+ per unit), price per counted message, VAT; maker-checker publish. None published = not charged.';
CREATE UNIQUE INDEX messaging_rate_published_key ON platform.messaging_rate (effective_from) WHERE state = 'published';
SELECT platform.apply_rls('platform.messaging_rate', 'platform');
GRANT SELECT ON platform.messaging_rate TO gp_app, gp_reporting;
GRANT SELECT, INSERT, UPDATE ON platform.messaging_rate TO gp_platform;

CREATE TABLE platform.message_usage (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  building_id      uuid,
  channel_id       uuid,
  notification_id  uuid,
  oa               platform.messaging_oa NOT NULL,
  kind             platform.message_kind NOT NULL,
  counted          integer NOT NULL,
  month            date NOT NULL,
  occurred_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT message_usage_pkey PRIMARY KEY (id),
  CONSTRAINT message_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT message_usage_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES platform.messaging_channel (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT message_usage_oa_check CHECK ((oa = 'own') = (channel_id IS NOT NULL)),
  CONSTRAINT message_usage_counted_check CHECK (counted >= 0 AND (kind = 'push' OR counted = 0)),
  CONSTRAINT message_usage_month_check CHECK (extract(day FROM month) = 1)
);
COMMENT ON TABLE platform.message_usage IS 'Every LINE message sent for a tenant (D-254): shared or own OA, push or reply, what LINE counts (replies 0), the Bangkok month. Append-only.';
CREATE UNIQUE INDEX message_usage_notification_id_key ON platform.message_usage (notification_id);
CREATE INDEX message_usage_tenant_id_month_idx ON platform.message_usage (tenant_id, month);
CREATE INDEX message_usage_channel_id_idx ON platform.message_usage (channel_id);
CREATE TRIGGER message_usage_append_only BEFORE UPDATE OR DELETE ON platform.message_usage FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
SELECT platform.apply_rls('platform.message_usage', 'tenant');
GRANT SELECT ON platform.message_usage TO gp_app, gp_reporting;
GRANT SELECT, INSERT ON platform.message_usage TO gp_platform;

CREATE TABLE platform.messaging_notice (
  id         uuid NOT NULL DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  month      date NOT NULL,
  kind       platform.messaging_notice_kind NOT NULL,
  counted    integer NOT NULL,
  allowance  integer,
  sent_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT messaging_notice_pkey PRIMARY KEY (id),
  CONSTRAINT messaging_notice_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_notice_month_check CHECK (extract(day FROM month) = 1)
);
COMMENT ON TABLE platform.messaging_notice IS 'Messaging notices sent to a tenant (D-254): 80 % / 100 % of the shared OA''s free messages, a LINE quota refusal that fell back to SMS — once per tenant, month and kind.';
CREATE UNIQUE INDEX messaging_notice_tenant_id_month_kind_key ON platform.messaging_notice (tenant_id, month, kind);
SELECT platform.apply_rls('platform.messaging_notice', 'tenant');
GRANT SELECT ON platform.messaging_notice TO gp_app, gp_reporting;
GRANT SELECT, INSERT ON platform.messaging_notice TO gp_platform;
