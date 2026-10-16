import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { assetCoreMigrate } from '@collective/asset-core';
import { checkPrismaDrift } from '@collective/asset-core/testing';

import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { loadDmmf, schemaFiles } from '../support/prisma-dmmf';
import { applyPrismaMigrations, listMigrations } from '../support/prisma-migrations';

const APP_SCHEMAS = ['platform', 'ops', 'smart', 'bridge', 'juristic'];

describe('migrations (asset-core + prisma/migrations) from an empty database', () => {
  let db: IntDatabase;

  beforeAll(async () => {
    db = await createIntDatabase({ empty: true, prefix: 'gp_mig' });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('applies the package migrations, then all nine app migrations', async () => {
    const core = await assetCoreMigrate({ client: db.admin });
    expect(core.applied).toHaveLength(7);
    const applied = await applyPrismaMigrations(db.admin);
    expect(applied).toEqual(listMigrations().map((m) => m.name));
    expect(applied).toHaveLength(9);
  });

  it('creates exactly the tables of schema-design §7.1/§7.2: core 18, platform 39, ops 5, bridge 1, smart/juristic empty', async () => {
    const { rows } = await db.admin.query<{ schema: string; n: number }>(
      `SELECT n.nspname AS schema, count(c.oid)::int AS n
         FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' AND c.relname NOT LIKE '\\_%'
        WHERE n.nspname IN ('core', 'platform', 'ops', 'smart', 'bridge', 'juristic') GROUP BY 1 ORDER BY 1`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.schema, r.n]))).toEqual({
      bridge: 1,
      core: 18,
      juristic: 0,
      ops: 5,
      platform: 39,
      smart: 0,
    });
    const view = await db.admin.query(
      `SELECT to_regclass('platform.v_consent_state') IS NOT NULL AS present`,
    );
    expect(view.rows[0]).toEqual({ present: true });
  });

  it('enables and forces row-level security on every table of every schema', async () => {
    const { rows } = await db.admin.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN ('core', 'platform', 'ops', 'bridge') AND c.relname NOT LIKE '\\_%'
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('does not create TimescaleDB objects (D-162)', async () => {
    const { rows } = await db.admin.query(`SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`);
    expect(rows).toEqual([]);
  });

  it('is idempotent: re-running applies nothing', async () => {
    expect((await assetCoreMigrate({ client: db.admin })).applied).toEqual([]);
    expect(await applyPrismaMigrations(db.admin)).toEqual([]);
  });

  it('has no drift between prisma/schema and the migrated database (structural check)', async () => {
    const problems = await checkPrismaDrift(db.admin, loadDmmf(), {
      schemas: ['core', ...APP_SCHEMAS],
      schemaText: schemaFiles()
        .map(([, text]) => text)
        .join('\n'),
      ignoreTables: ['core._migration'],
    });
    expect(problems).toEqual([]);
  });

  // The real `prisma migrate diff` needs Prisma's native schema engine (downloaded from binaries.prisma.sh);
  // CI sets PRISMA_MIGRATE_DIFF=1 (ADR-0011). Elsewhere the structural check above stands in for it.
  const realDiff = process.env.PRISMA_MIGRATE_DIFF === '1' ? it : it.skip;
  realDiff('prisma migrate diff (database ↔ schema) is empty', () => {
    const cli = require.resolve('prisma/build/index.js');
    const run = spawnSync(
      process.execPath,
      [cli, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema', '--exit-code'],
      { cwd: join(__dirname, '..', '..'), env: { ...process.env, DATABASE_URL: db.url }, encoding: 'utf8' },
    );
    expect({ status: run.status, out: run.stdout + run.stderr }).toEqual(
      expect.objectContaining({ status: 0 }),
    );
  });
});
