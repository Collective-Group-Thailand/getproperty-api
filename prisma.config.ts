// Prisma 7 configuration (reference: getpack-api). The datasource URL lives here, not in the schema:
// `DATABASE_URL` / `SHADOW_DATABASE_URL` come from the environment (.env.example; `pnpm db:local` prints them).
// Multi-file schema (one file per bounded context) in prisma/schema; hand-written SQL migrations in
// prisma/migrations (schema-design §1.2 "Prisma": hypertables, triggers, RLS, exclusion constraints and partial
// indexes live in the SQL tail — Prisma models the relational shape only).
import 'dotenv/config';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
    // `prisma migrate dev` / `prisma migrate reset` seed the reference data (roles, settings, tariffs, …).
    seed: 'pnpm db:seed',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://getproperty:getproperty@localhost:5432/getproperty',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
