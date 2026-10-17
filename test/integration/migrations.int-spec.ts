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

  it('applies the package migrations (0.3.0: ten), then every app migration', async () => {
    const core = await assetCoreMigrate({ client: db.admin });
    expect(core.applied).toHaveLength(10);
    const applied = await applyPrismaMigrations(db.admin);
    expect(applied).toEqual(listMigrations().map((m) => m.name));
    expect(applied).toHaveLength(20);
  });

  it('creates exactly the tables of schema-design §7.1–§7.3 (+ §7.5): core 18, platform 41 (+ B4.1 compliance_score), ops 37 (B2.1–B4.2), bridge 1, smart 25 (B1.3 + B3, partitioned parents counted once), juristic empty', async () => {
    const { rows } = await db.admin.query<{ schema: string; n: number }>(
      `SELECT n.nspname AS schema, count(c.oid)::int AS n
         FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT LIKE '\\_%'
        WHERE n.nspname IN ('core', 'platform', 'ops', 'smart', 'bridge', 'juristic') GROUP BY 1 ORDER BY 1`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.schema, r.n]))).toEqual({
      bridge: 1,
      core: 18,
      juristic: 0,
      ops: 37,
      platform: 41,
      smart: 25,
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
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('core', 'platform', 'ops', 'bridge', 'smart') AND c.relname NOT LIKE '\\_%'
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
    // Monthly partitions of the D-162 tables are created at run time; Prisma models their parents only.
    const partitions = await db.admin.query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relispartition`,
    );
    const problems = await checkPrismaDrift(db.admin, loadDmmf(), {
      schemas: ['core', ...APP_SCHEMAS],
      schemaText: schemaFiles()
        .map(([, text]) => text)
        .join('\n'),
      ignoreTables: ['core._migration', ...partitions.rows.map((r) => r.name)],
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
