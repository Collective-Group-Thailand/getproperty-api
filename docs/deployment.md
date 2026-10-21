# Deployment — getproperty on the Collective platform (D-230)

getproperty runs where getpack runs: **Collective's shared AWS platform** ("Config C"), defined only in the
**collective-infra** repository (Terraform for AWS `ap-southeast-7`, the docker-compose platform on one EC2 box per
environment, and the reusable GitHub Actions). This repository carries **no infrastructure code**; this page says
what getproperty needs from the platform and how the image meets the platform's contract. The changes getproperty
needs in collective-infra are on its branch **`getproperty/r1-platform`** (patches: `collective-infra-patches/`
beside this checkout); until that branch is merged and tagged, getproperty cannot be deployed.

> **2026-10-21 / 2026-10-22 — Collective's locked infrastructure decisions (D-233–D-238) and the gap tasks.** They win
> over anything below. On 2026-10-22 getproperty-api implemented its side of the gap tasks (T-1, T-3, T-5–T-9, T-12–T-16)
> and the founder resolved O-012–O-016 (D-239–D-243); collective-infra's branch `getproperty/r1-platform` carries the
> matching platform side (EMQX HTTP authn/authz, device-CA secret, one product secret, shared ClamAV, budget limits,
> ingest on :3001, DLM copy, restore-drill hook). The task table with its status is in `docs/platform-blueprint.md`
> § Infrastructure & operations.

| | uat | prod |
|---|---|---|
| Box | `t4g.large` (2 vCPU / 8 GB), Mon–Fri 08:00–20:00 Asia/Bangkok | `t4g.xlarge` (4 vCPU / 16 GB), 24×7 |
| Shared services | Caddy 2.10 · PostgreSQL 18 `timescale/timescaledb-ha:pg18` (pgBackRest → S3) · Valkey 8 (`noeviction`) · EMQX 5.8 · Grafana Alloy → Grafana Cloud | same |
| Per product | S3 bucket `collective-<env>-getproperty-assets` · **one** Secrets Manager secret `collective/<env>/getproperty/app` (D-233; the branch still uses `…/{app,web,liff,mqtt-tls}` — T-4, T-6) · SES identity · ECR `getproperty/{api,web,liff}` · the instance role (no keys) | same |
| Deploys | GitHub Actions (OIDC) → ECR → SSM `deploy-product.sh` (pull · migrate · up · health · rollback) | + GitHub Environment `production` approval |

Shell access, logs, backups, restore drills and resizing are platform runbooks: collective-infra `README.md` §5.

## 1. Containers

`platform/products/getproperty/docker-compose.yml` (collective-infra), compose project `getproperty` on the external
network `collective`:

| Service | Image · command | Port | Health | Memory (now) | Budget (D-233) |
|---|---|---|---|---|---|
| `web` | `getproperty/web:${WEB_IMAGE_TAG}` | 3000 | `/api/healthz` | 384M | 384M |
| `liff` | `getproperty/liff:${LIFF_IMAGE_TAG}` | 3000 | `/api/healthz` | 256M | 192M |
| `api` | `getproperty/api:${IMAGE_TAG}` · `node dist/src/main.js` | 3000 | `/health` (+ `/metrics`) | 640M | 512M |
| `worker` | same · `node dist/src/worker.js` | 3001 | `/health` (+ `/metrics`) | 1536M (own Chromium, ADR-0012) | 512M once `pdf-render` is consumed (D-236, D-242); **1.5G until then** (ADR-0012) |
| `ingest` | same · `node dist/src/ingest.js` | 3001 (`INGEST_HEALTH_PORT=3001` in its own container; image default 3002) | `/health` (+ `/metrics`) | 192M | 192M |
| `clamav` | — (shared platform service `platform-clamav-1:3310`, T-2) | — | — | 0 | 0 |
| `migrate` | same · `node dist/src/migrate.js` (one-shot, profile `tools`) | — | exit code | 512M | 512M one-shot (outside the steady state) |
| **Total** | | | | **≈ 2.8 GB while ADR-0012 is active** | **1,792 MB ≈ 1.8 GB** |

Exactly one `ingest` replica (EMQX shared subscription `$share/ingest/…` also works with more). The platform's
Alloy scrapes every container labelled `collective.metrics` and receives OTLP traces on `platform-alloy-1:4318`.

## 2. The image contract

