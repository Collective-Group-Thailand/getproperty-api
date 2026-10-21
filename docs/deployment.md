# Deployment — getproperty on the Collective platform (D-230)

getproperty runs where getpack runs: **Collective's shared AWS platform** ("Config C"), defined only in the
**collective-infra** repository (Terraform for AWS `ap-southeast-7`, the docker-compose platform on one EC2 box per
environment, and the reusable GitHub Actions). This repository carries **no infrastructure code**; this page says
what getproperty needs from the platform and how the image meets the platform's contract. The changes getproperty
needs in collective-infra are on its branch **`getproperty/r1-platform`** (patches: `collective-infra-patches/`
beside this checkout); until that branch is merged and tagged, getproperty cannot be deployed.

| | uat | prod |
|---|---|---|
| Box | `t4g.large` (2 vCPU / 8 GB), Mon–Fri 08:00–20:00 Asia/Bangkok | `t4g.xlarge` (4 vCPU / 16 GB), 24×7 |
| Shared services | Caddy 2.10 · PostgreSQL 18 `timescale/timescaledb-ha:pg18` (pgBackRest → S3) · Valkey 8 (`noeviction`) · EMQX 5.8 · Grafana Alloy → Grafana Cloud | same |
| Per product | S3 bucket `collective-<env>-getproperty-assets` · Secrets Manager `collective/<env>/getproperty/*` · SES identity · ECR `getproperty/{api,web,liff}` · the instance role (no keys) | same |
| Deploys | GitHub Actions (OIDC) → ECR → SSM `deploy-product.sh` (pull · migrate · up · health · rollback) | + GitHub Environment `production` approval |

Shell access, logs, backups, restore drills and resizing are platform runbooks: collective-infra `README.md` §5.

## 1. Containers

`platform/products/getproperty/docker-compose.yml` (collective-infra), compose project `getproperty` on the external
network `collective`:

| Service | Image · command | Port | Health | Memory |
|---|---|---|---|---|
| `web` | `getproperty/web:${WEB_IMAGE_TAG}` | 3000 | `/api/healthz` | 384M |
| `liff` | `getproperty/liff:${LIFF_IMAGE_TAG}` | 3000 | `/api/healthz` | 256M |
| `api` | `getproperty/api:${IMAGE_TAG}` · `node dist/src/main.js` | 3000 | `/health` (+ `/metrics`) | 640M |
| `worker` | same · `node dist/src/worker.js` | 3001 | `/health` (+ `/metrics`) | 1G (Chromium PDFs) |
| `ingest` | same · `node dist/src/ingest.js` | 3002 | `/health` (+ `/metrics`) | 256M |
| `clamav` | `clamav/clamav-debian:1.4` | 3310 | `clamdcheck.sh` | 1280M |
| `migrate` | same · `node dist/src/migrate.js` (one-shot, profile `tools`) | — | exit code | 512M |

Exactly one `ingest` replica (EMQX shared subscription `$share/ingest/…` also works with more). The platform's
Alloy scrapes every container labelled `collective.metrics` and receives OTLP traces on `platform-alloy-1:4318`.

## 2. The image contract

One image (`Dockerfile`), built natively for `linux/arm64` by collective-infra's `reusable-build-push.yml`:

- **Commands**: `node dist/src/main.js` (API), `worker.js`, `ingest.js`, `migrate.js`. The entrypoint runs a given
  command as is; without one, `PROCESS=main|worker|ingest|migrate` picks it (local `docker run`).
- **Health**: API `GET /health` on `:3000` (PostgreSQL, Redis, S3, MQTT; 503 when one is down). The worker and the
  ingest process serve `GET /health` + `GET /metrics` on their own port (`WORKER_HEALTH_PORT=3001`,
  `INGEST_HEALTH_PORT=3002`; `src/common/observability/metrics.ts`): database + Redis (+ MQTT for ingest).
- **Metrics**: Prometheus text on `/metrics` — Node.js runtime metrics with label `service`, plus
  `http_server_request_duration_seconds{method,route,status}` on the API (route **pattern**, never the URL). The API
  answers `/metrics` only to `METRICS_ALLOWED_CIDRS` by client IP (default: loopback + private ranges = Alloy on the
  docker network); Caddy also blocks `/metrics` on every public host.
- **Traces**: OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (`src/instrument.ts`), `OTEL_SERVICE_NAME` per container.
- **Time zone**: `TZ=Asia/Bangkok` (image + compose; `tzdata` installed). Business rules use Asia/Bangkok explicitly
  anyway; stored times are UTC.
