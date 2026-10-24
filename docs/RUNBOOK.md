# getproperty-api — Runbook (R1)

Operating the API, worker and ingest processes on Collective's shared AWS platform (D-230; collective-infra,
`docs/deployment.md`). Platform operations — shell (SSM), backups, restore drills, resizing, secrets rendering — are in
collective-infra `README.md` §5; this runbook covers getproperty. Audience: the on-call engineer and Collective
Group's platform admins. Every action here that touches tenant data is audited; never paste secrets, OTPs,
national ids or bank data into tickets, chat or logs.

> Status: written with B6.5 before the first production deployment. Steps marked **UNVERIFIED** have not been run
> against the live environment yet; tick them in `docs/LAUNCH-CHECKLIST.md` when they have.

## 1. System map

One EC2 box per environment (uat `t4g.large`, office hours; prod `t4g.xlarge`, 24×7) in AWS `ap-southeast-7`,
compose project `getproperty` beside getpack (`docs/deployment.md` §1):

| Process | Container | Role | Health |
|---|---|---|---|
| API | `getproperty-api` (`node dist/src/main.js`) | `/v1/*`, `/webhooks/*`, `/health`, `/docs` (allow-list), `/internal/emqx/*` (EMQX HTTP authn/authz, docker network only — D-244) | `:3000/health` |
| Worker | `getproperty-worker` (`worker.js`) | BullMQ consumers + repeatable maintenance jobs (`src/worker.runner.ts`), PDFs (own Chromium under ADR-0012 until getpack's `pdf-render` consumer exists, D-242), `integration-delivery` (D-247) | `:3001/health` |
| Ingest | `getproperty-ingest` (`ingest.js`) | MQTT shared subscription on EMQX → telemetry, health, readings | `:3001/health` (own container, `INGEST_HEALTH_PORT=3001`; 3002 locally) |
| Web | `getproperty-web` | owner console, staff PWA, platform admin (getproperty-web) | `:3000/api/healthz` |
| LIFF | `getproperty-liff` | resident LINE Mini App (getproperty-liff) | `:3000/api/healthz` |
| ClamAV | `platform-clamav-1` (shared platform service, T-2) | upload virus scan (INSTREAM :3310, `CLAMAV_HOST`) | `clamdcheck.sh` |

Shared platform services: PostgreSQL 18 `timescale/timescaledb-ha:pg18` (container `platform-postgres-1`, database
`getproperty`, pgBackRest to S3, TimescaleDB available — D-162 as amended), Valkey (BullMQ, locks, caches;
`noeviction`), EMQX 5.8 (`platform-emqx-1`; gateways on 8883 with mutual TLS + device JWT, WSS fallback per gateway; authn / authz asked from getproperty-api), Caddy (TLS, host routing), Grafana
Alloy (logs, metrics, traces → Grafana Cloud). Per product: S3 bucket `collective-<env>-getproperty-assets` (private,
versioned, presigned URLs only), SES identity, **one** Secrets Manager secret `collective/<env>/getproperty/app` (+ platform secrets `platform/device-ca`, `platform/emqx`).

Configuration: environment variables (`src/config/env.schema.ts`, validated at boot — a bad value stops the process
before it serves) from the compose file and the env file the box renders from `collective/<env>/getproperty/app`
(`docs/deployment.md` §3). Business values are **settings** (`platform.setting`, effective-dated, audited —
ADR-0004), never env vars.

## 2. Deploy

1. CI is green on `main` (lint, typecheck, unit, e2e, integration with PostgreSQL 18, contract build + lint,
   build, image build).
2. `.github/workflows/deploy.yml`: `main` → image `getproperty/api:sha-…` + `:uat` (arm64) → uat; tag `vX.Y.Z` →
   `:prod` → production after the GitHub Environment approval. Same bytes uat → prod with collective-infra
   `promote.yml`.
3. On the box (`deploy-product.sh getproperty <tag>` via SSM): secrets rendered → images pulled → **migrations
   first**: the one-shot `migrate` service runs `node dist/src/migrate.js` (asset-core `core` schema, then
   `prisma/migrations`, then the optional TimescaleDB step, then the idempotent reference seed) as the product login. Migrations are additive; a
   destructive change ships in two releases (expand, then contract).
4. `compose up --wait` (container health) → edge health through Caddy on every getproperty host → done, or an
   automatic rollback to the previous tag.
5. Watch for 30 minutes (Grafana): 5xx rate, p95 latency (`http_server_request_duration_seconds`), outbox lag (§6),
   queue depth, ingest dead letters.

**Rollback**: automatic on failed health; by hand `sudo /opt/collective/platform/bin/rollback.sh getproperty` (SSM
session). Never roll back a migration; the previous image must work on the new schema (expand / contract rule).
The front ends roll back on their own (`rollback.sh getproperty --component web|liff`). Downtime per deploy: the
seconds `compose up` needs to replace a container (single box, no blue/green — PLAN.md non-goal).

## 3. Health and alerts

- `GET /health` — database, Redis, object storage, MQTT (fakes report `fake`); the compose healthcheck and the deploy
  gate use it. Worker `:3001/health`, ingest `:3002/health` (database, Redis, + MQTT for ingest).
- Metrics: `/metrics` on each process (Prometheus; scraped by Alloy on the docker network — 404 from outside).
- Alerts (Grafana Cloud alerting → ops e-mail; host alarms are CloudWatch → SNS, collective-infra): `/health` of
  api/web/liff through Caddy; 5xx > 1 % for 5 min; p95 > 1.5 s; outbox `pending` older than 5 min; dead letters > 0;
  BullMQ `failed` growing; PostgreSQL CPU / connections / disk (`/data`) > 80 %; container memory near its limit;
  gateways offline > 10 % of a tenant (tenant health `gateways_offline`).
- Logs are JSON (pino) with `requestId`, `tenantId`, `actor` — never request bodies of auth, payments or webhooks.

## 4. Data protection and access

- **Support access into a tenant** needs a support grant approved by the tenant's Owner (D-090), time-boxed
  (`support.grant_max_hours`), every request audited (`support_grant.used`). Support is **read-only** inside the
  grant (`support.read_only` on any write); only a Platform admin may act, and that is audited as
  `support_grant.bypassed`. Incident grants without the Owner: `POST /v1/admin/support-grants/{id}/actions/approve-incident`
  (second platform admin), reason mandatory.
- **PDPA requests** (D-025): owners handle their tenants' requests in the owner console; platform-level requests are
  listed at `GET /v1/admin/data-subject-requests` with their due dates (`privacy.dsr_due_days`).
- **Secrets**: AWS Secrets Manager `collective/<env>/getproperty/{app,web,liff,mqtt-tls}` today; target one secret
  `collective/<env>/getproperty/app` + the platform's `collective/<env>/platform/device-ca` (D-233, D-235); rotate by putting a new
  value — the box re-renders hourly (`secrets-refresh.timer`) and the next deploy (or `deploy-product.sh getproperty
  <same tag>`) restarts with it. Payment provider credentials live under
  `collective/<env>/getproperty/payments/<tenant|platform>/<provider>/<merchantRef>` (`PAYMENTS_SECRETS_PREFIX`;
  locks and e-Tax likewise) and are read at run time with the instance role. The tenant data keys are wrapped by the
  key-encryption key; rotating it re-wraps keys (no data re-encryption) — run it as a one-off job, never during
  billing.

## 5. Recurring jobs (worker)

All jobs are repeatable BullMQ jobs on the `maintenance` queue, exactly once across replicas. A failed run is
retried on the next tick; each job is idempotent.

| Job | Every | What | If it fails |
|---|---|---|---|
| `outbox-relay` | 1 s | domain events → subscribers | events pile up as `pending`; see §6 |
| `billing-cycles` | 15 min | cut-off, readings, drafts, auto-issue (B4) | owners see cycles stuck in `collecting`; run is safe to repeat |
| `platform-subscriptions` | 1 h | trial end, 1st-of-month usage + platform invoice, overdue → past_due → suspended, cancellation (B6.1) | no platform invoices on the 1st; rerun via the job — usage snapshots are unique per month |
| `payment-settlement` | 1 day | provider statements reconciliation (D-197) | discrepancies stay open; owners can upload the statement |
| `receivables` | 1 h | overdue, dunning, late fee | reminders late; nothing lost |
| `telemetry-rollup` / `telemetry-partitions` | 1 min / 1 day | hourly / daily rollups from raw points, monthly partitions and retention (D-184, D-241; 15-minute series are read from raw points, ADR-0014) | hourly / daily charts stale; 15-minute series stay current; ingest creates partitions on demand |
| `integration-delivery` | 30 s | outbound integration events → partner products (webhook, D-247) | events stay `pending` / `failed` and are retried with backoff; `dead` ones show in the admin console (`/v1/admin/integration-events?state=dead`) |
| `gateway-health`, `meter-health`, `config-drift`, `device-commands` | 1–5 min | smart health (B3) | stale health badges |
| `etax-submissions` | 1 min | e-Tax submissions due: submit, poll, store the signed XML / PDF (B6.2, D-215) | documents stay `queued` / `submitted`; provider errors retry with backoff (10 attempts), then the owner is told; the owner can retry |
| `etax-monthly` | 1 h (acts on the 1st) | last month's e-Tax figures to the owner and accountant (once per month) | notice late; figures stay available in the console |
| `tm30-sweep` | 1 h | TM30 duties of move-ins the subscriber missed (last 7 days, idempotent) (B6.2, D-216) | a duty opens late; the move-in subscriber normally opens it at once |
| `analytics-rollup` | 1 h | facts and day / week / month rollups of the last two days, every tenant (B6.3, D-217) | insights a little stale; the KPI and insights endpoints refresh their own window |
| `analytics-benchmarks` | 1 day | anonymised benchmark buckets (k ≥ 5 opted-in tenants) | benchmarks of yesterday stay shown |
| `retention`, `support-grants-expire`, `lease-lifecycle`, `notifications-release`, `workflow-timer-sweep`, `compliance-score` | see `src/worker.runner.ts` | | |

## 6. Outbox, subscribers and dead letters

- Every state change writes a domain event in its own transaction (outbox). Subscribers run exactly once per event
  (inbox). A subscriber that keeps failing ends as a **dead letter**.
- Inspect: `GET /v1/admin/outbox/messages?state=failed`, `GET /v1/admin/outbox/dead-letters`.
- Replay after the cause is fixed: `POST /v1/admin/outbox/dead-letters/{id}/actions/replay` (idempotent subscribers;
  audited). Ingest dead letters (malformed device payloads): `GET /v1/admin/ingest/dead-letters`, replay one with
  `POST …/{id}/actions/replay`.

## 7. Platform billing (B6.1)

- Prices are **price plan versions** (D-156, Proposed until validated in the pilot): add a draft version, publish it
  from a date ≥ today (`/v1/admin/price-plans`). Issued invoices keep their snapshot.
- Subscriptions: create (trial `subscription.trial_days`), change plan, cancel (end of month), suspend / reinstate
  with typed confirmation (`/v1/admin/subscriptions`). Suspended or cancelled = tenant `read_only`: owner and staff
  writes get 403 `tenant.read_only`, reads/exports/resident payments continue, nothing is deleted (D-082).
- The 1st of the month: the job counts units (status ≠ inactive), rented meter points and last month's OCR photos,
  snapshots usage and issues the platform invoice (PIV series, tenant NULL) with the Thai QR of the platform
  merchant (`platform.payments.merchant`, ⚖ O-008) and its PDF.
- A transfer received: `POST /v1/admin/platform-invoices/{id}/payments` (bank reference unique). A wrong invoice:
  request a credit note, a **second** platform user approves it (D-091).
- Platform payment callbacks arrive at `POST /webhooks/platform-payments/{provider}`; a 401 burst means the merchant
  secret or the provider's signing changed — check the secret version, never disable verification.

## 8. Incidents

| Symptom | First checks | Action |
|---|---|---|
| Owners cannot log in | SMS provider status, `auth.*` 5xx, Redis | switch the SMS provider credentials (secret) and redeploy; tell owners through LINE OA |
| Payments not confirmed | `/webhooks/payments/*` 401/5xx, provider status, `ops.payment_webhook` backlog | fix secret, replay callbacks from the provider portal; daily settlement catches misses |
| Gateways offline | `docker ps` / logs of `platform-emqx-1`, port 8883 reachable, broker certificate expiry (`collective/<env>/platform/device-ca`), the API up (EMQX asks `POST /internal/emqx/authn` — API down = every gateway refused), `EMQX_AUTH_TOKEN` = `platform/emqx` `getproperty_auth_token` (403 in the API log otherwise), audit `mqtt.authn_denied` reasons (`device_jwt_missing` = agents older than protocol 1.2 while `mqtt.authn.require_device_jwt` is on; `certificate_revoked`; `ws_fallback_disabled`) | renew the broker certificate (`pnpm device:broker-cert`, `docs/deployment.md` §5); `docker exec platform-emqx-1 emqx ctl listeners`; temporarily set `mqtt.authn.require_device_jwt` off (platform setting, audited) only if the fleet cannot run 1.2 yet; gateways buffer locally (store and forward) |
| PDFs not produced | worker log `PdfRenderError` / Chromium crashes, `PDF_RENDERER_MODE` | `real` (ADR-0012): worker memory (1.5 GB) and `shm_size`; `queue`: getpack worker up, `pdf-render` depth in Grafana, `PDF_RENDER_REDIS_URL`; subscribers retry by themselves — documents appear once rendering works |
| Provider calls refused (QR, locks, e-Tax) | `no credentials for …` in the worker log, `GET /v1/admin/provider-credentials?tenantId=…` | set or replace the credential (`POST /v1/admin/provider-credentials`, D-240); a leaked key: revoke it first (`…/{id}/actions/revoke`) |
| Billing cycle stuck | worker logs `billing-cycles`, readings review queue | finish reviews; the cycle resumes on the next tick |
| Database CPU high | `pg_stat_statements` (Grafana), long transactions, CPUCreditBalance | kill runaway export jobs; resize the box (collective-infra tfvars) |
| Data restore needed | pgBackRest PITR (35 days) | `restore-drill.sh prod --pitr "<time>"` on uat to inspect, export the rows; never restore over prod (collective-infra README §5) |

Post-incident: a short write-up in `docs/incidents/` (what, impact, timeline, fix, follow-ups) within 5 working days.

## 9. Backups and restore (UNVERIFIED until the drill in the launch checklist)

- Platform backups (locked decision 6, D-233): pgBackRest full (Sunday) / diff (daily 01:30) + WAL archive to
  `s3://collective-<env>-backups` (35 days, **RPO ≤ 5 min** via `archive_timeout` 300 s), EBS snapshot daily (DLM) with
  an encrypted cross-region copy to `ap-northeast-1` (Tokyo, 7 days — D-243, PDPA basis in
  `docs/compliance/cross-border-backups.md`); the assets bucket is versioned. No managed failover. Readings acknowledged in
  the last ≤ 5 minutes before a loss are not re-sent by gateways, but bills come only from cumulative registers
  (D-030), so the next reading restores every total.
- Restore drill (monthly, platform): `sudo /opt/collective/platform/bin/restore-drill.sh prod` on uat. The platform's
  getproperty hook (`platform/products/getproperty/hooks/drill-smoke.sh`) checks the migration history and runs
  **`node dist/src/drill-smoke.js`** from the deployed api image against the restored database (isolated network,
  512 MB; D-248, T-15): `SMOKE migrations`, `rls_cross_tenant`, `freshness`, and — when the backup is this box's own
  environment (`DRILL_SAME_ENV=true`) — `owner_login` (SMS OTP through the HTTP surface), `cross_tenant_api` (404) and
  `billing_preview` (the current cycle of one property computed on the throw-away copy). Any `fail` fails the drill;
  the drill report records `rto_seconds` against the **30-min target** (the former 4 h stays the tolerated ceiling).
  Locally: `pnpm build && DATABASE_URL=<restored db> DRILL_SAME_ENV=true pnpm drill:smoke`.
- **PDPA after a restore**: data-subject erasures (anonymisation, destroyed tenant keys) executed after the restore
  point are re-applied from `platform.data_subject_request` before the restored database serves traffic; copies age
  out of pgBackRest within 35 days and of EBS snapshots within 7 days, so an erasure is complete everywhere within
  35 days.

## 10. Load expectations (R1)

`test/integration/load.int-spec.ts` (D-207): 300 meters, 300 occupied units. At the cut-off the closing 15-minute
readings go through the ingest pipeline and the October cycle is opened, computed and issued — asserted under 60 s
(measured in the sandbox: see the B6 entry of `docs/PROGRESS.md`). The day of 15-minute data before it is replayed
as a store-and-forward backfill and extrapolated to a month; the worker's IoT promotion is reported separately (it
runs concurrently on BullMQ in production, one job at a time in the in-memory test queue). If a real cycle gets
close to the budget: raise the worker's memory / concurrency in the product compose file, check PostgreSQL CPU, and
keep `readings.iot_promotion_minutes` at its default. Sizing: `docs/deployment.md` §6.

