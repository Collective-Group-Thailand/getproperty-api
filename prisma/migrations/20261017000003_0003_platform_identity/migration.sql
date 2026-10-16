-- getproperty-api 0003 — identity sessions, OTP, credentials, roles & permissions, platform role assignments,
-- support grants, invitations, tenant bank accounts + history (ADR-0003, D-090, D-091, D-145, D-042;
-- schema-design v2 §3.2.3, §3.2.4). core.user_account (the login) lives in the package; secrets live here.

CREATE TYPE platform.audience AS ENUM ('operator', 'resident', 'technician', 'platform', 'device');
CREATE TYPE platform.session_revoke_reason AS ENUM ('logout', 'reuse_detected', 'password_change', 'admin', 'expired');
CREATE TYPE platform.otp_purpose AS ENUM ('operator_login', 'resident_login', 'technician_login', 'bank_account_change', 'lease_signature', 'phone_verify');
CREATE TYPE platform.role_scope_kind AS ENUM ('tenant', 'platform');
CREATE TYPE platform.support_grant_state AS ENUM ('requested', 'approved', 'active', 'expired', 'revoked', 'denied');
CREATE TYPE platform.support_grant_approval_via AS ENUM ('in_app', 'platform_admin_incident');
CREATE TYPE platform.invitation_kind AS ENUM ('tenant_member', 'lease_resident');
CREATE TYPE platform.invitation_channel AS ENUM ('sms', 'line_qr', 'email', 'link');
CREATE TYPE platform.invitation_state AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE platform.promptpay_id_type AS ENUM ('national_id', 'tax_id', 'phone', 'ewallet', 'bank_account');
CREATE TYPE platform.payment_provider AS ENUM ('kbank', 'scb', 'opn', 'none');
CREATE TYPE platform.bank_account_state AS ENUM ('pending_otp', 'active', 'replaced', 'removed');
CREATE TYPE platform.bank_change AS ENUM ('created', 'activated', 'replaced', 'removed', 'default_changed');

CREATE TABLE platform.user_credential (
  user_id                  uuid NOT NULL,
  password_hash            text,
  password_changed_at      timestamptz(6),
  totp_secret_enc          bytea,
  totp_enabled_at          timestamptz(6),
  totp_recovery_codes_hash bytea[],
  failed_login_count       smallint NOT NULL DEFAULT 0,
  locked_until             timestamptz(6),
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT user_credential_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_credential_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT user_credential_password_hash_check CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
  CONSTRAINT user_credential_failed_login_count_check CHECK (failed_login_count >= 0)
);
COMMENT ON TABLE platform.user_credential IS 'App-specific secrets of a core.user_account (argon2id password, TOTP with the platform key). gp_platform only.';

