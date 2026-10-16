# 00 — Master Plan (backend): getproperty-api

> อ่านไฟล์นี้และ `docs/decisions.md` ก่อนทุก session แล้วเปิด prompt ของ deliverable ที่ได้รับมอบหมาย
> Repo นี้คือ backend อย่างเดียว · หน้าเว็บคือ `getproperty-web` · LINE Mini App คือ `getproperty-liff` · gateway agent คือ `getproperty-edge` · asset core (schema `core` + migrations + event contracts) คือ package `collective-asset-core` · ข้อตกลง API ร่วม: `docs/contract/api-conventions.md` · โปรโตคอลอุปกรณ์: `docs/contract/device-protocol.md` · ฐานข้อมูล: `docs/schema-design.md` (v2)
> คำศัพท์ (D-151): **tenant** = องค์กรลูกค้า SaaS เท่านั้น · ผู้เช่า/เจ้าของร่วม/ช่าง = **party** · ผู้อยู่อาศัย = audience **resident** · คนทำงานให้ tenant = audience **operator**

---

## 1. Product
**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย**, operated by **Collective Group (Thailand)** (D-001). Collective Group's **Building Operations platform** (D-150) for four tenant types on one neutral core — `apartment` (first customer, Phase 1), `condo_juristic`, `pm_company`, `landlord` — and 12 modules in groups A (operations base: lease & occupant, billing & accounting, smart meter & utility billing, service request & maintenance), B (condo juristic), C (smart building & portfolio), D (bridges to getbuild/getpack). **Phase 1 = group A for the first apartment** (Feb 2027): the promise is **zero-touch billing** (D-011) and the sales argument is the **utility loss** made visible (D-032). Pricing per D-156 (Apartment Starter / Smart, hardware sold or rented). Groups B–D are designed-for, not built (schema-design v2 §3.7).

```
Platform admin: tenants (type, plan, import) · utility tariffs (MEA/PEA/MWA/PWA versions) · price plans · subscriptions · device inventory & OTA · support grants · AI usage cost (D-161)
Operator (owner console): tenant → property → building → floor → unit · parties · leases (สคบ. standard contract, e-sign) → deposit · rate plans
        ↓
Edge:   meters (Modbus / pulse / LoRaWAN) → gateway (store-and-forward) → MQTT → ingest → smart.meter_reading (cumulative registers)
        staff PWA: OCR / manual readings with photo when no IoT · installs · move-in/out inspections
        ↓
Billing cycle (cut-off per property) → invoice lines from rate plans (warn + acknowledge above the utility rate, D-021a) → invoice issued (immutable, snapshot) → LINE Flex + PDF
        ↓
Resident (getproperty-liff): sees invoice + Thai QR → bank webhook confirms → receipt issued → reminders otherwise
        ↓
Owner dashboard: income, arrears, occupancy, utility loss % and suspects · exports (FlowAccount / PEAK / Excel)
R2: service requests & work orders (technician LIFF), smart locks (access follows the lease), parcels, announcements, facility booking, e-Tax, TM30, 6 languages, anomaly alerts
Phase 2+: condo juristic (B1–B3), PM portfolio (C3), access/energy (C1/C2), post-sale portal & landlord tier (D1/D2) — on the same core, no migration of group A tables
```

## 2. System context
```
getproperty-web  (Next.js 16: owner console, staff PWA, platform admin; BFF)   ── Bearer JWT aud operator | platform
getproperty-liff (LINE Mini App: residents, technicians, landlords; BFF)        ── Bearer JWT aud resident | technician
        ▼
getproperty-api (this repo, NestJS 12)
  HTTP process    src/main.ts      /v1/auth /v1/owner /v1/staff /v1/resident /v1/technician /v1/admin /v1/device /webhooks /health /docs
  Worker process  src/worker.ts    outbox relay, BullMQ consumers, workflow timers, billing cycles, reminders, documents (PDF), health rules, integration events, analytics rollups
  Ingest process  src/ingest.ts    MQTT subscriber (EMQX shared subscription) → validate → dedup → smart.meter_reading + telemetry hypertables → events
        │                                   ▲
PostgreSQL 18 + TimescaleDB (schemas core · platform · ops · smart · bridge · juristic) · Redis · object storage · email · EMQX (MQTT)
payment/bank QR adapter · slip-verify adapter · LINE Messaging API + LIFF + LINE Login · SMS OTP · OCR (vision) adapter · TTLock / Tuya (R2) · e-Tax provider (R2)
getbuild / getpack ◀── integration events (Pub/Sub + REST callback, zod contracts from collective-asset-core) ──▶ bridge.integration_event
                                            │ MQTT over TLS, mTLS
                                   getproperty-edge (gateway agent in each building)
```
- Backend is cookie-agnostic: tokens in response bodies (contract §4). Page-shaped read endpoints (`/v1/owner/dashboard`, `/v1/resident/home`) reuse domain services.
- One Docker image, three processes (`main`, `worker`, `ingest`). Scheduled work = BullMQ repeatable jobs in the worker (exactly-once across replicas). The ingest process is horizontally scalable through EMQX shared subscriptions (`$share/ingest/gp/v1/+/telemetry`).
- Artefacts shared with other repos: `contract/openapi.json` (web, LIFF) and `contract/device-protocol.json` (edge). The `core` schema and the integration event contracts come **into** this repo from `collective-asset-core`.
- **Deployment (D-160):** GCP — Cloud Run for api/web/liff (the `worker` and `ingest` processes as Cloud Run services/jobs), GKE Autopilot for EMQX, Cloud SQL (PostgreSQL 18; TimescaleDB availability is O-005), GCS, Memorystore (Redis), Terraform + the getpack CI shape; environments dev / uat / prod. The AWS-flavoured adapters from B1.1 (S3, SES, Secrets Manager) stay behind their ports; GCS / email / Secret Manager adapters arrive in B6.5 — not a Phase 1 blocker. Optional per-building edge box (Docker Compose on a mini PC) runs `getproperty-edge`.

