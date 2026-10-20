import 'reflect-metadata';

import { bangkokDate } from '@common/time/bangkok';
import { AccessService } from '@core/tenancy/access.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const PHONE_B = '+660000000197';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');

interface Task {
  type: string;
  id: string;
  unitNo: string | null;
  priority: string;
  overdue: boolean;
  completable: boolean;
  assigneeUserId: string | null;
}
interface Day {
  total: number;
  groups: { type: string; count: number; floors: { floorId: string | null; tasks: Task[] }[] }[];
}
const flat = (d: Day) => d.groups.flatMap((g) => g.floors.flatMap((f) => f.tasks));

/**
 * B5.4 acceptance (docs/prompts/B5-operations.md 5.4, D-213, D-090): a day of tasks for a staff user over reading
 * requests, inspections, install orders, work orders and parcels, grouped by type and floor with priorities;
 * completing a task updates its source; a Staff login limited to buildings sees only those; another tenant sees
 * nothing (404); the view runs with the caller's RLS.
 */
describe('B5.4 staff tasks (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let other: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const S = () => bearer(staff);
  const day = async (query = '') =>
    (await t.http.get(`/v1/staff/tasks${query}`).set(S()).expect(200)).body as Day;
  const unit = async (no: string) =>
    (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2`, [
        DEV.buildingId,
        no,
      ])
    )[0]!.id;
  const photo = (kind: string) =>
    uploadFile(t, db, staff, {
      kind,
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: `${kind}.jpg`,
      mimeType: 'image/jpeg',
      body: Buffer.concat([JPEG, Buffer.from(kind + Math.random())]),
      surface: 'staff',
    });

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b54' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b54',
      phone: PHONE_B,
      type: 'apartment',
    });
    ids.a101 = await unit('A-101');
    ids.a102 = await unit('A-102');
    const now = t.clock.now();
    ids.today = bangkokDate(now);
    ids.later = bangkokDate(new Date(now.getTime() + 2 * 86_400_000));

    // work orders: mine today (urgent), the manager's today, mine in two days
    const wo = (body: Record<string, unknown>) =>
      t.http
        .post('/v1/owner/work-orders')
        .set(O())
        .send({ buildingId: DEV.buildingId, kind: 'repair', ...body })
        .expect(201)
        .then((r) => r.body.id as string);
    ids.woMine = await wo({
      title: 'ก๊อกน้ำรั่ว',
      unitId: ids.a101,
      priority: 'urgent',
      assigneeUserId: DEV.users.staff,
      scheduledAt: new Date(now.getTime() - 1_800_000).toISOString(),
    });
    ids.woManager = await wo({
      title: 'ไฟทางเดินดับ',
      assigneeUserId: DEV.users.manager,
      scheduledAt: new Date(now.getTime() - 1_800_000).toISOString(),
    });
    ids.woLater = await wo({
      title: 'ล้างแอร์',
      unitId: ids.a102,
      assigneeUserId: DEV.users.staff,
      scheduledAt: `${ids.later}T10:00:00+07:00`,
    });
    // a parcel waiting at the desk for A-102 (never `await` inside a pending supertest chain)
    const parcelPhoto = await photo('service_photo');
    ids.parcel = (
      await t.http
        .post('/v1/staff/parcels')
        .set(S())
        .send({ unitId: ids.a102, carrier: 'Flash', photoDocumentId: parcelPhoto })
        .expect(201)
    ).body.id as string;
    // an inspection of the A-101 lease
    ids.inspection = (
      await t.http
        .post('/v1/staff/inspections')
        .set(S())
        .send({
          leaseId: DEV.leaseId,
          type: 'move_out',
          scheduledFor: new Date(now.getTime() - 3_600_000).toISOString(),
        })
        .expect(201)
    ).body.id as string;
    // a reading request for the A-102 electricity meter, overdue
    const [ma] = await q<{ id: string; asset_item_id: string }>(
      `SELECT id, asset_item_id FROM core.meter_assignment
        WHERE unit_id = $1 AND utility = 'electric' AND valid_to IS NULL`,
      [ids.a102],
    );
    ids.meter = ma!.asset_item_id;
    ids.reading = (
      await q<{ id: string }>(
        `INSERT INTO smart.reading_request (tenant_id, building_id, meter_assignment_id, asset_item_id, assignee_user_id,
                                            requested_at, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          DEV.tenantId,
          DEV.buildingId,
          ma!.id,
          ma!.asset_item_id,
          DEV.users.staff,
          now,
          new Date(now.getTime() - 60_000),
        ],
      )
    )[0]!.id;
    // a platform install order for the building (Collective's field engineers)
    ids.install = (
      await q<{ id: string }>(
        `INSERT INTO platform.install_order (tenant_id, building_id, kind, items)
         VALUES ($1, $2, 'install', '[]'::jsonb) RETURNING id`,
        [DEV.tenantId, DEV.buildingId],
      )
    )[0]!.id;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('a day of tasks: grouped by type and floor, priorities, today only, mine', async () => {
    const today = await day();
    expect(today.groups.map((g) => g.type)).toEqual([
      'work_order',
      'inspection',
      'reading',
      'parcel',
      'install',
    ]);
    const tasks = flat(today);
    const byId = new Map(tasks.map((x) => [x.id, x]));
    expect(byId.has(ids.woLater!)).toBe(false);
    expect(byId.get(ids.woMine!)).toMatchObject({ type: 'work_order', priority: 'urgent', unitNo: 'A-101' });
    expect(byId.get(ids.reading!)).toMatchObject({ type: 'reading', priority: 'high', overdue: true });
    expect(byId.get(ids.inspection!)).toMatchObject({ type: 'inspection', overdue: true, unitNo: 'A-101' });
    expect(byId.get(ids.parcel!)).toMatchObject({ type: 'parcel', unitNo: 'A-102', assigneeUserId: null });
    expect(byId.get(ids.install!)).toMatchObject({ type: 'install', completable: false });
    expect(today.total).toBe(6);
    // work orders: the building-wide one (no floor) first, then by floor
    const wos = today.groups.find((g) => g.type === 'work_order')!;
    expect(wos.floors[0]!.floorId).toBeNull();
    expect(wos.floors[0]!.tasks.map((x) => x.id)).toEqual([ids.woManager]);

    const mine = flat(await day('?mine=true')).map((x) => x.id);
    expect(mine).not.toContain(ids.woManager);
    expect(mine).toEqual(expect.arrayContaining([ids.woMine, ids.reading, ids.parcel, ids.install]));
    const later = flat(await day(`?date=${ids.later}&building=${DEV.buildingId}`)).map((x) => x.id);
    expect(later).toContain(ids.woLater);

    const one = await t.http.get(`/v1/staff/tasks/parcel/${ids.parcel}`).set(S()).expect(200);
    expect(one.body).toMatchObject({ type: 'parcel', sourceStatus: 'received' });
    await t.http.get(`/v1/staff/tasks/parcel/${ids.woMine}`).set(S()).expect(404);
    await t.http.get(`/v1/staff/tasks/bogus/${ids.woMine}`).set(S()).expect(400);
  });

  it('completing a task writes its source', async () => {
    const complete = (type: string, id: string, body: Record<string, unknown>) =>
      t.http.post(`/v1/staff/tasks/${type}/${id}/actions/complete`).set(S()).set(idem()).send(body);

    // work order: the after photo is required by the source's rules
    await complete('work_order', ids.woMine!, {})
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('work_order.photo_required'));
    await t.http.post(`/v1/staff/work-orders/${ids.woMine}/actions/check-in`).set(S()).expect(200);
    const after = await photo('service_photo');
    await t.http
      .post(`/v1/staff/work-orders/${ids.woMine}/photos`)
      .set(S())
      .send({ documentId: after, role: 'after' })
      .expect(200);
    await complete('work_order', ids.woMine!, { note: 'เปลี่ยนก๊อกแล้ว' })
      .expect(200)
      .expect((r) => expect(r.body).toEqual({ type: 'work_order', id: ids.woMine, sourceStatus: 'done' }));
    const wo = await t.http.get(`/v1/owner/work-orders/${ids.woMine}`).set(O()).expect(200);
    expect(wo.body).toMatchObject({ status: 'done', completionNote: 'เปลี่ยนก๊อกแล้ว' });

    // parcel: handed over by staff
    await complete('parcel', ids.parcel!, {}).expect(422);
    await complete('parcel', ids.parcel!, { staffConfirmed: true })
      .expect(200)
      .expect((r) => expect(r.body.sourceStatus).toBe('picked_up'));
    expect((await t.http.get(`/v1/staff/parcels/${ids.parcel}`).set(S()).expect(200)).body).toMatchObject({
      status: 'picked_up',
      pickupConfirmedBy: 'staff',
    });

    // reading request: fulfilled by the reading taken now
    const meterPhoto = await photo('meter_photo');
    const read = await complete('reading', ids.reading!, {
      photoDocumentId: meterPhoto,
      typedValue: '120.000',
    }).expect(200);
    expect(read.body.sourceStatus).toBe('fulfilled');
    const [req] = await q<{ status: string; fulfilled_reading_id: string | null }>(
      'SELECT status::text, fulfilled_reading_id FROM smart.reading_request WHERE id = $1',
      [ids.reading],
    );
    expect(req).toMatchObject({ status: 'fulfilled', fulfilled_reading_id: expect.any(String) });
    for (let i = 0; i < 3; i += 1) await t.worker.tick();

    // inspection: lines filled, then completed and signed through the task
    const current = await t.http.get(`/v1/staff/inspections/${ids.inspection}`).set(S()).expect(200);
    await t.http
      .patch(`/v1/staff/inspections/${ids.inspection}/items`)
      .set(S())
      .set('If-Match', current.headers.etag!)
      .send({
        items: (current.body.items as { itemKey: string }[]).map((i) => ({
          itemKey: i.itemKey,
          condition: 'good',
          ...(i.itemKey.startsWith('meter:') ? { meterRegister: '130.500' } : {}),
        })),
      })
      .expect(200);
    await complete('inspection', ids.inspection!, {
      staffSignaturePng: PNG,
      residentSignaturePng: PNG,
      note: 'คืนกุญแจครบ',
    })
      .expect(200)
      .expect((r) => expect(r.body.sourceStatus).toBe('signed'));

    // install orders belong to Collective's field engineers
    await complete('install', ids.install!, {})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('staff_task.not_completable'));

    // finished work leaves the day
    const left = flat(await day()).map((x) => x.id);
    expect(left).toEqual(expect.arrayContaining([ids.woManager, ids.install]));
    for (const done of [ids.woMine, ids.parcel, ids.reading, ids.inspection])
      expect(left).not.toContain(done);
    await complete('parcel', ids.parcel!, { staffConfirmed: true }).expect(404);
  });

  it('a Staff login limited to buildings sees only those (D-090)', async () => {
    const property = DEV.propertyId;
    ids.buildingB = (
      await t.http
        .post('/v1/owner/buildings')
        .set(O())
        .send({ propertyId: property, code: 'B54', name: 'อาคาร B54', type: 'apartment', floorsCount: 1 })
        .expect(201)
    ).body.id as string;
    ids.woB = (
      await t.http
        .post('/v1/owner/work-orders')
        .set(O())
        .send({
          buildingId: ids.buildingB,
          kind: 'repair',
          title: 'ประตูลิฟต์',
          assigneeUserId: DEV.users.staff,
        })
        .expect(201)
    ).body.id as string;
    expect(flat(await day()).map((x) => x.id)).toContain(ids.woB);

    await q(
      `UPDATE core.membership SET module_scopes = jsonb_build_object('buildingIds', jsonb_build_array($1::text))
        WHERE user_id = $2 AND tenant_id = $3`,
      [DEV.buildingId, DEV.users.staff, DEV.tenantId],
    );
    t.app.get(AccessService).forget(DEV.users.staff);
    staff = await operatorToken(t, '+660000000003');
    try {
      const limited = flat(await day()).map((x) => x.id);
      expect(limited).not.toContain(ids.woB);
      expect(limited).toContain(ids.woManager);
      await t.http.get(`/v1/staff/tasks?building=${ids.buildingB}`).set(S()).expect(404);
      await t.http.get(`/v1/staff/tasks/work_order/${ids.woB}`).set(S()).expect(404);
      await t.http
        .post(`/v1/staff/tasks/work_order/${ids.woB}/actions/complete`)
        .set(S())
        .set(idem())
        .send({})
        .expect(404);
    } finally {
      await q(
        `UPDATE core.membership SET module_scopes = '{}'::jsonb WHERE user_id = $1 AND tenant_id = $2`,
        [DEV.users.staff, DEV.tenantId],
      );
      t.app.get(AccessService).forget(DEV.users.staff);
      staff = await operatorToken(t, '+660000000003');
    }
  });

  it('another tenant sees none of it (404) and the view applies the caller’s RLS', async () => {
    const X = bearer(await operatorToken(t, PHONE_B));
    expect((await t.http.get('/v1/staff/tasks').set(X).expect(200)).body.total).toBe(0);
    await t.http.get(`/v1/staff/tasks/work_order/${ids.woManager}`).set(X).expect(404);
    await t.http.get(`/v1/staff/tasks/install/${ids.install}`).set(X).expect(404);
    await t.http
      .post(`/v1/staff/tasks/work_order/${ids.woManager}/actions/complete`)
      .set(X)
      .set(idem())
      .send({})
      .expect(404);
    const count = (tenantId: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM ops.staff_task'),
        )
        .then((r) => r[0]!.n);
    expect(await count(DEV.tenantId)).toBeGreaterThan(0);
    expect(await count(other.tenantId)).toBe(0);
  });
});