CREATE TABLE platform.auth_session (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  user_id            uuid,
  device_id          uuid,
  audience           platform.audience NOT NULL,
  family_id          uuid NOT NULL,
  refresh_token_hash bytea NOT NULL,
  parent_token_hash  bytea,
  issued_at          timestamptz(6) NOT NULL DEFAULT now(),
  expires_at         timestamptz(6) NOT NULL,
  rotated_at         timestamptz(6),
  revoked_at         timestamptz(6),
  revoke_reason      platform.session_revoke_reason,
  ip                 inet,
  user_agent         text,
  scopes             text[] NOT NULL DEFAULT '{}',
  last_used_at       timestamptz(6),
  CONSTRAINT auth_session_pkey PRIMARY KEY (id),
  CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT auth_session_subject_check CHECK ((user_id IS NULL) <> (device_id IS NULL)),
  CONSTRAINT auth_session_device_audience_check CHECK ((audience = 'device') = (device_id IS NOT NULL)),
  CONSTRAINT auth_session_revoked_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE platform.auth_session IS 'Refresh-token families (rotation + reuse detection, ADR-0003). device_id ⇢ smart.device (FK in B3.1).';
CREATE UNIQUE INDEX auth_session_refresh_token_hash_key ON platform.auth_session (refresh_token_hash);
CREATE INDEX auth_session_user_id_revoked_at_idx ON platform.auth_session (user_id, revoked_at);
CREATE INDEX auth_session_family_id_idx ON platform.auth_session (family_id);
CREATE INDEX auth_session_expires_at_idx ON platform.auth_session (expires_at);

CREATE TABLE platform.otp_challenge (
  id           uuid NOT NULL DEFAULT uuidv7(),
  purpose      platform.otp_purpose NOT NULL,
  phone_e164   text NOT NULL,
  phone_hash   bytea NOT NULL,
  code_hash    bytea NOT NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  expires_at   timestamptz(6) NOT NULL,
  consumed_at  timestamptz(6),
  subject_type text,
  subject_id   uuid,
  ip           inet,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenge_pkey PRIMARY KEY (id),
  CONSTRAINT otp_challenge_attempts_check CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT otp_challenge_phone_e164_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);
COMMENT ON TABLE platform.otp_challenge IS 'SMS OTP (login, bank-account change, e-sign). The code is stored only as a hash; never logged (D-025).';
CREATE INDEX otp_challenge_phone_hash_purpose_created_at_idx ON platform.otp_challenge (phone_hash, purpose, created_at DESC);
CREATE INDEX otp_challenge_expires_at_idx ON platform.otp_challenge (expires_at);

CREATE TABLE platform.role (
  id          uuid NOT NULL DEFAULT uuidv7(),
  key         text NOT NULL,
  scope_kind  platform.role_scope_kind NOT NULL,
  name_th     text NOT NULL,
  name_en     text NOT NULL,
  description text NOT NULL,
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT role_pkey PRIMARY KEY (id),
  CONSTRAINT role_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$')
);
COMMENT ON TABLE platform.role IS 'Tenant roles (owner, manager, staff, accountant) and platform roles (platform_admin, support, field_engineer, finance) — D-090, seeded from code.';
CREATE UNIQUE INDEX role_key_key ON platform.role (key);

CREATE TABLE platform.permission (
  id          uuid NOT NULL DEFAULT uuidv7(),
  key         text NOT NULL,
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL,
  surfaces    text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT permission_pkey PRIMARY KEY (id),
  CONSTRAINT permission_key_check CHECK (key = resource || '.' || action AND key ~ '^[a-z][a-z0-9_.]*\.[a-z_]+$'),
  CONSTRAINT permission_surfaces_check CHECK (surfaces <@ ARRAY['owner', 'staff', 'admin', 'resident', 'technician']::text[])
);
COMMENT ON TABLE platform.permission IS '`resource.action` catalogue generated from code (src/core/rbac) → docs/rbac.md (D-091).';
CREATE UNIQUE INDEX permission_key_key ON platform.permission (key);

CREATE TABLE platform.role_permission (
  role_id       uuid NOT NULL,
  permission_id uuid NOT NULL,
  CONSTRAINT role_permission_pkey PRIMARY KEY (role_id, permission_id),
  CONSTRAINT role_permission_role_id_fkey FOREIGN KEY (role_id) REFERENCES platform.role (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT role_permission_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES platform.permission (id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX role_permission_permission_id_idx ON platform.role_permission (permission_id);

CREATE TABLE platform.platform_role_assignment (
  id         uuid NOT NULL DEFAULT uuidv7(),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  granted_by uuid,
  granted_at timestamptz(6) NOT NULL DEFAULT now(),
  expires_at timestamptz(6),
  revoked_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT platform_role_assignment_pkey PRIMARY KEY (id),
  CONSTRAINT platform_role_assignment_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT platform_role_assignment_role_id_fkey FOREIGN KEY (role_id) REFERENCES platform.role (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.platform_role_assignment IS 'Collective Group staff roles (tenant roles live on core.membership.role). Only platform-scope roles (checked by trigger).';
CREATE UNIQUE INDEX platform_role_assignment_user_id_role_id_key ON platform.platform_role_assignment (user_id, role_id) WHERE (revoked_at IS NULL);
CREATE INDEX platform_role_assignment_role_id_idx ON platform.platform_role_assignment (role_id);

CREATE OR REPLACE FUNCTION platform.check_platform_role_scope() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF (SELECT scope_kind FROM platform.role WHERE id = NEW.role_id) <> 'platform' THEN
    RAISE EXCEPTION 'platform.role_scope: role % is not a platform role', NEW.role_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_role_assignment_scope BEFORE INSERT OR UPDATE OF role_id ON platform.platform_role_assignment
  FOR EACH ROW EXECUTE FUNCTION platform.check_platform_role_scope();

CREATE TABLE platform.support_grant (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  requested_by uuid NOT NULL,
  reason       text NOT NULL,
  ticket_ref   text,
  state        platform.support_grant_state NOT NULL DEFAULT 'requested',
  approved_by  uuid,
  approved_via platform.support_grant_approval_via,
  approved_at  timestamptz(6),
  valid_from   timestamptz(6),
  valid_to     timestamptz(6),
  revoked_at   timestamptz(6),
  revoked_by   uuid,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT support_grant_pkey PRIMARY KEY (id),
  CONSTRAINT support_grant_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT support_grant_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT support_grant_range_check CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CONSTRAINT support_grant_approved_check CHECK (state NOT IN ('approved', 'active') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND valid_from IS NOT NULL AND valid_to IS NOT NULL))
);
COMMENT ON TABLE platform.support_grant IS 'Time-boxed Support read access into a tenant (D-090, contract §8); valid_to ≤ valid_from + setting support.grant_max_hours.';
CREATE INDEX support_grant_tenant_id_state_valid_to_idx ON platform.support_grant (tenant_id, state, valid_to);
CREATE INDEX support_grant_requested_by_state_idx ON platform.support_grant (requested_by, state);

CREATE TABLE platform.invitation (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  kind                platform.invitation_kind NOT NULL,
  role                text,
  building_ids        uuid[],
  lease_id            uuid,
  party_id            uuid,
  phone_e164          text,
  email               citext,
  code_hash           bytea NOT NULL,
  channel             platform.invitation_channel NOT NULL,
  state               platform.invitation_state NOT NULL DEFAULT 'pending',
  expires_at          timestamptz(6) NOT NULL,
  accepted_at         timestamptz(6),
  accepted_by_user_id uuid,
  invited_by          uuid,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT invitation_pkey PRIMARY KEY (id),
  CONSTRAINT invitation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invitation_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invitation_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT invitation_kind_check CHECK ((kind = 'tenant_member' AND role IS NOT NULL) OR (kind = 'lease_resident' AND lease_id IS NOT NULL)),
  CONSTRAINT invitation_contact_check CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR channel IN ('line_qr', 'link')),
  CONSTRAINT invitation_accepted_check CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);
COMMENT ON TABLE platform.invitation IS 'Tenant-member and lease-resident invitations (D-145). lease_id ⇢ ops.lease (FK added in B2.3).';
CREATE UNIQUE INDEX invitation_code_hash_key ON platform.invitation (code_hash);
CREATE INDEX invitation_tenant_id_state_idx ON platform.invitation (tenant_id, state);
CREATE INDEX invitation_lease_id_idx ON platform.invitation (lease_id);

CREATE TABLE platform.tenant_bank_account (
  id                        uuid NOT NULL DEFAULT uuidv7(),
  tenant_id                 uuid NOT NULL,
  bank_code                 text NOT NULL,
  bank_name_th              text NOT NULL,
  branch                    text,
  account_no_enc            bytea NOT NULL,
  account_no_hash           bytea NOT NULL,
  account_no_masked         text NOT NULL,
  account_name              text NOT NULL,
  promptpay_id_type         platform.promptpay_id_type,
  promptpay_id_enc          bytea,
  payment_provider          platform.payment_provider NOT NULL DEFAULT 'none',
  provider_merchant_ref_enc bytea,
  building_ids              uuid[],
  is_default                boolean NOT NULL DEFAULT false,
  state                     platform.bank_account_state NOT NULL DEFAULT 'pending_otp',
  effective_from            timestamptz(6) NOT NULL DEFAULT now(),
  effective_to              timestamptz(6),
  confirmed_by_otp_id       uuid,
  confirmed_at              timestamptz(6),
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz(6) NOT NULL DEFAULT now(),
  updated_by                uuid,
  CONSTRAINT tenant_bank_account_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_bank_account_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tenant_bank_account_confirmed_by_otp_id_fkey FOREIGN KEY (confirmed_by_otp_id) REFERENCES platform.otp_challenge (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tenant_bank_account_bank_code_check CHECK (bank_code ~ '^[0-9]{3}$'),
  CONSTRAINT tenant_bank_account_active_check CHECK (state <> 'active' OR confirmed_at IS NOT NULL),
  CONSTRAINT tenant_bank_account_promptpay_check CHECK ((promptpay_id_type IS NULL) = (promptpay_id_enc IS NULL)),
  CONSTRAINT tenant_bank_account_range_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);
COMMENT ON TABLE platform.tenant_bank_account IS 'Accounts that receive residents'' money — the platform never holds funds (D-042). Changes need the Owner''s OTP (D-091). payment_provider default none (⚖ O-001).';
CREATE UNIQUE INDEX tenant_bank_account_tenant_id_default_key ON platform.tenant_bank_account (tenant_id) WHERE (is_default AND (state = 'active'::platform.bank_account_state));
CREATE INDEX tenant_bank_account_tenant_id_state_idx ON platform.tenant_bank_account (tenant_id, state);

CREATE TABLE platform.tenant_bank_account_history (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  change           platform.bank_change NOT NULL,
  before           jsonb,
  after            jsonb,
  otp_challenge_id uuid,
  actor            jsonb NOT NULL,
  occurred_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT tenant_bank_account_history_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_bank_account_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tenant_bank_account_history_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES platform.tenant_bank_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tenant_bank_account_history_otp_challenge_id_fkey FOREIGN KEY (otp_challenge_id) REFERENCES platform.otp_challenge (id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
COMMENT ON TABLE platform.tenant_bank_account_history IS 'Append-only history of bank account changes (masked values only).';
CREATE INDEX tenant_bank_account_history_tenant_id_occurred_at_idx ON platform.tenant_bank_account_history (tenant_id, occurred_at DESC);
CREATE INDEX tenant_bank_account_history_bank_account_id_idx ON platform.tenant_bank_account_history (bank_account_id);

CREATE TRIGGER user_credential_set_updated_at BEFORE UPDATE ON platform.user_credential FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER role_set_updated_at BEFORE UPDATE ON platform.role FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER platform_role_assignment_set_updated_at BEFORE UPDATE ON platform.platform_role_assignment FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER support_grant_set_updated_at BEFORE UPDATE ON platform.support_grant FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER invitation_set_updated_at BEFORE UPDATE ON platform.invitation FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER tenant_bank_account_set_updated_at BEFORE UPDATE ON platform.tenant_bank_account FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER tenant_bank_account_history_append_only BEFORE UPDATE OR DELETE ON platform.tenant_bank_account_history
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation();
