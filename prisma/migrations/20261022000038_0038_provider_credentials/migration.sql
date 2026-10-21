-- getproperty-api 0038 — per-merchant provider credentials in PostgreSQL (O-013 resolved → D-240).
-- Payment-provider merchants (KBank / SCB / Opn), smart-lock vendor accounts (TTLock / Tuya) and e-Tax service
-- providers (INET) used to live as Secrets Manager entries under collective/<env>/getproperty/{payments,locks,etax}/…,
-- read at run time; D-233 allows one secret per product per environment. They move here, sealed with the tenant's
-- data key (asset-core field envelope, AAD = tenant | platform.provider_credential | secret | row id; the platform's
-- own merchant — tenant_id NULL — with the platform field key), every decrypt audited (provider_credential.decrypted).
-- Platform-only table (RLS platform_only): written by the admin surface, read by gp_platform services.
-- Deviation (schema-design §7.5 row 103).

CREATE TYPE platform.provider_credential_kind AS ENUM ('payment', 'lock', 'etax');

CREATE TABLE platform.provider_credential (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid,
  kind              platform.provider_credential_kind NOT NULL,
  provider          text NOT NULL,
  account_ref_hash  bytea,
  account_ref_hint  text,
  secret_enc        bytea NOT NULL,
  key_names         text[] NOT NULL DEFAULT '{}',
  fingerprint       text NOT NULL,
  source            text NOT NULL DEFAULT 'admin',
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  created_by        uuid,
  revoked_at        timestamptz(6),
  revoked_by        uuid,
  revoke_reason     text,
  CONSTRAINT provider_credential_pkey PRIMARY KEY (id),
  CONSTRAINT provider_credential_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT provider_credential_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT provider_credential_account_ref_check CHECK ((kind = 'payment') = (account_ref_hash IS NOT NULL)),
  CONSTRAINT provider_credential_platform_check CHECK (tenant_id IS NOT NULL OR kind = 'payment'),
  CONSTRAINT provider_credential_source_check CHECK (source IN ('admin', 'import')),
  CONSTRAINT provider_credential_hint_check CHECK (account_ref_hint IS NULL OR length(account_ref_hint) <= 16),
  CONSTRAINT provider_credential_revoked_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE platform.provider_credential IS 'D-240 (O-013): per-merchant provider credentials (payments, locks, e-Tax) sealed with the tenant data key (platform key for the platform merchant, tenant_id NULL); live = revoked_at IS NULL; every decrypt audited.';
COMMENT ON COLUMN platform.provider_credential.account_ref_hash IS 'payments: lookup hash of the merchant reference (merchantRefHash, provider-bound); NULL for locks and e-Tax (one account per tenant and provider).';
COMMENT ON COLUMN platform.provider_credential.account_ref_hint IS 'Last 4 characters of the merchant reference for the admin list (never the full reference).';
COMMENT ON COLUMN platform.provider_credential.fingerprint IS 'First 12 hex of an HMAC of the sealed JSON: shows that a value changed without revealing it.';
CREATE UNIQUE INDEX provider_credential_live_key ON platform.provider_credential (tenant_id, kind, provider, account_ref_hash) NULLS NOT DISTINCT WHERE (revoked_at IS NULL);
CREATE INDEX provider_credential_tenant_id_idx ON platform.provider_credential (tenant_id);

SELECT platform.apply_rls('platform.provider_credential', 'platform_only');
GRANT SELECT, INSERT, UPDATE ON platform.provider_credential TO gp_platform;
REVOKE ALL ON platform.provider_credential FROM gp_app, gp_reporting;
