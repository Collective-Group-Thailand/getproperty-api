# CLAUDE.md — getproperty-api

**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย** · operated by **Collective Group (Thailand)**
NestJS backend of getproperty: a multi-tenant SaaS for Thai apartment owners (30–300 rooms) with IoT metering — meter readings arrive automatically → bills computed at the lawful utility tariff (สคบ. 2568) → sent through LINE → paid by Thai QR and confirmed by the bank → receipt issued, with the owner touching nothing. Frontend is the separate repo `getproperty-web` (one Next.js app: owner, tenant, staff and admin zones); the gateway agent is `getproperty-edge`.

## Read before every task
1. `docs/prompts/00-master-plan.md` — architecture, conventions, run order, Definition of Done.
2. `docs/decisions.md` — **business and legal decisions (D-###). They override everything else.**
3. `docs/contract/api-conventions.md` — API contract rules shared with `getproperty-web` and `getproperty-edge`; `docs/contract/device-protocol.md` for anything touching gateways or readings.
4. The prompt you were asked to execute (`docs/prompts/B*.md`) — **only the deliverable you were given**.
5. `docs/PROGRESS.md` (latest entries).
6. `../getpack-api` (if checked out beside this repo) — a **conventions reference only** (D-003): copy structure, tooling, platform-module patterns and documentation decorators; never copy packaging business logic.

## Hard rules
- **Tenancy**: every business row carries `org_id`; repositories take an `OrgContext`; cross-org access is a `404`; tests prove it for every module (contract §8).
- **Compliance before convenience** (D-020–D-025): a bill line above the utility tariff triggers the legal warning and requires an Owner acknowledgement, and is blocked only where the platform admin set `block` (`compliance.tariff_cap`, D-021a), bills are immutable once issued (D-040), the platform never cuts power or revokes access for arrears (D-024, D-071), deposits follow the 7-day settlement flow (D-023). Every compliance rule has an id, a legal reference and a test.
- **Readings → bills**: bills come only from cumulative registers (D-030); the billing engine reads `readings`, never raw telemetry; every reading keeps its `source`, `confidence` and evidence (D-012, D-035).
- Every business value that a decision marks as configurable is a **setting with effective dates, audited, editable by the role named in the decision** — never a constant in code. Tariffs are platform-level versioned tables (D-021).
- Money: `numeric(14,2)` in DB, `decimal.js` in code, decimal **strings** in JSON; meter quantities `numeric(12,3)`. Time: `timestamptz` (UTC), business rules in `Asia/Bangkok`.
- Every endpoint change → `pnpm contract:build` **and** `pnpm contract:lint`, then commit `contract/openapi.json` (and `contract/device-protocol.json` when payloads change) in the same commit. Every operation needs operationId, summary, description with its decision id, security, full status-code set and examples (contract §5).
- Every state change: one DB transaction + audit/activity row + domain event via the outbox. Notifications, document generation, ledger-like postings and analytics are **event subscribers**, never inline.
- Money-moving and irreversible operations require `Idempotency-Key`, explicit permissions and maker-checker where decisions say so.
- No secrets, OTPs, tokens, bank or ID-card data in logs (PDPA, D-025). Platform company data (Collective Group legal name, tax id, logo) comes from `settings`; each org's company data from `org_settings`.
- Plan Mode first for each deliverable; wait for approval. Small vertical slices, Conventional Commits, CI green per slice. When ambiguous: record the assumption in `docs/PROGRESS.md` and choose the most conservative option; never guess a legal or business value — write an `O-###` in `docs/decisions.md`.

## Commands
`pnpm dev` · `pnpm dev:worker` · `pnpm dev:ingest` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:int` · `pnpm test:e2e` · `pnpm contract:build` · `pnpm contract:lint` · `pnpm db:migrate` · `pnpm db:seed:dev` · `pnpm sim:gateway` (publishes fake telemetry for a seeded building) · `docker compose up -d`
