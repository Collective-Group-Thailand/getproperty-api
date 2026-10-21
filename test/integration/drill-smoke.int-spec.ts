import { runDrillSmoke, type SmokeLine } from '../../src/drill/drill-smoke';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, onboardTenant } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const by = (lines: SmokeLine[]) => Object.fromEntries(lines.map((l) => [l.check, l.outcome]));

/**
 * T-15: getproperty's restore-drill smoke (`node dist/src/drill-smoke.js`, run by collective-infra's drill hook against
 * the restored instance): migrations complete, tenant isolation under RLS, and — with the same environment's keys — an
 * Owner login through the HTTP surface, a cross-tenant 404 and a billing-cycle preview.
 */
describe('restore drill smoke (T-15, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_drill' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    // a second tenant with its own building, so isolation has something to prove
    const admin = await adminToken(t);
    const other = await onboardTenant(t, admin, { slug: 'drill-other', phone: '+660000000888' });
    await db.admin.query(
      `INSERT INTO core.property (id, tenant_id, name, code) VALUES (uuidv7(), $1, 'Drill other', 'DRILL-O')`,
      [other.tenantId],
    );
    await db.admin.query(
      `INSERT INTO core.building (tenant_id, property_id, owner_tenant_id, operator_tenant_id, name, code, type)
       SELECT $1, id, $1, $1, 'Other building', 'OB', 'apartment' FROM core.property WHERE code = 'DRILL-O'`,
      [other.tenantId],
    );
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('same environment: every check passes, the Owner signs in and a cycle is computed', async () => {
    const lines: string[] = [];
    const result = await runDrillSmoke({
      databaseUrl: db.url,
      sameEnv: true,
      appRole: 'gp_app',
      log: (l) => lines.push(l),
      bootApp: async () => {
        await t.app.listen(0, '127.0.0.1');
        return {
          // the suite owns the app: the smoke must not close it
          app: {
            getHttpServer: (): unknown => t.app.getHttpServer(),
            close: () => Promise.resolve(),
          } as never,
          lastOtp: (p) => t.sms.lastCodeTo(p),
        };
      },
    });
    expect({ result: by(result), lines }).toEqual({
      lines: expect.any(Array),
      result: {
        migrations: 'ok',
        rls_cross_tenant: 'ok',
        freshness: 'ok',
        owner_login: 'ok',
        cross_tenant_api: 'ok',
        billing_preview: 'ok',
      },
    });
    expect(lines.every((l) => /^SMOKE(_ELAPSED_MS)? /.test(l))).toBe(true);
  });

  it('a backup of another environment: database checks only; a missing migration fails the drill', async () => {
    const skipped = await runDrillSmoke({ databaseUrl: db.url, sameEnv: false });
    expect(by(skipped)).toMatchObject({
      migrations: 'ok',
      rls_cross_tenant: 'ok',
      owner_login: 'skip',
      billing_preview: 'skip',
    });
    await db.admin.query(
      `UPDATE public."_prisma_migrations" SET rolled_back_at = now()
        WHERE migration_name = (SELECT max(migration_name) FROM public."_prisma_migrations")`,
    );
    const broken = await runDrillSmoke({ databaseUrl: db.url, sameEnv: false });
    expect(broken.find((l) => l.check === 'migrations')).toMatchObject({
      outcome: 'fail',
      detail: expect.stringContaining('missing='),
    });
  });
});
