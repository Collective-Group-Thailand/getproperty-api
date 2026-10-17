import ExcelJS from 'exceljs';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Reads a binary supertest response into a Buffer. */
const binary = (
  res: { on(e: string, cb: (c?: Buffer) => void): void },
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * B2.1 acceptance — property → building → floors → bulk units → Excel import → board; unit status override and the
 * subscription unit count (D-082); cross-tenant 404s; a landlord tenant with a unit grant sees that unit only;
 * RLS on ops.unit_profile / ops.unit_detail / ops.utility_account.
 */
describe('B2.1 properties, buildings, floors, units (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_units' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'landlord-b',
      phone: '+660000000071',
      type: 'landlord',
    });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('owner console flow', () => {
    it('creates a property and a building (owner = operator = tenant)', async () => {
      const p = await t.http
        .post('/v1/owner/properties')
        .set(bearer(owner))
        .send({ code: 'SOUTH', name: 'หอพักตัวอย่าง สาขาใต้', provinceCode: '10' })
        .expect(201);
      ids.property = p.body.id;
      const dup = await t.http
        .post('/v1/owner/properties')
        .set(bearer(owner))
        .send({ code: 'SOUTH', name: 'ซ้ำ' })
        .expect(409);
      expect(dup.body.code).toBe('asset.duplicate');
      const b = await t.http
        .post('/v1/owner/buildings')
        .set(bearer(owner))
        .send({ propertyId: ids.property, code: 'B', name: 'อาคาร B', type: 'apartment', floorsCount: 2 })
        .expect(201);
      ids.building = b.body.id;
      expect(b.body).toMatchObject({
        access: 'operator',
        ownerTenantId: DEV.tenantId,
        operatorTenantId: DEV.tenantId,
      });
      const etag = (await t.http.get(`/v1/owner/buildings/${ids.building}`).set(bearer(owner)).expect(200))
        .headers.etag!;
      await t.http
        .patch(`/v1/owner/buildings/${ids.building}`)
        .set(bearer(owner))
        .send({ floorsCount: 3 })
        .expect(428);
      const upd = await t.http
        .patch(`/v1/owner/buildings/${ids.building}`)
        .set(bearer(owner))
        .set('If-Match', etag)
        .send({ floorsCount: 3 })
        .expect(200);
      expect(upd.body.floorsCount).toBe(3);
      await t.http
        .patch(`/v1/owner/buildings/${ids.building}`)
        .set(bearer(owner))
        .set('If-Match', etag)
        .send({ floorsCount: 4 })
        .expect(412);
    });

    it('adds floors, a room type and bulk units (floor × pattern)', async () => {
      for (const level of [1, 2]) {
        const f = await t.http
          .post(`/v1/owner/buildings/${ids.building}/floors`)
          .set(bearer(owner))
          .send({ level, name: `ชั้น ${level}` })
          .expect(201);
        ids[`floor${level}`] = f.body.id;
      }
      const profile = await t.http
        .post(`/v1/owner/buildings/${ids.building}/unit-profiles`)
        .set(bearer(owner))
        .send({
          name: 'สตูดิโอ',
          areaSqm: '25',
          defaultRent: '5000',
          defaultLeaseLines: [{ kind: 'internet', description: 'เน็ต', amount: '300' }],
        })
        .expect(201);
      ids.profile = profile.body.id;
      expect(profile.body).toMatchObject({ defaultRent: '5000.00', defaultDepositMonths: '1.0' });
      const bulk = await t.http
        .post(`/v1/owner/buildings/${ids.building}/units/bulk`)
        .set(bearer(owner))
        .send({
          floorIds: [ids.floor1, ids.floor2],
          countPerFloor: 6,
          pattern: '{building}-{floor}{nn}',
          unitProfileId: ids.profile,
        })
        .expect(201);
      expect((bulk.body as { unitNo: string }[]).map((u) => u.unitNo)).toEqual([
        'B-101',
        'B-102',
        'B-103',
        'B-104',
        'B-105',
        'B-106',
        'B-201',
        'B-202',
        'B-203',
        'B-204',
        'B-205',
        'B-206',
      ]);
      expect(bulk.body[0]).toMatchObject({
        baseRent: '5000.00',
        areaSqm: '25.00',
        status: 'vacant',
        unitProfileName: 'สตูดิโอ',
      });
      ids.unit = bulk.body[0].id;
      const again = await t.http
        .post(`/v1/owner/buildings/${ids.building}/units/bulk`)
        .set(bearer(owner))
        .send({ floorIds: [ids.floor1], countPerFloor: 2, pattern: '{building}-{floor}{nn}' })
        .expect(409);
      expect(again.body.code).toBe('asset.duplicate');
      const audit = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'unit.bulk_created'`,
      );
      expect(audit.rows[0].n).toBe(1);
      const own = await db.admin.query(
        `SELECT count(*)::int AS n FROM core.unit_ownership o JOIN core.unit u ON u.id = o.unit_id
          WHERE u.building_id = $1 AND o.party_id = (SELECT legal_party_id FROM core.tenant WHERE id = $2)`,
        [ids.building, DEV.tenantId],
      );
      expect(own.rows[0].n).toBe(12); // apartment: the tenant's legal party owns every unit
    });

    it('adds a manual electric and water meter to every unit, refuses a second one', async () => {
      const created = await t.http
        .post(`/v1/owner/buildings/${ids.building}/meters/actions/create-missing`)
        .set(bearer(owner))
        .send({ utilities: ['electric', 'water'] })
        .expect(201);
      expect(created.body).toHaveLength(24);
      const again = await t.http
        .post(`/v1/owner/buildings/${ids.building}/meters/actions/create-missing`)
        .set(bearer(owner))
        .send({ utilities: ['electric'] })
        .expect(201);
      expect(again.body).toHaveLength(0);
      const dup = await t.http
        .post(`/v1/owner/units/${ids.unit}/meters`)
        .set(bearer(owner))
        .send({ utility: 'electric', code: 'B-101-E2' })
        .expect(409);
      expect(dup.body.code).toBe('meter.already_assigned');
      await t.http
        .post(`/v1/owner/buildings/${ids.building}/meters`)
        .set(bearer(owner))
        .send({
          purpose: 'main',
          utility: 'electric',
          code: 'MAIN-E',
          initialReading: '20345.1',
          multiplier: '40',
        })
        .expect(201);
      const list = await t.http.get(`/v1/owner/units/${ids.unit}/meters`).set(bearer(owner)).expect(200);
      expect((list.body as { code: string }[]).map((m) => m.code).sort()).toEqual(['B-101-E', 'B-101-W']);
    });

    it('imports units from Excel: template → upload → preview → commit (creates floor 3, updates a rent)', async () => {
      const tpl = await t.http
        .get(`/v1/owner/buildings/${ids.building}/unit-imports/template`)
        .set(bearer(owner))
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(tpl.headers['content-type']).toContain(XLSX);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tpl.body as ArrayBuffer);
      const ws = wb.getWorksheet('units')!;
      ws.addRow(['B-301', 3, 'room', '30', '5500', 'สตูดิโอ', 'ห้องใหม่']);
      ws.addRow(['B-302', 3, 'room', '30', '5500', '', '']);
      ws.addRow(['B-101', 1, 'room', '25', '5200', 'สตูดิโอ', '']); // existing → update the rent
      const body = Buffer.from(await wb.xlsx.writeBuffer());
      const fileId = await uploadFile(t, db, owner, {
        kind: 'other',
        scopeType: 'building',
        scopeId: ids.building,
        fileName: 'units.xlsx',
        mimeType: XLSX,
        body,
      });
      const noFloors = await t.http
        .post(`/v1/owner/buildings/${ids.building}/unit-imports/actions/preview`)
        .set(bearer(owner))
        .send({ fileId })
        .expect(200);
      expect(noFloors.body.summary).toMatchObject({ create: 0, update: 1, error: 2 });
      expect(noFloors.body.rows[0].errors[0]).toMatchObject({ column: 'floor_level', code: 'notFound' });
      const preview = await t.http
        .post(`/v1/owner/buildings/${ids.building}/unit-imports/actions/preview`)
        .set(bearer(owner))
        .send({ fileId, createFloors: true })
        .expect(200);
      expect(preview.body.summary).toEqual({
        create: 2,
        update: 1,
        unchanged: 0,
        error: 0,
        floorsToCreate: [3],
      });
      await t.http
        .post(`/v1/owner/buildings/${ids.building}/unit-imports/actions/commit`)
        .set(bearer(owner))
        .set(idem())
        .send({ fileId, createFloors: true, previewToken: 'x'.repeat(43) })
        .expect(409);
      await t.http
        .post(`/v1/owner/buildings/${ids.building}/unit-imports/actions/commit`)
        .set(bearer(owner))
        .set(idem())
        .send({ fileId, createFloors: true, previewToken: preview.body.previewToken })
        .expect(200);
      const b101 = await t.http.get(`/v1/owner/units/${ids.unit}`).set(bearer(owner)).expect(200);
      expect(b101.body.baseRent).toBe('5200.00');
      const exported = await t.http
        .get(`/v1/owner/buildings/${ids.building}/units/export`)
        .set(bearer(owner))
        .buffer(true)
        .parse(binary)
        .expect(200);
      const out = new ExcelJS.Workbook();
      await out.xlsx.load(exported.body as ArrayBuffer);
      expect(out.getWorksheet('units')!.rowCount).toBe(15); // header + 14 units
    });

    it('shows the board: floors top first, unit cards with meters', async () => {
      const board = await t.http
        .get(`/v1/owner/buildings/${ids.building}/board`)
        .set(bearer(owner))
        .expect(200);
      expect((board.body.floors as { level: number }[]).map((f) => f.level)).toEqual([3, 2, 1]);
      expect(board.body.summary).toMatchObject({ total: 14, vacant: 14, occupied: 0, occupancyPct: '0.0' });
      const card = board.body.floors[2].units[0] as { meters: unknown };
      expect(card).toMatchObject({
        unitNo: 'B-101',
        status: 'vacant',
        lessee: null,
        balance: null,
        meterHealth: null,
      });
      expect((card.meters as { code: string }[]).map((m) => m.code)).toEqual(['B-101-E', 'B-101-W']);
    });

    it('status override: vacant ↔ maintenance/inactive with a reason; the subscription count excludes inactive', async () => {
      const before = await t.http.get('/v1/owner/units/count').set(bearer(owner)).expect(200);
      const bad = await t.http
        .post(`/v1/owner/units/${ids.unit}/actions/set-status`)
        .set(bearer(owner))
        .send({ status: 'occupied', reason: 'ทดสอบ' })
        .expect(422);
      expect(bad.body.code).toBe('validation.failed');
      await t.http
        .post(`/v1/owner/units/${ids.unit}/actions/set-status`)
        .set(bearer(owner))
        .send({ status: 'inactive', reason: 'ปิดปรับปรุงทั้งห้อง' })
        .expect(200);
      const blocked = await t.http
        .post(`/v1/owner/units/${ids.unit}/actions/set-status`)
        .set(bearer(owner))
        .send({ status: 'maintenance', reason: 'ทดสอบ' })
        .expect(409);
      expect(blocked.body.code).toBe('unit.invalid_status_transition');
      const after = await t.http.get('/v1/owner/units/count').set(bearer(owner)).expect(200);
      expect(after.body.billable).toBe(before.body.billable - 1);
      expect(after.body.inactive).toBe(before.body.inactive + 1);
      const audit = await db.admin.query(
        `SELECT metadata->>'reason' AS reason FROM platform.audit_log WHERE action = 'unit.status_changed' AND subject_id = $1`,
        [ids.unit],
      );
      expect(audit.rows).toEqual([{ reason: 'ปิดปรับปรุงทั้งห้อง' }]);
      await t.http
        .post(`/v1/owner/units/${ids.unit}/actions/set-status`)
        .set(bearer(owner))
        .send({ status: 'vacant', reason: 'เปิดให้เช่าอีกครั้ง' })
        .expect(200);
    });

    it('lists units with filters and the seeded dev building (2 floors × 6 units)', async () => {
      const list = await t.http
        .get(`/v1/owner/units?buildingId=${DEV.buildingId}&perPage=100`)
        .set(bearer(owner))
        .expect(200);
      expect(list.body.meta.total).toBe(12);
      expect(list.body.data[0].unitNo).toBe('A-101');
      const q = await t.http
        .get(`/v1/owner/units?q=B-2&buildingId=${ids.building}`)
        .set(bearer(owner))
        .expect(200);
      expect(q.body.meta.total).toBe(6);
    });
  });

  describe('tenancy (contract §8)', () => {
    it('another tenant gets 404 for every B2.1 resource of tenant A', async () => {
      const B = bearer(other.token);
      for (const path of [
        `/v1/owner/properties/${ids.property}`,
        `/v1/owner/buildings/${ids.building}`,
        `/v1/owner/buildings/${ids.building}/floors`,
        `/v1/owner/buildings/${ids.building}/board`,
        `/v1/owner/buildings/${ids.building}/unit-profiles`,
        `/v1/owner/buildings/${ids.building}/utility-accounts`,
        `/v1/owner/buildings/${ids.building}/meters`,
        `/v1/owner/buildings/${ids.building}/units/export`,
        `/v1/owner/units/${ids.unit}`,
        `/v1/owner/units/${ids.unit}/meters`,
        `/v1/owner/units/${ids.unit}/asset-items`,
      ])
        expect((await t.http.get(path).set(B)).status).toBe(404);
      for (const [method, path, body] of [
        ['post', `/v1/owner/buildings/${ids.building}/floors`, { level: 9, name: 'x' }],
        [
          'post',
          `/v1/owner/buildings/${ids.building}/units/bulk`,
          { floorIds: [ids.floor1], countPerFloor: 1 },
        ],
        ['post', '/v1/owner/units', { buildingId: ids.building, unitNo: 'X-1' }],
        ['post', `/v1/owner/units/${ids.unit}/actions/set-status`, { status: 'inactive', reason: 'ทดสอบ' }],
        ['post', `/v1/owner/units/${ids.unit}/meters`, { utility: 'water' }],
        ['post', `/v1/owner/units/${ids.unit}/asset-items`, { category: 'appliance', name: 'ตู้เย็น' }],
        ['post', `/v1/owner/buildings/${ids.building}/unit-profiles`, { name: 'x', defaultRent: '1' }],
        ['delete', `/v1/owner/unit-profiles/${ids.profile}`, undefined],
      ] as const) {
        const res = await t.http[method](path).set(B).send(body);
        expect([403, 404]).toContain(res.status);
        if (res.status === 403) expect(res.body.code).toBe('asset.read_only');
      }
      const units = await t.http.get('/v1/owner/units').set(B).expect(200);
      expect(units.body.meta.total).toBe(0);
      expect((await t.http.get('/v1/owner/buildings').set(B).expect(200)).body).toEqual([]);
    });

    it('a landlord tenant with a unit grant sees that unit only, read-only (D-152)', async () => {
      await t.http
        .post('/v1/owner/asset-grants')
        .set(bearer(owner))
        .set(idem())
        .send({
          granteeTenantId: other.tenantId,
          buildingId: ids.building,
          unitId: ids.unit,
          modules: ['ops.lease', 'ops.billing'],
          access: 'write',
          reason: 'landlord_unit',
        })
        .expect(201);
      const B = bearer(other.token);
      const units = await t.http.get('/v1/owner/units').set(B).expect(200);
      expect((units.body.data as { id: string }[]).map((u) => u.id)).toEqual([ids.unit]);
      const one = await t.http.get(`/v1/owner/units/${ids.unit}`).set(B).expect(200);
      // the unit detail is visible through the ops.lease unit grant; the room type is building data (core.asset)
      expect(one.body.unitProfileId).toBe(ids.profile);
      expect(one.body.unitProfileName).toBeNull();
      const etag = one.headers.etag!;
      const edit = await t.http
        .patch(`/v1/owner/units/${ids.unit}`)
        .set(B)
        .set('If-Match', etag)
        .send({ notes: 'แก้โดยผู้รับสิทธิ์' })
        .expect(403);
      expect(edit.body.code).toBe('asset.read_only');
      expect((await t.http.get(`/v1/owner/buildings/${ids.building}/board`).set(B)).status).toBe(404);
      const other12 = (await t.http.get(`/v1/owner/units?buildingId=${ids.building}`).set(B).expect(200))
        .body;
      expect(other12.meta.total).toBe(1);
    });
  });

  describe('RLS on the B2.1 tables', () => {
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);

    beforeAll(async () => {
      await t.http
        .post(`/v1/owner/buildings/${ids.building}/utility-accounts`)
        .set(bearer(owner))
        .send({ utility: 'electric', provider: 'mea', customerNo: '000012345678', label: 'มิเตอร์หลัก' })
        .expect(201);
    });

    it('ops.unit_profile / ops.utility_account: invisible to another tenant, even with a unit grant', async () => {
      expect(await count(DEV.tenantId, 'ops.unit_profile')).toBe(3);
      expect(await count(DEV.tenantId, 'ops.utility_account')).toBe(1);
      expect(await count(other.tenantId, 'ops.unit_profile')).toBe(0);
      expect(await count(other.tenantId, 'ops.utility_account')).toBe(0);
    });

    it('ops.unit_detail: the granted unit only (ops.lease unit grant); invisible without', async () => {
      expect(await count(DEV.tenantId, 'ops.unit_detail')).toBe(26);
      expect(await count(other.tenantId, 'ops.unit_detail')).toBe(1);
      const third = (
        await db.admin.query<{ id: string }>(
          `INSERT INTO core.tenant (slug, display_name, legal_name, legal_form) VALUES ('third', 'Third', 'Third Co.', 'company') RETURNING id`,
        )
      ).rows[0]!.id;
      expect(await count(third, 'ops.unit_detail')).toBe(0);
    });

    it('writes stamped with another tenant are refused', async () => {
      await expect(
        db.prisma().withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.unitProfile.create({
            data: { tenantId: DEV.tenantId, buildingId: ids.building!, name: 'แอบ', defaultRent: '1' },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        db.prisma().withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.utilityAccount.create({
            data: {
              tenantId: DEV.tenantId,
              buildingId: ids.building!,
              utility: 'water',
              provider: 'mwa',
              customerNo: '99999999',
              label: 'x',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});