One image (`Dockerfile`), built natively for `linux/arm64` by collective-infra's `reusable-build-push.yml`:

- **Commands**: `node dist/src/main.js` (API), `worker.js`, `ingest.js`, `migrate.js`. The entrypoint runs a given
  command as is; without one, `PROCESS=main|worker|ingest|migrate` picks it (local `docker run`).
- **Health**: API `GET /health` on `:3000` (PostgreSQL, Redis, S3, MQTT; 503 when one is down). The worker and the
  ingest process serve `GET /health` + `GET /metrics` on their own port (`WORKER_HEALTH_PORT=3001`,
  `INGEST_HEALTH_PORT` — 3001 in the platform's ingest container, T-10; image default 3002 so both run side by side
  locally; `src/common/observability/metrics.ts`): database + Redis (+ MQTT for ingest).
- **Metrics**: Prometheus text on `/metrics` — Node.js runtime metrics with label `service`, plus
  `http_server_request_duration_seconds{method,route,status}` on the API (route **pattern**, never the URL). The API
  answers `/metrics` only to `METRICS_ALLOWED_CIDRS` by client IP (default: loopback + private ranges = Alloy on the
  docker network); Caddy also blocks `/metrics` on every public host.
- **Traces**: OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (`src/instrument.ts`), `OTEL_SERVICE_NAME` per container.
- **Time zone**: `TZ=Asia/Bangkok` (image + compose; `tzdata` installed). Business rules use Asia/Bangkok explicitly
  anyway; stored times are UTC.
- **PDFs** (D-236, D-242, ADR-0012): `PDF_RENDERER_MODE` = `real` (default in the image: Debian's Chromium,
  `PDF_CHROMIUM_EXECUTABLE=/usr/bin/chromium`, in the worker only) **until getpack's `pdf-render` consumer is
  deployed**, then `queue` (the shared `pdf-render` BullMQ queue — `docs/pdf-render-queue.md`; `PDF_RENDER_REDIS_URL` =
  the platform's shared-queue Valkey DB, prefix `collective`); collective-infra maps `GETPROPERTY_PDF_RENDERER_MODE`
  and `GETPROPERTY_WORKER_MEMORY` (1536M now, 512M with `queue`). Chromium leaves the image after the switch.
- **One-shot commands** besides `migrate.js`: `node dist/src/drill-smoke.js` (restore drill, T-15, D-248) and
  `node dist/src/credentials-import.js` (provider credentials from the former Secrets Manager sub-paths, D-240).
- **Pool** (T-5, D-246): `DATABASE_POOL_MAX` per container — api 10 (≤ 15), worker 10 (≤ 10), ingest 5 (≤ 5); a value
  above the ceiling fails the start-up. getproperty's total ≤ 26 connections (+ migrate 1, + Python workers 5 from
  Phase 2) ≤ 35 (A-1).
