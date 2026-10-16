-- 0003_tenancy — orgs, members, invitations, bank accounts (+history), org setting versions
-- (schema-design §3.2.3–§3.2.5; D-004, D-042, D-091, D-144, D-145). `property_setting_versions` waits for
-- `properties` (B2.1).

-- §3.2.3 orgs — tenancy root (D-004). logo_file_id FK is added in 0005 (file_objects).
CREATE TABLE orgs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id          uuid NOT NULL DEFAULT uuidv7(),
  slug               citext NOT NULL,
  display_name       text NOT NULL,
  legal_name         text,
  org_kind           org_kind NOT NULL,
  tax_id             text,
  vat_registered     boolean NOT NULL DEFAULT false,
  address            jsonb,
  logo_file_id       bigint,
  default_language   char(2) NOT NULL DEFAULT 'th',
  timezone           text NOT NULL DEFAULT 'Asia/Bangkok',
  status             org_status NOT NULL DEFAULT 'active',
  deactivated_at     timestamptz,
  deactivated_reason text,
  owner_user_id      bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint,
  CONSTRAINT orgs_public_id_key UNIQUE (public_id),
  CONSTRAINT orgs_slug_key UNIQUE (slug),
  CONSTRAINT orgs_tax_id_check CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{13}$'),
  CONSTRAINT orgs_slug_check CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT orgs_deactivated_check CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE INDEX orgs_status_idx ON orgs (status);

-- Deferred FKs from 0002 (user_roles, support_grants) now that orgs exists.
ALTER TABLE user_roles ADD CONSTRAINT user_roles_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE RESTRICT;
ALTER TABLE support_grants ADD CONSTRAINT support_grants_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE RESTRICT;

-- org_members — membership (roles live in user_roles)
CREATE TABLE org_members (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  user_id        bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  state          member_state NOT NULL DEFAULT 'invited',
  joined_at      timestamptz,
  removed_at     timestamptz,
  removed_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint,
  CONSTRAINT org_members_org_id_user_id_key UNIQUE (org_id, user_id),
  CONSTRAINT org_members_removed_check CHECK ((state = 'removed') = (removed_at IS NOT NULL))
);
CREATE INDEX org_members_user_id_idx ON org_members (user_id);

-- invitations — org-member (B1) and lease-bound tenant (B2.2) invitations, one table (D-145). lease_id FK in B2.3.
CREATE TABLE invitations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid NOT NULL DEFAULT uuidv7(),
  org_id              bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  kind                invitation_kind NOT NULL,
  role_id             bigint REFERENCES roles (id) ON DELETE RESTRICT,
  property_ids        bigint[],
  lease_id            bigint,
  phone_e164          text,
  email               citext,
  code_hash           bytea NOT NULL,
  channel             invitation_channel NOT NULL,
  state               invitation_state NOT NULL DEFAULT 'pending',
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_by_user_id bigint REFERENCES users (id) ON DELETE SET NULL,
  invited_by          bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint,
  CONSTRAINT invitations_public_id_key UNIQUE (public_id),
  CONSTRAINT invitations_code_hash_key UNIQUE (code_hash),
  CONSTRAINT invitations_kind_check CHECK (
    (kind = 'org_member' AND role_id IS NOT NULL) OR (kind = 'tenant_lease' AND lease_id IS NOT NULL)),
  CONSTRAINT invitations_contact_check CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR channel IN ('line_qr', 'link')),
  CONSTRAINT invitations_accepted_check CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX invitations_org_id_state_idx ON invitations (org_id, state);
CREATE INDEX invitations_lease_id_idx ON invitations (lease_id);

-- §3.2.4 org_bank_accounts — the account that receives tenant money; the platform never holds funds (D-042).
-- Changes are maker-checker by OTP (D-091): a row cannot be active without confirmed_at.
CREATE TABLE org_bank_accounts (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id                 uuid NOT NULL DEFAULT uuidv7(),
  org_id                    bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  bank_code                 text NOT NULL,
  bank_name_th              text NOT NULL,
  branch                    text,
  account_no_enc            bytea NOT NULL,
  account_no_hash           bytea NOT NULL,
  account_no_masked         text NOT NULL,
  account_name              text NOT NULL,
  promptpay_id_type         promptpay_id_type,
  promptpay_id_enc          bytea,
  payment_provider          payment_provider NOT NULL DEFAULT 'none',
  provider_merchant_ref_enc bytea,
  is_default                boolean NOT NULL DEFAULT false,
  state                     bank_account_state NOT NULL DEFAULT 'pending_otp',
  effective_from            timestamptz,
  effective_to              timestamptz,
  confirmed_by_otp_id       bigint REFERENCES otp_challenges (id) ON DELETE SET NULL,
  confirmed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                bigint,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                bigint,
  CONSTRAINT org_bank_accounts_public_id_key UNIQUE (public_id),
  CONSTRAINT org_bank_accounts_bank_code_check CHECK (bank_code ~ '^[0-9]{3}$'),
  CONSTRAINT org_bank_accounts_active_confirmed_check CHECK (state <> 'active' OR confirmed_at IS NOT NULL),
  CONSTRAINT org_bank_accounts_promptpay_pair_check CHECK ((promptpay_id_type IS NULL) = (promptpay_id_enc IS NULL)),
  CONSTRAINT org_bank_accounts_effective_check CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX org_bank_accounts_one_default_uq ON org_bank_accounts (org_id) WHERE is_default AND state = 'active';
CREATE INDEX org_bank_accounts_org_id_state_idx ON org_bank_accounts (org_id, state);
CREATE INDEX org_bank_accounts_account_no_hash_idx ON org_bank_accounts (account_no_hash);

-- org_bank_account_history ⟲ — every change as a row (masked before/after). Append-only trigger in 0008.
CREATE TABLE org_bank_account_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  bank_account_id  bigint NOT NULL REFERENCES org_bank_accounts (id) ON DELETE RESTRICT,
  change           bank_change NOT NULL,
  before           jsonb,
  after            jsonb,
  otp_challenge_id bigint REFERENCES otp_challenges (id) ON DELETE SET NULL,
  actor            jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_bank_account_history_org_id_occurred_at_idx ON org_bank_account_history (org_id, occurred_at DESC);
CREATE INDEX org_bank_account_history_bank_account_id_idx ON org_bank_account_history (bank_account_id);

-- §3.2.5 org_setting_versions — effective-dated org values of `settings` keys with 'org' in scope_allowed (D-144).
-- setting_id FK is added in 0004 (settings). No backdating: CK effective_from >= created_at - 5 min (ADR-0004).
CREATE TABLE org_setting_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
  setting_id     bigint NOT NULL,
  value          jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint,
  CONSTRAINT org_setting_versions_org_id_setting_id_effective_from_key UNIQUE (org_id, setting_id, effective_from),
  CONSTRAINT org_setting_versions_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT org_setting_versions_no_backdating_check CHECK (effective_from >= created_at - interval '5 minutes'),
  CONSTRAINT org_setting_versions_no_overlap_excl EXCLUDE USING gist (
    org_id WITH =, setting_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX org_setting_versions_setting_id_idx ON org_setting_versions (setting_id);
