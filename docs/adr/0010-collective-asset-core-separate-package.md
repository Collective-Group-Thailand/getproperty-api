# ADR-0010 — `collective-asset-core` as a separate package

**Status:** Accepted (2026-10-17, schema lock)
**Decision ids:** D-152, D-153, D-155, D-160 · `docs/platform-blueprint.md` §"Platform core & collective-asset-core", §"Integration contracts with getbuild & getpack" · related: ADR-0002, ADR-0009

## Context
The asset core (tenant → property → building → floor → unit, party, ownership, occupancy, asset items, documents, cross-tenant grants) is needed by **getproperty** (which operates buildings for decades) and **getbuild** (which builds and hands them over). The blueprint's open question was whether to start it as a folder inside `getproperty-api` and extract it when getbuild needs it, or to make it a package from day one. The founder chose a separate repository and private npm package from day one (D-153). Each product keeps **its own database**; they share the *schema definition* and the *event contracts*, not rows.

## Decision
- **Repository `collective-asset-core`**, published as a private npm package `@collective/asset-core` (semver). Owned by the getproperty tech lead (getproperty owns the asset core because it holds building data longest).
- **Contents:**
  1. `migrations/` — ordered SQL migrations that create and evolve the `core` schema (tables, enums, helper functions `core.current_tenant_id()`, `core.accessible_building_ids()`, `core.accessible_unit_ids()`, `core.acts_for()`, trigger functions `core.set_updated_at()`, `core.deny_mutation()`, `core.close_previous_period()`, RLS policies of core tables, the uuidv7 guard and the extensions core needs: `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`).
  2. `prisma/core.prisma` — the Prisma model fragment (`@@schema("core")`) that apps include in their multi-file Prisma schema (read-only for apps: they never generate migrations for it).
  3. `contracts/` (zod) — the integration event envelope and payloads: `building.handover.requested`, `unit.transferred`, `warranty.defect.reported`, `warranty.defect.closed`, `juristic.formed`, `procurement.rfq.requested`, `procurement.order.updated`, `identity.party.linked`; plus the `asset_access_grant` rule set (which module keys exist, which grant reasons allow write).
  4. `src/` — small, dependency-free TypeScript helpers: enum constants mirroring the Postgres enums, the per-tenant field-encryption envelope format, the RLS session helper (`SET LOCAL app.tenant_id`), and a runner `assetCoreMigrate(databaseUrl)` that applies pending core migrations and records them in `core._migration`.
- **Install and run order:** `getproperty-api` (and later `getbuild-api`) depends on a pinned version. `pnpm db:migrate` runs `assetCoreMigrate` **first**, then the app's own Prisma migrations (`platform`, `ops`, `smart`, `bridge`, `juristic`). App migrations may reference core tables (FKs into `core`) and may not alter them; core migrations never reference app schemas.
- **Compatibility:** within a major version only additive changes (new tables, nullable columns, new enum values, new event types/fields); renames and drops need a new major and a coordinated upgrade of both products. Event consumers ignore unknown fields.
- **Version 0.1.0** contains exactly the tables listed in schema-design v2 §7.1 (tenancy, identity, asset hierarchy, party relations, asset items, meter assignment, documents, grants). It is written and published before getproperty-api B1.2 step 2 lands; until the registry is set up, B1.2 may install it from a Git tag (`github:collective-group/collective-asset-core#v0.1.0`).
- **Integration transport** (blueprint): events over Pub/Sub + REST callback, each side persisting every event in its own `bridge.integration_event` table for replay; idempotency key per event; PII in payloads encrypted with the Collective shared integration key (KMS, D-160); consumer ack within 24 h or the platform admin sees it.

## Alternatives considered
- **Folder inside getproperty-api, extract later:** cheapest today, but the first getbuild integration would force an extraction under time pressure, and getbuild would copy the folder meanwhile (two drifting copies of the core).
- **Shared database between getbuild and getproperty:** one source of truth for buildings, but couples deployments, failure domains, PDPA controllership and backups of two products; the blueprint chose events.
- **Only event contracts shared, each product modelling its own core:** the hand-over (`building.handover.requested`) would need a mapping layer on both sides; sharing the schema makes the payload a straight copy.
- **Part of `collective-shared`:** that package (auth, LINE, UI) is extracted from getpack later (D-155) and has a different release cadence; the asset core is data, not UI/auth plumbing.

## Consequences
- A change to a `core` table is a PR to `collective-asset-core`, a release, and a version bump in `getproperty-api` — never an app migration. `CLAUDE.md` and the prompt pack say so.
- Local development and CI install the package like any dependency; the e2e-real job runs core migrations before app migrations against the TimescaleDB image.
- Prisma: the app schema enables `multiSchema` with `schemas = ["core", "platform", "ops", "smart", "bridge", "juristic"]`; `prisma migrate diff` checks only app schemas (core is excluded from drift by the migration runner's own checksum table).
- getbuild adopts the same version when it starts; until then getproperty is the only consumer and may iterate 0.x releases quickly (0.x allows breaking minors — used only before getbuild installs it).