## 11. Client IP, proxies and session refresh (D-229)

The API uses the client IP for the per-IP auth / OTP throttle, the `/docs` allow-list, audit rows, session rows and the
e-signature evidence (D-062). It is Express `req.ip` with `trust proxy` = `trustProxy(TRUST_PROXY, TRUSTED_PROXY_CIDRS)`
(`src/common/http/trust-proxy.ts`):

- `X-Forwarded-For` is read **from the right**: the socket peer and the next `TRUST_PROXY − 1` entries are our own
  edge; `req.ip` is the next one. The left-most entries are whatever the caller sent and are never trusted.
- On the Collective platform (D-230) **Caddy is the one proxy**: for an internet client (outside its
  `trusted_proxies private_ranges`) it *replaces* `X-Forwarded-For` with the client address, so the API sees one hop:
  `TRUST_PROXY=1`. Never more than the real number of hops: one too many lets a caller choose its IP.
- `TRUSTED_PROXY_CIDRS=172.30.0.0/16`: the docker network `collective`, from which getproperty-web and
  getproperty-liff call `http://getproperty-api:3000`. A hop from there is trusted too, so the end-user address the
  BFF forwards becomes `req.ip`; an internet caller is never inside that network. Without this, every resident
  would share the BFF's address and one throttle bucket.
