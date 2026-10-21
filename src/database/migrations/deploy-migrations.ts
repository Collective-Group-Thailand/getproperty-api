import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assetCoreMigrate, PACKAGE_VERSION } from '@collective/asset-core';

import { applyPrismaMigrations, type MigrationClient, prismaDir } from './app-migrations';

/** `TIMESCALEDB_MIGRATION`: `auto` applies the optional step where the extension can be used, `on` requires it. */
export type TimescaleMode = 'auto' | 'on' | 'off';

export const TIMESCALE_STEP = 'timescale/001_telemetry_hypertables';
/** Step 2 (D-234, T-12, ADR-0014): raw telemetry without RLS (platform-only) and compressed after 30 days. */
export const TIMESCALE_COMPRESSION_STEP = 'timescale/002_telemetry_compression';
/** The optional TimescaleDB steps in apply order. */
export const TIMESCALE_STEPS = [TIMESCALE_STEP, TIMESCALE_COMPRESSION_STEP] as const;

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
 * The optional TimescaleDB steps (D-162, D-234): `001_telemetry_hypertables` converts the raw telemetry and gateway
 * health tables to hypertables, `002_telemetry_compression` makes raw telemetry platform-only without RLS and
 * compresses it after 30 days (T-12, ADR-0014) — where TimescaleDB is usable, each once, each in its own transaction,
 * recorded in `_optional_migrations` (not in `_prisma_migrations`, so `prisma migrate deploy` never sees an unknown
 * migration). Without the extension nothing happens and the native monthly partitions stay; tenants read the same
 * rollups and 15-minute function either way.
 */
export async function applyOptionalTimescale(
  db: MigrationClient,
  mode: TimescaleMode,
  dir = join(prismaDir(), 'optional'),
): Promise<DeployMigrationsResult['timescale']> {
  if (mode === 'off') return 'skipped_off';
  await db.query(OPTIONAL_DDL);
  const steps = TIMESCALE_STEPS.map((name) => {
    const sql = readFileSync(join(dir, `${name}.sql`), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  const { rows } = await db.query(
    `SELECT name, checksum FROM public."_optional_migrations" WHERE name = ANY ($1::text[])`,
    [steps.map((s) => s.name)],
  );
  const done = new Map(rows.map((r) => [String(r.name), String(r.checksum)]));
  for (const step of steps)
    if (done.has(step.name) && done.get(step.name) !== step.checksum)
      throw new Error(`optional migration ${step.name} was modified after it was applied`);
  const pending = steps.filter((s) => !done.has(s.name));
  if (pending.length === 0) return 'already_applied';
  if (!(await timescaleUsable(db))) {
    if (mode === 'on')
      throw new Error(
        'TIMESCALEDB_MIGRATION=on but the timescaledb extension is not available and preloaded',
      );
    return 'skipped_unavailable';
  }
  for (const step of pending) {
    // The files are hand-runnable (own BEGIN/COMMIT); here each runs inside this runner's transaction with its record.
    const body = step.sql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
    await db.query('BEGIN');
    try {
      await db.query(body);
      await db.query(`INSERT INTO public."_optional_migrations" (name, checksum) VALUES ($1, $2)`, [
        step.name,
        step.checksum,
      ]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw new Error(`optional migration ${step.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return 'applied';
}

/** The oldest `@collective/asset-core` whose runner migrates as a non-superuser product login by itself (ADR-0013). */
export const MIN_ASSET_CORE_VERSION = '0.4.0';

/** `a >= b` for plain `major.minor.patch` versions. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}

/**
 * `@collective/asset-core` migrations (schema `core`, roles, helpers). Since asset-core 0.4.0 the package's runner
 * itself grants `gp_platform` the CREATE right on `core` that migration 0007 needs when the login is not a superuser
 * (the Collective platform's product login `getproperty` is NOCREATEROLE, D-230) and revokes it afterwards — this
 * repository's former workaround (`migrateCoreAsProductLogin`) is gone (blueprint T-3, ADR-0013). An older package
 * is refused instead of failing half-way on the platform.
 */
export async function migrateCore(
  db: MigrationClient,
  log: (line: string) => void,
  packageVersion: string = PACKAGE_VERSION,
): Promise<string[]> {
  if (!versionAtLeast(packageVersion, MIN_ASSET_CORE_VERSION))
    throw new Error(
      `@collective/asset-core ${packageVersion} is too old for the migrate command: ${MIN_ASSET_CORE_VERSION} or newer is required (ADR-0013)`,
    );
  return (await assetCoreMigrate({ client: db, log })).applied;
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
  const core = await migrateCore(db, log);
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
