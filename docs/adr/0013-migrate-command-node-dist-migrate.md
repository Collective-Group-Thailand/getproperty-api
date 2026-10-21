# ADR-0013 — The migrate command is `node dist/src/migrate.js`, not `npx prisma migrate deploy`

**Status:** Accepted (2026-10-22; blueprint T-3, D-246)
**Decision ids:** D-153, D-230, D-233, D-246 · related: ADR-0010, ADR-0011 · collective-infra locked decision 11

## Context
The Collective platform's image contract (locked decision 11) names `npx prisma migrate deploy` as a product's migration
command — what getpack runs. getproperty's schema has two owners: the `core` schema belongs to the package
`@collective/asset-core` (its own SQL migrations, ledger `core._migration`, D-153, ADR-0010) and must be migrated
**before** the app's `prisma/migrations`, which reference `core` tables; `prisma migrate deploy` knows nothing about the
package's migrations (Prisma treats `core` as external tables, ADR-0011). The runtime image also carries no Prisma CLI
or schema engine (size, and the engine binaries are fetched from a host the build should not depend on). Finally the
platform migrates as the product login `getproperty` — database owner, `NOCREATEROLE`, not a superuser — while
asset-core 0007 hands its SECURITY DEFINER helpers to `gp_platform`, which PostgreSQL allows only when that role may
CREATE in the schema; until 2026-10-22 getproperty-api worked around this itself (`migrateCoreAsProductLogin`).

## Decision
1. The image's migrate command is **`node dist/src/migrate.js`** (`src/database/migrations/deploy-migrations.ts`), run by
   the product compose's one-shot **`migrate` service** that collective-infra's `deploy-product.sh` starts before `up`
   (collective-infra README wording "the product compose's `migrate` service", T-17):
   1. `@collective/asset-core` migrations (advisory lock, checksums, idempotent);
   2. `prisma/migrations/*` in order, each in one transaction, recorded in `_prisma_migrations` with the **same name and
      sha256 checksum `prisma migrate deploy` writes** — either tool can follow the other; CI keeps running the real
      `prisma migrate deploy` and `prisma migrate diff` (ADR-0011);
   3. the optional TimescaleDB steps (`prisma/optional/timescale/`, `TIMESCALEDB_MIGRATION`, ADR-0014);
   4. the idempotent reference seed (`SEED_REFERENCE=false` skips it).
2. **asset-core ≥ 0.4.0** is required and enforced: its runner grants `gp_platform` `CREATE ON SCHEMA core` for the run
   when the login is not a superuser and revokes it afterwards, so the workaround in this repository is removed; an
   older package makes the command fail before touching the database. CI and the Docker build check out asset-core
   `v0.4.0`.
3. App migrations that must hand a function to `gp_platform` do the same inside their own transaction (0039: grant
   `CREATE ON SCHEMA smart`, `ALTER FUNCTION … OWNER TO gp_platform`, revoke).
4. Proof: `test/integration/platform-migrate.int-spec.ts` runs the whole sequence as a non-superuser product login with
   the roles the platform's init script creates; asset-core's own suite does the same for the package.

## Consequences
- + One command for every getproperty deploy; core always first; no CLI in the image.
- + The platform contract stays generic ("the product's migrate service"); getpack keeps `npx prisma migrate deploy`.
- − getproperty owns a small runner that must stay byte-compatible with Prisma's ledger — covered by the checksum
  tests and CI's real `prisma migrate deploy`.