- The BFFs apply the same rule on their side: they take the entry `TRUSTED_HOPS` (=1, Caddy) from the right of the
  inbound header and forward that single address; they never forward the inbound header as is.
- **Smoke check on the box** (UNVERIFIED until the first uat deploy; LAUNCH-CHECKLIST §3), SSM session:
  1. From your laptop, a deliberately failed staff sign-in with a spoofed header:
     `curl -s -H 'X-Forwarded-For: 6.6.6.6' -H 'Content-Type: application/json' -d '{"email":"smoke@example.invalid","password":"x"}' https://<API_HOST>/v1/auth/operator/login` (401 expected, audited `auth.login_failed`)
  2. On the box (SSM session):
     `docker exec platform-postgres-1 psql -U postgres -d getproperty -Atc "SELECT action, ip FROM platform.audit_log ORDER BY occurred_at DESC LIMIT 3"`
     — the `ip` is your laptop's public address, never `6.6.6.6` and never `172.30.x.x`.
  3. Sign in through the LIFF app on a phone (mobile data) and check the newest `platform.auth_session.ip` is the
     phone's public address, not the liff container's `172.30.x.x`.

**Refresh rotation grace** (`REFRESH_REUSE_GRACE_SECONDS`, default 30, 0 = off): the immediately previous refresh token
presented again within the window — two instances of a BFF refreshing the same session at once — answers the **same**
successor refresh token (derived with `FIELD_HASH_KEY`, never stored in clear) and a fresh access token; audited
`auth.refresh_grace_reused`. After the window, or once the successor itself was used, it is reuse: the family is
revoked (`auth.refresh_reuse_detected`, D-163). A burst of `auth.refresh_grace_reused` from one family with different
user agents / IPs is worth a look (stolen token racing the owner). Rotating `FIELD_HASH_KEY` makes in-flight graces
count as reuse for at most the window.