## 3. Platform baseline
Node 24 LTS · pnpm · TypeScript 6 strict · **NestJS 12** · ESLint flat + Prettier · **PostgreSQL 18 + TimescaleDB** (ADR-0001; `timescale/timescaledb-ha:pg18` in Testcontainers) · **`collective-asset-core`** (core schema migrations + Prisma fragment + zod contracts, ADR-0010) · Prisma (current major; `prisma.config.ts`, multi-file schema `prisma/schema/*.prisma` with `multiSchema`; hypertables, RLS, triggers and continuous aggregates in raw SQL migrations) · BullMQ + Redis · MQTT.js + EMQX · object storage behind a port (S3 now, GCS in B6.5) · Puppeteer (PDF, embedded Thai fonts) · exceljs · sharp · class-validator + `@nestjs/swagger` DTOs · `@scalar/nestjs-api-reference` · pino + OpenTelemetry + Sentry · Terminus health · helmet + throttler · nestjs-i18n (th default, en; resident strings my/km/lo/zh in R2) · Testcontainers (postgres, redis, emqx) · supertest. Same tooling, lint config, documentation decorators and CI shape as `getpack-api`.

## 4. Module map (`src/core/*`, `src/modules/*`)
Nest module boundaries follow the blueprint so modules can be split into services or packages later. `core/*` = shared platform services; `modules/<group>-<area>` = business modules, one per schema group.

