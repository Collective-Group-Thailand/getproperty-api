import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { DocumentsService } from '@core/documents/documents.service';
import { StorageReclaimService } from '@core/storage/storage-reclaim.service';
import { StorageReconciliationService } from '@core/storage/storage-reconciliation.service';
import { TenantTx } from '@database/tenant-tx';
import { StoragePackagesService } from '@modules/platform-subscriptions/storage-packages.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

/** Deterministic PRNG (mulberry32) for the property test: the same seed replays the same sequence. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * G1 acceptance (docs/prompts/G-growth-api.md G1, D-285, D-286; real PostgreSQL, fake object storage): usage stays
 * exact through uploads, derivatives, deletes and purges (seeded property test); the nightly reconciliation fixes
 * injected drift and reports orphans / missing keys; a legal document is counted, held and undeletable (API and the
 * hold table's trigger) and a receipt is issued over the quota; an optional upload over the quota is refused with the
 * position; a storage package raises the quota only after its purchase invoice is paid and its expiry deletes
 * nothing; reclaim deletes softly, restores, purges after the window; the quota override; cross-tenant 404.
 */
describe('G1 storage quota, legal hold, packages and reclaim (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let other: { tenantId: string; token: string };
  let unitA101: string;
  let month = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const A = () => bearer(admin);
  const fakeS3 = () => t.app.get<FakeObjectStorage>(OBJECT_STORAGE);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const relogin = async () => {
    admin = await adminToken(t);
    owner = await ownerToken(t);
    other = { ...other, token: await operatorToken(t, '+660000000285') };
  };
  const jump = async (days: number) => {
    const day = addCalendarDays(bangkokDate(t.clock.now()), days);
    t.clock.set(new Date(startOfBangkokDay(day).getTime() + 10 * 3_600_000));
    await relogin();
  };
  const s3Bytes = (tenantId = DEV.tenantId) => {
    let sum = 0n;
    for (const [key, v] of fakeS3().objects)
      if (key.startsWith(`t/${tenantId}/`)) sum += BigInt(v.body.length);
    return sum;
  };
  const counters = async (tenantId = DEV.tenantId) =>
    BigInt(
      (
        await q<{ b: string }>(
          `SELECT coalesce(sum(bytes), 0)::text AS b FROM platform.storage_usage WHERE tenant_id = $1`,
          [tenantId],
        )
      )[0]!.b,
    );
  const ledger = async (tenantId = DEV.tenantId) =>
    BigInt(
      (
        await q<{ b: string }>(
          `SELECT coalesce(sum(bytes), 0)::text AS b FROM platform.document_storage WHERE tenant_id = $1 AND counted`,
          [tenantId],
        )
      )[0]!.b,
    );
  /** The invariant: counters = ledger = what object storage holds under the tenant prefix. */
  const expectExact = async (label: string) => {
    const [c, l] = [await counters(), await ledger()];
    expect({ label, counters: c, ledger: l }).toEqual({ label, counters: s3Bytes(), ledger: s3Bytes() });
  };
  const storage = async (token = owner) =>
    (await t.http.get('/v1/owner/storage').set(bearer(token)).expect(200)).body as {
      fileBytes: string;
      usedBytes: string;
      allowanceBytes: string | null;
      freeBytes: string | null;
      packageBytes: string;
      level: string | null;
      legalHoldBytes: string;
      pendingPurgeBytes: string;
      categories: { category: string; bytes: string; objects: number }[];
    };
  const pdf = (size: number, seed: number) =>
    Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, seed % 251)]);
  const png = (w: number, h: number, color: string) =>
    sharp({ create: { width: w, height: h, channels: 3, background: color } })
      .png()
      .toBuffer();
  const presign = (kind: string, sizeBytes: number, mimeType = 'application/pdf') =>
    t.http
      .post('/v1/owner/files/presign')
      .set(O())
      .send({
        kind,
        scopeType: 'tenant',
        fileName: `${kind}.pdf`,
        mimeType,
        sizeBytes,
        sha256: createHash('sha256').update(String(sizeBytes)).digest('hex'),
      });

  /** A draft invoice for A-101 issued through the API, then paid in cash: the receipt PDF follows in the worker. */
  async function paidInvoice(subtotal: string): Promise<{ invoiceId: string; paymentId: string }> {
    month += 1;
    const start = `2025-${String(month).padStart(2, '0')}-01`;
    const [inv] = await q<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                subtotal, vat_amount, total, balance)
       VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, $7, 0, $7, $7)
       RETURNING id`,
      [DEV.tenantId, DEV.buildingId, unitA101, DEV.residentPartyId, DEV.leaseId, start, subtotal],
    );
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
       VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', $3, $3)`,
      [DEV.tenantId, inv!.id, subtotal],
    );
    await t.http
      .post(`/v1/owner/invoices/${inv!.id}/actions/issue`)
      .set(O())
      .set(idem())
      .send({})
      .expect(200);
    await settle();
    const pay = await t.http.post('/v1/owner/payments').set(O()).set(idem()).send({
      invoiceId: inv!.id,
      amount: subtotal,
      method: 'cash',
      paidAt: t.clock.now().toISOString(),
      reference: 'เงินสด',
    });
    if (pay.status !== 201 && pay.status !== 200) throw new Error(JSON.stringify(pay.body));
    await settle();
    return { invoiceId: inv!.id, paymentId: pay.body.id as string };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g1' });
    t = await createIntApp(db);
    admin = await adminToken(t);
    owner = await ownerToken(t);
    other = await onboardTenant(t, admin, { slug: 'other-g1', phone: '+660000000285', type: 'landlord' });
    unitA101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    // records count 0 bytes here so the quota is driven by files only
    await t.http
      .put('/v1/admin/settings/storage.record_bytes')
      .set(A())
      .send({ value: { _default: 0 }, reason: 'ทดสอบ G1' })
      .expect(200);
  }, 180_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('starts aligned: the first reconciliation sets the counters to what object storage holds', async () => {
    const result = await t.app.get(StorageReconciliationService).reconcile(DEV.tenantId);
    expect(result.corrected).toBe(true);
    await expectExact('after the first reconciliation');
    // the migration seeded the counter rows from live documents; every category is reported
    const s = await storage();
    expect(s.categories.map((c) => c.category).sort()).toEqual(
      ['attachment', 'listing_media', 'system_legal', 'system_other'].sort(),
    );
  });

  it('usage stays exact through uploads, derivatives, deletes, restores and purges (seeded property test)', async () => {
    const rnd = prng(0x6e1);
    const reclaim = t.app.get(StorageReclaimService);
    const live: string[] = [];
    for (let step = 0; step < 18; step += 1) {
      const r = rnd();
      if (r < 0.4 || live.length === 0) {
        // optional pdf attachment (no derivative)
        live.push(
          await uploadFile(t, db, owner, {
            kind: 'other',
            scopeType: 'tenant',
            fileName: `a${step}.pdf`,
            mimeType: 'application/pdf',
            body: pdf(500 + Math.floor(rnd() * 20_000), step),
          }),
        );
      } else if (r < 0.65) {
        // an image: the scan adds a 320 px WebP thumbnail (a derivative object)
        live.push(
          await uploadFile(t, db, owner, {
            kind: 'other',
            scopeType: 'tenant',
            fileName: `p${step}.png`,
            mimeType: 'image/png',
            body: await png(200 + Math.floor(rnd() * 600), 100 + Math.floor(rnd() * 400), '#3a7bd5'),
          }),
        );
      } else if (r < 0.8) {
        // a listing photo: re-encoded without metadata (resize of the original) + 3 renditions + thumbnail
        live.push(
          await uploadFile(t, db, owner, {
            kind: 'listing_photo',
            scopeType: 'unit',
            scopeId: unitA101,
            fileName: `l${step}.jpg`,
            mimeType: 'image/jpeg',
            body: await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#c27a7a' } })
              .jpeg()
              .toBuffer(),
          }),
        );
      } else {
        // delete one for reclaim (still counted), sometimes restore it
        const id = live.splice(Math.floor(rnd() * live.length), 1)[0]!;
        await t.http
          .post('/v1/owner/storage/files/actions/delete')
          .set(O())
          .send({ documentIds: [id] })
          .expect(200);
        if (rnd() < 0.3) {
          await t.http
            .post('/v1/owner/storage/files/actions/restore')
            .set(O())
            .send({ documentIds: [id] })
            .expect(200);
          live.push(id);
        }
      }
      await expectExact(`step ${step}`);
    }
    const listed = (await t.http.get('/v1/owner/storage/files?sort=size&perPage=100').set(O()).expect(200))
      .body as {
      data: { id: string; bytes: string; objects: number; kind: string }[];
    };
    const sizes = listed.data.map((f) => BigInt(f.bytes));
    expect([...sizes].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))).toEqual(sizes); // largest first
    const photo = listed.data.find((f) => f.kind === 'listing_photo');
    if (photo) expect(photo.objects).toBe(5); // file + 3 renditions + thumbnail

    const pending = (await t.http.get('/v1/owner/storage/files?state=deleted').set(O()).expect(200)).body as {
      data: { id: string; purgeAfter: string }[];
    };
    const before = await counters();
    const pendingBytes = BigInt((await storage()).pendingPurgeBytes);
    expect(await reclaim.purge()).toBe(0); // inside the window: nothing purged
    await jump(8);
    expect(await reclaim.purge()).toBe(pending.data.length);
    expect(await counters()).toBe(before - pendingBytes);
    await expectExact('after the purge');
    for (const f of pending.data)
      expect((await q(`SELECT upload_state::text AS s FROM core.document WHERE id = $1`, [f.id]))[0]).toEqual(
        { s: 'deleted' },
      );
    // purged files cannot be restored
    if (pending.data[0])
      await t.http
        .post('/v1/owner/storage/files/actions/restore')
        .set(O())
        .send({ documentIds: [pending.data[0].id] })
        .expect(409);
  });

  it('the reconciliation fixes injected drift and reports orphans and missing keys', async () => {
    const reconciliation = t.app.get(StorageReconciliationService);
    await q(
      `UPDATE platform.storage_usage SET bytes = bytes + 12345 WHERE tenant_id = $1 AND category = 'attachment'`,
      [DEV.tenantId],
    );
    const [thumb] = await q<{ document_id: string; key: string }>(
      `SELECT document_id, derivative_keys[1] AS key FROM platform.document_storage
        WHERE tenant_id = $1 AND counted AND cardinality(derivative_keys) > 0 LIMIT 1`,
      [DEV.tenantId],
    );
    expect(thumb).toBeDefined();
    fakeS3().objects.delete(thumb!.key);
    fakeS3().putDirect(
      `t/${DEV.tenantId}/other/2026/10/orphan-object`,
      Buffer.alloc(777, 1),
      'application/pdf',
    );
    const r = await reconciliation.reconcile(DEV.tenantId);
    expect(r.missing).toContain(thumb!.key);
    expect(r.orphans).toContain(`t/${DEV.tenantId}/other/2026/10/orphan-object`);
    expect(r.corrected).toBe(true);
    // counters = what the documents occupy (the orphan is reported, not counted)
    expect(await counters()).toBe(s3Bytes() - 777n);
    expect(await counters()).toBe(await ledger());
    const report = await t.http
      .get(`/v1/admin/storage/reconciliations?tenantId=${DEV.tenantId}`)
      .set(A())
      .expect(200);
    expect(report.body.data[0]).toMatchObject({ tenantId: DEV.tenantId, corrected: true });
    expect(report.body.data[0].details).toMatchObject({ orphanCount: 1, missingCount: 1 });
    fakeS3().objects.delete(`t/${DEV.tenantId}/other/2026/10/orphan-object`);
    const again = await t.http
      .post(`/v1/admin/storage/tenants/${DEV.tenantId}/actions/reconcile`)
      .set(A())
      .expect(200);
    expect(again.body).toMatchObject({ driftBytes: '0', corrected: false });
    await t.http.get('/v1/admin/storage/reconciliations').set(O()).expect(403);
  });

  it('over the quota: optional uploads refused with the position; a receipt is still issued, counted and held', async () => {
    const quota = await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/storage-quota`)
      .set(A())
      .send({ freeGb: '0.0001', reason: 'ทดสอบ G1: พื้นที่ฟรีเล็กมาก' })
      .expect(200);
    expect(quota.body).toMatchObject({ tenantId: DEV.tenantId, freeGb: '0.0001' });
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/storage-quota`)
      .set(O())
      .send({ freeGb: '1', reason: 'x x x' })
      .expect(403);
    const s = await storage();
    expect(BigInt(s.usedBytes)).toBeGreaterThan(107374n); // the property test stored more than 0.0001 GB
    expect(s).toMatchObject({ freeBytes: '107374', packageBytes: '0', level: 'over' });

    const held = await presign('other', 30_000);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({
      code: 'storage.allowance_exceeded',
      storage: { allowanceBytes: '107374', packagesUrl: '/v1/owner/storage/packages' },
    });
    expect((await presign('slip', 30_000)).status).toBe(201); // payment evidence is never refused (D-286)

    const before = await counters();
    const { paymentId } = await paidInvoice('4500.00');
    const [receipt] = await q<{ document_id: string | null }>(
      `SELECT document_id FROM ops.receipt WHERE payment_id = $1`,
      [paymentId],
    );
    expect(receipt?.document_id).toBeTruthy();
    const docId = receipt!.document_id!;
    const [row] = await q<{ category: string; counted: boolean; bytes: string }>(
      `SELECT category::text, counted, bytes::text FROM platform.document_storage WHERE document_id = $1`,
      [docId],
    );
    expect(row).toMatchObject({ category: 'system_legal', counted: true });
    expect(await counters()).toBeGreaterThan(before); // counted although the tenant is over
    const [hold] = await q<{
      document_kind: string;
      retain_until: string | null;
      retention_policy_id: string | null;
    }>(
      `SELECT document_kind, retain_until::text, retention_policy_id FROM platform.document_legal_hold WHERE document_id = $1`,
      [docId],
    );
    expect(hold).toMatchObject({ document_kind: 'pdf_receipt' });
    expect(hold!.retention_policy_id).not.toBeNull();
    expect(hold!.retain_until! > addCalendarDays(bangkokDate(t.clock.now()), 4 * 365)).toBe(true);
    expect(BigInt((await storage()).legalHoldBytes)).toBeGreaterThanOrEqual(BigInt(row!.bytes));

    // undeletable: the API refuses (whole request), the listing says why, the hold table's trigger refuses too
    const refused = await t.http
      .post('/v1/owner/storage/files/actions/delete')
      .set(O())
      .send({ documentIds: [docId] })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'storage.legal_hold', heldDocumentIds: [docId] });
    const legal = (
      await t.http.get('/v1/owner/storage/files?category=system_legal&perPage=100').set(O()).expect(200)
    ).body as { data: { id: string; held: boolean; deletable: boolean; notDeletableReason: string }[] };
    expect(legal.data.find((f) => f.id === docId)).toMatchObject({
      held: true,
      deletable: false,
      notDeletableReason: 'legal_hold',
    });
    await expect(
      q(`DELETE FROM platform.document_legal_hold WHERE document_id = $1`, [docId]),
    ).rejects.toThrow(/storage\.legal_hold/);
    await expect(
      q(`UPDATE platform.document_legal_hold SET released_at = now() WHERE document_id = $1`, [docId]),
    ).rejects.toThrow(/storage\.legal_hold/);
    await expect(
      q(`UPDATE platform.document_legal_hold SET retain_until = current_date WHERE document_id = $1`, [
        docId,
      ]),
    ).rejects.toThrow(/storage\.legal_hold/);
    // a system file and an evidence kind are not reclaimable either
    const [systemFile] = await q<{ document_id: string }>(
      `SELECT document_id FROM platform.document_storage WHERE tenant_id = $1 AND counted AND category = 'system_other' LIMIT 1`,
      [DEV.tenantId],
    );
    if (systemFile)
      expect(
        (
          await t.http
            .post('/v1/owner/storage/files/actions/delete')
            .set(O())
            .send({ documentIds: [systemFile.document_id] })
            .expect(409)
        ).body.code,
      ).toBe('storage.not_deletable');
    await expectExact('after the receipt');
  });

  it('a storage package is not sold without a price, raises the quota once paid and expires without deleting', async () => {
    const created = await t.http
      .post('/v1/admin/storage/packages')
      .set(A())
      .send({
        key: 'storage_plus_test',
        nameTh: 'พื้นที่เพิ่ม 1 GB',
        nameEn: 'Extra 1 GB',
        sizeGb: '1',
        period: 'month',
        visibility: 'public',
        effectiveFrom: bangkokDate(t.clock.now()),
      })
      .expect(201);
    expect(created.body).toMatchObject({
      sizeBytes: '1073741824',
      onSale: false,
      unitPrice: null,
      versionState: 'draft',
    });
    await t.http.post('/v1/admin/storage/packages').set(O()).send({}).expect(403);
    const packageId = created.body.id as string;
    const offers = (await t.http.get('/v1/owner/storage/packages').set(O()).expect(200)).body as {
      offers: { id: string; onSale: boolean; price: string | null }[];
    };
    expect(offers.offers.find((o) => o.id === packageId)).toMatchObject({ onSale: false, price: null });
    const notOnSale = await t.http
      .post('/v1/owner/storage/packages')
      .set(O())
      .set(idem())
      .send({ packageId })
      .expect(409);
    expect(notOnSale.body.code).toBe('storage.package_not_on_sale');

    // the admin sets the price (a new version, terms kept) and publishes it from today
    const version = await t.http
      .post(`/v1/admin/price-plans/${packageId}/versions`)
      .set(A())
      .set(idem())
      .send({
        effectiveFrom: bangkokDate(t.clock.now()),
        billingUnit: 'per_package',
        unitPrice: '100',
        vatRate: '0.07',
      })
      .expect(201);
    await t.http
      .post(`/v1/admin/price-plans/versions/${version.body.id}/actions/publish`)
      .set(A())
      .expect(200);
    const offer = (
      (await t.http.get('/v1/owner/storage/packages').set(O()).expect(200)).body.offers as {
        id: string;
        onSale: boolean;
        price: string;
        total: string;
      }[]
    ).find((o) => o.id === packageId);
    expect(offer).toMatchObject({ onSale: true, price: '100.00', total: '107.00' });

    const key = idem();
    const bought = await t.http
      .post('/v1/owner/storage/packages')
      .set(O())
      .set(key)
      .send({ packageId })
      .expect(201);
    expect(bought.body).toMatchObject({ state: 'pending_payment', price: '107.00', startsOn: null });
    expect(bought.body.invoice).toMatchObject({ total: '107.00', state: 'issued' });
    const replay = await t.http
      .post('/v1/owner/storage/packages')
      .set(O())
      .set(key)
      .send({ packageId })
      .expect(201);
    expect(replay.body.id).toBe(bought.body.id);
    expect(
      (await t.http.post('/v1/owner/storage/packages').set(O()).set(idem()).send({ packageId }).expect(409))
        .body.code,
    ).toBe('storage.package_pending');
    const [inv] = await q<{ kind: string; subscription_id: string | null; line_kind: string }>(
      `SELECT i.kind::text, i.subscription_id, l.kind::text AS line_kind FROM platform.platform_invoice i
         JOIN platform.platform_invoice_line l ON l.invoice_id = i.id WHERE i.id = $1`,
      [bought.body.invoice.id],
    );
    expect(inv).toEqual({ kind: 'purchase', subscription_id: null, line_kind: 'storage' });
    // unpaid: the quota is unchanged and optional uploads stay held
    expect((await storage()).packageBytes).toBe('0');
    expect((await presign('other', 30_000)).status).toBe(409);
    // another tenant never sees it
    await t.http.get(`/v1/owner/storage/packages/${bought.body.id}`).set(bearer(other.token)).expect(404);

    // Finance records the bank transfer → paid → active from today
    await t.http
      .post(`/v1/admin/platform-invoices/${bought.body.invoice.id}/payments`)
      .set(A())
      .set(idem())
      .send({
        amount: '107.00',
        method: 'bank_transfer',
        paidAt: t.clock.now().toISOString(),
        reference: 'KTB-G1-0001',
      })
      .expect(201);
    await settle();
    const active = await t.http.get(`/v1/owner/storage/packages/${bought.body.id}`).set(O()).expect(200);
    expect(active.body).toMatchObject({ state: 'active', startsOn: bangkokDate(t.clock.now()) });
    const raised = await storage();
    expect(raised.packageBytes).toBe('1073741824');
    expect(BigInt(raised.allowanceBytes!)).toBe(107374n + 1073741824n);
    expect((await presign('other', 30_000)).status).toBe(201);

    // the period ends → expired; nothing is deleted, optional uploads are held again
    const docs = async () =>
      Number(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM core.document WHERE tenant_id = $1 AND deleted_at IS NULL`,
            [DEV.tenantId],
          )
        )[0]!.n,
      );
    const kept = await docs();
    await jump(32);
    const result = await t.app.get(StoragePackagesService).maintain();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(
      (await t.http.get(`/v1/owner/storage/packages/${bought.body.id}`).set(O()).expect(200)).body.state,
    ).toBe('expired');
    expect((await storage()).packageBytes).toBe('0');
    expect((await presign('other', 30_000)).status).toBe(409);
    expect(await docs()).toBe(kept);
  });

  it('reclaim refuses evidence and is tenant-scoped; a generated legal file via the service is held', async () => {
    // lift the quota for uploads in this test
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/storage-quota`)
      .set(A())
      .send({ freeGb: '5', reason: 'ทดสอบ G1: คืนค่าเดิม' })
      .expect(200);
    const meter = await uploadFile(t, db, owner, {
      kind: 'meter_photo',
      scopeType: 'tenant',
      fileName: 'm.png',
      mimeType: 'image/png',
      body: await png(120, 80, '#222222'),
    }).catch(() => null);
    if (meter) {
      const r = await t.http
        .post('/v1/owner/storage/files/actions/delete')
        .set(O())
        .send({ documentIds: [meter] })
        .expect(409);
      expect(r.body.code).toBe('storage.not_deletable');
    }
    const mine = await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'tenant',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      body: pdf(1000, 9),
    });
    await t.http
      .post('/v1/owner/storage/files/actions/delete')
      .set(bearer(other.token))
      .send({ documentIds: [mine] })
      .expect(404);
    await t.http.get('/v1/owner/storage/files').set(bearer(other.token)).expect(200);

    // a TM30-like export stored with an explicit hold key is held; its counted bytes move to system_legal
    const documents = t.app.get(DocumentsService);
    const doc = await t.app.get(TenantTx).tenant({ tenantId: DEV.tenantId, source: 'path' }, (tx) =>
      documents.storeGenerated(tx, {
        tenantId: DEV.tenantId,
        kind: 'export',
        scopeType: 'tenant',
        scopeId: DEV.tenantId,
        buildingId: null,
        title: 'tm30.xlsx',
        mimeType: 'application/octet-stream',
        body: Buffer.alloc(2048, 3),
        holdPolicyKey: 'tm30_export',
      }),
    );
    expect(
      (
        await q(`SELECT category::text AS c FROM platform.document_storage WHERE document_id = $1`, [doc.id])
      )[0],
    ).toEqual({ c: 'system_legal' });
    expect(
      (await q(`SELECT document_kind FROM platform.document_legal_hold WHERE document_id = $1`, [doc.id]))[0],
    ).toEqual({ document_kind: 'tm30_export' });
    await expectExact('end');
  });
});
