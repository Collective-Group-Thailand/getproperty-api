// Prisma 7 configuration (reference: getpack-api). The datasource URL lives here, not in the schema:
// `DATABASE_URL` / `SHADOW_DATABASE_URL` come from the environment (.env.example; `pnpm db:local` prints them).
// Multi-file schema (one file per bounded context) in prisma/schema; hand-written SQL migrations in
// prisma/migrations (schema-design §1.2 "Prisma": CHECK/EXCLUDE constraints, partial indexes, triggers and RLS
// live in the SQL — Prisma models the relational shape only).
//
// The `core` schema belongs to @collective/asset-core (D-153, ADR-0010, ADR-0011): its 18 tables and 31 enums are
// declared EXTERNAL so Prisma Migrate never creates, alters or drops them, and the shadow database used by
// `prisma migrate dev|diff --from-migrations` is initialised with the package's own SQL first. The runner's
// bookkeeping table `core._migration` is external too: otherwise `prisma migrate deploy` on a fresh database (after
// `asset-core migrate`) sees a non-empty schema and stops with P3005.
import 'dotenv/config';

import { CORE_ENUMS, CORE_TABLES, coreMigrationSql } from '@collective/asset-core';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema',
  experimental: { externalTables: true },
  tables: { external: [...CORE_TABLES.map((t) => `core.${t}`), 'core._migration'] },
  enums: { external: Object.keys(CORE_ENUMS).map((e) => `core.${e}`) },
  migrations: {
    path: 'prisma/migrations',
    initShadowDb: coreMigrationSql(),
    // `prisma migrate dev` / `prisma migrate reset` seed the reference data (roles, settings, tariffs, …).
    seed: 'pnpm db:seed',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://getproperty:getproperty@localhost:5432/getproperty',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