| Area | Modules | Schema | Prompt |
|---|---|---|---|
| Platform core | `core/identity` (auth: OTP, LINE, platform TOTP, device bootstrap; sessions), `core/tenancy` (tenants, memberships, RBAC, support grants, tenant context + RLS session), `core/asset` (property → building → floor → unit, party, ownership, occupancy, asset items, meter assignments, access grants — over the `collective-asset-core` tables), `core/settings` (platform/tenant/property, effective-dated), `core/feature-flags`, `core/documents` (files, presign, scan, retention), `core/audit`, `core/events` (domain events + outbox), `core/notifications` (LINE, SMS, email, in-app, web push), `core/realtime`, `core/privacy` (consents, DSR, retention), `core/compliance` (rule registry, evaluations, acknowledgements), `core/workflow` (state machines + SLA timers, D-159), `core/utility-tariffs` (platform-maintained MEA/PEA/MWA/PWA versions) | `core` (package), `platform`, `ops.workflow_*` | B1 |
| A1 Lease & occupant | `modules/ops-units` (unit board, unit profiles, utility accounts), `modules/ops-parties` (residents, occupant profiles, LINE linking, invitations), `modules/ops-leases` (standard contract templates, lease lines, co-tenants, e-sign, renewals, 30-day notice, termination), `modules/ops-deposits` (receipt, settlement with 7-day clock, damage items with evidence, refund), `modules/ops-inspections` (move-in/out checklists with photos) | `core`, `ops` | B2 |
| A3 Smart meter & utility billing | `modules/smart-devices` (registry, provisioning, meter channels, swaps, fleet views, OTA rings), `modules/smart-ingest` (MQTT consumer, validation, dedup, telemetry hypertables), `modules/smart-readings` (cumulative registers from any source, OCR review queue, plausibility, reading batches), `modules/smart-meter-health` (stale/silent rules), `modules/ops-utility-loss` (owner-entered utility invoices → loss reports) | `smart`, `ops` | B3 |
| A2 Billing & accounting | `modules/ops-billing` (rate plans, cycles, cut-off selection, estimates, invoice computation with the compliance engine, issue, void → credit/debit notes), `modules/ops-payments` (QR per invoice via gateway adapter, webhooks, slip fallback, partial payments, allocation, receipts, tax invoices), `modules/ops-receivables` (balances, aging, dunning-light reminders, penalties), `modules/ops-documents` (numbering series, PDF rendering, LINE Flex), `modules/ops-exports` (FlowAccount / PEAK / Excel, VAT working figures) | `ops`, `platform` | B4 |
| A4 Service & community (R2) | `modules/ops-service` (service requests, work orders, categories, SLA via workflow, ratings, auto-requests from meter health, warranty hook → `bridge`), `modules/smart-access` (TTLock/Tuya, credentials follow the lease, access events), `modules/ops-community` (announcements, parcels, facility booking, building rules, contacts), `modules/ops-staff-tasks` | `ops`, `smart` | B5 |
| Platform business & launch | `modules/platform-subscriptions` (price plans D-156, subscriptions, unit counting, platform invoices, HaaS assets), `modules/ops-etax`, `modules/ops-tm30`, `modules/platform-analytics` (KPIs, pilot KPIs D-083, benchmarks), `modules/platform-support` (grants, tenant onboarding, AI usage cost D-161), `modules/bridge-integration` (integration event inbox/outbox, D-153 contracts; consumers arrive with D1/D2), launch readiness | `platform`, `ops`, `bridge` | B6 |
| Later (designed-for only) | `modules/juristic-*` (B1 AGM & e-voting, B2 AI juristic assistant, B3 asset/sinking fund/inspection), `modules/smart-access` (C1 full), `modules/smart-energy` (C2), `modules/ops-portfolio` (C3 PM back-office), `modules/bridge-post-sale` (D1), `modules/bridge-landlord` (D2), `ai/gateway` | `juristic`, `smart`, `ops`, `bridge` | Phase 2–4 |

Integrations (`src/integrations/*`, each with timeout, retry/backoff, circuit breaker and an in-memory fake used by tests and `pnpm dev`): object storage (s3 → gcs), email (ses → GCP-equivalent), secrets, sms-otp (ThaiBulkSMS-class), line-messaging, line-login/liff, payment-qr (`QrPaymentAdapter`: KBank / SCB / Opn — O-001), slip-verify, ocr-vision, mqtt (EMQX client + ACL sync), lock-vendors (TTLock, Tuya — B5), etax-provider (B6), integration-bus (Pub/Sub + REST callback for getbuild/getpack), geocoding (optional).

## 5. Data-model principles (details: `docs/schema-design.md` v2)
- **Schemas** (D-152): `core` (asset core, tenancy, identity, party — migrations owned by `collective-asset-core`, run first), `platform`, `ops` (group A), `smart` (group C + A3 devices/readings), `bridge` (integration events, later D1/D2), `juristic` (empty until Phase 2/3).
- Singular snake_case table names, `id uuid` (UUIDv7) primary keys, `timestamptz`, `numeric(14,2)` money, `numeric(12,3)` meter quantities, Postgres enums for every status and for `tenant.type`, `unit.type`, `invoice_line.source_type`; FKs + check constraints, `jsonb` for snapshots and rate-plan tiers; `created_at/updated_at/created_by`, `deleted_at` only where soft delete applies.
- **`tenant_id` on every row** with composite indexes `(tenant_id, …)`; `building_id` on everything below a building. Row-level security on `app.tenant_id` for the application role, widened by building owner/operator and `core.asset_access_grant` (D-152). Repository filters stay as the first line.
- **Party ≠ user**: people are `core.party` rows related to units by `unit_ownership`, `occupancy` and `ops.lease`; logins are `core.user_account`.
- **Readings vs telemetry**: `smart.meter_reading` (one row per accepted cumulative register reading, the billing source of truth) is a normal table; `smart.telemetry_point` is a TimescaleDB hypertable with continuous aggregates (`15m`, `1h`, `1d`) used only for insight and loss analysis (D-030).
- **Effective-dated configuration**: platform/tenant/property settings, utility tariffs, rate plans, price plans, health rules, reminder schedules — versioned rows with `effective_from`, never updated in place; invoices snapshot what they used (D-040).
- **Immutable financial documents**: invoices, receipts, tax invoices, credit/debit notes, deposit statements have gapless per-tenant series and append-only triggers; corrections by new documents only.
- Domain events + transactional outbox from B1; every notification, document, reminder, analytics fact, lock-credential change and integration event is a subscriber. Things with an SLA or a clock carry a `ops.workflow_instance` (D-159).

