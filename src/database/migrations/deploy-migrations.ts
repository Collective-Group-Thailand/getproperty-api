import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assetCoreMigrate } from '@collective/asset-core';

import { applyPrismaMigrations, type MigrationClient, prismaDir } from './app-migrations';

/** `TIMESCALEDB_MIGRATION`: `auto` applies the optional step where the extension can be used, `on` requires it. */
export type TimescaleMode = 'auto' | 'on' | 'off';

export const TIMESCALE_STEP = 'timescale/001_telemetry_hypertables';

/** pg_advisory_lock key serialising concurrent app migration runners ("gp-app-mig" as two int4). */
const LOCK_KEY: [number, number] = [0x67702d61, 0x70706d67];

const OPTIONAL_DDL = `
CREATE TABLE IF NOT EXISTS public."_optional_migrations" (
  "name"       text PRIMARY KEY,
  "checksum"   varchar(64) NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now()
)`;

export interface DeployMigrationsResult {
  core: string[];
  app: string[];
  timescale: 'applied' | 'already_applied' | 'skipped_unavailable' | 'skipped_off';
}

/**
 * Whether TimescaleDB can be used in this database: installed already — the Collective platform's init script
 * creates it in the product database (`timescale/timescaledb-ha:pg18` preloads the library; D-230) — or, for a
 * superuser only (who alone may create this untrusted extension and read `shared_preload_libraries`), available
 * and preloaded.
 */
export async function timescaleUsable(db: MigrationClient): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS installed,
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') AS available,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
  );
  const r = rows[0] ?? {};
  if (r.installed === true) return true;
  if (r.available !== true || r.superuser !== true) return false;
  const preload = await db.query(`SELECT current_setting('shared_preload_libraries') AS libs`);
  const libs = preload.rows[0]?.libs;
  return typeof libs === 'string' && libs.includes('timescaledb');
}

/**
 * The optional D-162 step (`prisma/optional/timescale/001_telemetry_hypertables.sql`): converts the raw telemetry
 * and gateway health tables to hypertables where TimescaleDB is usable, once, in one transaction, recorded in
 * `_optional_migrations` (not in `_prisma_migrations`, so `prisma migrate deploy` never sees an unknown migration).
 * Without the extension nothing happens and the native monthly partitions stay — the API reads only the rollup
 * tables either way.
 */
export async function applyOptionalTimescale(
  db: MigrationClient,
  mode: TimescaleMode,
  dir = join(prismaDir(), 'optional'),
): Promise<DeployMigrationsResult['timescale']> {
  if (mode === 'off') return 'skipped_off';
  await db.query(OPTIONAL_DDL);
  const sql = readFileSync(join(dir, `${TIMESCALE_STEP}.sql`), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const { rows } = await db.query(`SELECT checksum FROM public."_optional_migrations" WHERE name = $1`, [
    TIMESCALE_STEP,
  ]);
  if (rows[0]) {
    if (rows[0].checksum !== checksum)
      throw new Error(`optional migration ${TIMESCALE_STEP} was modified after it was applied`);
    return 'already_applied';
  }
  if (!(await timescaleUsable(db))) {
    if (mode === 'on')
      throw new Error(
        'TIMESCALEDB_MIGRATION=on but the timescaledb extension is not available and preloaded',
      );
    return 'skipped_unavailable';
  }
  // The file is hand-runnable (its own BEGIN/COMMIT); here it runs inside this runner's transaction with the record.
  const body = sql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
  await db.query('BEGIN');
  try {
    await db.query(body);
    await db.query(`INSERT INTO public."_optional_migrations" (name, checksum) VALUES ($1, $2)`, [
      TIMESCALE_STEP,
      checksum,
    ]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw new Error(`optional migration ${TIMESCALE_STEP} failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return 'applied';
}

/**
 * `@collective/asset-core` migrations when the login is not a superuser — the Collective platform's product login
 * `getproperty` owns its database but is NOCREATEROLE (D-230). asset-core 0007 hands its SECURITY DEFINER helpers to
 * `gp_platform` (`ALTER FUNCTION … OWNER TO gp_platform`), which PostgreSQL allows only when the new owner may
 * CREATE in the schema. The runner grants that for the duration of the core migrations and revokes it afterwards,
 * so `gp_platform` keeps no DDL right on `core` at run time. A superuser (CI, tests, local) needs none of this.
 */
export async function migrateCoreAsProductLogin(
  db: MigrationClient,
  log: (line: string) => void,
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gp_platform') AS platform_role`,
  );
  const needsGrant = rows[0]?.superuser !== true && rows[0]?.platform_role === true;
  if (needsGrant) {
    await db.query('CREATE SCHEMA IF NOT EXISTS core');
    await db.query('GRANT CREATE ON SCHEMA core TO gp_platform');
  }
  try {
    return (await assetCoreMigrate({ client: db, log })).applied;
  } finally {
    if (needsGrant) await db.query('REVOKE CREATE ON SCHEMA core FROM gp_platform');
  }
}

/**
 * Everything a deployment runs before starting new containers (D-230, the platform's one-shot `migrate` service):
 * `@collective/asset-core` migrations (schema `core`, roles, helpers) first, then this repository's
 * `prisma/migrations`, then the optional TimescaleDB step. Serialised by an advisory lock; each step is idempotent.
 */
export async function runDeployMigrations(
  db: MigrationClient,
  options: { timescale: TimescaleMode; log?: (line: string) => void },
): Promise<DeployMigrationsResult> {
  const log = options.log ?? (() => undefined);
  const core = await migrateCoreAsProductLogin(db, log);
  await db.query('SELECT pg_advisory_lock($1, $2)', LOCK_KEY);
  try {
    const app = await applyPrismaMigrations(db);
    for (const name of app) log(`app: applied ${name}`);
    if (app.length === 0) log('app: schema is up to date');
    const timescale = await applyOptionalTimescale(db, options.timescale);
    log(`timescale: ${timescale}`);
    return { core, app, timescale };
  } finally {
    await db.query('SELECT pg_advisory_unlock($1, $2)', LOCK_KEY).catch(() => undefined);
  }
}