## 12. PDF rendering (D-236, D-242, ADR-0012)

- Now: `PDF_RENDERER_MODE=real` — the worker's own Chromium (1.5 GB worker). Check: an invoice issued in the owner
  console gets its PDF within a minute (`documents` subscriber), Thai text renders (Sarabun).
- Switch to the shared queue when getpack's `pdf-render` consumer runs on the box (`docs/pdf-render-queue.md` §6):
  collective-infra `platform/env/<env>.env` → `GETPROPERTY_PDF_RENDERER_MODE=queue`, `GETPROPERTY_WORKER_MEMORY=512M`,
  `PDF_RENDER_REDIS_URL` in the product secret; deploy; issue one invoice (A4) and one receipt (80 mm) on uat and
  compare them with the `real` output; then a follow-up release removes Chromium from the image (T-1, T-11).
- A render that fails is retried by the subscriber; `PdfRenderError: … does not match the result` means the object in
  `tmp/pdf-render/` was overwritten or truncated — look at the getpack worker.

## 13. Provider credentials (D-240)

- Entered by a platform admin with `admin.provider_credential.manage`: `POST /v1/admin/provider-credentials`
  `{ tenantId | null, kind: payment|lock|etax, provider, merchantRef (payments), values: {…}, reason }`. Values are
  write-only; the list shows key names, a fingerprint and the last 4 characters of the merchant reference. Every
  decrypt by an adapter is an audit row `provider_credential.decrypted`.
