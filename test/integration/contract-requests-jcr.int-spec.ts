import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, onboardTenant, otpSignIn } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000851';
const PHONE_J2 = '+660000000852';
const PHONE_L = '+660000000853';
const PHONE_OWNER = '+66810008511';
const ADDRESS = { line1: 'ถนนสุขุมวิท', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postcode: '10110' };

/**
 * J-CR (D-335): the cheap contract requests of getproperty-web (JW1–JW4) and getproperty-liff (#37–#52) — register
 * floors / property filter / owners picker, resolution file facts, list counts (receivables, expenses, vendors,
 * contracts, rounds), vendor filters, import problem extensions and the open filter, the revenue schedule of a cycle,
 * juristic menu keys, admin stub buildings, resident single reads and payment-plan options — with cross-tenant 404s.
 */
describe('J-CR contract requests (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  let coOwner: string;
  const ids: Record<string, string> = {};

  const J = () => bearer(jur.token);
  const J2 = () => bearer(jur2.token);
  const R = () => bearer(coOwner);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows[0] as T;

  async function estate(token: string, code: string) {
    const property = await t.http
      .post('/v1/owner/properties')
      .set(bearer(token))
      .send({ code, name: `คอนโด ${code}`, kind: 'condo' })
      .expect(201);
    const building = await t.http
      .post('/v1/owner/buildings')
      .set(bearer(token))
      .send({
        propertyId: property.body.id,
        code: 'A',
        name: 'อาคาร A',
        type: 'condo',
        legalForm: 'condo_act',
      })
      .expect(201);
    return { propertyId: property.body.id as string, buildingId: building.body.id as string };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_jcr' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db);
    t.clock.set(new Date('2027-01-15T09:00:00+07:00'));
    admin = await adminToken(t);
    jur = await onboardTenant(t, admin, { slug: 'jcr-a', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'jcr-b', phone: PHONE_J2, type: 'juristic' });
    const a = await estate(jur.token, 'CA');
    ids.property = a.propertyId;
    ids.building = a.buildingId;
    const b = await estate(jur2.token, 'CB');
    ids.property2 = b.propertyId;
    ids.building2 = b.buildingId;
    ids.floor = (
      await t.http
        .post(`/v1/owner/buildings/${ids.building}/floors`)
        .set(J())
        .send({ level: 12, name: 'ชั้น 12' })
        .expect(201)
    ).body.id;
    for (const [key, unitNo, floorId] of [
      ['u1', 'A-1201', ids.floor],
      ['u2', 'A-1202', undefined],
    ] as const)
      ids[key] = (
        await t.http
          .post('/v1/owner/units')
          .set(J())
          .send({ buildingId: ids.building, unitNo, type: 'condo_unit', areaSqm: '35.50', floorId })
          .expect(201)
      ).body.id;
    ids.u21 = (
      await t.http
        .post('/v1/owner/units')
        .set(J2())
        .send({ buildingId: ids.building2, unitNo: 'B-1', type: 'condo_unit' })
        .expect(201)
    ).body.id;
    const owners = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.u1}/owners`)
      .set(J())
      .send({
        validFrom: '2020-01-01',
        sharePct: '100',
        party: { type: 'person', displayName: 'สมพร เจ้าของห้อง', phone: PHONE_OWNER },
      })
      .expect(201);
    ids.owner = owners.body.owners[0].party.id;
    await t.http
      .post(`/v1/owner/juristic/register/units/${ids.u21}/owners`)
      .set(J2())
      .send({ validFrom: '2020-01-01', sharePct: '100', party: { type: 'person', displayName: 'สมพร อื่น' } })
      .expect(201);
    coOwner = (await otpSignIn(t, 'resident', PHONE_OWNER, jur.token)).accessToken;
  }, 300_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('register: floor and property on the rows, the property filter, the owners picker (cross-tenant 404)', async () => {
    const list = await t.http
      .get(`/v1/owner/juristic/register?propertyId=${ids.property}`)
      .set(J())
      .expect(200);
    const u1 = (list.body.data as Record<string, unknown>[]).find((u) => u.unitId === ids.u1)!;
    expect(u1).toMatchObject({
      propertyId: ids.property,
      floorId: ids.floor,
      floorLevel: 12,
      floorName: 'ชั้น 12',
    });
    expect((list.body.data as Record<string, unknown>[]).find((u) => u.unitId === ids.u2)).toMatchObject({
      floorId: null,
      floorLevel: null,
    });
    await t.http.get(`/v1/owner/juristic/register?propertyId=${ids.property2}`).set(J()).expect(404);

    const picker = await t.http
      .get(`/v1/owner/juristic/register/owners?q=${encodeURIComponent('สมพร')}`)
      .set(J())
      .expect(200);
    expect(picker.body.data).toEqual([
      {
        unitId: ids.u1,
        unitNo: 'A-1201',
        buildingId: ids.building,
        buildingName: 'อาคาร A',
        partyId: ids.owner,
        partyName: 'สมพร เจ้าของห้อง',
      },
    ]);
    const byUnit = await t.http.get('/v1/owner/juristic/register/owners?q=1201&limit=5').set(J()).expect(200);
    expect(byUnit.body.data).toHaveLength(1);
    await t.http.get(`/v1/owner/juristic/register/owners?buildingId=${ids.building2}`).set(J()).expect(404);
    await t.http.get(`/v1/owner/juristic/register/owners?propertyId=${ids.property2}`).set(J()).expect(404);

    // units of a property (housing estates read every soi at once); another tenant's property lists nothing
    const units = await t.http
      .get(`/v1/owner/units?propertyId=${ids.property}&perPage=50`)
      .set(J())
      .expect(200);
    expect((units.body.data as { id: string }[]).map((u) => u.id).sort()).toEqual([ids.u1, ids.u2].sort());
    const other = await t.http.get(`/v1/owner/units?propertyId=${ids.property2}`).set(J()).expect(200);
    expect(other.body.data).toEqual([]);
  });

  it('resolution documents carry their title, type and size', async () => {
    const res = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.building,
        meetingKind: 'agm',
        meetingDate: '2027-01-10',
        number: '1/2570',
        title: 'งบประมาณ',
        text: 'ที่ประชุมอนุมัติ',
      })
      .expect(201);
    const docId = (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, title, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'รายงานการประชุม.pdf', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 4321, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [jur.tenantId],
      )
    ).id;
    const added = await t.http
      .post(`/v1/owner/juristic/resolutions/${res.body.id}/documents`)
      .set(J())
      .send({ documentId: docId, kind: 'minutes' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    expect(added.body.documents).toEqual([
      expect.objectContaining({
        documentId: docId,
        kind: 'minutes',
        title: 'รายงานการประชุม.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4321,
      }),
    ]);
  });

  it('lists carry their tab counts; vendors filter by several categories and by party', async () => {
    const recv = await t.http.get('/v1/owner/juristic/receivables').set(J()).expect(200);
    expect(recv.body.counts).toEqual({ all: 0, atStep: 0, plan: 0, dispute: 0 });
    const exp = await t.http.get('/v1/owner/juristic/expense-requests').set(J()).expect(200);
    expect(exp.body.counts).toEqual({
      all: 0,
      awaitingMe: 0,
      draft: 0,
      submitted: 0,
      approved: 0,
      rejected: 0,
      paid: 0,
      cancelled: 0,
    });
    const lift = await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({ type: 'company', name: 'ลิฟต์ดี', categories: ['lift'] })
      .expect(201);
    await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({ type: 'company', name: 'สะอาดดี', categories: ['cleaning'] })
      .expect(201);
    await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({ type: 'company', name: 'ไฟฟ้าดี', categories: ['electrical'] })
      .expect(201);
    const two = await t.http
      .get('/v1/owner/juristic/vendors?categories=lift,electrical')
      .set(J())
      .expect(200);
    expect((two.body.data as { name: string }[]).map((v) => v.name).sort()).toEqual(
      ['ไฟฟ้าดี', 'ลิฟต์ดี'].sort(),
    );
    expect(two.body.counts).toEqual({ all: 2, active: 2, blocked: 0 });
    const repeated = await t.http
      .get('/v1/owner/juristic/vendors?categories=lift&categories=cleaning')
      .set(J())
      .expect(200);
    expect(repeated.body.meta.total).toBe(2);
    await t.http.get('/v1/owner/juristic/vendors?categories=nope').set(J()).expect(422);
    const byParty = await t.http
      .get(`/v1/owner/juristic/vendors?partyId=${lift.body.partyId}`)
      .set(J())
      .expect(200);
    expect((byParty.body.data as { id: string }[]).map((v) => v.id)).toEqual([lift.body.id]);
    const all = await t.http.get('/v1/owner/juristic/vendors?state=blocked').set(J()).expect(200);
    expect(all.body.data).toEqual([]);
    expect(all.body.counts).toEqual({ all: 3, active: 3, blocked: 0 });
    // another tenant's vendors are not counted
    const theirs = await t.http.get('/v1/owner/juristic/vendors').set(J2()).expect(200);
    expect(theirs.body.counts.all).toBe(0);
    const contracts = await t.http.get('/v1/owner/juristic/vendor-contracts').set(J()).expect(200);
    expect(contracts.body.counts).toMatchObject({ all: 0, active: 0, endingSoon: 0, endingWithinDays: 90 });
    const rounds = await t.http
      .post('/v1/owner/juristic/quotation-rounds')
      .set(J())
      .send({ buildingId: ids.building, title: 'ซ่อมลิฟต์', category: 'lift' })
      .expect(201);
    expect(rounds.body.id).toBeTruthy();
    const roundList = await t.http
      .get('/v1/owner/juristic/quotation-rounds?state=awarded')
      .set(J())
      .expect(200);
    expect(roundList.body.data).toEqual([]);
    expect(roundList.body.counts).toEqual({
      all: 1,
      awaitingMe: 0,
      open: 1,
      awaitingApproval: 0,
      awarded: 0,
      cancelled: 0,
    });
  });

  it('expense accounts for requesters: active expense accounts only; not a juristic tenant → 404', async () => {
    const accounts = await t.http.get('/v1/owner/juristic/expense-accounts').set(J()).expect(200);
    expect(accounts.body.data.length).toBeGreaterThan(0);
    for (const a of accounts.body.data as { type: string; isActive?: boolean; active?: boolean }[])
      expect(a.type).toBe('expense');
    const apartment = await onboardTenant(t, admin, {
      slug: 'jcr-apartment',
      phone: '+660000000854',
      type: 'apartment',
    });
    await t.http.get('/v1/owner/juristic/expense-accounts').set(bearer(apartment.token)).expect(404);
  });

  it('imports: the open job is named in the problem and found with ?open=true', async () => {
    const job = await t.http
      .post('/v1/owner/juristic/imports')
      .set(J())
      .send({ buildingId: ids.building, asOfDate: '2027-01-14' })
      .expect(201);
    const again = await t.http
      .post('/v1/owner/juristic/imports')
      .set(J())
      .send({ buildingId: ids.building, asOfDate: '2027-01-14' })
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'import.job_open',
      jobId: job.body.id,
      jobNumber: job.body.number,
    });
    const open = await t.http.get('/v1/owner/juristic/imports?open=true').set(J()).expect(200);
    expect((open.body.data as { id: string }[]).map((j) => j.id)).toEqual([job.body.id]);
    const closed = await t.http.get('/v1/owner/juristic/imports?open=false').set(J()).expect(200);
    expect(closed.body.data).toEqual([]);
  });

  it('the revenue schedule of a cycle (empty for a monthly one); another tenant’s cycle is a 404', async () => {
    const cycle = await t.http
      .post('/v1/owner/billing-cycles')
      .set(J())
      .send({ propertyId: ids.property, periodKey: '2027-02' })
      .expect(200);
    const s = await t.http
      .get(`/v1/owner/billing-cycles/${cycle.body.id}/revenue-schedule`)
      .set(J())
      .expect(200);
    expect(s.body).toEqual({
      billingCycleId: cycle.body.id,
      frequency: 'monthly',
      months: [],
      total: '0.00',
    });
    await t.http.get(`/v1/owner/billing-cycles/${cycle.body.id}/revenue-schedule`).set(J2()).expect(404);
    await t.http.get(`/v1/owner/billing-cycles/${randomUUID()}/revenue-schedule`).set(J()).expect(404);
  });

  it('menu: a juristic office gets its own keys and no leases / deposits', async () => {
    const me = await t.http.get('/v1/owner/me').set(J()).expect(200);
    expect(me.body.menu).toEqual(
      expect.arrayContaining([
        'juristic_overview',
        'juristic_resolutions',
        'juristic_reports',
        'juristic_payment_mandates',
        'juristic_petty_cash',
      ]),
    );
    expect(me.body.menu).not.toContain('leases');
    expect(me.body.menu).not.toContain('deposits');
  });

  it('admin: stub buildings to claim, by name', async () => {
    const landlord = await onboardTenant(t, admin, {
      slug: 'jcr-landlord',
      phone: PHONE_L,
      type: 'landlord',
    });
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(bearer(landlord.token))
      .send({
        address: ADDRESS,
        kind: 'condo_unit',
        projectName: 'คอนโด เจซีอาร์ ทดสอบ',
        unitNo: '8/801',
        bedrooms: 1,
        bathrooms: 1,
        areaSqm: '30.00',
        defaultRent: '15000.00',
      })
      .expect(201);
    expect(unit.body.stub).toBe(true);
    const stubs = await t.http
      .get(`/v1/admin/buildings/stubs?q=${encodeURIComponent('เจซีอาร์')}`)
      .set(bearer(admin))
      .expect(200);
    expect(stubs.body.data).toEqual([
      expect.objectContaining({
        id: unit.body.buildingId,
        landlordUnits: 1,
        propertyId: unit.body.propertyId,
      }),
    ]);
    const byAddress = await t.http
      .get(`/v1/admin/buildings/stubs?q=${encodeURIComponent('คลองเตย')}`)
      .set(bearer(admin))
      .expect(200);
    expect((byAddress.body.data as { id: string }[]).map((b) => b.id)).toContain(unit.body.buildingId);
    // an operator cannot list them
    await t.http.get('/v1/admin/buildings/stubs').set(J()).expect(403);
  });

  it('resident: unit measures, plan options and single reads of statements, plans and certificates (404 otherwise)', async () => {
    const units = await t.http.get('/v1/resident/me/units').set(R()).expect(200);
    expect(units.body.units).toEqual([
      expect.objectContaining({
        unitId: ids.u1,
        areaSqm: '35.50',
        ownershipRatio: null,
        landAreaSqwa: null,
        plotNo: null,
        recurringAvailable: expect.any(Boolean),
      }),
    ]);
    const options = await t.http
      .get(`/v1/resident/units/${ids.u1}/payment-plan-requests/options`)
      .set(R())
      .expect(200);
    expect(options.body).toMatchObject({
      minInstalments: 2,
      maxInstalments: expect.any(Number),
      earliestFirstDueOn: '2027-01-15',
      defaultFirstDueOn: '2027-02-01',
      proposedPrincipal: '0.00',
      available: false,
    });
    await t.http.get(`/v1/resident/units/${ids.u21}/payment-plan-requests/options`).set(R()).expect(404);
    await t.http.get(`/v1/resident/units/${ids.u1}/payment-plans/${randomUUID()}`).set(R()).expect(404);
    await t.http.get(`/v1/resident/units/${ids.u21}/payment-plans/${randomUUID()}`).set(R()).expect(404);
    await t.http.get(`/v1/resident/units/${ids.u1}/debt-clearances/${randomUUID()}`).set(R()).expect(404);
    await t.http.get(`/v1/resident/statements/${randomUUID()}`).set(R()).expect(404);
    // consents say what my last answer was, whatever its version
    const consents = await t.http.get('/v1/resident/consents').set(R()).expect(200);
    const purposes = (
      Array.isArray(consents.body) ? consents.body : (consents.body.data ?? consents.body.purposes)
    ) as {
      lastGranted: boolean | null;
    }[];
    expect(purposes.length).toBeGreaterThan(0);
    for (const p of purposes) expect(p).toHaveProperty('lastGranted');
    // a certificate issued to me is read back by id (nothing owed → issued at once)
    const dcl = await t.http
      .post(`/v1/resident/units/${ids.u1}/debt-clearance-requests`)
      .set(R())
      .set('Idempotency-Key', randomUUID())
      .send({ asOf: '2027-01-15' })
      .expect(201);
    const got = await t.http
      .get(`/v1/resident/units/${ids.u1}/debt-clearances/${dcl.body.id}`)
      .set(R())
      .expect(200);
    expect(got.body).toMatchObject({ id: dcl.body.id, verifyCode: null });
    // the juristic office of another building cannot reach it through its unit
    await t.http.get(`/v1/resident/units/${ids.u21}/debt-clearances/${dcl.body.id}`).set(R()).expect(404);
  });
});
