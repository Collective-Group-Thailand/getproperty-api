# ADR-0011 — Prisma with a package-owned schema (`core` from `@collective/asset-core`)

**Status:** Accepted (2026-10-17, B1.2 step 2b)
**Decision ids:** D-152, D-153, D-162 · related: ADR-0001 (as amended by D-162), ADR-0009, ADR-0010

## Context
getproperty-api uses Prisma 7 (client + Migrate, multi-file schema, `multiSchema`). The `core` schema (18 tables,
31 enums, functions, RLS) is created and evolved **only** by the package `@collective/asset-core` and its own SQL
runner (`asset-core migrate`, ledger `core._migration`, ADR-0010). The app's models must still *relate* to core rows
(FKs to `core.tenant`, `core.building`, `core.user_account`, …) and the app must never generate a migration that
creates, alters or drops a `core.*` object (CLAUDE.md, D-153). Two Prisma behaviours collide with that:
1. `prisma migrate dev` / `migrate diff --from-migrations` replay `prisma/migrations` on an empty **shadow database**:
   the app migrations reference `core.*` and fail there, and Prisma would otherwise want to create the core tables
   it sees in the schema.
2. Prisma requires both sides of every relation. Core models live in a generated fragment the app cannot edit, yet
   each app relation to a core model needs an opposite field on that core model.

## Decision
1. **External tables and enums.** `prisma.config.ts` enables `experimental.externalTables` and lists every core table
   (`tables.external`, from the package's `CORE_TABLES`) and enum (`enums.external`, from `CORE_ENUMS`). Prisma keeps
   them in the client API but never migrates them; `prisma migrate diff/dev` ignore them.
2. **Shadow database bootstrap.** `migrations.initShadowDb` = `coreMigrationSql()` from the package, so the shadow
   database receives exactly the package's `core` schema before the app migrations are replayed.
3. **Run order.** `pnpm db:migrate` = `asset-core migrate && prisma migrate deploy`. Core first, always; app
   migrations may add FKs to core and never alter it. Roles, extensions and the `core.*` helper functions come from
   the package.
4. **Generated fragment with back-relations.** `prisma/schema/core.prisma` is produced by
   `pnpm prisma:core` (= `asset-core prisma-fragment --relations-from prisma/schema --out prisma/schema/core.prisma`):
   the package's models plus, for every app relation to a core model, the opposite field. App relations to core
   models must therefore be **named** (`@relation("AuditLogTenant", …)` → `Tenant.auditLogTenant AuditLog[]`; `?` for
   a unique FK). The file starts with a GENERATED header; a unit test fails when it differs from what the installed
   package would generate.
5. **Partial indexes.** The generator enables the `partialIndexes` preview: partial unique/normal indexes are modelled
   with `where: raw("…")` written exactly as PostgreSQL prints the predicate, so Prisma's diff sees them as equal.
   Expression indexes are avoided (`NULLS NOT DISTINCT` unique indexes replace `coalesce(tenant_id, '0…0')`, and
   `audit_log.actor_id` replaces an index on `actor->>'id'`). CHECK/EXCLUDE constraints, triggers, RLS policies, views
   and functions stay SQL-only (Prisma ignores them).
6. **Drift is checked twice.** CI (`migrations` job, PostgreSQL 18 service) runs the real `prisma migrate deploy`,
   `pnpm db:diff` (`--from-config-datasource --to-schema`) and `prisma migrate diff --from-migrations … --exit-code`
   (shadow bootstrapped by `initShadowDb`). The integration suite also runs a **structural drift check**
   (`checkPrismaDrift` from `@collective/asset-core/testing`: tables, columns, types, nullability, defaults, enums,
   PKs, unique/secondary indexes incl. method, operator class, sort order and predicate, FKs incl. actions) between
   the migrated database and the DMMF of `prisma/schema` — it needs no native engine, so it also runs where
   binaries.prisma.sh is unreachable; the package uses the same check to prove `core.prisma` = its SQL.
7. **Dependency resolution.** Until the private registry exists the dependency is
   `"@collective/asset-core": "link:../collective-asset-core"`: CI checks the sibling repository out at the pinned
   tag and builds it (`.github/actions/setup`), the Docker build receives it as the named context `asset-core-src`.
   When v0.1.0 is published to GitHub Packages the dependency becomes `"@collective/asset-core": "0.1.0"` and both
   workarounds go.
8. **Writing new app migrations.** Change `prisma/schema/*.prisma`, then
   `pnpm exec prisma migrate dev --create-only --name <change>` (shadow bootstrapped from the package), hand-edit the
   SQL for what Prisma cannot express (CHECK/EXCLUDE, triggers, RLS via `platform.apply_rls(table, kind, module)`),
   run `pnpm prisma:core` when a relation to a core model changed, and make the drift checks green. A change to a
   core table is a PR to the package, a release, and a version bump here — never an app migration.

## Alternatives considered
- **Introspect `core` into the app schema (`db pull`)**: drifts from the package and invites app migrations on core.
- **No relations to core in Prisma (plain uuid columns)**: the FKs would exist in SQL only and Prisma's diff would
  try to drop them; the client would lose typed joins to tenants, buildings and users.
- **`relationMode = "prisma"`**: no database FKs at all — unacceptable for integrity and RLS-protected data.
- **Shadow database = a copy of a migrated database (`shadowDatabaseUrl` pointing at a pre-seeded DB)**: works
  locally but needs manual preparation; `initShadowDb` is declarative and versioned with the package.

## Consequences
- `prisma migrate dev` works normally for app schemas; core changes are impossible through Prisma by design.
- Every relation to a core model costs one generated field on that model (41 in v0.1.0 of the app schema); naming
  relations is mandatory and enforced by the generator.
- `externalTables` and `partialIndexes` are Prisma preview/experimental features (Prisma 7.10): a Prisma upgrade
  re-runs the CI drift jobs before merging.
- Sandboxes without access to binaries.prisma.sh can generate the client and validate (WebAssembly; the CLI is
  pointed at a stub engine binary that is never executed, `scripts/prisma-generate.mjs`) and run the integration
  suite, but not `prisma migrate deploy/diff`; there the suite applies `prisma/migrations` with an equivalent runner
  that writes `_prisma_migrations` the same way, and CI stays the authority for the real engine.
