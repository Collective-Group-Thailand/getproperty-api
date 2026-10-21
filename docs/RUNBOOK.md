# getproperty-api — Runbook (R1)

Operating the API, worker and ingest processes on GCP (D-160). Audience: the on-call engineer and Collective
Group's platform admins. Every action here that touches tenant data is audited; never paste secrets, OTPs,
national ids or bank data into tickets, chat or logs.

> Status: written with B6.5 before the first production deployment. Steps marked **UNVERIFIED** have not been run
> against the live environment yet; tick them in `docs/LAUNCH-CHECKLIST.md` when they have.

## 1. System map

| Process | Cloud Run service | Role | Scales on |
|---|---|---|---|
| API | `gp-<env>-api` | `/v1/*`, `/webhooks/*`, `/health`, `/docs` (allow-list) | requests (min 2 in prod) |
| Worker | `gp-<env>-worker` | BullMQ consumers + repeatable maintenance jobs (`src/worker.runner.ts`) | always on, 1–4 |
| Ingest | `gp-<env>-ingest` | MQTT shared subscription on EMQX → telemetry, health, readings | always on, 1–4 |
| Web | `gp-<env>-web` | owner console, staff PWA, platform admin (getproperty-web) | requests |
| LIFF | `gp-<env>-liff` | resident LINE Mini App (getproperty-liff) | requests |

Data stores: Cloud SQL PostgreSQL 18 (`gp-<env>-pg`, private IP, PITR), Memorystore Redis (BullMQ, locks, caches;
`noeviction`), GCS buckets `<project>-documents|exports|ota|archive` (private, signed URLs only), EMQX on GKE
Autopilot (`gp-<env>-emqx`). Infrastructure: `infra/terraform` (workspaces dev / uat / prod).

Configuration: environment variables (`src/config/env.schema.ts`, validated at boot — a bad value stops the process
before it serves) and Secret Manager secrets mounted as env vars. Business values are **settings**
(`platform.setting`, effective-dated, audited — ADR-0004), never env vars.

## 2. Deploy

1. CI is green on `main` (lint, typecheck, unit, e2e, integration with PostgreSQL 18, contract build + lint,
   build, `pnpm infra:lint`, `terraform validate`).
2. Images are built once and promoted by digest: dev → uat → prod.
3. **Migrations first**, as the migrator role, from a one-off Cloud Run job of the API image:
   `pnpm db:migrate` (Prisma migrate deploy of the SQL migrations under `prisma/migrations`). Migrations are
   additive; a destructive change ships in two releases (expand, then contract).
4. Deploy worker and ingest, then the API (new revision, 0 % traffic), smoke test the revision URL
   (`/health`, `/v1/public/plans`, an owner login on uat), then shift traffic 10 % → 100 %.
5. Watch for 30 minutes: 5xx rate, p95 latency, outbox lag (§6), queue depth, ingest dead letters.

**Rollback**: shift traffic back to the previous revision (seconds). Never roll back a migration; the previous
revision must work on the new schema (expand / contract rule). Worker/ingest: redeploy the previous digest.

## 3. Health and alerts

- `GET /health` — database, Redis, object storage, MQTT (fakes report `fake`). Cloud Run startup and liveness probes
  use it.
- Alerts (Cloud Monitoring → `alert_email`): uptime of `/health` on api/web/liff; 5xx > 1 % for 5 min; p95 > 1.5 s;
  outbox `pending` older than 5 min; dead letters > 0; BullMQ `failed` growing; Cloud SQL CPU > 80 % / storage >
  80 %; gateways offline > 10 % of a tenant (tenant health `gateways_offline`).
- Logs are JSON (pino) with `requestId`, `tenantId`, `actor` — never request bodies of auth, payments or webhooks.

## 4. Data protection and access

- **Support access into a tenant** needs a support grant approved by the tenant's Owner (D-090), time-boxed
  (`support.grant_max_hours`), every request audited (`support_grant.used`). Support is **read-only** inside the
  grant (`support.read_only` on any write); only a Platform admin may act, and that is audited as
  `support_grant.bypassed`. Incident grants without the Owner: `POST /v1/admin/support-grants/{id}/actions/approve-incident`
  (second platform admin), reason mandatory.
- **PDPA requests** (D-025): owners handle their tenants' requests in the owner console; platform-level requests are
  listed at `GET /v1/admin/data-subject-requests` with their due dates (`privacy.dsr_due_days`).