- **Build input**: `@collective/asset-core` is a sibling source tree (ADR-0011) passed as the named build context
  `asset-core-src`; the Dockerfile builds it. CI passes it with `extra_repository` / `build_contexts`
  (`.github/workflows/deploy.yml`) until the package is published to GitHub Packages (then it becomes a normal
  dependency, like getpack's `@getpack/dieline`, and the extra checkout goes away).

### Migrations — why not `npx prisma migrate deploy` (ADR-0013)

The platform template for getpack runs `npx prisma migrate deploy`; collective-infra's README now names the product
compose's **`migrate` service** instead, which for getproperty runs **`node dist/src/migrate.js`**
(`src/database/migrations/deploy-migrations.ts`, ADR-0013): the `core` schema belongs to `@collective/asset-core` and
**must migrate first** (D-153, ADR-0011), and the runtime image has no Prisma CLI or schema engine.

1. `@collective/asset-core` migrations — schema `core`, roles, helper functions (advisory-locked, checksummed,
   idempotent). **asset-core ≥ 0.4.0** is required (the command refuses an older package): as a non-superuser runner
   it grants `gp_platform` `CREATE ON SCHEMA core` for the run itself (0007 hands its SECURITY DEFINER helpers to
   `gp_platform`) and revokes it afterwards — getproperty's former workaround is gone (T-3);
2. `prisma/migrations/*` in order, each in one transaction, recorded in `_prisma_migrations` with the same name and
   sha256 checksum `prisma migrate deploy` writes — either tool can follow the other (CI still runs the real
   `prisma migrate deploy` + `prisma migrate diff`);
3. the optional TimescaleDB steps (`prisma/optional/timescale/`) where the extension is usable —
   `TIMESCALEDB_MIGRATION=auto` (default; **`on` in prod**, D-234, so a missing extension fails the deploy), `off`
   skips: `001_telemetry_hypertables` (raw telemetry and health samples become hypertables with retention policies)
   and `002_telemetry_compression` (raw telemetry platform-only without RLS, compressed after 30 days — T-12,
   ADR-0014), each once, recorded in `_optional_migrations`. Without the extension (tests, plain PostgreSQL) the
   native monthly partitions stay; tenants read the same rollups and 15-minute function either way. **UNVERIFIED**
   against a live TimescaleDB until the first UAT deploy;
4. the **reference seed** (`prisma/seed/run.ts reference`: RBAC catalogue, settings catalogue, compliance rules,
   invoice line kinds, utility tariffs, holidays, templates, price plans …) — idempotent, every insert is `ON
   CONFLICT` on a natural key; `SEED_REFERENCE=false` skips it. It runs as `gp_platform` (BYPASSRLS) via `SET ROLE`.

It runs as the product login `getproperty` (not a superuser — `test/integration/platform-migrate.int-spec.ts` proves
the whole sequence that way). App migration 0039 hands its two SECURITY DEFINER telemetry functions to `gp_platform`
the same way (a `CREATE ON SCHEMA smart` grant inside its own transaction).

`pnpm db:migrate` (asset-core CLI + `prisma migrate deploy`) stays the developer command.

## 3. Secrets and database roles

The box renders Secrets Manager JSON into env files (`/run/collective/*.env`); **the app does not read its own
secret** (`AWS_SECRETS_ID` stays empty). **One** product secret per environment (D-233, T-4):
`collective/<env>/getproperty/app`. Keys without a prefix belong to the API image (api, worker, ingest, migrate);
component keys carry a prefix that collective-infra's `fetch-secrets.sh` strips while splitting them into the
component's own env file — **`WEB__…`** → `getproperty-web.env`, **`LIFF__…`** → `getproperty-liff.env`,
**`MQTT_TLS__…`** (interim only, see §5) — so a front end never receives the API's secrets. Per-merchant provider
credentials are **not** secrets any more but sealed rows in PostgreSQL (D-240, below). Platform-owned values come from
platform secrets: the device CA (`collective/<env>/platform/device-ca`, D-245) and the EMQX hook token
(`collective/<env>/platform/emqx` `getproperty_auth_token`), which collective-infra's getproperty hook writes into the
API env file.

**API keys of `collective/<env>/getproperty/app`** (flat JSON; values never in git):

| Keys | Value / rule |
|---|---|
| `DATABASE_URL` | `postgresql://getproperty:<getproperty_password>@postgres:5432/getproperty` — no `connection_limit` parameter (it has no effect with the pg adapter); the pool is `DATABASE_POOL_MAX` per container (T-5, set by the compose file) |
| `DATABASE_APP_ROLE`, `DATABASE_PLATFORM_ROLE` | `gp_app`, `gp_platform` — the login switches role per transaction so RLS applies |
| `REDIS_URL` | `redis://:<valkey password>@valkey:6379/2` (getproperty's logical DB; getpack uses its own) |
| `PDF_RENDER_REDIS_URL` | only with `PDF_RENDERER_MODE=queue`: the platform's shared-queue Valkey DB (`docs/pdf-render-queue.md`) |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | `getproperty-api`, random hex — EMQX's internal listener (the platform hook creates the built-in user); also the service user the authz endpoint allows below `gp/v1/` (`EMQX_SERVICE_USERNAMES` overrides the list) |
| `PUBLIC_API_BASE_URL`, `PUBLIC_WEB_APP_URL`, `PUBLIC_STAFF_APP_URL`, `PUBLIC_RESIDENT_APP_URL` | `https://<API_HOST>`, `https://<OWNER_HOST>`, `https://<STAFF_HOST>`, `https://<LIFF_HOST>`. `https://<API_HOST>/brand/*` serves the logos emails and LINE messages link (D-232) |
| `MQTT_PUBLIC_URL` | `mqtts://<MQTT_HOST>:8883` |
| `MQTT_PUBLIC_WS_URL` | `wss://<MQTT_HOST>/mqtt` — the WebSocket fallback (D-239); handed only to gateways whose fallback the platform admin enabled |
| `DEVICE_PUBLIC_BASE_URL` | **empty / unset**: device URLs (`ota_apply.manifestUrl`) are relative `/v1/device/…` paths the agent resolves against its device host; `https://<DEVICE_HOST>` is equivalent. Never `https://<API_HOST>` (D-231) |
| `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` | 32 bytes base64; ≥ 32 characters (the field key also seals the platform merchant's provider credentials, D-240) |
| `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_KID`, `AUTH_JWT_PREVIOUS_KEYS` | Ed25519 PKCS#8 (base64), key id, rotation set |
| `OTA_SIGNING_PUBLIC_KEYS` | OTA manifest keys |
| `LINE_LOGIN_CHANNEL_IDS`, `LINE_MESSAGING_ACCESS_TOKEN` | LINE channels |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_API_SECRET` | SMS gateway |
| `SES_FROM_ADDRESS` | `getproperty <no-reply@<ses_domain>>` — a verified identity (`ses_domain` in collective-infra tfvars) |
| `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | VAPID |
| `INTEGRATION_GETBUILD_*`, `INTEGRATION_GETPACK_*` | cross-product events (D-247), once a partner consumes them: `…_TRANSPORT=webhook`, `…_WEBHOOK_URL=http://<partner>-api:3000/webhooks/integration/getproperty`, `…_SIGNING_KEYS` (ours, ≥ 32 characters), `…_VERIFY_KEYS` (theirs); default `none` |
| `SLIP_VERIFY_API_KEY`, `AI_GATEWAY_URL`, `AI_GATEWAY_API_KEY`, `SENTRY_DSN` | optional providers |
| `DOCS_ENABLED`, `DOCS_ALLOWED_CIDRS` | `/docs` on uat only, by office IP |

**Written by collective-infra's getproperty hook** into the API env (not in the product secret): `DEVICE_CA_CERT`,
`DEVICE_CA_KEY`, `DEVICE_CA_CHAIN` (base64 PEM from `platform/device-ca` `issuing_cert_pem`, `issuing_key_pem`,
`ca_chain_pem` — D-245) and `EMQX_AUTH_TOKEN` (= `platform/emqx` `getproperty_auth_token`, D-244).

**Set by the compose file** (not secrets): `NODE_ENV`, `TZ`, `INTEGRATIONS_MODE=real`, `DATA_STORES_MODE=real`,
`AWS_REGION`, `S3_BUCKET`, `MQTT_URL=mqtt://platform-emqx-1:1883`, `TRUST_PROXY`, `TRUSTED_PROXY_CIDRS`,
`METRICS_ALLOWED_CIDRS`, `DEVICE_MTLS_*`, `CLAMAV_HOST=platform-clamav-1`, `PDF_RENDERER_MODE`
(`GETPROPERTY_PDF_RENDERER_MODE`), `DATABASE_POOL_MAX` per service, `INGEST_HEALTH_PORT=3001`, OTEL settings, ports.
The three `*_SECRETS_PREFIX` lines go away once `credentials-import` ran (D-240, RUNBOOK §13).

**Per-merchant provider credentials** (D-240): KBank / SCB / Opn merchants, TTLock / Tuya accounts, INET e-Tax
accounts are entered by the platform admin (`POST /v1/admin/provider-credentials`, values write-only) and sealed with
the tenant's data key in `platform.provider_credential`; the platform's own merchant with the platform field key. On a
box that still holds the former sub-path secrets (`collective/<env>/getproperty/{payments,locks,etax}/…`): run
`node dist/src/credentials-import.js` once with the `*_SECRETS_PREFIX` variables set, check its report, then delete the
sub-path secrets and the prefixes.

**Front ends** (`WEB__…`, `LIFF__…` keys of the same secret): each front end's own run-time env (session secrets,
hosts, `API_INTERNAL_URL`, …). **Both front ends read every value at run time, the public `NEXT_PUBLIC_*` ones
included** (web ADR-0009, liff ADR-0007): on the server from their env file like every other variable, handed to the
browser as props or server-rendered `<html data-*>` attributes; a literal `process.env.NEXT_PUBLIC_…` read fails their
tests (liff's one exception is `NEXT_PUBLIC_LIFF_MOCK`, the mock build flavour, never set for a platform image). No
build arguments, so **one image per front end serves every environment** and `promote.yml` can ship the bytes UAT ran
(§7).

| Front end | Public keys (with their prefix in the product secret) |
|---|---|
| **getproperty-web** | `WEB__OWNER_HOST`, `WEB__STAFF_HOST`, `WEB__ADMIN_HOST` (= `caddy/sites.<env>.yml`), optional `WEB__NEXT_PUBLIC_ASSET_BASE_URL=https://collective-<env>-getproperty-assets.s3.ap-southeast-7.amazonaws.com`, `WEB__NEXT_PUBLIC_SENTRY_DSN`, `WEB__NEXT_PUBLIC_ENV_BADGE=uat`, `WEB__NEXT_PUBLIC_LINE_OA_ID` |
| **getproperty-liff** | **`LIFF__NEXT_PUBLIC_LIFF_ID`** (required — the LIFF app of *that environment's* LINE Login channel; a production container without it fails its start-up check and answers 500, `/api/healthz` included, so the deploy's health check fails and rolls back), `LIFF__NEXT_PUBLIC_ASSET_BASE_URL`, `LIFF__NEXT_PUBLIC_VAPID_PUBLIC_KEY` (= this API's `WEB_PUSH_VAPID_PUBLIC_KEY`), optional `LIFF__NEXT_PUBLIC_SENTRY_DSN`, `LIFF__NEXT_PUBLIC_ENV_BADGE=uat`, `LIFF__NEXT_PUBLIC_LINE_OA_ID`, `LIFF__FEATURE_TECHNICIAN`, `LIFF__APP_ORIGIN` |

A changed public value means, for both front ends: update the secret and restart that container (the next deploy
re-renders the env file).

**Retired** (2026-10-22): the per-component secrets `collective/<env>/getproperty/{web,liff,mqtt-tls}` (moved into
`app` with prefixes; collective-infra README §3 "Moving from the per-component secrets"), `DEVICE_CA_*` in the product
secret, and `getproperty_mqtt_password` in `platform/postgres` with the `getproperty_mqtt` login (EMQX no longer reads
PostgreSQL).

**Database roles** (`platform/postgres/init/20-getproperty.sh`): the product login `getproperty` owns database
`getproperty` and is `NOCREATEROLE`, so the init script (superuser) creates the asset-core group roles `gp_owner`,
`gp_app` (NOBYPASSRLS), `gp_platform` (BYPASSRLS), `gp_reporting`, grants them to `getproperty`, and creates the
extensions (`timescaledb`, `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`). The init script also creates `gp_mqtt` (NOLOGIN, no
members) because migration 0010 (immutable) grants to it and the product login cannot create roles; migration 0037
drops its policy and grants (D-244), and collective-infra's `hooks/post-migrate.sh` drops the role once 0037 is
recorded as applied — on fresh and existing boxes alike. The shared `pdf-render` queue lives in Valkey DB 15
(reserved for cross-product queues); getproperty's own queues use DB 2.

## 4. Hosts, Caddy and the client IP

`platform/caddy/templates/getproperty.caddy` with the hosts of `caddy/sites.<env>.yml` (domains are TODO there):

| Key | Example (prod) | Upstream |
|---|---|---|
| `OWNER_HOST`, `STAFF_HOST`, `ADMIN_HOST` | `app.` / `staff.` / `admin.getproperty.co` | `getproperty-web:3000` (zones by host) |
| `LIFF_HOST` | `liff.getproperty.co` | `getproperty-liff:3000` |
| `API_HOST` | `api.getproperty.co` | `getproperty-api:3000` (webhooks, presigned flows) |
| `DEVICE_HOST` | `device.getproperty.co` | `getproperty-api:3000`, `/v1/device/*` + `/health` only, gateway client certificates |
| `MQTT_HOST` | `mqtt.getproperty.co` | DNS for EMQX `:8883`; the Caddy site only answers the health check |

**Client IP (D-229)**: Caddy is the one proxy. For an internet client (not in `trusted_proxies private_ranges`) it
*replaces* `X-Forwarded-For` with the client's address, so a spoofed header never survives; the containers see one
hop. The BFFs (web, liff) call `http://getproperty-api:3000` over the docker network and send the end user's
address they took from their own inbound header (`TRUSTED_HOPS=1`). Hence:

- API: `TRUST_PROXY=1`, `TRUSTED_PROXY_CIDRS=172.30.0.0/16` (the `collective` network, daemon.json address pool);
- web / liff: `TRUSTED_HOPS=1`.

Smoke check on the box: RUNBOOK §11.

## 5. MQTT and gateways

EMQX 5.8 is the **shared platform broker** (D-235); getproperty-api is its **HTTP authn / authz authority** for gateways
(D-244); the namespace `gp/v1/#` is getproperty's. Device protocol **1.2** (`docs/contract/device-protocol.md`).

| Listener | Who | Authentication | Authorisation |
|---|---|---|---|
| `ssl:default` **8883** (public) | gateways | mutual TLS against `ca_chain_pem` of `platform/device-ca` (`verify_peer`, `fail_if_no_peer_cert`; zone `devices`: `peer_cert_as_username = cn`, `peer_cert_as_clientid = cn`) **+** HTTP authn → `POST /internal/emqx/authn` with `transport = mtls`: CN `gw-<gatewayId>` of a provisioned, non-retired gateway holding a current certificate, and its device JWT as password (setting `mqtt.authn.require_device_jwt`, on by default) | HTTP authz → `POST /internal/emqx/authz` |
| `ws:default` **8083** (behind Caddy `wss://<MQTT_HOST>/mqtt`) | gateways of buildings that block 8883, **only with the per-gateway fallback on** (D-239) | HTTP authn with `transport = ws`: no certificate; a valid device JWT of that gateway is required | same |
| `tcp:default` **1883** (docker network only) | getproperty api / worker / ingest | EMQX built-in users (`MQTT_USERNAME`) | same endpoint: service users below `gp/v1/` |

- **Endpoints** (`src/surfaces/internal/emqx-auth.controller.ts`, `src/core/devices/emqx-auth.service.ts`): callers inside
  `EMQX_HTTP_ALLOWED_CIDRS` (default loopback + private ranges); header `x-emqx-auth-token` = `EMQX_AUTH_TOKEN`
  (constant-time; empty token = every request refused); `EMQX_HTTP_RATE_LIMIT` per minute (default 6,000); answers
  `{"result":"allow"|"deny"|"ignore"}` (`is_superuser: false` with `allow`). Not in the OpenAPI contract; shapes in
  `docs/contract/device-protocol.md` §1a. Caddy answers 404 for `/internal/*` on every public host.
- **Authz** from `smart.mqtt_acl` (the source of truth, written at bootstrap): a gateway publishes only
  `gp/v1/<id>/{telemetry,health,events,cmd/ack}` (QoS ≤ 1, never retained) and subscribes only to
  `gp/v1/<id>/{config,cmd}`; anything else of a gateway is `deny` (EMQX `deny_action = disconnect`); other users are
  denied inside `gp/v1/` and ignored outside. EMQX caches authz ≤ 1 min, so a revoked / retired gateway loses its
  topics within a minute; its next connect is refused at once (no current certificate / revoked session family).
- **Audit**: every gateway denial is `mqtt.authn_denied` / `mqtt.authz_denied` (reason, transport, topic, peer — never
  the password), one row per subject, reason and minute.
- **Fail closed**: the API down or the token missing = EMQX gets no `allow` → gateways stay disconnected and keep their
  readings (store-and-forward 30 days), reconnecting with back-off.

**Device CA** (D-245): `collective/<env>/platform/device-ca` — `ca_chain_pem`, `issuing_cert_pem`, `issuing_key_pem`,
`broker_cert_pem` (leaf + issuing CA), `broker_key_pem`. Issue the broker certificate with the device CA (the keys never
leave the machine that runs it):

```bash
DEVICE_CA_CERT=… DEVICE_CA_KEY=… [DEVICE_CA_CHAIN=…] pnpm device:broker-cert --host mqtt.getproperty.co --out .local/broker-cert
aws secretsmanager put-secret-value --secret-id collective/prod/platform/device-ca \
  --secret-string file://.local/broker-cert/device-ca-secret.json && rm -rf .local/broker-cert
```

collective-infra's `bin/render-device-ca.sh` installs it for EMQX (8883 + the WSS certificate on `MQTT_HOST`) and Caddy
(`DEVICE_HOST` trust pool) and the getproperty hook writes `DEVICE_CA_*` into the API env; redeploy the API after a CA
change. Broker certificate: 397 days (LAUNCH-CHECKLIST §5); gateway certificates 12 months (agent renews at 11).
Interim only: while `platform/device-ca` is still empty on a box, collective-infra serves the listener from the product
secret's `MQTT_TLS__SERVER_PEM` / `__SERVER_KEY` / `__CA_PEM` and the API keeps its own `DEVICE_CA_*`.

**Gateway HTTPS** (`/v1/device/bootstrap`, `/v1/device/token`, `/v1/device/certificate/renew`, …): `DEVICE_HOST`, where
Caddy verifies a presented client certificate against the device CA (`verify_if_given`: bootstrap has no certificate
yet) and forwards only its SHA-256 in `X-Client-Cert-Sha256`; the API runs `DEVICE_MTLS_SOURCE=sha256_header`. Every
other host strips that header, and the API container is not reachable from outside the docker network.

**WebSocket fallback (D-239, O-012 resolved)** — for a building whose firewall blocks outbound 8883:

1. platform admin: `POST /v1/admin/devices/{deviceId}/actions/set-mqtt-transport` `{ "wsFallback": true, "reason": … }`
   (audited) — before issuing the provisioning code, or re-provision the gateway afterwards (the URL arrives with the
   bootstrap answer);
2. the bootstrap answer then carries `mqtt.wsUrl = wss://<MQTT_HOST>/mqtt` (`MQTT_PUBLIC_WS_URL`);
3. the agent (protocol 1.2, `GP_MQTT_WS_FALLBACK=on` on that gateway) connects there with username = client id =
   `gw-<gatewayId>` and a fresh device JWT as password.

Risks accepted for that path (ADR-0015): no client certificate — a stolen device JWT (≤ 1 h; issued only over mTLS to a
non-retired gateway) lets its holder connect as that gateway until it expires, limited to that gateway's own topics;
TLS ends at Caddy. Keep the fallback to the buildings that need it and switch it off when 8883 is opened.

## 5a. OTA releases (D-231)

Gateways reach only `DEVICE_HOST:443` and `MQTT_HOST:8883`, so the agent binary is served **by the API on the
device host** from the private product bucket — no public bucket, CDN or presigned URL:

| | |
|---|---|
| Object | `s3://collective-<env>-getproperty-assets/releases/edge/<version>/getproperty-edge-<version>-linux-<arch>` (`S3_KEY_PREFIX` is empty on the platform; versioned, SSE-S3) |
| Manifest `artifact.url` | `https://<DEVICE_HOST>/v1/device/ota/artifacts/<version>/<file>` — getproperty-edge `pnpm image --base-url https://<DEVICE_HOST>/v1/device/ota/artifacts` |
| Served by | `GET /v1/device/ota/artifacts/{version}/{file}` (device JWT + the gateway's client certificate; only a registered, non-deprecated release of its architecture; `Content-Length`, `ETag` = sha256) |
| Caddy | `DEVICE_HOST` route `/v1/device/ota/artifacts/*`: GET/HEAD only, upstream `read_timeout 10m` (slow building links) |
| Who writes | a release engineer whose IAM identity has `collective-<env>-getproperty-release-publisher` (put/get/list on `releases/*`). The instance role **reads** `releases/*` only: put/delete there are explicitly denied, so a compromised API cannot replace a binary (it would also fail the ed25519 signature and sha256 checks on the gateway) |

Publishing a release:

```bash
# getproperty-edge, on the release machine (signing key never leaves it)
OTA_SIGNING_KEY_FILE=… OTA_KEY_ID=gp-ota-2026 pnpm image --arch arm64 --node ./node-arm64/bin/node \
  --base-url https://device.getproperty.co/v1/device/ota/artifacts --channel stable
aws s3 cp dist/release/0.4.0/getproperty-edge-0.4.0-linux-arm64 \
  s3://collective-prod-getproperty-assets/releases/edge/0.4.0/ --content-type application/octet-stream
# then the platform admin registers dist/release/0.4.0/manifest-arm64.json (POST /v1/admin/ota/releases): the API
# refuses it (422 ota.artifact_missing) until the object exists with the signed size; then rollouts ring by ring.
```

Deprecating a release stops its download at once; the object stays (bucket versioning, 30-day noncurrent expiry
applies only to overwritten versions — never overwrite a published version, bump it).

## 6. Sizing

**Budget (locked decision 14, D-233)**: on the 16 GB prod box platform ≈ 6 GB, getpack 3.2 GB, **getproperty ≈ 1.8 GB**,
getpop ≈ 1.5 GB, hard limits in compose. getproperty's line: api 512M · worker 512M · ingest 192M · web 384M · liff
192M = 1,792 MB (migrate 512M one-shot). ClamAV is a shared platform service (T-2); while ADR-0012 is active the worker
runs its own Chromium at 1.5 GB (≈ 2.8 GB in total) until getpack's `pdf-render` consumer is deployed (D-242); the
300-meter / 300-unit load test is re-run under the limits on UAT (T-11). On **uat** (8 GB) the limits over-commit (they are ceilings): set
`POSTGRES_MEMORY_LIMIT=2g` for uat and watch `container_memory_working_set_bytes` in Grafana. The R1 load target
(300 meters / 300 units, D-207) is a single-box workload; the telemetry volumes per KPI and the trigger for a DB box
are in `docs/platform-blueprint.md` § Infrastructure asks; the **DB-box trigger** is getproperty's database > 100 GB
or `/data` > 70 % (D-241, Grafana alerts in collective-infra).

## 7. CI/CD

- **getproperty-api**: `.github/workflows/deploy.yml` — `main` → build `getproperty/api:sha-…` + `:uat` → deploy uat;
  tag `vX.Y.Z` → `:prod` → deploy production (approval). Deploys run the migrate service first. GitHub Environments
  `uat` / `production` hold `AWS_DEPLOY_ROLE_ARN`, `INSTANCE_ID`, `AWS_REGION=ap-southeast-7`; the repo secret
  `ASSET_CORE_READ_TOKEN` (already used by CI) feeds the asset-core checkout.
- **getproperty-web** / **getproperty-liff** (both have their standalone Dockerfile without build arguments,
  `/api/healthz` and `/api/metrics`): the same workflow with their own image and `component`, no migration, after the
  api image exists:

```yaml
# .github/workflows/deploy.yml in getproperty-web (liff: image getproperty/liff, component liff)
name: Deploy
on:
  push:
    branches: [main]
    tags: ['v*.*.*']
  workflow_dispatch:
permissions: { id-token: write, contents: read, packages: read }
jobs:
  build-uat:
    if: github.ref == 'refs/heads/main'
    uses: collective-group/collective-infra/.github/workflows/reusable-build-push.yml@v1
    with: { image: getproperty/web, environment: uat, moving_tag: uat }
  deploy-uat:
    needs: build-uat
    uses: collective-group/collective-infra/.github/workflows/reusable-deploy.yml@v1
    with: { product: getproperty, component: web, migrate: false, environment: uat, image_tag: '${{ needs.build-uat.outputs.image_tag }}' }
  build-prod:
    if: startsWith(github.ref, 'refs/tags/v')
    uses: collective-group/collective-infra/.github/workflows/reusable-build-push.yml@v1
    with: { image: getproperty/web, environment: production, moving_tag: prod }
  deploy-prod:
    needs: build-prod
    uses: collective-group/collective-infra/.github/workflows/reusable-deploy.yml@v1
    with: { product: getproperty, component: web, migrate: false, environment: production, image_tag: '${{ needs.build-prod.outputs.image_tag }}' }
```

`component: web` makes the box record `WEB_IMAGE_TAG` and roll back only that image; until a front end's first
deploy the box runs its moving `:uat` / `:prod` tag. Instead of rebuilding on a tag, collective-infra's `promote.yml`
(manual, `production` approval) re-tags what UAT runs as `:prod` and deploys it — per component, as the repos deploy:
`component: api` (api image + migration), `web`, `liff` (that front end alone, `<NAME>_IMAGE_TAG`), or `all` (api,
then web, then liff, each from its own `:uat` sha). The liff image is promotable like web's since it reads its LIFF id
and other public values at run time (§3): the UAT bytes start in production with production's LIFF id.
- **getproperty-edge** is not deployed by the platform (it runs on gateways): its `GP_API_URL` default is the device
  host; releases are published as in §5a.

## 8. Local development

Unchanged: `pnpm dev` with fakes, or `docker compose up -d` (PostgreSQL + TimescaleDB, Redis, EMQX with dev
users/ACL, **LocalStack** S3 + SES + Secrets Manager like getpack, Mailpit) and `DATA_STORES_MODE=real`,
`INTEGRATIONS_MODE=real`, `AWS_ENDPOINT_URL=http://localhost:4566`, `S3_FORCE_PATH_STYLE=true`. The migrate command
runs locally too: `pnpm build && pnpm db:migrate:deploy`.
