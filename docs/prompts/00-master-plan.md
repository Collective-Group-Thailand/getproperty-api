# 00 — Master Plan (backend): getproperty-api

> อ่านไฟล์นี้และ `docs/decisions.md` ก่อนทุก session แล้วเปิด prompt ของ deliverable ที่ได้รับมอบหมาย
> Repo นี้คือ backend อย่างเดียว · frontend คือ `getproperty-web` · gateway agent คือ `getproperty-edge` · ข้อตกลง API ร่วม: `docs/contract/api-conventions.md` · โปรโตคอลอุปกรณ์: `docs/contract/device-protocol.md`

---

## 1. Product
**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย**, operated by **Collective Group (Thailand)** (D-001). A multi-tenant SaaS for Thai apartment owners (D-010) whose single promise is **zero-touch billing** (D-011) and whose sales argument is the **utility loss** it makes visible and recoverable (D-032). Software-only (Lite) or with platform-owned IoT hardware as a service (Smart, D-080).

```
Platform admin: tariffs (MEA/PEA/MWA/PWA versions) · price plans · orgs & subscriptions · device fleet & OTA · support grants
Owner:  org → properties → floors → rooms → leases (สคบ. standard contract, e-sign) → deposit
        ↓
Edge:   meters (Modbus / pulse / LoRaWAN) → gateway (store-and-forward) → MQTT → ingest → readings (cumulative registers)
        staff PWA: OCR / manual readings with photo when no IoT · installs · move-in/out inspections
        ↓
Billing cycle (cut-off per property) → bill lines at ≤ tariff cap → bill issued (immutable, snapshot) → LINE Flex + PDF
        ↓
Tenant (LINE Mini App): sees bill + Thai QR → bank webhook confirms → receipt issued → arrears/reminders otherwise
        ↓
Owner dashboard: income, arrears, occupancy, utility loss % and suspects · exports (FlowAccount / PEAK / Excel)
R2: maintenance, smart locks (access follows the lease), parcels & announcements, e-Tax, TM30, 6 languages, anomaly alerts
R3: vacancy listing & booking, embedded insurance, equipment leasing
```

## 2. System context
```
getproperty-web (Next.js 16, one app: owner / tenant / staff / admin zones, BFF with httpOnly cookies)
        │ Bearer JWT (audiences org | tenant | platform)
        ▼
getproperty-api (this repo, NestJS 12)
  HTTP process    src/main.ts      /v1/auth /v1/owner /v1/tenant /v1/staff /v1/admin /v1/device /webhooks /health /docs
  Worker process  src/worker.ts    outbox relay, BullMQ consumers, billing cycles, reminders, documents (PDF), health rules, analytics rollups
  Ingest process  src/ingest.ts    MQTT subscriber (EMQX shared subscription) → validate → dedup → readings + telemetry hypertables → events
        │                                   ▲
PostgreSQL 18 + TimescaleDB · Redis · S3 · SES · EMQX (MQTT) · payment/bank QR adapter · slip-verify adapter
LINE Messaging API + LIFF + LINE Login · SMS OTP · OCR (vision) adapter · TTLock / Tuya (R2) · e-Tax provider (R2)
                                            │ MQTT over TLS, mTLS
                                   getproperty-edge (gateway agent in each building)
```
- Backend is cookie-agnostic: tokens in response bodies (contract §4). Page-shaped read endpoints (`/v1/owner/dashboard`, `/v1/tenant/home`) reuse domain services.
- One Docker image, three processes (`main`, `worker`, `ingest`). Scheduled work = BullMQ repeatable jobs in the worker (exactly-once across replicas). The ingest process is horizontally scalable through EMQX shared subscriptions (`$share/ingest/gp/v1/+/telemetry`).
- Artefacts shared with other repos: `contract/openapi.json` (web) and `contract/device-protocol.json` (edge).

