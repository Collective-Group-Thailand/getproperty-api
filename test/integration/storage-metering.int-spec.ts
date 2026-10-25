import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { StorageMeteringService } from '@core/storage/storage-metering.service';
import { TenantTx } from '@database/tenant-tx';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

/**
 * D-276 storage metering on @collective/documents (real PostgreSQL): usage = live files + records at their counted
 * size; daily snapshots per tenant (idempotent), notices once per crossing (LINE + in-app to the owner), upload
 * admission that only ever holds optional files, the owner's usage bar, and tenancy.
 */
describe('D-276 storage metering (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let other: { tenantId: string; token: string };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const metering = () => t.app.get(StorageMeteringService);
  const storage = async (token = owner) =>
    (await t.http.get('/v1/owner/storage').set(bearer(token)).expect(200)).body as {
      metered: boolean;
      usedBytes: string;
      fileBytes: string;
      records: Record<string, number>;
      allowanceBytes: string | null;
      usedPercent: number | null;
      level: string | null;
      freeGb: string | null;
      history: { day: string; countedBytes: string }[];
    };
  const presign = (kind: string, sizeBytes: number, token = owner) =>
    t.http
      .post('/v1/owner/files/presign')
      .set(bearer(token))
      .send({
        kind,
        scopeType: 'tenant',
        fileName: `${kind}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes,
        sha256: createHash('sha256').update(String(sizeBytes)).digest('hex'),
      });
  const setPlatform = (key: string, value: unknown) =>
    t.http
      .put(`/v1/admin/settings/${key}`)
      .set(bearer(admin))
      .send({ value, reason: 'ทดสอบ D-276' })
      .expect(200);
  const nextDay = async () => {
    const day = addCalendarDays(bangkokDate(t.clock.now()), 1);
    t.clock.set(new Date(startOfBangkokDay(day).getTime() + 9 * 3_600_000));
    admin = await adminToken(t);
    owner = await ownerToken(t);
    other.token = await operatorToken(t, '+660000000276');
  };
  const notices = () =>
    q<{ threshold_pct: number; cleared: boolean }>(
      `SELECT threshold_pct, cleared_at IS NOT NULL AS cleared FROM platform.storage_notice WHERE tenant_id = $1
        ORDER BY sent_at, threshold_pct`,
      [DEV.tenantId],
    );

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_storage' });
    t = await createIntApp(db);
    admin = await adminToken(t);
    owner = await ownerToken(t);
    other = await onboardTenant(t, admin, {
      slug: 'other-storage',
      phone: '+660000000276',
      type: 'landlord',
    });
  }, 180_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('5 GB free per tenant type is seeded (D-279); a type without an allowance is not metered; snapshots are daily', async () => {
    const seeded = await q<{ key: string; value: unknown }>(
      `SELECT s.key, v.value FROM platform.setting s JOIN platform.setting_version v ON v.setting_id = s.id
        WHERE s.key LIKE 'storage.%' ORDER BY s.key`,
    );
    expect(Object.fromEntries(seeded.map((r) => [r.key, r.value]))).toMatchObject({
      'storage.free_gb': { apartment: '5', landlord: '5', condo_juristic: '5', pm_company: '5' },
      'storage.price_per_gb_month': { apartment: null, landlord: null },
      'storage.packs': [],
      'storage.notice_at_percent': [80, 100],
      'storage.record_bytes': { _default: 1024, invoice: 2048, meter_reading: 256 },
    });
    const before = await storage();
    expect(before).toMatchObject({ metered: true, allowanceBytes: '5368709120', level: 'ok', freeGb: '5' });
    expect(Object.keys(before.records).sort()).toEqual(
      ['invoice', 'lease', 'meter_reading', 'payment', 'receipt', 'service_request'].sort(),
    );
    expect(BigInt(before.usedBytes)).toBeGreaterThanOrEqual(BigInt(before.fileBytes));

    // the platform admin can switch metering off for one tenant type (null allowance): usage shown, nothing held
    await setPlatform('storage.free_gb', {
      apartment: '5',
      condo_juristic: '5',
      pm_company: '5',
      landlord: null,
    });
    expect(await storage(other.token)).toMatchObject({ metered: false, allowanceBytes: null, freeGb: null });
    expect((await presign('other', 40_000_000, other.token)).status).toBe(201);

    expect(await metering().sweep()).toBeGreaterThanOrEqual(2); // DEV + other (+ any seeded tenant)
    expect(await metering().sweep()).toBe(0); // one snapshot per tenant and Bangkok day
    const snaps = await q<{ tenant_id: string; allowance_bytes: string | null; policy_version: string }>(
      `SELECT tenant_id, allowance_bytes::text, policy_version FROM platform.storage_usage_daily WHERE tenant_id = ANY($1)`,
      [[DEV.tenantId, other.tenantId]],
    );
    const by = Object.fromEntries(snaps.map((r) => [r.tenant_id, r]));
    expect(by[DEV.tenantId]!.allowance_bytes).toBe('5368709120');
    expect(by[other.tenantId]!.allowance_bytes).toBeNull();
    expect(by[DEV.tenantId]!.policy_version.split(',')).toHaveLength(5);
    expect(await notices()).toEqual([]);

    // the admin overview lists the latest snapshot of every tenant (D-279)
    const overview = (await t.http.get('/v1/admin/storage/tenants').set(bearer(admin)).expect(200)).body as {
      data: {
        tenantId: string;
        usedPercent: number | null;
        level: string | null;
        allowanceBytes: string | null;
      }[];
      totals: { tenants: number; usedBytes: string };
    };
    expect(overview.data.find((r) => r.tenantId === DEV.tenantId)).toMatchObject({
      level: 'ok',
      allowanceBytes: '5368709120',
    });
    expect(overview.data.find((r) => r.tenantId === other.tenantId)).toMatchObject({
      level: null,
      allowanceBytes: null,
    });
    expect(overview.totals.tenants).toBeGreaterThanOrEqual(2);
    await t.http.get('/v1/admin/storage/tenants').set(bearer(owner)).expect(403);
  });

  it('crossing 80 % notifies the owner once; an optional upload over the allowance is held, legal ones never', async () => {
    // records count 0 bytes here so the test controls usage with files only; 0.0001 GB = 107 374 bytes
    await setPlatform('storage.record_bytes', { _default: 0 });
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/settings/storage.free_gb`)
      .set(bearer(admin))
      .send({ value: { apartment: '0.0001' }, reason: 'ทดสอบ: พื้นที่ฟรีเล็กมาก' })
      .expect(200);
    const base = BigInt((await storage()).fileBytes);
    const fill = Number((107_374n * 85n) / 100n - base);
    expect(fill).toBeGreaterThan(0); // the dev tenant starts with (almost) no files
    await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'tenant',
      fileName: 'fill.pdf',
      mimeType: 'application/pdf',
      body: Buffer.alloc(fill, 1),
    });
    const now = await storage();
    expect(now).toMatchObject({
      metered: true,
      allowanceBytes: '107374',
      level: 'warning',
      freeGb: '0.0001',
    });
    expect(now.usedPercent).toBe(84);

    // the landlord type has no allowance (set above): still not metered — per tenant type, and per tenant override
    expect((await storage(other.token)).metered).toBe(false);

    // optional over the allowance while overage is not sold → held; legal and operational → always stored
    const held = await presign('other', 30_000);
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('storage.allowance_exceeded');
    expect((await presign('contract', 30_000)).status).toBe(201);
    expect((await presign('utility_invoice', 30_000)).status).toBe(201);

    await nextDay();
    await metering().sweep();
    await settle();
    expect(await notices()).toEqual([{ threshold_pct: 80, cleared: false }]);
    const told = await q<{ channel: string; recipient_id: string }>(
      `SELECT n.channel::text, n.recipient_id FROM platform.notification n
         JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'storage.threshold_crossed' AND e.tenant_id = $1 ORDER BY n.channel`,
      [DEV.tenantId],
    );
    expect(told.map((n) => n.channel)).toContain('in_app'); // + line when the owner has LINE linked
    expect(new Set(told.map((n) => n.recipient_id))).toEqual(new Set([DEV.users.owner]));
    const [event] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'storage.threshold_crossed' AND tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(event!.payload).toMatchObject({ thresholdPct: 80, usedPercent: 84, allowanceBytes: '107374' });

    // the next day at the same level: no second notice
    await nextDay();
    await metering().sweep();
    await settle();
    expect(await notices()).toEqual([{ threshold_pct: 80, cleared: false }]);
  });

  it('a legal upload takes the tenant over 100 %: notice once, then overage sold → optional accepted, charge computed', async () => {
    await uploadFile(t, db, owner, {
      kind: 'contract',
      scopeType: 'tenant',
      fileName: 'lease.pdf',
      mimeType: 'application/pdf',
      body: Buffer.alloc(30_000, 2),
    });
    expect((await storage()).level).toBe('over');
    await nextDay();
    await metering().sweep();
    await settle();
    expect((await notices()).map((n) => n.threshold_pct)).toEqual([80, 100]);

    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/settings/storage.price_per_gb_month`)
      .set(bearer(admin))
      .send({ value: { apartment: '10.00' }, reason: 'ทดสอบ: ขายพื้นที่เพิ่ม' })
      .expect(200);
    expect((await presign('other', 30_000)).status).toBe(201);

    const month = bangkokDate(t.clock.now()).slice(0, 7);
    const charge = await t.app
      .get(TenantTx)
      .platform((tx) => metering().monthlyCharge(tx, DEV.tenantId, 'apartment', month));
    expect(charge).toMatchObject({ packsAmount: '0.00' });
    expect(charge!.overageGbMonths).toMatch(/^\d+\.\d{3}$/);
    expect(charge!.total).toMatch(/^\d+\.\d{2}$/);
    expect(BigInt(charge!.averageOverageBytes)).toBeGreaterThan(0n);
    const history = (await storage()).history;
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.map((h) => h.day)).toEqual([...history.map((h) => h.day)].sort());
  });

  it('the usage bar and the snapshots are tenant-scoped (RLS); deleting files is never done by metering', async () => {
    const mine = await storage();
    const theirs = await storage(other.token);
    expect(theirs.fileBytes).toBe('0');
    expect(theirs.history.every((h) => BigInt(h.countedBytes) >= 0n)).toBe(true);
    expect(theirs.history.length).toBeLessThan(mine.history.length + 1);
    // RLS: the application role sees only its own tenant's snapshots
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE gp_app');
      await q(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenantId]);
      const rows = await q<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM platform.storage_usage_daily`,
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([other.tenantId]);
      await expect(
        q(
          `INSERT INTO platform.storage_usage_daily (tenant_id, day, file_bytes, counted_bytes, policy_version)
           VALUES ($1, current_date, 0, 0, 'x')`,
          [DEV.tenantId],
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
    } finally {
      await q('ROLLBACK');
    }
    const live = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.document WHERE tenant_id = $1 AND deleted_at IS NOT NULL`,
      [DEV.tenantId],
    );
    expect(live[0]!.n).toBe(0);
    // snapshots are append-only
    await expect(q(`UPDATE platform.storage_usage_daily SET counted_bytes = 0`)).rejects.toThrow(
      /append-only/,
    );
  });
});
