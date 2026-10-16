import { DEV } from '../../prisma/seed/run';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

describe('append-only tables (§4.9)', () => {
  let db: IntDatabase;
  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_audit' });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('audit rows are written by the app and can never be updated, deleted or truncated — not even by a superuser', async () => {
    const row = await db.prisma().withTenant({ tenantId: DEV.tenantId, actorId: DEV.users.owner }, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: DEV.tenantId,
          actor: { type: 'user', id: DEV.users.owner, audience: 'operator' },
          actorId: DEV.users.owner,
          action: 'tenant.bank_account.changed',
          subjectType: 'platform.tenant_bank_account',
        },
      }),
    );
    expect(row.outcome).toBe('success');
    await expect(
      db.admin.query(`UPDATE platform.audit_log SET action = 'auth.login' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/core.append_only/);
    await expect(db.admin.query(`DELETE FROM platform.audit_log WHERE id = $1`, [row.id])).rejects.toThrow(
      /core.append_only/,
    );
    await expect(db.admin.query(`TRUNCATE platform.audit_log`)).rejects.toThrow(/core.append_only/);
    const { rows } = await db.admin.query(`SELECT count(*)::int AS n FROM platform.audit_log WHERE id = $1`, [
      row.id,
    ]);
    expect(rows[0]).toEqual({ n: 1 });
  });

  it.each([
    'platform.domain_event',
    'platform.consent',
    'platform.compliance_evaluation',
    'platform.compliance_acknowledgement',
    'ops.workflow_event',
    'platform.tenant_bank_account_history',
  ])('%s refuses UPDATE and DELETE', async (table) => {
    await expect(db.admin.query(`UPDATE ${table} SET id = id`)).resolves.toBeDefined(); // no rows → no trigger fired
    const trig = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = $1::regclass AND p.proname = 'deny_mutation' AND NOT t.tgisinternal`,
      [table],
    );
    expect(trig.rows[0]!.n).toBe(1);
  });

  it('setting versions are closed by the next version and otherwise immutable', async () => {
    const setting = await db.admin.query<{ id: string }>(
      `SELECT id FROM platform.setting WHERE key = 'reminders.schedule'`,
    );
    const id = setting.rows[0]!.id;
    await db.admin.query(
      `INSERT INTO platform.setting_version (setting_id, value, effective_from, reason) VALUES ($1, '[1,5]', now() + interval '1 day', 'test')`,
      [id],
    );
    const { rows } = await db.admin.query<{ open: number }>(
      `SELECT count(*) FILTER (WHERE effective_to IS NULL)::int AS open FROM platform.setting_version WHERE setting_id = $1`,
      [id],
    );
    expect(rows[0]!.open).toBe(1);
    await expect(
      db.admin.query(`UPDATE platform.setting_version SET value = '[9]' WHERE setting_id = $1`, [id]),
    ).rejects.toThrow(/core.append_only/);
    await expect(
      db.admin.query(
        `INSERT INTO platform.setting_version (setting_id, value, effective_from, reason) VALUES ($1, '[2]', now() - interval '1 day', 'backdated')`,
        [id],
      ),
    ).rejects.toThrow(/setting_version_backdated_check/);
  });
});