## 6. Run order (backend)
| Step | Prompt | Output |
|---|---|---|
| B1 | `B1-foundation.md` 1.1 → 1.3 | scaffold, CI, contract pipeline, 3 processes ✅; schema lock (v2) ✅; `collective-asset-core` v0.1.0 + platform/ops/smart/bridge foundation migrations; identity, tenancy & RLS, asset core services, settings, utility tariffs, outbox, notifications, documents, audit, privacy, compliance acknowledgements, **workflow engine** |
| B2 | `B2-property-lease.md` 2.1 → 2.4 | properties, buildings, floors, units; parties & invitations; leases, standard contract & e-sign; deposits & inspections |
| B3 | `B3-metering-iot.md` 3.1 → 3.4 | device registry & provisioning & meter assignment & config push; MQTT ingest & telemetry; meter readings from all sources (OCR queue); meter health & utility invoices & loss |
| B4 | `B4-billing-payments.md` 4.1 → 4.5 | compliance engine; rate plans, billing cycles & invoices; documents & numbering & PDF/Flex; payments (QR, webhooks, slips), receipts & tax invoices; receivables, reminders & exports |
| B5 | `B5-operations.md` 5.1 → 5.4 | service requests & work orders (technician LIFF API); access control; community (announcements, parcels, facility booking); staff tasks |
| B6 | `B6-platform-launch.md` 6.1 → 6.5 | subscriptions (D-156 pricing) & HaaS; e-Tax & TM30; analytics & pilot KPIs; platform admin, tenant onboarding, support & AI usage cost; launch readiness, GCP adapters & gateway simulator |
R1 = B1–B4 + B6.1/6.4/6.5. B3 and B4 may run in parallel after B2.1 (readings and invoices meet at 4.2). B5 and B6.2/6.3 are R2 (maintenance stays R2, D-150).

## 7. Definition of Done (every deliverable)
- Lint, format, typecheck, unit, integration (Testcontainers), e2e green; ≥ 80 % coverage on services with business rules; **golden tests for the billing engine** (fixtures per utility tariff version and rate plan, pro-rata, estimates, credit notes) and property tests for money rounding and reading monotonicity.
- Every compliance rule (D-020–D-025, D-021a) has a test that proves the refusal or warning and the legal reference string.
- Tenancy tests: every new endpoint has a cross-tenant `404` test, and every new table an RLS test (row invisible with another `app.tenant_id`; visible through an active `asset_access_grant` where the module allows it).
- No `core.*` DDL in this repo; core changes are a `collective-asset-core` release.
- Contract regenerated and committed; `pnpm contract:lint` green; no unintended breaking diff.
- Every configurable value is a setting with effective date + audit + permission (decision id in a code comment).
- Events recorded for every state change; subscribers idempotent.
- `docs/PROGRESS.md` entry: done, decisions implemented (D-###), deviations, open questions (as `O-###` in `decisions.md`).

## 8. ADRs
0001 PostgreSQL 18 + TimescaleDB for telemetry · 0002 Repositories and the shared contracts · 0003 Auth audiences & tokens (operator, resident, technician, platform, device) · 0004 Effective-dated configuration & platform tariffs · 0005 Readings vs telemetry (cumulative-register billing) · 0006 MQTT device protocol & store-and-forward · 0007 Compliance rule engine · 0008 Payment adapters and the no-funds-held model · 0009 Platform blueprint: tenant types, neutral asset core, schemas · 0010 `collective-asset-core` as a separate package. B1.1 wrote 0001–0004; the schema lock wrote 0009–0010 and amended 0001–0004; B3.1 writes 0005–0006; B4.1 writes 0007–0008.

## 9. Repositories
| Repo | Role |
|---|---|
| `getproperty-api` | this repo — NestJS backend, owner of `contract/openapi.json` and `contract/device-protocol.json` |
| `getproperty-web` | Next.js: owner console (PM/landlord portfolio views later), staff PWA, platform admin |
| `getproperty-liff` | LINE Mini App: residents (invoices/pay, service requests, lease, announcements, parcels), technicians (my work orders), landlords (D-154) |
| `getproperty-edge` | gateway agent (MQTT, drivers, store-and-forward) |
| `collective-asset-core` | private npm package: `core` schema migrations, Prisma fragment, zod integration contracts, grant rules (D-153, ADR-0010) |
| `getproperty-ai-workers` | Python workers (OCR, STT, forecast, RAG) — Phase 2 |
| `collective-shared` | auth, LINE, notification, billing types, UI kit extracted from getpack later (D-155) — not a Phase 1 dependency |