- Rotation: post the new values (the old row is revoked in the same transaction). A leak: `…/{id}/actions/revoke` at
  once, then set the new key; QR codes, lock syncs or e-Tax submissions fail until then.
- Migration from the former Secrets Manager sub-paths (once per environment): run
  `node dist/src/credentials-import.js` in the api image with the normal env plus `PAYMENTS_SECRETS_PREFIX`,
  `LOCKS_SECRETS_PREFIX`, `ETAX_SECRETS_PREFIX` (SSM Run Command, `docker compose run --rm api node
  dist/src/credentials-import.js`); it reports `imported / already in the database / not found`; then delete the
  sub-path secrets and the three prefix lines from the product compose file (collective-infra).

## 14. Cross-product integration events (D-247)

- Outbound: `bridge.integration_event` rows go to the partner configured by `INTEGRATION_<GETBUILD|GETPACK>_TRANSPORT`
  (`none` until the partner consumes them). `failed` rows retry with backoff (30 s → 4 h); `dead` after a permanent
  refusal (4xx) or 12 attempts — fix the cause, then set the row back to `pending` (SQL as `gp_platform`, audited
  ticket) so the job resends it; partners dedupe on the idempotency key.
- Inbound: `POST /webhooks/integration/<platform>`; a burst of 401 = keys out of step (`INTEGRATION_<P>_VERIFY_KEYS`
  must contain the partner's current signing key — rotate by adding the new key on the receiver first, then switching
  the sender).