- **Chromium** (PDFs) from Debian, available for arm64 and amd64; `PDF_CHROMIUM_EXECUTABLE=/usr/bin/chromium`.
- **Build input**: `@collective/asset-core` is a sibling source tree (ADR-0011) passed as the named build context
  `asset-core-src`; the Dockerfile builds it. CI passes it with `extra_repository` / `build_contexts`
  (`.github/workflows/deploy.yml`) until the package is published to GitHub Packages (then it becomes a normal
  dependency, like getpack's `@getpack/dieline`, and the extra checkout goes away).

### Migrations — why not `npx prisma migrate deploy`

The platform template for getpack runs `npx prisma migrate deploy`. For getproperty that would be wrong: the `core`
schema belongs to `@collective/asset-core` and **must migrate first** (D-153, ADR-0011), and the runtime image has
no Prisma CLI or schema engine. `node dist/src/migrate.js` (`src/database/migrations/deploy-migrations.ts`):

1. `assetCoreMigrate()` — schema `core`, roles, helper functions (advisory-locked, checksummed, idempotent);
2. `prisma/migrations/*` in order, each in one transaction, recorded in `_prisma_migrations` with the same name and
   sha256 checksum `prisma migrate deploy` writes — either tool can follow the other (CI still runs the real
   `prisma migrate deploy` + `prisma migrate diff`);
3. the optional TimescaleDB step of D-162 (`prisma/optional/timescale/001_telemetry_hypertables.sql`) when
   `TIMESCALEDB_MIGRATION=auto` (default) and the extension is usable — on the platform it is: the two raw tables
   become hypertables with retention policies, once, recorded in `_optional_migrations`. `off` skips it, `on`
   requires it. Without the extension (tests, plain PostgreSQL) the native monthly partitions stay; the API reads
   only rollup tables either way. **UNVERIFIED** against a live TimescaleDB until the first UAT deploy.

4. the **reference seed** (`prisma/seed/run.ts reference`: RBAC catalogue, settings catalogue, compliance rules,
   invoice line kinds, utility tariffs, holidays, templates, price plans …) — idempotent, every insert is `ON
   CONFLICT` on a natural key; `SEED_REFERENCE=false` skips it. It runs as `gp_platform` (BYPASSRLS) via `SET ROLE`.

It runs as the product login `getproperty` (not a superuser — `test/integration/platform-migrate.int-spec.ts`
proves the whole sequence that way). asset-core 0007 hands its SECURITY DEFINER helpers to `gp_platform`, which
PostgreSQL allows only when `gp_platform` may CREATE in schema `core`; the runner grants that for the duration of the
core migrations and revokes it afterwards (`migrateCoreAsProductLogin`). A proper fix belongs in
`@collective/asset-core` (grant in 0001 for non-superuser runners) — recorded for its next release.

`pnpm db:migrate` (asset-core CLI + `prisma migrate deploy`) stays the developer command; it needs a superuser or the
same temporary grant.

## 3. Secrets and database roles

The box renders Secrets Manager JSON into env files (`/run/collective/*.env`); **the app does not read its own
secret** (`AWS_SECRETS_ID` stays empty). It does read **provider credentials** at run time through the secrets port
(`PAYMENTS_SECRETS_PREFIX`, `LOCKS_SECRETS_PREFIX`, `ETAX_SECRETS_PREFIX`), so the compose file points those prefixes
under `collective/<env>/getproperty/…` — the only path the instance role may read.

**`collective/<env>/getproperty/app`** (flat JSON; values never in git):

| Keys | Value / rule |
|---|---|
| `DATABASE_URL` | `postgresql://getproperty:<getproperty_password>@postgres:5432/getproperty?connection_limit=10` |
| `DATABASE_APP_ROLE`, `DATABASE_PLATFORM_ROLE` | `gp_app`, `gp_platform` — the login switches role per transaction so RLS applies |
| `REDIS_URL` | `redis://:<valkey password>@valkey:6379/2` (getproperty's logical DB; getpack uses its own) |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | `getproperty-api`, random hex — EMQX's internal listener (the platform hook creates the user) |
| `PUBLIC_API_BASE_URL`, `PUBLIC_WEB_APP_URL`, `PUBLIC_STAFF_APP_URL`, `PUBLIC_RESIDENT_APP_URL` | `https://<API_HOST>`, `https://<OWNER_HOST>`, `https://<STAFF_HOST>`, `https://<LIFF_HOST>`. `https://<API_HOST>/brand/*` serves the logos emails and LINE messages link (D-232); LINE shows the logo only for an https origin |
| `MQTT_PUBLIC_URL` | `mqtts://<MQTT_HOST>:8883` |
| `MQTT_PUBLIC_WS_URL` | **unset** (do not add the key): the bootstrap then omits `mqtt.wsUrl` — no WSS endpoint verifies gateway certificates while O-012 is open (§5, D-231) |
| `DEVICE_PUBLIC_BASE_URL` | **empty / unset**: device URLs (`ota_apply.manifestUrl`) are relative `/v1/device/…` paths the agent resolves against its device host; `https://<DEVICE_HOST>` is equivalent. Never `https://<API_HOST>` (D-231) |
| `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` | 32 bytes base64; ≥ 32 characters |
| `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_KID`, `AUTH_JWT_PREVIOUS_KEYS` | Ed25519 PKCS#8 (base64), key id, rotation set |
| `DEVICE_CA_CERT`, `DEVICE_CA_KEY` | the platform device CA (EC P-256, base64 PEM) — also issues the broker certificate (§5) |
| `OTA_SIGNING_PUBLIC_KEYS` | OTA manifest keys |
| `LINE_LOGIN_CHANNEL_IDS`, `LINE_MESSAGING_ACCESS_TOKEN` | LINE channels |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_API_SECRET` | SMS gateway |
| `SES_FROM_ADDRESS` | `getproperty <no-reply@<ses_domain>>` — a verified identity (`ses_domain` in collective-infra tfvars) |
| `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | VAPID |
| `SLIP_VERIFY_API_KEY`, `AI_GATEWAY_URL`, `AI_GATEWAY_API_KEY`, `SENTRY_DSN` | optional providers |
| `DOCS_ENABLED`, `DOCS_ALLOWED_CIDRS` | `/docs` on uat only, by office IP |

Set by the compose file (not secrets): `NODE_ENV`, `TZ`, `INTEGRATIONS_MODE=real`, `DATA_STORES_MODE=real`,
`AWS_REGION`, `S3_BUCKET`, `MQTT_URL=mqtt://platform-emqx-1:1883`, `TRUST_PROXY`, `TRUSTED_PROXY_CIDRS`,
`METRICS_ALLOWED_CIDRS`, `DEVICE_MTLS_*`, `CLAMAV_HOST`, the provider secret prefixes, OTEL settings, ports.

**`collective/<env>/getproperty/web`**, **`…/liff`**: each front end's own run-time env (session secrets, hosts,
`API_INTERNAL_URL`, …) → `/run/collective/getproperty-web.env` / `-liff.env`. The front ends never receive the API's
secrets. **Both front ends read every value at run time, the public `NEXT_PUBLIC_*` ones included** (web ADR-0009,
liff ADR-0007): on the server from the secret like every other variable, handed to the browser as props or
server-rendered `<html data-*>` attributes; a literal `process.env.NEXT_PUBLIC_…` read fails their tests (liff's one
exception is `NEXT_PUBLIC_LIFF_MOCK`, the mock build flavour, never set for a platform image). No build arguments, so
**one image per front end serves every environment** and `promote.yml` can ship the bytes UAT ran (§7).

| Front end | Public keys in its secret (besides its own run-time env) |
|---|---|
| **getproperty-web** | `OWNER_HOST`, `STAFF_HOST`, `ADMIN_HOST` (= `caddy/sites.<env>.yml`), optional `NEXT_PUBLIC_ASSET_BASE_URL=https://collective-<env>-getproperty-assets.s3.ap-southeast-7.amazonaws.com`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_ENV_BADGE=uat`, `NEXT_PUBLIC_LINE_OA_ID` |
| **getproperty-liff** | **`NEXT_PUBLIC_LIFF_ID`** (required — the LIFF app of *that environment's* LINE Login channel; a production container without it fails its start-up check and answers 500, `/api/healthz` included, so the deploy's health check fails and rolls back), `NEXT_PUBLIC_ASSET_BASE_URL` (the environment's bucket origin, as for web), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (= this API's `WEB_PUSH_VAPID_PUBLIC_KEY`), optional `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_ENV_BADGE=uat` (empty or `production` = no badge), `NEXT_PUBLIC_LINE_OA_ID`, `FEATURE_TECHNICIAN`, `APP_ORIGIN` |

So a changed public value means, for both front ends: update the secret and restart that container (the next deploy
re-renders the env file). The liff repository variables `UAT_*` / `PROD_*` of the former per-environment builds are
no longer read.

**`collective/<env>/getproperty/mqtt-tls`**: `{"server_pem", "server_key", "ca_pem"}` — §5.

**`collective/<env>/platform/postgres`** gets `getproperty_mqtt_password` (EMQX's authorization login).

**Database roles** (`platform/postgres/init/20-getproperty.sh`): the product login `getproperty` owns database
`getproperty` and is `NOCREATEROLE`, so the init script (superuser) creates the asset-core group roles `gp_owner`,
`gp_app` (NOBYPASSRLS), `gp_platform` (BYPASSRLS), `gp_reporting`, plus `gp_mqtt`, grants them to `getproperty`,
creates the login `getproperty_mqtt` (member of `gp_mqtt`: reads only live rows of `smart.mqtt_acl`) and the
extensions (`timescaledb`, `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`). Idempotent; on a box initialised before
it existed, run it once by SSM (command in the script header).

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

The device protocol does not change (§1 of `docs/contract/device-protocol.md`): MQTT 5 over TLS on **8883 with a
per-gateway X.509 client certificate**, and the `caChainPem` a gateway receives at bootstrap is the **only** trust
anchor it uses for the broker. The platform's original EMQX listener (`verify_none`, username/password, Let's
Encrypt certificate) therefore cannot serve gateways; `getproperty/r1-platform` changes it:

- listener `ssl:default` (8883): `verify_peer` + `fail_if_no_peer_cert` against the getproperty device CA; server
  certificate issued **from the same CA** for `MQTT_HOST`; `peer_cert_as_username = cn` (zone `devices`) so the
  username is `gw-<gatewayId>`; no password on this listener;
- authorization: file source (the API user `getproperty-api`: `gp/v1/+/#`, `$share/ingest/gp/v1/+/#`) → PostgreSQL
  source `SELECT permission, action, topic FROM smart.mqtt_acl WHERE username = ${username} AND revoked_at IS NULL`
  (login `getproperty_mqtt`) → `no_match = deny`, `deny_action = disconnect`. A gateway publishes only
  `gp/v1/<its id>/+` and `…/cmd/ack`, subscribes only `…/config` and `…/cmd`;
- internal listener 1883 (docker network only) and ws 8083: password users (built-in database). The API, worker and
  ingest connect to `mqtt://platform-emqx-1:1883` as `MQTT_USERNAME`.

Issue the broker certificate with the device CA (the key never leaves the machine that runs it):

```bash
DEVICE_CA_CERT=… DEVICE_CA_KEY=… pnpm device:broker-cert --host mqtt.getproperty.co --out .local/broker-cert
aws secretsmanager put-secret-value --secret-id collective/prod/getproperty/mqtt-tls --secret-string "$(jq -n \
  --rawfile s .local/broker-cert/server.pem --rawfile k .local/broker-cert/server.key --rawfile c .local/broker-cert/ca.pem \
  '{server_pem: $s, server_key: $k, ca_pem: $c}')"
```

`products/getproperty/hooks/post-secrets.sh` installs it into `/data/emqx/certs/getproperty`, restarts the listener
and gives Caddy the CA for `DEVICE_HOST`. Renew yearly (397 days) — calendar it in LAUNCH-CHECKLIST §5.

**Gateway HTTPS** (`/v1/device/bootstrap`, `/v1/device/certificate/renew`, …): `DEVICE_HOST`, where Caddy verifies a
presented client certificate against the device CA (`verify_if_given`: bootstrap has no certificate yet) and
forwards only its SHA-256 in `X-Client-Cert-Sha256`; the API runs `DEVICE_MTLS_SOURCE=sha256_header`. Every other
host strips that header, and the API container is not reachable from outside the docker network.

**Open (O-012)**: the WSS fallback on 443 for buildings that block 8883 (device protocol §1). Caddy terminates TLS for
`/mqtt` on the platform host, so EMQX cannot see the gateway certificate there. Until it is decided
`MQTT_PUBLIC_WS_URL` stays **unset** and the bootstrap answer carries no `mqtt.wsUrl` (D-231, edge CR-013; the agent
also ignores a WSS URL unless `GP_MQTT_WS_FALLBACK=on`). R1 gateways use 8883; the options
(Caddy `client_auth` on an `mqtt-ws` host + EMQX `peer_cert_as_username` from a proxy header, or a TLS passthrough
layer4 route) need a platform decision before a building without 8883 is onboarded.

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

Limits of getproperty's containers: 3.75 GB including ClamAV (1.25 GB) and the transient migrate. On **prod**
(16 GB) with getpack (3.2 GB), the platform services (1.7 GB) and PostgreSQL (4 GB) there is headroom for page cache.
On **uat** (8 GB) the limits over-commit (they are ceilings): set `POSTGRES_MEMORY_LIMIT=2g` for uat and watch
`container_memory_working_set_bytes` in Grafana; if the box swaps, move ClamAV to one shared platform service first
(getpack can use it too). The R1 load target (300 meters / 300 units, D-207) is a single-box workload.

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
