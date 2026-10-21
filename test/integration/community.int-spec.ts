import 'reflect-metadata';

import { bangkokDate } from '@common/time/bangkok';
import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000b5c301';
const PHONE_B = '+660000000195';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

/**
 * B5.3 acceptance (docs/prompts/B5-operations.md 5.3, D-073, blueprint A1.6): announcement → LINE push → read
 * receipts; parcel received → resident notified with a PIN → handed over (PIN or staff) or returned; facility booking
 * within the weekly quota, a double booking refused by the exclusion constraint (409), the quota enforced; building
 * rules acknowledged at lease signing (B2.3 hook) and in the app; contacts; cross-tenant 404s and RLS on every table.
 */
describe('B5.3 community (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let residentRefresh: string;
  let other: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const unit = async (no: string) =>
    (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2`, [
        DEV.buildingId,
        no,
      ])
    )[0]!.id;
  // access tokens live 15 minutes: refresh before each use so clock jumps do not log anybody out
  const relogin = async () => {
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
  };
  const O = () => bearer(owner);
  const S = () => bearer(staff);
  let resident = '';
  const R = () => bearer(resident);
  // never `.set(await …)` on a pending supertest request: build the request after every await
  const refreshResident = async () => {
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: residentRefresh }).expect(200);
    residentRefresh = r.body.refreshToken as string;
    resident = r.body.accessToken as string;
  };
  const told = async (type: string, aggregateId: string) =>
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = $1 AND e.aggregate_id = $2`,
        [type, aggregateId],
      )
    )[0]!.n;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b53' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    await relogin();
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b53',
      phone: PHONE_B,
      type: 'apartment',
    });
    ids.a101 = await unit('A-101');
    ids.a102 = await unit('A-102');
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(O())
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า B53' }) })
      .expect(200);
    const R0 = bearer(login.body.accessToken as string);
    const purposes = await t.http.get('/v1/resident/consents').set(R0).expect(200);
    await t.http
      .post('/v1/resident/consents')
      .set(R0)
      .send({
        items: (purposes.body as { key: string; version: number; required: boolean }[])
          .filter((x) => x.required)
          .map((x) => ({ purposeKey: x.key, version: x.version, granted: true })),
      })
      .expect(201);
    await t.http.post(`/v1/resident/invitations/${code}/accept`).set(R0).expect(200);
    residentRefresh = login.body.refreshToken as string;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('announcement → LINE push → read receipts; the audience filter hides it from other units', async () => {
    await refreshResident();
    const created = await t.http
      .post('/v1/owner/announcements')
      .set(O())
      .send({
        buildingId: DEV.buildingId,
        title: 'งดจ่ายน้ำวันเสาร์',
        bodyTh: 'งดจ่ายน้ำเวลา 9:00–12:00',
        translations: { en: { title: 'Water outage', body: 'No water 9–12.' } },
        pinned: true,
        publish: true,
      })
      .expect(201);
    ids.ann = created.body.id as string;
    expect(created.body).toMatchObject({ pinned: true, readCount: 0, audienceFilter: {} });
    expect(created.body.publishedAt).not.toBeNull();
    expect(Object.keys(created.body.translations as object)).toEqual(['en']);
    // a draft for A-102 only: the A-101 resident never sees it, even once published
    const draft = await t.http
      .post('/v1/owner/announcements')
      .set(O())
      .send({
        buildingId: DEV.buildingId,
        title: 'เฉพาะห้อง A-102',
        bodyTh: 'x',
        audienceFilter: { unitIds: [ids.a102] },
      })
      .expect(201);
    expect(draft.body.publishedAt).toBeNull();
    await t.http.post(`/v1/owner/announcements/${draft.body.id}/actions/publish`).set(O()).expect(200);
    await t.http.post(`/v1/owner/announcements/${draft.body.id}/actions/publish`).set(O()).expect(409);
    await t.http
      .patch(`/v1/owner/announcements/${ids.ann}`)
      .set(O())
      .send({ title: 'แก้หัวข้อ' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('announcement.published'));
    await settle();
    expect(await told('announcement.published', ids.ann)).toBeGreaterThan(0);

    const R1 = R();
    const list = await t.http.get('/v1/resident/announcements').set(R1).expect(200);
    expect((list.body.data as { id: string }[]).map((a) => a.id)).toEqual([ids.ann]);
    expect(list.body.data[0]).toMatchObject({ language: 'th', title: 'งดจ่ายน้ำวันเสาร์', readAt: null });
    await t.http.post(`/v1/resident/announcements/${draft.body.id}/actions/read`).set(R1).expect(404);
    const read = await t.http.post(`/v1/resident/announcements/${ids.ann}/actions/read`).set(R1).expect(200);
    expect(read.body.data[0].readAt).not.toBeNull();
    await t.http.post(`/v1/resident/announcements/${ids.ann}/actions/read`).set(R1).expect(200);

    const receipts = await t.http.get(`/v1/owner/announcements/${ids.ann}/reads`).set(O()).expect(200);
    expect(receipts.body.audience).toBeGreaterThanOrEqual(1);
    expect(receipts.body.data).toEqual([expect.objectContaining({ partyId: DEV.residentPartyId })]);
    expect((await t.http.get(`/v1/owner/announcements/${ids.ann}`).set(O()).expect(200)).body.readCount).toBe(
      1,
    );
    // archived → gone from the LIFF, kept for the owner
    await t.http.post(`/v1/owner/announcements/${ids.ann}/actions/archive`).set(O()).expect(200);
    expect((await t.http.get('/v1/resident/announcements').set(R()).expect(200)).body.data).toEqual([]);
    const all = await t.http.get('/v1/owner/announcements').set(O()).expect(200);
    expect(all.body.data).toHaveLength(2);
  });

  it('parcel flow: received with a photo → resident told with a PIN → handed over or returned', async () => {
    await refreshResident();
    const photo = () =>
      uploadFile(t, db, staff, {
        kind: 'service_photo',
        scopeType: 'building',
        scopeId: DEV.buildingId,
        fileName: 'parcel.jpg',
        mimeType: 'image/jpeg',
        body: JPEG,
        surface: 'staff',
      });
    const photos = [await photo(), await photo(), await photo()];
    const received = await t.http
      .post('/v1/staff/parcels')
      .set(S())
      .send({ unitId: ids.a101, carrier: 'Kerry Express', trackingNo: 'KEX1', photoDocumentId: photos[0] })
      .expect(201);
    ids.parcel = received.body.id as string;
    expect(received.body).toMatchObject({ status: 'received', unitNo: 'A-101' });
    await settle();
    expect((await t.http.get(`/v1/staff/parcels/${ids.parcel}`).set(S()).expect(200)).body.status).toBe(
      'notified',
    );
    expect(await told('parcel.received', ids.parcel)).toBeGreaterThan(0);

    const mine = await t.http.get('/v1/resident/parcels').set(R()).expect(200);
    const pin = (mine.body.data as { id: string; pin: string }[]).find((p) => p.id === ids.parcel)!.pin;
    expect(pin).toMatch(/^\d{6}$/);
    // the PIN is stored encrypted, never in clear
    const raw = await q<{ row: string }>(
      `SELECT row_to_json(p)::text AS row FROM ops.parcel p WHERE id = $1`,
      [ids.parcel],
    );
    expect(raw[0]!.row).not.toContain(pin);

    const wrong = pin === '111111' ? '222222' : '111111';
    await t.http
      .post(`/v1/staff/parcels/${ids.parcel}/actions/pick-up`)
      .set(S())
      .send({ pin: wrong })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('parcel.pin_mismatch'));
    const picked = await t.http
      .post(`/v1/staff/parcels/${ids.parcel}/actions/pick-up`)
      .set(S())
      .send({ pin })
      .expect(200);
    expect(picked.body).toMatchObject({ status: 'picked_up', pickupConfirmedBy: 'resident_pin' });
    await t.http.post(`/v1/staff/parcels/${ids.parcel}/actions/pick-up`).set(S()).send({ pin }).expect(409);
    const after = await t.http.get('/v1/resident/parcels').set(R()).expect(200);
    expect(
      (after.body.data as { id: string; pin: string | null }[]).find((p) => p.id === ids.parcel)!.pin,
    ).toBeNull();

    // staff hand-over without a PIN, and a return to the carrier
    const second = await t.http
      .post('/v1/owner/parcels')
      .set(O())
      .send({ unitId: ids.a101, carrier: 'Flash', photoDocumentId: photos[1] })
      .expect(201);
    await t.http
      .post(`/v1/owner/parcels/${second.body.id}/actions/pick-up`)
      .set(O())
      .send({ staffConfirmed: true })
      .expect(200)
      .expect((r) => expect(r.body.pickupConfirmedBy).toBe('staff'));
    const third = await t.http
      .post('/v1/staff/parcels')
      .set(S())
      .send({ unitId: ids.a102, photoDocumentId: photos[2] })
      .expect(201);
    const returned = await t.http
      .post(`/v1/staff/parcels/${third.body.id}/actions/return`)
      .set(S())
      .send({ reason: 'ไม่มีผู้มารับ' })
      .expect(200);
    expect(returned.body).toMatchObject({ status: 'returned', returnReason: 'ไม่มีผู้มารับ' });
    const open = await t.http.get('/v1/staff/parcels?open=true').set(S()).expect(200);
    expect(open.body.data).toEqual([]);
    // the A-101 resident never sees the A-102 parcel
    const residentParcels = (await t.http.get('/v1/resident/parcels').set(R()).expect(200)).body.data as {
      id: string;
    }[];
    expect(residentParcels.map((p) => p.id)).not.toContain(third.body.id);
  });

  it('facility booking: within the quota, a double booking refused by the database, the quota enforced', async () => {
    await refreshResident();
    const facility = await t.http
      .post('/v1/owner/facilities')
      .set(O())
      .send({
        buildingId: DEV.buildingId,
        name: 'ห้องประชุมชั้น 1',
        kind: 'meeting_room',
        capacity: 10,
        bookingPolicy: { slotMinutes: 60, openFrom: '08:00', openTo: '22:00', maxPerUnitPerWeek: 2 },
      })
      .expect(201);
    ids.facility = facility.body.id as string;
    expect(facility.body.bookingPolicy).toMatchObject({ maxPerUnitPerWeek: 2, requiresApproval: false });
    const day = bangkokDate(new Date(t.clock.now().getTime() + 86_400_000));
    const slot = (h: number) => ({
      facilityId: ids.facility,
      unitId: ids.a101,
      startsAt: `${day}T${String(h).padStart(2, '0')}:00:00+07:00`,
      endsAt: `${day}T${String(h + 1).padStart(2, '0')}:00:00+07:00`,
    });
    const R1 = R();
    const facilities = await t.http.get(`/v1/resident/facilities?unitId=${ids.a101}`).set(R1).expect(200);
    expect((facilities.body.data as { id: string }[]).map((f) => f.id)).toEqual([ids.facility]);
    await t.http.get(`/v1/resident/facilities?unitId=${ids.a102}`).set(R1).expect(404);

    const bookKey = idem();
    const first = await t.http
      .post('/v1/resident/facility-bookings')
      .set(R1)
      .set(bookKey)
      .send(slot(10))
      .expect(201);
    expect(first.body).toMatchObject({ status: 'confirmed', unitNo: 'A-101' });
    // D-229: the retry of the same booking (same key, same body) answers it again, not 409 for my own slot
    const replay = await t.http
      .post('/v1/resident/facility-bookings')
      .set(R1)
      .set(bookKey)
      .send(slot(10))
      .expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    // the same slot again: the exclusion constraint refuses it
    await t.http
      .post('/v1/resident/facility-bookings')
      .set(R1)
      .send(slot(10))
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('facility.slot_taken'));
    // half a slot or outside the opening hours: policy problems
    await t.http
      .post('/v1/resident/facility-bookings')
      .set(R1)
      .send({ ...slot(12), endsAt: `${day}T12:30:00+07:00` })
      .expect(422);
    await t.http.post('/v1/resident/facility-bookings').set(R1).send(slot(6)).expect(422);
    // the database itself refuses an overlapping live booking whatever the code does
    await expect(
      q(
        `INSERT INTO ops.facility_booking (tenant_id, building_id, facility_id, unit_id, starts_at, ends_at, status)
         SELECT tenant_id, building_id, facility_id, $2, starts_at + interval '30 minutes', ends_at, 'confirmed'
           FROM ops.facility_booking WHERE id = $1`,
        [first.body.id, ids.a102],
      ),
    ).rejects.toThrow(/facility_booking_no_overlap/);

    await t.http.post('/v1/resident/facility-bookings').set(R1).send(slot(14)).expect(201);
    await t.http
      .post('/v1/resident/facility-bookings')
      .set(R1)
      .send(slot(16))
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('facility.quota_exceeded'));
    // cancelling frees the quota and the slot
    await t.http
      .post(`/v1/resident/facility-bookings/${first.body.id}/actions/cancel`)
      .set(R1)
      .send({ reason: 'ติดธุระ' })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('cancelled'));
    await t.http.post('/v1/resident/facility-bookings').set(R1).send(slot(10)).expect(201);

    const availability = await t.http
      .get(`/v1/resident/facilities/${ids.facility}/availability?date=${day}`)
      .set(R1)
      .expect(200);
    expect(availability.body.busy).toHaveLength(2);
    expect((availability.body.busy as { mine: boolean }[]).every((b) => b.mine)).toBe(true);
    expect((await t.http.get('/v1/resident/facility-bookings').set(R1).expect(200)).body.data).toHaveLength(
      3,
    );

    // approval flow: requested → approved by the owner; a no-show on a confirmed booking
    await t.http
      .patch(`/v1/owner/facilities/${ids.facility}`)
      .set(O())
      .send({ bookingPolicy: { requiresApproval: true, maxPerUnitPerWeek: 5 } })
      .expect(200);
    const requested = await t.http.post('/v1/resident/facility-bookings').set(R1).send(slot(18)).expect(201);
    expect(requested.body.status).toBe('requested');
    await t.http
      .post(`/v1/owner/facility-bookings/${requested.body.id}/actions/approve`)
      .set(O())
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('confirmed'));
    await t.http
      .post(`/v1/owner/facility-bookings/${requested.body.id}/actions/approve`)
      .set(O())
      .expect(409);
    await t.http
      .post(`/v1/owner/facility-bookings/${requested.body.id}/actions/no-show`)
      .set(O())
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('no_show'));
    const owners = await t.http
      .get(`/v1/owner/facilities/${ids.facility}/bookings?from=${day}T00:00:00%2B07:00`)
      .set(O())
      .expect(200);
    expect(owners.body.data).toHaveLength(4);
  });

  it('building rules: acknowledged at lease signing (B2.3) and in the app; never backdated', async () => {
    await refreshResident();
    const today = bangkokDate(t.clock.now());
    const yesterday = bangkokDate(new Date(t.clock.now().getTime() - 86_400_000));
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/rules`)
      .set(O())
      .send({ title: 'ระเบียบ', bodyTh: 'ห้ามส่งเสียงดัง', effectiveFrom: yesterday })
      .expect(422);
    const v1 = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/rules`)
      .set(O())
      .send({
        title: 'ระเบียบการอยู่อาศัย',
        bodyTh: 'ห้ามส่งเสียงดังหลัง 22:00 น.',
        translations: { en: { title: 'House rules', body: 'Quiet after 22:00.' } },
        effectiveFrom: today,
      })
      .expect(201);
    ids.rule = v1.body.id as string;
    expect(v1.body).toMatchObject({ version: 1, acknowledgements: 0 });
    await settle();
    expect(await told('building_rule.published', ids.rule)).toBeGreaterThan(0);

    // B2.3: the resident confirms the house rules of the lease addendum → recorded as an acknowledgement here
    await q(
      `UPDATE ops.lease SET addendum = '[{"type":"house_rules","text":"ห้ามเลี้ยงสัตว์"}]'::jsonb WHERE id = $1`,
      [DEV.leaseId],
    );
    const R1 = R();
    const before = await t.http.get(`/v1/resident/building-rules?unitId=${ids.a101}`).set(R1).expect(200);
    expect(before.body).toMatchObject({ ruleId: ids.rule, version: 1, acknowledgedAt: null, language: 'th' });
    await t.http.post(`/v1/resident/leases/${DEV.leaseId}/rules/acknowledge`).set(R1).expect(200);
    await settle();
    const acks = await t.http
      .get(`/v1/owner/building-rules/${ids.rule}/acknowledgements`)
      .set(O())
      .expect(200);
    expect(acks.body.data).toEqual([
      expect.objectContaining({ partyId: DEV.residentPartyId, leaseId: DEV.leaseId }),
    ]);
    const after = await t.http.get(`/v1/resident/building-rules?unitId=${ids.a101}`).set(R1).expect(200);
    expect(after.body.acknowledgedAt).not.toBeNull();
    // acknowledging again in the app changes nothing
    await t.http
      .post('/v1/resident/building-rules/actions/acknowledge')
      .set(R1)
      .send({ unitId: ids.a101 })
      .expect(200);
    await t.http
      .post('/v1/resident/building-rules/actions/acknowledge')
      .set(R1)
      .send({ unitId: ids.a102 })
      .expect(404);

    // a lessee signing a lease (B2.3 `lease.signed`) acknowledges the rules in force
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({ type: 'person', displayName: 'ผู้เช่าใหม่ B53', phone: '+660000000196' })
      .expect(201);
    const partyId = (party.body.id ?? party.body.party?.id) as string;
    await t.app.get(TenantTx).platform((tx) =>
      t.app.get(DomainEvents).record(tx, {
        type: 'lease.signed',
        aggregateType: 'lease',
        aggregateId: DEV.leaseId,
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
        payload: { leaseId: DEV.leaseId, signerRole: 'co_tenant', partyId },
      }),
    );
    await settle();
    const ackRows = await q<{ party_id: string; lease_id: string }>(
      `SELECT party_id, lease_id FROM ops.building_rule_ack WHERE rule_id = $1 ORDER BY acked_at`,
      [ids.rule],
    );
    expect(ackRows).toEqual([
      { party_id: DEV.residentPartyId, lease_id: DEV.leaseId },
      { party_id: partyId, lease_id: DEV.leaseId },
    ]);
    const versions = await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/rules`).set(O()).expect(200);
    expect(versions.body.data[0]).toMatchObject({ version: 1, acknowledgements: 2 });
  });

  it('contacts of the building in the LIFF', async () => {
    await refreshResident();
    await t.http
      .post('/v1/owner/contacts')
      .set(O())
      .send({ buildingId: DEV.buildingId, kind: 'emergency', name: 'ไม่มีเบอร์' })
      .expect(422);
    const c = await t.http
      .post('/v1/owner/contacts')
      .set(O())
      .send({ buildingId: DEV.buildingId, kind: 'emergency', name: 'สำนักงานอาคาร', phone: '+6620000000' })
      .expect(201);
    ids.contact = c.body.id as string;
    await t.http
      .post('/v1/owner/contacts')
      .set(O())
      .send({ kind: 'utility', name: 'การไฟฟ้านครหลวง', phone: '1130' })
      .expect(201);
    const R1 = R();
    const list = await t.http.get(`/v1/resident/contacts?unitId=${ids.a101}`).set(R1).expect(200);
    expect((list.body.data as { name: string }[]).map((x) => x.name).sort()).toEqual(
      ['การไฟฟ้านครหลวง', 'สำนักงานอาคาร'].sort(),
    );
    await t.http.patch(`/v1/owner/contacts/${ids.contact}`).set(O()).send({ sortOrder: 2 }).expect(200);
    await t.http.delete(`/v1/owner/contacts/${ids.contact}`).set(O()).expect(204);
    expect(
      (await t.http.get(`/v1/resident/contacts?unitId=${ids.a101}`).set(R1).expect(200)).body.data,
    ).toHaveLength(1);
  });

  it('a new occupant never sees a former occupant’s parcel, its pick-up PIN or bookings (review #9, D-224)', async () => {
    await relogin();
    const photo = await uploadFile(t, db, staff, {
      kind: 'service_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'parcel-old.jpg',
      mimeType: 'image/jpeg',
      body: JPEG,
      surface: 'staff',
    });
    const waiting = await t.http
      .post('/v1/staff/parcels')
      .set(S())
      .send({ unitId: ids.a101, carrier: 'Kerry Express', trackingNo: 'KEX-OLD', photoDocumentId: photo })
      .expect(201);
    await settle();
    await q(`UPDATE ops.parcel SET received_at = received_at - interval '10 days' WHERE id = $1`, [
      waiting.body.id,
    ]);
    await q(
      `UPDATE ops.facility_booking SET created_at = created_at - interval '10 days' WHERE unit_id = $1`,
      [ids.a101],
    );
    const party = (
      await q<{ id: string }>(
        `INSERT INTO core.party (tenant_id, type, display_name) VALUES ($1, 'person', 'ผู้อยู่ใหม่ A-101') RETURNING id`,
        [DEV.tenantId],
      )
    )[0]!.id;
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from) VALUES ($1, $2, $3, $4, 'family', $5::date)`,
      [DEV.tenantId, DEV.buildingId, ids.a101, party, today],
    );
    const sub = 'U00000000000000000000000000b53c09';
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub, name: 'ผู้อยู่ใหม่' }) })
      .expect(200);
    await q(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via) SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [DEV.tenantId, party, sub],
    );
    const N = bearer(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)).body
        .accessToken as string,
    );
    const parcels = (await t.http.get('/v1/resident/parcels').set(N).expect(200)).body.data as {
      id: string;
    }[];
    expect(parcels.map((p) => p.id)).not.toContain(waiting.body.id);
    expect((await t.http.get('/v1/resident/facility-bookings').set(N).expect(200)).body.data).toEqual([]);
    // the former occupant (still on the lease) keeps seeing their parcel and its PIN
    await refreshResident();
    const theirs = (await t.http.get('/v1/resident/parcels').set(R()).expect(200)).body.data as {
      id: string;
      pin: string | null;
    }[];
    expect(theirs.find((p) => p.id === waiting.body.id)?.pin).toMatch(/^\d{6}$/);
  });

  it('another tenant gets 404; RLS hides every community table', async () => {
    const X = bearer(await operatorToken(t, PHONE_B));
    await t.http.get(`/v1/owner/announcements/${ids.ann}`).set(X).expect(404);
    await t.http.get(`/v1/owner/announcements/${ids.ann}/reads`).set(X).expect(404);
    await t.http.post(`/v1/owner/announcements/${ids.ann}/actions/archive`).set(X).expect(404);
    await t.http.get(`/v1/owner/parcels/${ids.parcel}`).set(X).expect(404);
    await t.http
      .post(`/v1/owner/parcels/${ids.parcel}/actions/return`)
      .set(X)
      .send({ reason: 'x' })
      .expect(404);
    await t.http.patch(`/v1/owner/facilities/${ids.facility}`).set(X).send({ name: 'x' }).expect(404);
    await t.http.get(`/v1/owner/facilities/${ids.facility}/bookings`).set(X).expect(404);
    await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/rules`).set(X).expect(404);
    await t.http.get(`/v1/owner/building-rules/${ids.rule}/acknowledgements`).set(X).expect(404);
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/rules`)
      .set(X)
      .send({ title: 'x', bodyTh: 'x', effectiveFrom: bangkokDate(t.clock.now()) })
      .expect(404);
    await t.http
      .post('/v1/owner/facilities')
      .set(X)
      .send({ buildingId: DEV.buildingId, name: 'x', kind: 'meeting_room' })
      .expect(404);
    expect((await t.http.get('/v1/owner/announcements').set(X).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/facilities').set(X).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/contacts').set(X).expect(200)).body.data).toEqual([]);

    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of [
      'ops.announcement',
      'ops.announcement_read',
      'ops.parcel',
      'ops.facility',
      'ops.facility_booking',
      'ops.building_rule',
      'ops.building_rule_ack',
      'ops.contact',
    ]) {
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
      expect(await count(other.tenantId, table)).toBe(0);
    }
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.$executeRawUnsafe(`UPDATE ops.parcel SET status = 'returned' WHERE id = '${ids.parcel}'`),
        ),
    ).resolves.toBe(0);
  });
});