## 15. Telemetry growth and the DB box (D-241)

- Watch getproperty's database size and the box's `/data` in Grafana; **trigger**: database > 100 GB **or** `/data` >
  70 % → plan the move to a separate DB box within a quarter (collective-infra, locked decision 2); `/data` 120 → 250 GB
  is planned for 2027-09-01 (A-2).
- Volumes: raw points 24 months (compressed after 30 days on TimescaleDB), 15-minute series computed from them,
  hourly / daily rollups 5 years, health samples 6 months (no per-meter array), dedup marks 90 days.


## Switching off subscriptions (D-250, B7.0)

getproperty is free for operators. `platform.subscriptions.enabled` (platform setting, seeded `false`) gates the D-204
lifecycle: while it is false the hourly `platform-subscriptions` job does nothing and `POST /v1/admin/subscriptions`
answers `409 subscription.disabled`. HaaS assets, field work and platform invoices are untouched.

Once per environment that already has subscriptions (UAT), close them without deleting anything and give suspended
tenants their write access back:

```sql
BEGIN;
UPDATE platform.subscription
   SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'pricing_model_changed (D-250)'
 WHERE state IN ('trial', 'active', 'past_due', 'suspended');
UPDATE core.tenant SET status = 'active' WHERE status = 'read_only';
COMMIT;
```

Then restart the API (the access cache reloads) — or wait for its TTL.
