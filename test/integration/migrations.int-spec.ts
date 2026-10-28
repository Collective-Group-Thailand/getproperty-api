import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { assetCoreMigrate } from '@collective/asset-core';
import { checkPrismaDrift } from '@collective/asset-core/testing';
import { applyPrismaMigrations, listMigrations } from '@database/migrations/app-migrations';
import {
  applyOptionalTimescale,
  runDeployMigrations,
  timescaleUsable,
} from '@database/migrations/deploy-migrations';

import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { loadDmmf, schemaFiles } from '../support/prisma-dmmf';

const APP_SCHEMAS = ['platform', 'ops', 'smart', 'bridge', 'juristic'];

describe('migrations (asset-core + prisma/migrations) from an empty database', () => {
  let db: IntDatabase;

  beforeAll(async () => {
    db = await createIntDatabase({ empty: true, prefix: 'gp_mig' });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('applies the package migrations (0.6.0: twelve), then every app migration', async () => {
    const core = await assetCoreMigrate({ client: db.admin });
    expect(core.applied).toHaveLength(13);
    const applied = await applyPrismaMigrations(db.admin);
    expect(applied).toEqual(listMigrations().map((m) => m.name));
    expect(applied).toHaveLength(62);
  });

  it('creates exactly the tables of schema-design §7.1–§7.3 (+ §7.5): core 18, platform 77 (+ B4.1 compliance_score, D-203 topic preferences, B6.1 platform business 17, B6.3 analytics 4, D-240 provider_credential, D-276 storage 2, B7.2 listing verification + report 2, B7.7 own LINE OA 3, B7.7 metering 3, B7.10 identity verification 1, B7.11 rent record share 1, B7.13 guide 1, G1 storage quota 5, G4 social channel 1), ops 75 (B2.1–B4.5, B5.1 service 5, B5.3 community 8, B6.2 e-Tax / TM30 2, D-218 service messages 1, D-226 link requests 1, B7.2 listings 3, B7.3 leads, messages, viewings 3, B7.9 share links 1, G2 mandates, co-broke, deals, fee accruals 4, G3 contract documents, signatures, renewal offers 3, G7 viewing access 1, G4 listing social posts 1), bridge 1, smart 28 (B1.3 + B3 + D-208 reading requests + B5.2 access 3 − T-14 telemetry_15m, partitioned parents counted once), juristic empty', async () => {
    const { rows } = await db.admin.query<{ schema: string; n: number }>(
      `SELECT n.nspname AS schema, count(c.oid)::int AS n
         FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT LIKE '\\_%'
        WHERE n.nspname IN ('core', 'platform', 'ops', 'smart', 'bridge', 'juristic') GROUP BY 1 ORDER BY 1`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.schema, r.n]))).toEqual({
      bridge: 1,
      core: 18,
      juristic: 0,
      ops: 90,
      platform: 83,
      smart: 28,
    });
    const view = await db.admin.query(
      `SELECT to_regclass('platform.v_consent_state') IS NOT NULL AS present,
              to_regclass('ops.staff_task') IS NOT NULL AS staff_task,
              (SELECT reloptions FROM pg_class WHERE oid = 'ops.staff_task'::regclass) AS options`,
    );
    expect(view.rows[0]).toEqual({ present: true, staff_task: true, options: ['security_invoker=true'] });
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

  it('the image migrate command (D-230): core + app up to date, the TimescaleDB step skipped without the extension', async () => {
    const lines: string[] = [];
    const result = await runDeployMigrations(db.admin, { timescale: 'auto', log: (l) => lines.push(l) });
    expect(result).toEqual({ core: [], app: [], timescale: 'skipped_unavailable' });
    expect(lines).toContain('app: schema is up to date');
    expect(await timescaleUsable(db.admin)).toBe(false);
    expect(await applyOptionalTimescale(db.admin, 'off')).toBe('skipped_off');
    await expect(applyOptionalTimescale(db.admin, 'on')).rejects.toThrow(/not available and preloaded/);
    const recorded = await db.admin.query(`SELECT count(*)::int AS n FROM public."_optional_migrations"`);
    expect(recorded.rows[0]).toEqual({ n: 0 });
    // native partitions stay in place
    const kind = await db.admin.query(
      `SELECT relkind FROM pg_class WHERE oid = 'smart.telemetry_point'::regclass`,
    );
    expect(kind.rows[0]).toEqual({ relkind: 'p' });
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
