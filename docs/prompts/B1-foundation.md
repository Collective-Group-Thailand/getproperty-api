# B1 — Foundation

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/contract/device-protocol.md` ก่อน · ทำทีละ Deliverable (1.1 → 1.3) ต่อ 1 session · Plan Mode ทุกครั้ง
> Deliverable 1.2 มี **review gate**: หยุดหลังเขียน `docs/schema-design.md` เพื่อให้ผู้ใช้ตรวจก่อนเขียน migration
> ถ้ามี `../getpack-api` ให้ใช้เป็นตัวอย่าง convention (โครงสร้าง, decorators, CI, fakes) — ห้ามคัดลอก business logic (D-003)

---

You are a senior backend engineer building **`getproperty-api`**, the NestJS 12 backend of **getproperty** (Collective Group (Thailand)). This prompt builds everything later modules depend on. No business modules yet.

## Repository layout (target)
```
getproperty-api/
├─ src/
│  ├─ main.ts  worker.ts  ingest.ts  app.module.ts  worker.module.ts  ingest.module.ts
│  ├─ common/        guards (audience, permission, org-scope, support-grant), decorators (@CurrentActor, @Can, @Public, @OrgScoped),
│  │                 problem-details filter, interceptors (request-id, logging, idempotency, etag), money (decimal.js), quantity,
│  │                 time (Bangkok, billing-cycle calendar), pagination, compliance error helper
│  ├─ config/        validated env schema, Secrets Manager loader
│  ├─ database/      PrismaService, `withTx`, OrgContext repository base, Timescale helpers
│  ├─ platform/      settings, feature-flags, files, audit, domain-events + outbox, notifications, realtime, privacy, tariffs
│  ├─ modules/       auth, iam, orgs  (business modules arrive in B2–B6)
│  └─ integrations/  one folder per provider, each with a fake
├─ prisma/schema/*.prisma  prisma/migrations/  prisma/seed/ (roles, permissions, platform settings, tariff versions, dev org)
├─ contract/openapi.json  contract/device-protocol.json
├─ test/             unit helpers, integration (Testcontainers), e2e, golden/
├─ docs/             prompts/ contract/ adr/ decisions.md schema-design.md rbac.md PROGRESS.md
├─ docker-compose.yml  postgres (timescale/timescaledb-ha:pg18), redis, emqx, localstack (S3/SES), mailpit
├─ Dockerfile        multi-stage, non-root, one image for main + worker + ingest
└─ .github/workflows/ci.yml  lint · typecheck · unit · integration · e2e · contract drift + oasdiff · prisma drift · build · image scan
```

## Deliverable 1.1 — Scaffold, CI, contract pipeline, ADRs
1. NestJS 12 project (pnpm, Node 24, TS 6 strict), ESLint flat + Prettier, path aliases, validated env (fail fast), Secrets Manager loader, pino with a redaction list (`authorization`, `password`, `otp`, `token`, `refreshToken`, `idToken`, `lineAccessToken`, `nationalId`, `passportNo`, `bankAccount`, `provisioningCode`), OpenTelemetry + Sentry, request id, Terminus `/health` (DB, Redis, S3, MQTT broker reachability from the ingest process).
2. URI versioning `/v1`; surface modules `AuthApi`, `OwnerApi`, `TenantApi`, `StaffApi`, `AdminApi`, `DeviceApi`, `Webhooks`; global problem-details filter (RFC 9457, localised th/en, `compliance.*` codes carry `legalRef`); validation pipe; pagination + series-query helpers; `Idempotency-Key` interceptor (Redis + `idempotency_keys`); ETag/If-Match helper; `X-Org-Id` resolution into `OrgContext` (contract §8).
3. **Contract & documentation pipeline** (contract §5): `pnpm contract:build` boots an app context with fake integrations and writes deterministic `contract/openapi.json` (OpenAPI 3.1, surface tags, named enum components, security scheme per audience, `servers`, shared problem components, webhook definitions) **and** `contract/device-protocol.json` (JSON Schemas from the MQTT DTO classes). Serve Scalar at `/docs`, Swagger UI at `/docs/swagger`, raw at `/docs-json` / `/docs.yaml`, gated by `DOCS_ENABLED` + platform auth outside local/dev. `pnpm contract:lint` (Spectral ruleset per §5). Documentation decorators `@ApiStandardErrors(...codes)`, `@ApiPaginated(Dto)`, `@ApiCursor(Dto)`, `@ApiIdempotent()`, `@ApiConcurrency()`, `@ApiCompliance(ruleId)`. CI: lint + drift + `oasdiff breaking` vs `main`; release workflow attaches both contract files to tag `vX.Y.Z`.
4. Three processes: `pnpm dev` (HTTP with fakes), `pnpm dev:worker`, `pnpm dev:ingest` (connects to the compose EMQX, subscribes `$share/ingest/gp/v1/+/telemetry|health|events`, logs validated envelopes — no persistence yet). `docker-compose.yml` (TimescaleDB, Redis, EMQX with a dev ACL file, LocalStack, Mailpit), `.env.example` (every variable documented), Dockerfile, CI.
5. ADRs 0001 (PostgreSQL 18 + TimescaleDB), 0002 (three repos & shared contracts), 0003 (auth audiences incl. device), 0004 (effective-dated configuration & platform tariffs) from `00-master-plan.md` and `decisions.md`.
6. Acceptance: `docker compose up -d && pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm contract:build && pnpm contract:lint` green; `/health` works; `/docs` renders; ingest process connects to EMQX and logs a hand-published test batch; CI green.

## Deliverable 1.2 — Schema design (review gate), then core migrations
1. Read `docs/decisions.md` end to end and `docs/contract/device-protocol.md`. Write **`docs/schema-design.md`**: bounded contexts, aggregates, tables with key columns, enums, relations, indexes, tenancy columns, effective-dating pattern, snapshot pattern (tariff version + readings + lease lines → bill), readings vs telemetry hypertable design (chunking, retention, continuous aggregates), document numbering, and a table **decision → tables/columns** proving every D-### with data implications is covered. Include a Mermaid ER diagram per context. **Stop here and ask the user to review.**
2. After approval, implement the **platform, IAM and org** part of the schema now (other contexts migrate in their own deliverables, following the approved design):
   - `0001_extensions` (`timescaledb`, `pgcrypto`, `pg_trgm`, `citext`).
   - IAM: `users` (phone, email, password hash, totp secret enc.), `auth_sessions`, `roles`, `permissions`, `role_permissions`, `user_roles` (scope `platform | org:{id} | property:{id}`), `support_grants`.
   - Tenancy: `orgs`, `org_settings` + versions, `org_bank_accounts` (change requires OTP confirmation; history), `org_members`, `invitations`.
   - Platform: `settings` + `setting_versions`, `feature_flags`, `tariffs` + `tariff_versions` (utility, region, structure: tiers/flat, Ft, service charge, VAT handling, `effective_from`, source doc), `file_objects`, `attachments`, `audit_logs`, `domain_events`, `outbox_messages`, `notification_templates` (+ versions), `notification_preferences`, `notifications`, `web_push_subscriptions`, `idempotency_keys`, `consent_purposes` (+ versions), `consents`, `data_subject_requests`, `retention_policies`, `business_calendars` (Thai public holidays).
3. Seeds: roles & permissions (D-090/091), platform settings from decisions with the decision id in the description (billing cut-off default, reading window ±2 h, stale/silent thresholds, deposit cap months ⚖, reminder schedule 1/3/7, late fee off, estimate policy, trial 30 days, price plans D-080 as proposed), **tariff versions** for MEA and PEA residential (ประเภท 1.1/1.2 with Ft) and MWA/PWA residential as of the current published rates, entered from the utilities' published tables with the source URL and date (mark `verified_by` empty until the platform admin confirms). Dev seed: one fake org ("หอพักตัวอย่าง"), one property with 2 floors × 6 rooms, owner/manager/staff users with obviously fake phones.

## Deliverable 1.3 — Auth, IAM & org scoping, orgs, settings, tariffs, outbox, notifications, files, audit, privacy
**Auth (contract §4)**: org users `POST /v1/auth/org/otp/request|verify` (SMS OTP, 6 digits, rate & attempt limits), `POST /v1/auth/org/login` (email + password + optional TOTP); tenants `POST /v1/auth/tenant/line` (LIFF id-token verification, account linking), `POST /v1/auth/tenant/otp/request|verify` (magic-link fallback); platform `POST /v1/auth/platform/login` (TOTP mandatory); devices `POST /v1/device/bootstrap` (provisioning code → CSR signed by the platform CA → certificate + device JWT; EMQX ACL row written); `refresh` (rotation + reuse detection), `logout`, JWKS. Passwords argon2id. `GET /v1/owner/me` (orgs, current org, roles, permissions, **menu entitlements**, feature flags, subscription state), `/v1/tenant/me` (leases, language, consent state), `/v1/staff/me`, `/v1/admin/me`.
**IAM & scoping**: permission catalogue (`resource.action`) in code → seeded; `@Can()` guard; `OrgScoped` repository base adding `org_id` to every query, with tests including ids in URLs, file keys, exports and cursor tokens; `property:` scope for Staff limited to properties; **support grants** (platform Support asks, org Owner approves in-app or platform admin grants for incidents; time-boxed; every read audited); admin endpoints for platform users; org endpoints for members, role assignment, invitations; `docs/rbac.md` generated from code.
**Orgs**: create org (first user becomes Owner), company data (legal name, tax id, address, VAT-registered flag, logo), bank account (add/change → OTP to Owner's phone → effective; history kept), org settings with `effective_from` (typed accessors, `at(date)`), org deactivation.
**Settings & tariffs**: platform settings (platform admin), org settings (Owner; some Manager), cache with invalidation on change event; tariffs: admin CRUD of tariff versions with `effective_from`, publish with verification flag, `GET /v1/owner/tariffs/current?utility=&region=` returning the structure and the **cap per unit** used by the compliance engine.
**Outbox & events**: `DomainEvents.record(tx, event)` → `domain_events` + `outbox_messages` in the caller's transaction; worker relay → BullMQ topics with backoff, dead-letter, admin list/replay. Envelope: `id, type, aggregateType, aggregateId, orgId, propertyId, actor, occurredAt, correlationId, causationId, payload`.
**Notifications**: templates (Handlebars; LINE Flex JSON, SMS, MJML email, in-app; th/en, versioned, preview, test send), channels (LINE Messaging push to linked tenants/owners, SMS, SES, web push, in-app), routing matrix per event × audience × channel (owner-configurable for tenant-facing events), preferences & PDPA consent gating, quiet hours for non-urgent tenant messages (default 21:00–08:00), idempotent per `(event_id, recipient, channel)`, delivery log with provider message ids.
**Realtime & web push**: realtime auth per surface (payload = ids + type only); VAPID subscriptions.
**Files**: presign (single + multipart), `file_objects` (sha256, mime, size, dimensions, scan status, retention class: `meter_photo`, `inspection_photo`, `slip`, `id_document`, `contract`, `logo`), async virus-scan interface + fake, thumbnails, signed downloads, retention job per policy.
**Audit**: security, money and PDPA-relevant actions (login, role change, permission denied, setting/tariff change, bank account change, export, support-grant use, consent change, DSR).
**Privacy**: consent purposes (versioned), consent capture endpoint for tenants and org users, DSR (access/erasure) workflow with the org as joint controller, retention policies job.
**Acceptance**: e2e — owner OTP login → `/v1/owner/me` with menu; platform login with TOTP; tenant LINE token exchange (fake) → `/v1/tenant/me`; device bootstrap → certificate → EMQX ACL row; a token of one audience rejected on other prefixes; cross-org id → 404 in every B1 endpoint; refresh rotation & reuse revocation; org setting with future `effective_from` resolves by date; tariff cap for a given date returned; bank-account change blocked until OTP; support grant required for Support reads and audited; a mutation writes audit + event + outbox atomically and a subscriber receives it exactly once; notification respects consent and quiet hours.

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.