## 3. Platform baseline
Node 24 LTS · pnpm · TypeScript 6 strict · **NestJS 12** · ESLint flat + Prettier · **PostgreSQL 18 + TimescaleDB** (ADR-0001; `timescale/timescaledb-ha:pg18` in Testcontainers) · Prisma (current major; `prisma.config.ts`, multi-file schema `prisma/schema/*.prisma`; hypertables and continuous aggregates created in raw SQL migrations) · BullMQ + Redis · MQTT.js + EMQX · AWS SDK v3 · Puppeteer (PDF, embedded Thai fonts) · exceljs · sharp · class-validator + `@nestjs/swagger` DTOs · `@scalar/nestjs-api-reference` · pino + OpenTelemetry + Sentry · Terminus health · helmet + throttler · nestjs-i18n (th default, en; tenant strings my/km/lo/zh in R2) · Testcontainers (postgres, redis, emqx) · supertest. Same tooling, lint config, documentation decorators and CI shape as `getpack-api`.

## 4. Module map (`src/modules/*`)
| Context | Modules | Prompt |
|---|---|---|
| Platform | `auth`, `iam` (roles, permissions, org scopes, support grants), `orgs` (tenancy root, org settings, company data, bank account with OTP-confirmed changes), `settings` (platform + org, typed, effective-dated, audited), `feature-flags`, `files`, `audit`, `domain-events`/`outbox`, `notifications` (LINE push, SMS, email, in-app, web push), `realtime`, `privacy` (consent purposes, DSR, retention), `tariffs` (platform-maintained MEA/PEA/MWA/PWA versions, D-021) | B1 |
| Property & lease | `properties` (buildings, floors, rooms, room types, amenities, common-area meters), `leases` (standard contract templates, lease lines, co-tenants, e-sign, renewals, 30-day notice, termination), `deposits` (receipt, settlement with 7-day clock, damage items with evidence, refund), `inspections` (move-in/out checklists with photos, comparison), `tenants` (persons, documents, LINE linking, invitations) | B2 |
| Metering & IoT | `devices` (registry, provisioning codes, bindings, meter swaps, fleet views, OTA rings), `ingest` (MQTT consumer, validation, dedup, telemetry hypertables), `readings` (cumulative registers from any source, OCR review queue, plausibility), `meter-health` (stale/silent rules, auto-tickets), `utility-invoices` (owner-entered MEA/PEA/MWA/PWA invoices → loss computation), `energy-insight` (R2: daily usage, anomalies, forecasts) | B3 |
| Billing & money | `billing` (cycles, cut-off selection, estimates, bill computation with the **compliance engine**, issue, void → credit/debit notes), `compliance` (rule registry with legal refs, tests), `payments` (QR per bill via gateway adapter, webhooks, slip fallback & review queue, partial payments, allocation), `receivables` (balances, arrears, aging, reminders, late fee policy), `documents` (numbering series, PDF rendering, LINE Flex, receipts, tax invoices, deposit statements, contracts), `exports` (FlowAccount / PEAK / Excel, VAT working figures) | B4 |
| Operations | `maintenance` (tickets, categories, SLA, assignment, ratings, auto-tickets), `access` (TTLock/Tuya adapters, credentials follow the lease, unlock logs), `community` (announcements with read receipts, parcels, building rules, contacts), `staff-tasks` (reading rounds, install work orders, inspections queue) | B5 |
| Platform business & launch | `subscriptions` (price plans, org subscription lifecycle, room counting, platform invoices & receipts, HaaS asset register), `etax` (provider adapter, R2), `tm30` (data pack, R2), `analytics` (platform KPIs, pilot KPIs D-083, org benchmarks anonymised k ≥ 5), `support` (grants, impersonation-free read access, audit), launch readiness | B6 |

Integrations (`src/integrations/*`, each with timeout, retry/backoff, circuit breaker and an in-memory fake used by tests and `pnpm dev`): s3, ses, sms-otp (ThaiBulkSMS-class), line-messaging, line-login/liff, payment-qr (`QrPaymentAdapter`: KBank / SCB / Opn — O-001), slip-verify, ocr-vision, mqtt (EMQX client + ACL sync), lock-vendors (TTLock, Tuya — B5), etax-provider (B6), geocoding (optional).

