-- 0002_iam — users, identities, sessions, OTP, roles & permissions, support grants (schema-design §3.2.1, §3.2.2).
-- Audit columns: created_by / updated_by hold users.id without a FK constraint (see docs/PROGRESS.md B1.2 step 2);
-- business actor columns (granted_by, approved_by, requested_by, …) keep their FKs.

-- §3.2.1 users — every human principal (org users, platform staff; tenants link through tenant_links in B2.2)
CREATE TABLE users (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id                 uuid NOT NULL DEFAULT uuidv7(),
  kind                      user_kind NOT NULL,
  phone_e164                text,
  phone_hash                bytea,
  phone_verified_at         timestamptz,
  email                     citext,
  email_verified_at         timestamptz,
  password_hash             text,
  password_changed_at       timestamptz,
  totp_secret_enc           bytea,
  totp_enabled_at           timestamptz,
  totp_recovery_codes_hash  bytea[],
  display_name              text NOT NULL,
  language                  char(2) NOT NULL DEFAULT 'th',
  timezone                  text NOT NULL DEFAULT 'Asia/Bangkok',
  failed_login_count        smallint NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  last_login_at             timestamptz,
  disabled_at               timestamptz,
  disabled_reason           text,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                bigint,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                bigint,
  CONSTRAINT users_public_id_key UNIQUE (public_id),
  CONSTRAINT users_phone_hash_key UNIQUE (phone_hash),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_phone_e164_check CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT users_platform_needs_email_check CHECK (kind <> 'platform_user' OR email IS NOT NULL),
  CONSTRAINT users_contact_check CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR kind = 'tenant_user'),
  CONSTRAINT users_phone_pair_check CHECK ((phone_e164 IS NULL) = (phone_hash IS NULL))
);
CREATE INDEX users_kind_idx ON users (kind);

-- user_identities — external identities (LINE for tenants/owners)
CREATE TABLE user_identities (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         identity_provider NOT NULL,
  provider_subject text NOT NULL,
  display_name     text,
  picture_url      text,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  raw_claims       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint,
  CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_subject)
);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

-- auth_sessions — refresh-token families (ADR-0003). device_id gets its FK in B3.1 (devices).
CREATE TABLE auth_sessions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id          uuid NOT NULL DEFAULT uuidv7(),
  user_id            bigint REFERENCES users (id) ON DELETE CASCADE,
  device_id          bigint,
  audience           audience NOT NULL,
  family_id          uuid NOT NULL,
  refresh_token_hash bytea NOT NULL,
  parent_token_hash  bytea,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  revoke_reason      session_revoke_reason,
  ip                 inet,
  user_agent         text,
  scopes             text[] NOT NULL DEFAULT '{}',
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_public_id_key UNIQUE (public_id),
  CONSTRAINT auth_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash),
  CONSTRAINT auth_sessions_principal_check CHECK (
    (audience = 'device' AND device_id IS NOT NULL AND user_id IS NULL)
    OR (audience <> 'device' AND user_id IS NOT NULL AND device_id IS NULL)),
  CONSTRAINT auth_sessions_revoke_pair_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX auth_sessions_user_id_revoked_at_idx ON auth_sessions (user_id, revoked_at);
CREATE INDEX auth_sessions_family_id_idx ON auth_sessions (family_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);

-- otp_challenges — SMS OTP (login, bank-account change, e-sign, phone verification). code_hash never leaves the DB.
CREATE TABLE otp_challenges (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid NOT NULL DEFAULT uuidv7(),
  purpose      otp_purpose NOT NULL,
  phone_e164   text NOT NULL,
  phone_hash   bytea NOT NULL,
  code_hash    bytea NOT NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  subject_type text,
  subject_id   bigint,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenges_public_id_key UNIQUE (public_id),
  CONSTRAINT otp_challenges_attempts_check CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT otp_challenges_subject_check CHECK ((subject_type IS NULL) = (subject_id IS NULL))
);
CREATE INDEX otp_challenges_phone_hash_purpose_created_at_idx ON otp_challenges (phone_hash, purpose, created_at DESC);
CREATE INDEX otp_challenges_expires_at_idx ON otp_challenges (expires_at);

-- §3.2.2 roles — seeded from code (D-090)
CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL,
  scope_kind  role_scope_kind NOT NULL,
  name_th     text NOT NULL,
  name_en     text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  CONSTRAINT roles_key_key UNIQUE (key),
  CONSTRAINT roles_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

-- permissions — `resource.action` catalogue generated from src/modules/iam/permissions.ts → docs/rbac.md (D-091)
CREATE TABLE permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL,
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL,
  surface     text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_key_key UNIQUE (key),
  CONSTRAINT permissions_key_check CHECK (key = resource || '.' || action AND key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);

CREATE TABLE role_permissions (
  role_id       bigint NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id)
);

-- user_roles — assignment with scope. org_id FK is added in 0003 (orgs), property_id FK in B2.1 (properties).
CREATE TABLE user_roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     bigint NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  scope_type  role_scope NOT NULL,
  org_id      bigint,
  property_id bigint,
  granted_by  bigint REFERENCES users (id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  CONSTRAINT user_roles_scope_check CHECK (
    (scope_type = 'platform' AND org_id IS NULL AND property_id IS NULL)
    OR (scope_type = 'org' AND org_id IS NOT NULL AND property_id IS NULL)
    OR (scope_type = 'property' AND org_id IS NOT NULL AND property_id IS NOT NULL))
);
CREATE UNIQUE INDEX user_roles_active_assignment_uq
  ON user_roles (user_id, role_id, scope_type, coalesce(org_id, 0), coalesce(property_id, 0))
  WHERE revoked_at IS NULL;
CREATE INDEX user_roles_org_id_user_id_idx ON user_roles (org_id, user_id);
CREATE INDEX user_roles_user_id_idx ON user_roles (user_id);

-- support_grants — time-boxed Support read access into an org (D-090, contract §8). org_id FK added in 0003.
CREATE TABLE support_grants (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid NOT NULL DEFAULT uuidv7(),
  org_id       bigint NOT NULL,
  requested_by bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason       text NOT NULL,
  ticket_ref   text,
  state        support_grant_state NOT NULL DEFAULT 'requested',
  approved_by  bigint REFERENCES users (id) ON DELETE SET NULL,
  approved_via support_grant_approval_via,
  approved_at  timestamptz,
  valid_from   timestamptz,
  valid_to     timestamptz,
  revoked_at   timestamptz,
  revoked_by   bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint,
  CONSTRAINT support_grants_public_id_key UNIQUE (public_id),
  CONSTRAINT support_grants_validity_check CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT support_grants_active_needs_window_check CHECK (state <> 'active' OR (valid_from IS NOT NULL AND valid_to IS NOT NULL))
);
CREATE INDEX support_grants_org_id_state_valid_to_idx ON support_grants (org_id, state, valid_to);
CREATE INDEX support_grants_requested_by_state_idx ON support_grants (requested_by, state);
