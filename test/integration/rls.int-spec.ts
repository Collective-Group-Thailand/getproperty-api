import { DEV } from '../../prisma/seed/run';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const OTHER = {
  tenantId: '0199f2a0-1111-7000-8000-000000000001',
  userId: '0199f2a0-1111-7000-8000-0000000000a1',
};

/**
 * Row-level security on the app tables (schema-design §4.5 DoD): PrismaService.withTenant switches to gp_app
 * (DATABASE_APP_ROLE) and sets app.tenant_id; the superuser connection writes fixtures for two tenants.
 */
describe('RLS on platform / ops / bridge tables', () => {
  let db: IntDatabase;
  const evtA = '0199f2a0-2222-7000-8000-00000000000a';
  const evtB = '0199f2a0-2222-7000-8000-00000000000b';

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_rls' });
    await db.admin.query(
      `INSERT INTO core.tenant (id, slug, display_name, legal_name, legal_form) VALUES ($1, 'other', 'Other', 'Other Co.', 'company');
       `.trim(),
      [OTHER.tenantId],
    );
    await db.admin.query(
      `INSERT INTO core.user_account (id, display_name, phone_e164) VALUES ($1, 'Other user', '+660000000099')`,
      [OTHER.userId],
    );
    for (const [tenant, evt] of [
      [DEV.tenantId, evtA],
      [OTHER.tenantId, evtB],
    ]) {
      await db.admin.query(
        `INSERT INTO platform.domain_event (id, type, aggregate_type, aggregate_id, tenant_id, actor, correlation_id, payload)
         VALUES ($2, 'tenant.updated', 'tenant', $1, $1, '{"type":"system","name":"test"}', $2, '{}')`,
        [tenant, evt],
      );
      await db.admin.query(
        `INSERT INTO platform.audit_log (tenant_id, actor, action) VALUES ($1, '{"type":"system","name":"test"}', 'tenant.updated')`,
        [tenant],
      );
      await db.admin.query(
        `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, reason)
         SELECT $1, id, '"block"', now(), 'test' FROM platform.setting WHERE key = 'billing.estimate_policy'`,
        [tenant],
      );
      await db.admin.query(
        `INSERT INTO bridge.integration_event (direction, platform, event_type, contract_version, idempotency_key, tenant_id, payload,
           payload_sha256, status, occurred_at)
         VALUES ('outbound', 'getbuild', 'juristic.formed', '0.1.0', 'k-' || $1::text, $1::uuid, '{}', sha256('{}'::bytea), 'pending', now())`,
        [tenant],
      );
      await db.admin.query(
        `INSERT INTO ops.document_series (tenant_id, doc_type, fiscal_year, prefix) VALUES ($1, 'invoice', 2026, 'INV')`,
        [tenant],
      );
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  const count = (tenantId: string, table: string, actorId?: string) =>
    db
      .prisma()
      .withTenant({ tenantId, actorId }, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
      )
      .then((r) => r[0]!.n);

  it.each([
    'platform.domain_event',
    'platform.audit_log',
    'platform.tenant_setting_version',
    'bridge.integration_event',
    'ops.document_series',
  ])('%s: each tenant sees only its own rows', async (table) => {
    expect(await count(DEV.tenantId, table)).toBe(1);
    expect(await count(OTHER.tenantId, table)).toBe(1);
  });

  it('a cross-tenant read by id returns nothing', async () => {
    const rows = await db
      .prisma()
      .withTenant({ tenantId: OTHER.tenantId }, (tx) => tx.domainEvent.findMany({ where: { id: evtA } }));
    expect(rows).toEqual([]);
    const tenants = await db
      .prisma()
      .withTenant({ tenantId: OTHER.tenantId }, (tx) => tx.tenant.findMany({ where: { id: DEV.tenantId } }));
    expect(tenants).toEqual([]);
  });

  it('without a tenant scope gp_app sees no tenant rows (but the catalogues)', async () => {
    const result = await db.prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE gp_app');
      const events = await tx.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM platform.domain_event',
      );
      const rules = await tx.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM platform.compliance_rule',
      );
      return { events: events[0]!.n, rules: rules[0]!.n };
    });
    expect(result.events).toBe(0);
    expect(result.rules).toBeGreaterThan(0);
  });

  it('writes stamped with another tenant are refused', async () => {
    await expect(
      db.prisma().withTenant({ tenantId: OTHER.tenantId }, (tx) =>
        tx.auditLog.create({
          data: { tenantId: DEV.tenantId, actor: { type: 'system', name: 'x' }, action: 'tenant.updated' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('platform catalogues are read-only for gp_app', async () => {
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: DEV.tenantId }, (tx) =>
          tx.$executeRawUnsafe(`UPDATE platform.setting SET description = description || ' D-000'`),
        ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: DEV.tenantId }, (tx) =>
          tx.$queryRawUnsafe('SELECT * FROM platform.user_credential'),
        ),
    ).rejects.toThrow(/permission denied/);
  });

  it('the app writes an event and its outbox row in one transaction, and cannot see other tenants’ outbox rows', async () => {
    const id = '0199f2a0-2222-7000-8000-0000000000ff';
    await db.prisma().withTenant({ tenantId: DEV.tenantId }, async (tx) => {
      await tx.domainEvent.create({
        data: {
          id,
          type: 'tenant.updated',
          aggregateType: 'tenant',
          aggregateId: DEV.tenantId,
          tenantId: DEV.tenantId,
          actor: { type: 'system', name: 'test' },
          correlationId: id,
          payload: {},
        },
      });
      await tx.outboxMessage.create({ data: { eventId: id, topic: 'tenant' } });
    });
    await db.admin.query(`INSERT INTO platform.outbox_message (event_id, topic) VALUES ($1, 'tenant')`, [
      evtB,
    ]);
    expect(await count(DEV.tenantId, 'platform.outbox_message')).toBe(1);
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: DEV.tenantId }, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM platform.outbox_message`),
        ),
    ).rejects.toThrow(/permission denied/);
  });

  it('notification routes: platform defaults (tenant_id null) are readable, only own rows writable', async () => {
    await db.admin.query(
      `INSERT INTO platform.notification_route (tenant_id, event_type, audience, channel) VALUES (NULL, 'test.rls_probe', 'resident', 'line')`,
    );
    const defaults = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification_route WHERE tenant_id IS NULL`,
    );
    expect(await count(DEV.tenantId, 'platform.notification_route')).toBe(defaults.rows[0]!.n);
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: DEV.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE platform.notification_route SET enabled = false WHERE tenant_id IS NULL`,
          ),
        ),
    ).resolves.toBe(0);
  });

  it('workflow instances are visible to the building owner/operator and invisible to others', async () => {
    const def = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.workflow_definition (key, version, states, transitions) VALUES ('rls_probe', 1, '[]', '[]') RETURNING id`,
    );
    await db.admin.query(
      `INSERT INTO ops.workflow_instance (tenant_id, building_id, definition_id, subject_type, subject_id, state)
       VALUES ($1, $2, $3, 'ops.deposit', $1, 'opened')`,
      [DEV.tenantId, DEV.buildingId, def.rows[0]!.id],
    );
    expect(await count(DEV.tenantId, 'ops.workflow_instance')).toBe(1);
    expect(await count(OTHER.tenantId, 'ops.workflow_instance')).toBe(0);
    // platform definitions (tenant_id null): the seeded ones + the probe
    const defs = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.workflow_definition WHERE tenant_id IS NULL`,
    );
    expect(await count(OTHER.tenantId, 'ops.workflow_definition')).toBe(defs.rows[0]!.n);
  });

  it('a user sees its own notification preferences and web push subscriptions only', async () => {
    await db.admin.query(
      `INSERT INTO platform.web_push_subscription (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example.invalid/1', 'k', 'a')`,
      [DEV.users.owner],
    );
    expect(await count(DEV.tenantId, 'platform.web_push_subscription', DEV.users.owner)).toBe(1);
    expect(await count(DEV.tenantId, 'platform.web_push_subscription', OTHER.userId)).toBe(0);
  });

  it('reporting cannot read encrypted bank account columns', async () => {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE gp_reporting');
      await expect(db.admin.query('SELECT account_no_enc FROM platform.tenant_bank_account')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.admin.query('ROLLBACK');
    }
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE gp_reporting');
      const { rows } = await db.admin.query('SELECT account_no_masked FROM platform.tenant_bank_account');
      expect(rows).toEqual([]);
    } finally {
      await db.admin.query('ROLLBACK');
    }
  });
});