## 5. Data-model principles
- snake_case, `bigint identity` PKs, `uuid` public ids, `timestamptz`, `numeric(14,2)` money, `numeric(12,3)` meter quantities, Postgres enums for closed sets, FKs + check constraints, `jsonb` for snapshots, `created_by/updated_by`, soft delete only where a decision needs it.
- **`org_id` on every business table** (D-004) with composite indexes `(org_id, …)`; `property_id` on everything below a property; row-level isolation in repositories (contract §8) and a Postgres RLS policy as a second line of defence for the reporting role.
- **Readings vs telemetry**: `readings` (one row per accepted cumulative register reading, the billing source of truth) is a normal table; `telemetry_points` is a TimescaleDB hypertable with continuous aggregates (`15m`, `1h`, `1d`) used only for insight and loss analysis (D-030).
- **Effective-dated configuration**: platform settings, org settings, tariffs, price plans, health rules, reminder schedules — versioned rows with `effective_from`, never updated in place; bills snapshot what they used (D-040).
- **Immutable financial documents**: bills, receipts, credit/debit notes, deposit statements have gapless per-org series and append-only triggers; corrections by new documents only.
- Domain events + transactional outbox from B1; every notification, document, reminder, analytics fact and lock-credential change is a subscriber.

## 6. Run order (backend)
| Step | Prompt | Output |
|---|---|---|
| B1 | `B1-foundation.md` 1.1 → 1.3 | scaffold, CI, contract pipeline, 3 processes; schema design (review gate); auth (OTP, LINE, platform TOTP, device bootstrap), IAM & org scoping, orgs, settings, tariffs, outbox, notifications, files, audit, privacy |
| B2 | `B2-property-lease.md` 2.1 → 2.4 | properties & rooms; tenants & invitations; leases, standard contract & e-sign; deposits & inspections |
| B3 | `B3-metering-iot.md` 3.1 → 3.4 | device registry & provisioning & config push; MQTT ingest & telemetry; readings from all sources (OCR queue); meter health & utility invoices & loss |
| B4 | `B4-billing-payments.md` 4.1 → 4.5 | compliance engine; billing cycles & bills; documents & numbering & PDF/Flex; payments (QR, webhooks, slips) & receipts; receivables, reminders & exports |
| B5 | `B5-operations.md` 5.1 → 5.4 | maintenance; access control; community; staff tasks |
| B6 | `B6-platform-launch.md` 6.1 → 6.5 | subscriptions & HaaS; e-Tax & TM30; analytics & pilot KPIs; support & platform admin; launch readiness & gateway simulator |
R1 = B1–B4 + B6.1/6.4/6.5. B3 and B4 may run in parallel after B2.1 (readings and bills meet at 4.2). B5 and B6.2/6.3 are R2.

## 7. Definition of Done (every deliverable)
- Lint, typecheck, unit, integration (Testcontainers), e2e green; ≥ 80 % coverage on services with business rules; **golden tests for the billing engine** (fixtures per tariff version, pro-rata, estimates, credit notes) and property tests for money rounding and reading monotonicity.
- Every compliance rule (D-020–D-025) has a test that proves the refusal and the legal reference string.
- Tenancy tests: every new endpoint has a cross-org `404` test.
- Contract regenerated and committed; `pnpm contract:lint` green; no unintended breaking diff.
- Every configurable value is a setting with effective date + audit + permission (decision id in a code comment).
- Events recorded for every state change; subscribers idempotent.
- `docs/PROGRESS.md` entry: done, decisions implemented (D-###), deviations, open questions (as `O-###` in `decisions.md`).

## 8. ADRs
0001 PostgreSQL 18 + TimescaleDB for telemetry · 0002 Three repositories and the shared contracts · 0003 Auth audiences & tokens (org, tenant, platform, device) · 0004 Effective-dated configuration & platform tariffs · 0005 Readings vs telemetry (cumulative-register billing) · 0006 MQTT device protocol & store-and-forward · 0007 Compliance rule engine · 0008 Payment adapters and the no-funds-held model. B1.1 writes 0001–0004; B3.1 writes 0005–0006; B4.1 writes 0007–0008.
