-- 0001_extensions — PostgreSQL 18 + TimescaleDB baseline (ADR-0001, schema-design §1.2, §7.1).
-- Extensions, the uuidv7() guard, the helper functions later migrations attach as triggers, and every
-- Postgres enum used by the B1 tables (§1.2 "Enums": values are snake_case and identical to the API strings;
-- additions are `ALTER TYPE … ADD VALUE`, never renames).

-- TimescaleDB is created only where the server offers it (timescale/timescaledb-ha:pg18 in compose, CI and
-- production). A developer cluster without it (`pnpm db:local`, embedded-postgres) still applies every B1
-- migration; hypertables arrive in B3.2 and need the real image. The API asserts the extension at start-up in
-- production (`DATA_STORES_MODE=real` + `NODE_ENV=production`, health indicator `timescaledb`).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  ELSE
    RAISE NOTICE 'timescaledb is not available on this server — skipped (hypertables need timescale/timescaledb-ha:pg18)';
  END IF;
END
$do$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- PostgreSQL 18 ships uuidv7() built in. Older servers (a Prisma shadow database on PG 17, a laptop) get a
-- compatible RFC 9562 implementation (PostgreSQL wiki): 48-bit unix milliseconds over a v4 uuid, bits 52–53 set
-- so the version nibble reads 7; the variant bits come from gen_random_uuid().
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'uuidv7' AND n.nspname IN ('pg_catalog', 'public') AND p.pronargs = 0
  ) THEN
    CREATE FUNCTION public.uuidv7() RETURNS uuid LANGUAGE sql VOLATILE PARALLEL SAFE AS $fn$
      SELECT encode(
        set_bit(
          set_bit(
            overlay(uuid_send(gen_random_uuid())
                    PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
            52, 1),
          53, 1),
        'hex')::uuid;
    $fn$;
  END IF;
END
$do$;

-- updated_at maintenance (schema-design §1.2 "Audit columns").
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Append-only tables (schema-design §4.8): audit_logs, domain_events, consents, *_history, compliance evidence.
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % rows are never % (D-040 / D-025)', TG_TABLE_NAME, lower(TG_OP) || 'd'
    USING ERRCODE = 'P0001';
END $$;

-- Effective dating (schema-design §4.1): inserting a version closes the previous open version of the same
-- parent. Works for setting_versions (setting_id) and org_setting_versions (org_id, setting_id); the parent
-- columns are passed as trigger arguments. Runs BEFORE INSERT so the exclusion constraint (no overlapping
-- ranges) sees the previous row already closed.
CREATE OR REPLACE FUNCTION close_previous_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_cols text[] := TG_ARGV;
  where_sql   text   := '';
  col         text;
  new_row     jsonb  := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY parent_cols LOOP
    where_sql := where_sql || format(' AND %I = %L', col, new_row ->> col);
  END LOOP;
  EXECUTE format(
    'UPDATE %I.%I SET effective_to = $1 WHERE effective_to IS NULL AND effective_from < $1 %s',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, where_sql)
  USING NEW.effective_from;
  RETURN NEW;
END $$;

-- RLS helper (schema-design §4.5): the org the reporting session works for (`SET LOCAL app.org_id = …`).
CREATE OR REPLACE FUNCTION current_org_id() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::bigint
$$;

-- ---------------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------------
-- IAM (§3.2.1, §3.2.2)
CREATE TYPE user_kind AS ENUM ('org_user', 'platform_user', 'tenant_user');
CREATE TYPE identity_provider AS ENUM ('line', 'line_liff', 'google');
CREATE TYPE audience AS ENUM ('org', 'tenant', 'platform', 'device');
CREATE TYPE session_revoke_reason AS ENUM ('logout', 'reuse_detected', 'password_change', 'admin', 'expired');
CREATE TYPE otp_purpose AS ENUM ('org_login', 'tenant_login', 'bank_account_change', 'lease_signature', 'phone_verify');
CREATE TYPE role_scope_kind AS ENUM ('org', 'platform');
CREATE TYPE role_scope AS ENUM ('platform', 'org', 'property');
CREATE TYPE support_grant_state AS ENUM ('requested', 'approved', 'active', 'expired', 'revoked', 'denied');
CREATE TYPE support_grant_approval_via AS ENUM ('in_app', 'platform_admin_incident');

-- Tenancy (§3.2.3, §3.2.4)
CREATE TYPE org_kind AS ENUM ('person', 'company');
CREATE TYPE org_status AS ENUM ('active', 'read_only', 'deactivated');
CREATE TYPE member_state AS ENUM ('invited', 'active', 'suspended', 'removed');
CREATE TYPE invitation_kind AS ENUM ('org_member', 'tenant_lease');
CREATE TYPE invitation_channel AS ENUM ('sms', 'line_qr', 'email', 'link');
CREATE TYPE invitation_state AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE promptpay_id_type AS ENUM ('national_id', 'tax_id', 'phone', 'ewallet', 'bank_account');
CREATE TYPE payment_provider AS ENUM ('kbank', 'scb', 'opn', 'none');
CREATE TYPE bank_account_state AS ENUM ('pending_otp', 'active', 'replaced', 'removed');
CREATE TYPE bank_change AS ENUM ('created', 'activated', 'replaced', 'removed', 'default_changed');

-- Settings & tariffs (§3.1.1, §3.1.2)
CREATE TYPE setting_value_type AS ENUM ('string', 'int', 'decimal', 'bool', 'json', 'duration', 'money', 'date', 'time');
CREATE TYPE setting_scope AS ENUM ('platform', 'org', 'property');
CREATE TYPE utility AS ENUM ('electric', 'water');
CREATE TYPE utility_provider AS ENUM ('mea', 'pea', 'mwa', 'pwa');
CREATE TYPE meter_unit AS ENUM ('kwh', 'm3');
CREATE TYPE tariff_version_state AS ENUM ('draft', 'entered', 'verified', 'published', 'superseded');

-- Files, audit, outbox, idempotency (§3.1.3, §3.1.4)
CREATE TYPE file_retention_class AS ENUM ('meter_photo', 'inspection_photo', 'slip', 'id_document', 'contract', 'logo',
  'document_pdf', 'utility_invoice', 'ota_artifact', 'log_bundle', 'export', 'other');
CREATE TYPE file_scan_status AS ENUM ('pending', 'clean', 'infected', 'failed', 'skipped');
CREATE TYPE file_upload_state AS ENUM ('presigned', 'uploaded', 'verified', 'deleted');
CREATE TYPE audit_outcome AS ENUM ('success', 'denied', 'failure');
CREATE TYPE outbox_state AS ENUM ('pending', 'publishing', 'published', 'failed', 'dead');
CREATE TYPE idempotency_status AS ENUM ('in_progress', 'completed');

-- Notifications (§3.1.5)
CREATE TYPE notification_channel AS ENUM ('line', 'sms', 'email', 'in_app', 'web_push');
CREATE TYPE notification_audience AS ENUM ('tenant', 'owner', 'manager', 'staff', 'accountant', 'platform');
CREATE TYPE template_format AS ENUM ('handlebars_text', 'line_flex_json', 'mjml', 'plain');
CREATE TYPE template_version_state AS ENUM ('draft', 'published', 'retired');
CREATE TYPE notification_recipient AS ENUM ('user', 'tenant', 'phone', 'email', 'line_user');
CREATE TYPE notification_state AS ENUM ('queued', 'held_quiet_hours', 'held_no_consent', 'sent', 'delivered', 'failed', 'read', 'cancelled');

-- Privacy (§3.1.6)
CREATE TYPE consent_subject AS ENUM ('tenant', 'user');
CREATE TYPE consent_channel AS ENUM ('liff', 'web', 'paper', 'sms');
CREATE TYPE dsr_kind AS ENUM ('access', 'rectification', 'erasure', 'portability', 'objection', 'restriction');
CREATE TYPE dsr_state AS ENUM ('received', 'verifying', 'in_progress', 'fulfilled', 'rejected', 'withdrawn');
CREATE TYPE retention_target AS ENUM ('file_class', 'table');
CREATE TYPE retention_action AS ENUM ('delete', 'anonymise', 'archive');

-- Business calendar (§3.1.7)
CREATE TYPE calendar_kind AS ENUM ('th_public', 'th_bank');

-- Compliance registry (§3.6; pulled into B1.2 by D-021a / D-149). `verified` is the legal team's sign-off step
-- between pending_legal_verification and active.
CREATE TYPE compliance_severity AS ENUM ('block', 'warn');
CREATE TYPE rule_status AS ENUM ('pending_legal_verification', 'verified', 'active', 'retired');
