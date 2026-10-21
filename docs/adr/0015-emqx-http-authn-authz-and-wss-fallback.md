# ADR-0015 — Gateways on the shared EMQX: HTTP authn/authz by getproperty-api, device JWT as MQTT password, per-gateway WSS fallback

**Status:** Accepted (2026-10-22; D-235, D-239 — O-012 resolved, D-244)
**Decision ids:** D-130, D-165, D-231, D-235, D-239, D-244, D-245 · blueprint T-6–T-9, A-4, A-5

## Context
EMQX is the Collective platform's shared broker. Until 2026-10-22 getproperty's gateways were authorised by an EMQX
PostgreSQL source reading `smart.mqtt_acl` as a dedicated login (`getproperty_mqtt`, role `gp_mqtt`) and authenticated
by their client certificate only. That couples the shared broker to one product's database and roles, cannot tell a
retired gateway from a live one while its certificate is valid (EMQX does not pass the certificate fingerprint to
authorisation), and offers buildings that block outbound 8883 no way in: the WebSocket path ends TLS at Caddy, so EMQX
never sees a client certificate there (O-012).

## Decision
1. **getproperty-api answers EMQX** over the docker network: `POST /internal/emqx/authn` and `POST /internal/emqx/authz`
   (shared header token `x-emqx-auth-token`; empty token = fail closed; private callers only; rate-limited; not in the
   public OpenAPI). `smart.mqtt_acl` stays the source of truth; the PostgreSQL source, the `getproperty_mqtt` login and
   every grant to `gp_mqtt` are retired (migration 0037).
2. **Device protocol 1.2**: the MQTT password is a **device JWT** of the gateway (≤ 1 h, issued over mTLS by
   `POST /v1/device/token` only to a non-retired gateway with a current certificate). On 8883 the certificate CN must
   equal the username / client id and the JWT must be the gateway's own — required while the platform setting
   `mqtt.authn.require_device_jwt` is on (default). A retired or revoked gateway therefore cannot reconnect even with a
   certificate that is still within its validity period.
3. **Exact ACL**: a gateway publishes only `telemetry`, `health`, `events`, `cmd/ack` (QoS ≤ 1, not retained) and
   subscribes only to `config`, `cmd` — the former `gp/v1/<id>/+` also matched `config` / `cmd`.
4. **WSS fallback (O-012 → D-239)**: per gateway, off by default, switched by the platform admin with a reason
   (audited, outbox event): such a gateway may connect over `wss://<MQTT_HOST>/mqtt` (Caddy → EMQX ws 8083) with the
   device JWT **alone**. The gateway learns the URL from the bootstrap answer and — since D-249 (edge CR-015) — from
   every `POST /v1/device/token` answer (`mqtt { url, wsUrl? }`), so the switch reaches a provisioned gateway at its
   next token refresh without a site visit.
5. **Device CA** in the platform secret `collective/<env>/platform/device-ca` (`ca_chain_pem`, `issuing_cert_pem`,
   `issuing_key_pem`, `broker_cert_pem`, `broker_key_pem`), rendered into the API env as `DEVICE_CA_*` (D-245).

## Risks of the WSS path (accepted by the founder, documented for operators)
- No client certificate: possession of a valid device JWT is enough to connect as that gateway until the JWT expires
  (≤ 1 h). Obtaining one requires the gateway's private key or code execution on the gateway/agent.
- No channel binding: TLS ends at Caddy; a JWT replayed from elsewhere is indistinguishable.
- Blast radius: the authz rules still confine the connection to that one gateway's topics — fake telemetry/health of
  one gateway for ≤ 1 h; billing is protected by the reading review rules (D-035, D-142) and cumulative registers.
- Mitigations: off by default and per gateway; switching it off refuses the next connect; every denial audited;
  JWT lifetime ≤ 1 h; re-enable mTLS-only by opening 8883 at the building.

## Consequences
- + The shared broker needs no access to any product database; getproperty decides about its own gateways.
- + Revocation and retirement are effective on the next connect (and within the 1-minute authz cache).
- − Every connect and uncached publish/subscribe is an HTTP call to the API: the API being down keeps gateways out (they
  buffer 30 days); EMQX's authz cache (≤ 1 min) and the endpoint's rate limit bound the load.
- − Agents older than 1.2 are refused while `mqtt.authn.require_device_jwt` is on (edge CR in the triage, F11).
