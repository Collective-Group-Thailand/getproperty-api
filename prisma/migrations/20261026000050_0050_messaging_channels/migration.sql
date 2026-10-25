-- getproperty-api 0050 — the operator's own LINE Official Account (B7 deliverable 7.7 part 1, D-254). A tenant (or one
-- building) may connect its own Messaging API channel; the shared getproperty OA (the env token) stays the default.
-- Credentials are sealed with the tenant's data key (D-148). LINE user ids are per provider, so residents are linked
-- to an own OA by account linking: a follow / message on the OA → a single-use link token → the resident confirms in
-- the LIFF → the OA user id is kept per channel and login. schema-design §7.5 rows 127–129.

CREATE TYPE platform.messaging_channel_state AS ENUM ('pending', 'verified', 'failing', 'revoked');

CREATE TABLE platform.messaging_channel (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  building_id        uuid,
  line_channel_id    text NOT NULL,
  secret_enc         bytea NOT NULL,
  token_enc          bytea NOT NULL,
  webhook_key        text NOT NULL,
  bot_user_id        text,
  bot_name           text,
  bot_picture_url    text,
  state              platform.messaging_channel_state NOT NULL DEFAULT 'pending',
  verified_at        timestamptz(6),
  last_checked_at    timestamptz(6),
  last_error         text,
  revoked_at         timestamptz(6),
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT messaging_channel_pkey PRIMARY KEY (id),
  CONSTRAINT messaging_channel_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_channel_building_id_fkey FOREIGN KEY (building_id) REFERENCES core.building (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_channel_line_channel_id_check CHECK (line_channel_id ~ '^[0-9]{6,20}$'),
  CONSTRAINT messaging_channel_webhook_key_check CHECK (webhook_key ~ '^[A-Za-z0-9_-]{24,64}$'),
  CONSTRAINT messaging_channel_revoked_check CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT messaging_channel_verified_check CHECK (state <> 'verified' OR verified_at IS NOT NULL)
);
COMMENT ON TABLE platform.messaging_channel IS 'An operator''s own LINE Messaging API channel (D-254), for the tenant or one building; credentials sealed with the tenant data key. No row = the shared getproperty OA.';
CREATE UNIQUE INDEX messaging_channel_webhook_key_key ON platform.messaging_channel (webhook_key);
CREATE UNIQUE INDEX messaging_channel_tenant_scope_key ON platform.messaging_channel (tenant_id) WHERE building_id IS NULL AND state <> 'revoked';
CREATE UNIQUE INDEX messaging_channel_building_scope_key ON platform.messaging_channel (tenant_id, building_id) WHERE building_id IS NOT NULL AND state <> 'revoked';
CREATE INDEX messaging_channel_building_id_idx ON platform.messaging_channel (building_id);
SELECT platform.apply_rls('platform.messaging_channel', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.messaging_channel TO gp_app, gp_platform;

CREATE TABLE platform.messaging_channel_user (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  channel_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  line_user_id  text NOT NULL,
  linked_at     timestamptz(6) NOT NULL DEFAULT now(),
  unlinked_at   timestamptz(6),
  CONSTRAINT messaging_channel_user_pkey PRIMARY KEY (id),
  CONSTRAINT messaging_channel_user_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_channel_user_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES platform.messaging_channel (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_channel_user_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_channel_user_line_user_id_check CHECK (line_user_id ~ '^U[0-9a-f]{32}$')
);
COMMENT ON TABLE platform.messaging_channel_user IS 'A login linked to an own OA (D-254): the OA''s user id for that login (LINE ids are per provider).';
CREATE UNIQUE INDEX messaging_channel_user_channel_user_key ON platform.messaging_channel_user (channel_id, user_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX messaging_channel_user_channel_line_key ON platform.messaging_channel_user (channel_id, line_user_id) WHERE unlinked_at IS NULL;
CREATE INDEX messaging_channel_user_user_id_idx ON platform.messaging_channel_user (user_id);
CREATE INDEX messaging_channel_user_tenant_id_idx ON platform.messaging_channel_user (tenant_id);
SELECT platform.apply_rls('platform.messaging_channel_user', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.messaging_channel_user TO gp_app, gp_platform;

CREATE TABLE platform.messaging_link_token (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  channel_id    uuid NOT NULL,
  token_hash    bytea NOT NULL,
  line_user_id  text NOT NULL,
  expires_at    timestamptz(6) NOT NULL,
  used_at       timestamptz(6),
  used_by       uuid,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT messaging_link_token_pkey PRIMARY KEY (id),
  CONSTRAINT messaging_link_token_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_link_token_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES platform.messaging_channel (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_link_token_used_by_fkey FOREIGN KEY (used_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT messaging_link_token_used_check CHECK ((used_at IS NULL) = (used_by IS NULL))
);
COMMENT ON TABLE platform.messaging_link_token IS 'Single-use account-linking tokens of an own OA (D-254): issued on a follow / message from an unlinked OA user, confirmed in the LIFF.';
CREATE UNIQUE INDEX messaging_link_token_token_hash_key ON platform.messaging_link_token (token_hash);
CREATE INDEX messaging_link_token_channel_id_idx ON platform.messaging_link_token (channel_id, line_user_id);
CREATE INDEX messaging_link_token_tenant_id_idx ON platform.messaging_link_token (tenant_id);
CREATE INDEX messaging_link_token_used_by_idx ON platform.messaging_link_token (used_by);
SELECT platform.apply_rls('platform.messaging_link_token', 'tenant');
GRANT SELECT, INSERT, UPDATE ON platform.messaging_link_token TO gp_app, gp_platform;
