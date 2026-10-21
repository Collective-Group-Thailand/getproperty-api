-- getproperty-api 0037 — EMQX HTTP authn/authz (D-235, blueprint T-7 / T-9) and the gateway WebSocket fallback (O-012
-- resolved → D-239). EMQX no longer reads smart.mqtt_acl from PostgreSQL: getproperty-api answers
-- POST /internal/emqx/authn and /internal/emqx/authz, with smart.mqtt_acl as its source of truth.
--   * the broker's read path is retired: policy mqtt_acl_rls_broker and every grant to gp_mqtt are dropped, so
--     collective-infra can drop the role from its postgres init script (the role itself stays where it exists:
--     migration 0010 — immutable — still creates / grants it on a fresh database, and the product login is
--     NOCREATEROLE; 0037 then removes what 0010 gave it);
--   * T-9: a gateway publishes only its four explicit topics — the wildcard row gp/v1/<id>/+ (which also matched
--     config and cmd) is revoked and replaced by telemetry, health and events (cmd/ack exists already);
--   * O-012: smart.device.mqtt_ws_fallback — per gateway, off by default: only then may the gateway connect over
--     ws 8083 behind Caddy with its device JWT alone (no client certificate on that path).
-- Deviation (schema-design §7.5 row 102).

DROP POLICY IF EXISTS mqtt_acl_rls_broker ON smart.mqtt_acl;
DO $gp_mqtt$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gp_mqtt') THEN
    REVOKE ALL ON smart.mqtt_acl FROM gp_mqtt;
    REVOKE USAGE ON SCHEMA smart FROM gp_mqtt;
  END IF;
END
$gp_mqtt$;
COMMENT ON TABLE smart.mqtt_acl IS 'Broker ACL of each gateway (device protocol §1, D-235): the source of truth of getproperty-api''s EMQX HTTP authz endpoint (POST /internal/emqx/authz); username = certificate CN gw-<deviceId>. Never read by the broker itself.';

-- T-9: four explicit publish topics per gateway
INSERT INTO smart.mqtt_acl (device_id, tenant_id, username, action, topic, created_at)
SELECT a.device_id, a.tenant_id, a.username, 'publish', regexp_replace(a.topic, '\+$', t.leaf), now()
  FROM smart.mqtt_acl a
 CROSS JOIN (VALUES ('telemetry'), ('health'), ('events')) AS t(leaf)
 WHERE a.revoked_at IS NULL AND a.action = 'publish' AND a.topic LIKE 'gp/v1/%/+'
ON CONFLICT (username, action, topic) WHERE (revoked_at IS NULL) DO NOTHING;
UPDATE smart.mqtt_acl SET revoked_at = now()
 WHERE revoked_at IS NULL AND action = 'publish' AND topic LIKE 'gp/v1/%/+';

ALTER TABLE smart.device ADD COLUMN mqtt_ws_fallback boolean NOT NULL DEFAULT false;
ALTER TABLE smart.device ADD CONSTRAINT device_mqtt_ws_fallback_check CHECK (NOT mqtt_ws_fallback OR kind = 'gateway');
COMMENT ON COLUMN smart.device.mqtt_ws_fallback IS 'D-239 (O-012): the gateway may connect over EMQX ws 8083 behind Caddy with its device JWT only (buildings that block 8883); off by default, set by the platform admin per gateway, audited.';