- **Secrets**: Secret Manager; rotate by adding a version and redeploying (env-mounted secrets resolve at start).
  Payment provider credentials live under `payments/<tenant|platform>/<provider>/<merchantRef>` (ids mapped to
  `--` separators on GCP). The tenant data keys are wrapped by `data-key-kek`; rotating the KEK re-wraps keys (no
  data re-encryption) — run it as a one-off job, never during billing.

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
| `telemetry-rollup` / `telemetry-partitions` | 1 min / 1 day | rollups and monthly partitions (D-184) | usage charts stale; ingest creates partitions on demand |
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
| Gateways offline | EMQX pods, LB address, cert expiry | `kubectl -n emqx get pods`; renew certs; gateways buffer locally (store and forward) |
| Billing cycle stuck | worker logs `billing-cycles`, readings review queue | finish reviews; the cycle resumes on the next tick |
| Database CPU high | Query Insights, long transactions | kill runaway export jobs; scale tier (terraform) |
| Data restore needed | PITR window (7 days) | clone to a new instance at the timestamp, export the rows, never restore over prod |

Post-incident: a short write-up in `docs/incidents/` (what, impact, timeline, fix, follow-ups) within 5 working days.

## 9. Backups and restore (UNVERIFIED until the drill in the launch checklist)

- Cloud SQL automated backups daily (30 kept) + PITR 7 days; GCS buckets `documents` and `ota` are versioned.
- Restore drill (quarterly): clone the instance to `gp-<env>-pg-restore` at a timestamp, point a uat API revision at
  it, run the smoke tests, delete the clone. Record the time it took (RTO target 4 h, RPO 15 min).

## 10. Load expectations (R1)

`test/integration/load.int-spec.ts` (D-207): 300 meters, 300 occupied units. At the cut-off the closing 15-minute
readings go through the ingest pipeline and the October cycle is opened, computed and issued — asserted under 60 s
(measured in the sandbox: see the B6 entry of `docs/PROGRESS.md`). The day of 15-minute data before it is replayed
as a store-and-forward backfill and extrapolated to a month; the worker's IoT promotion is reported separately (it
runs concurrently on BullMQ in production, one job at a time in the in-memory test queue). If a real cycle gets
close to the budget: scale the worker (`max_instances`), check Cloud SQL CPU, and keep `readings.iot_promotion_minutes`
at its default. Production sizing in `infra/terraform/locals.tf`.

## 11. Client IP, proxies and session refresh (D-229)

The API uses the client IP for the per-IP auth / OTP throttle, the `/docs` allow-list, audit rows, session rows and the
e-signature evidence (D-062). It is Express `req.ip` with `trust proxy` = `trustProxy(TRUST_PROXY, TRUSTED_PROXY_CIDRS)`
(`src/common/http/trust-proxy.ts`):

- `X-Forwarded-For` is read **from the right**. Every Google front end *appends* the address it saw, so the left-most
  entries are whatever the caller sent and are never trusted. The socket peer and the next `TRUST_PROXY − 1` entries
  are our own edge; `req.ip` is the next one.
- `TRUST_PROXY`: `1` when clients reach the `run.app` URL (Cloud Run front end only — the current Terraform), `2` when
  an external HTTPS load balancer (Cloud Armor) sits in front of the service. Never more than the real number of
  hops: one too many lets a caller choose its IP. **UNVERIFIED** against the live edge: on uat, call
  `GET /v1/public/plans` with `X-Forwarded-For: 6.6.6.6` and check the request log's `ip` is your own address.
- `TRUSTED_PROXY_CIDRS`: the addresses our BFFs (getproperty-web, getproperty-liff) reach the API from — the VPC
  subnet (Private Google Access to `run.app`) and the Cloud NAT address; Terraform sets both. A hop from there is
  trusted too, so the end-user address the BFF forwards becomes `req.ip`; a direct caller cannot pose as a BFF because
  its real address is appended after anything it sends. Without this, every resident would share the BFF's address
  and one throttle bucket.
- The BFFs apply the same rule on their side: getproperty-liff takes the entry `TRUSTED_HOPS` from the right of the
  inbound header (Cloud Run = 1) and forwards that single address; it never forwards the inbound header as is.

**Refresh rotation grace** (`REFRESH_REUSE_GRACE_SECONDS`, default 30, 0 = off): the immediately previous refresh token
presented again within the window — two instances of a BFF refreshing the same session at once — answers the **same**
successor refresh token (derived with `FIELD_HASH_KEY`, never stored in clear) and a fresh access token; audited
`auth.refresh_grace_reused`. After the window, or once the successor itself was used, it is reuse: the family is
revoked (`auth.refresh_reuse_detected`, D-163). A burst of `auth.refresh_grace_reused` from one family with different
user agents / IPs is worth a look (stolen token racing the owner). Rotating `FIELD_HASH_KEY` makes in-flight graces
count as reuse for at most the window.
