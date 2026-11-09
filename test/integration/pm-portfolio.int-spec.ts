import 'reflect-metadata';

import { AccessService } from '@core/tenancy/access.service';
import { ManagementContractsService } from '@modules/ops-juristic/pm/management-contracts.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_PM = '+660000000331';
const PHONE_PM2 = '+660000000332';
const PHONE_JA = '+660000000333';
const PHONE_JB = '+660000000334';
const PHONE_PM_STAFF = '+66810003311';
const PHONE_COMMITTEE_A = '+66810003312';
const PHONE_COMMITTEE_B = '+66810003313';
const PHONE_MANAGER_A = '+66810003314';
const at = (d: string, time = '09:00:00') => new Date(`${d}T${time}+07:00`);

type Tok = { tenantId: string; token: string };

/**
 * J3.3 acceptance (D-150 C3, D-334): a PM company manages 3 buildings of 2 juristic tenants under management
 * contracts (offer with an adopted resolution → accept → read grant for the term); the portfolio shows the 3
 * buildings with KPIs only while the contract and grant are live; the committee of building A never sees building B
 * (other tenant, and a committee limited to one building of its own tenant); every ended billing period's fee becomes
 * one submitted expense request of the juristic tenant (approval bands + maker-checker, never paid automatically,
 * idempotent per contract × period); termination and the end date end the PM's access; PM staff see only the
 * buildings they are assigned to; cross-tenant 404 on every endpoint; RLS of the new tables.
 */
describe('J3.3 PM company portfolio (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let pm: Tok;
  let pm2: Tok;
  let ja: Tok;
  let jb: Tok;
  let pmStaff: string;
  let committeeA: string;
  let committeeB: string;
  let managerA: string;
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const H = (token: string) => bearer(token);
  const job = () => t.app.get(ManagementContractsService).run();
  const relogin = async () => {
    pm = { ...pm, token: await operatorToken(t, PHONE_PM) };
    pm2 = { ...pm2, token: await operatorToken(t, PHONE_PM2) };
    ja = { ...ja, token: await operatorToken(t, PHONE_JA) };
    jb = { ...jb, token: await operatorToken(t, PHONE_JB) };
    pmStaff = await operatorToken(t, PHONE_PM_STAFF);
    committeeA = await operatorToken(t, PHONE_COMMITTEE_A);
    committeeB = await operatorToken(t, PHONE_COMMITTEE_B);
    managerA = await operatorToken(t, PHONE_MANAGER_A);
  };
  const goTo = async (d: string) => {
    t.clock.set(at(d));
    await relogin();
  };
  const invite = async (owner: string, role: string, phone: string) => {
    const inv = await t.http
      .post('/v1/owner/invitations')
      .set(H(owner))
      .send({ role, phone, channel: 'link' })
      .expect(201);
    await operatorToken(t, phone, inv.body.code as string);
  };
  const building = async (owner: string, code: string, name: string) => {
    const p = await t.http
      .post('/v1/owner/properties')
      .set(H(owner))
      .send({ code, name: `คอนโด ${name}`, kind: 'condo' })
      .expect(201);
    const b = await t.http
      .post('/v1/owner/buildings')
      .set(H(owner))
      .send({ propertyId: p.body.id, code: 'T1', name, type: 'condo', legalForm: 'condo_act' })
      .expect(201);
    return b.body.id as string;
  };
  const adoptedResolution = async (owner: string, buildingId: string, number: string) => {
    const r = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(H(owner))
      .send({
        buildingId,
        meetingKind: 'agm',
        meetingDate: '2026-12-10',
        number,
        title: 'แต่งตั้งบริษัทบริหารทรัพย์สิน',
        text: 'ที่ประชุมใหญ่มีมติจ้างบริษัทบริหารทรัพย์สินเป็นผู้จัดการ',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${r.body.id}/actions/adopt`)
      .set(H(owner))
      .set(idem())
      .expect(200);
    return r.body.id as string;
  };
  const accounts = async (owner: string) => {
    const chart = await t.http.get('/v1/owner/juristic/accounts').set(H(owner)).expect(200);
    return Object.fromEntries((chart.body.data as { code: string; id: string }[]).map((a) => [a.code, a.id]));
  };
  const draft = (owner: string, body: Record<string, unknown>) =>
    t.http.post('/v1/owner/juristic/management-contracts').set(H(owner)).send(body);
  const offer = (owner: string, id: string | undefined) =>
    t.http.post(`/v1/owner/juristic/management-contracts/${id!}/actions/offer`).set(H(owner)).set(idem());
  const portfolio = async (token: string) =>
    (await t.http.get('/v1/owner/pm/portfolio').set(H(token)).expect(200)).body as {
      buildings: { buildingId: string; kpis: Record<string, unknown>; staffToday: unknown[] }[];
      totals: Record<string, unknown>;
    };
  const rowsAs = (tenantId: string, sql: string) =>
    db.prisma().withTenant({ tenantId }, (tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql));

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_pm_portfolio' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2026-12-20'));
    admin = await adminToken(t);
    pm = await onboardTenant(t, admin, { slug: 'j33-pm', phone: PHONE_PM, type: 'pm_company' });
    pm2 = await onboardTenant(t, admin, { slug: 'j33-pm-other', phone: PHONE_PM2, type: 'pm_company' });
    ja = await onboardTenant(t, admin, { slug: 'j33-jur-a', phone: PHONE_JA, type: 'juristic' });
    jb = await onboardTenant(t, admin, { slug: 'j33-jur-b', phone: PHONE_JB, type: 'juristic' });
    ids.A1 = await building(ja.token, 'A1', 'อาคาร A1');
    ids.A2 = await building(ja.token, 'A2', 'อาคาร A2');
    ids.B1 = await building(jb.token, 'B1', 'อาคาร B1');
    await invite(pm.token, 'staff', PHONE_PM_STAFF);
    await invite(ja.token, 'committee', PHONE_COMMITTEE_A);
    await invite(ja.token, 'manager', PHONE_MANAGER_A);
    await invite(jb.token, 'committee', PHONE_COMMITTEE_B);
    // the committee member of A is limited to building A1 (membership building scope, D-090)
    const cA = await one<{ user_id: string }>(
      `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'committee'`,
      [ja.tenantId],
    );
    await q(
      `UPDATE core.membership SET module_scopes = jsonb_build_object('buildingIds', jsonb_build_array($1::text))
        WHERE user_id = $2 AND tenant_id = $3`,
      [ids.A1, cA.user_id, ja.tenantId],
    );
    t.app.get(AccessService).forget(cA.user_id);
    ids.pmStaffUser = (
      await one<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'staff'`,
        [pm.tenantId],
      )
    ).user_id;
    ids.pmOwnerUser = (
      await one<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`,
        [pm.tenantId],
      )
    ).user_id;
    await relogin();
    // the PM company as a vendor of each juristic tenant (payee of the fee)
    for (const [k, owner] of [
      ['A', ja.token],
      ['B', jb.token],
    ] as const) {
      ids[`vendor${k}`] = (
        await t.http
          .post('/v1/owner/juristic/vendors')
          .set(H(owner))
          .send({ type: 'company', name: 'บริษัท บริหารทรัพย์สิน เจ33 จำกัด', categories: ['professional'] })
          .expect(201)
      ).body.id;
      ids[`acc${k}`] = (await accounts(owner))['5140']!;
    }
    ids.resA1 = await adoptedResolution(ja.token, ids.A1, '1/2569');
    ids.resA2 = await adoptedResolution(ja.token, ids.A2, '2/2569');
    ids.resB1 = await adoptedResolution(jb.token, ids.B1, '1/2569');
  }, 300_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('the juristic drafts and offers (adopted resolution, a real PM company, no overlap); the PM sees offers only', async () => {
    const base = {
      pmTenantId: pm.tenantId,
      title: 'สัญญาจ้างบริหารจัดการอาคาร 2570',
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
      whtKey: 'service',
    };
    // a juristic tenant is not a PM company (one answer, no enumeration)
    const notPm = await draft(ja.token, {
      ...base,
      pmTenantId: jb.tenantId,
      buildingId: ids.A1,
      vendorId: ids.vendorA,
      fee: '85600.00',
    }).expect(422);
    expect(notPm.body.code).toBe('management_contract.pm_tenant_invalid');
    // another tenant's building or vendor is 404
    await draft(ja.token, { ...base, buildingId: ids.B1, vendorId: ids.vendorA, fee: '1.00' }).expect(404);
    await draft(ja.token, { ...base, buildingId: ids.A1, vendorId: ids.vendorB, fee: '1.00' }).expect(404);

    const a1 = await draft(ja.token, {
      ...base,
      buildingId: ids.A1,
      vendorId: ids.vendorA,
      fee: '85600.00',
      vatAmount: '5600.00',
      dueDay: 5,
      expenseAccountId: ids.accA,
    }).expect(201);
    expect(a1.body).toMatchObject({
      state: 'draft',
      fee: '85600.00',
      vatAmount: '5600.00',
      feePeriod: 'monthly',
      pmName: 'Tenant j33-pm',
      nextActions: ['edit', 'offer', 'cancel'],
    });
    ids.cA1 = a1.body.id;
    // a draft is the juristic's own business
    await t.http.get(`/v1/owner/pm/management-contracts/${ids.cA1}`).set(H(pm.token)).expect(404);
    const noRes = await offer(ja.token, ids.cA1).expect(422);
    expect(noRes.body.code).toBe('management_contract.resolution_required');
    const wrongRes = await t.http
      .patch(`/v1/owner/juristic/management-contracts/${ids.cA1}`)
      .set(H(ja.token))
      .send({ resolutionId: ids.resA2 })
      .expect(200);
    expect(wrongRes.body.resolutionId).toBe(ids.resA2);
    expect((await offer(ja.token, ids.cA1).expect(422)).body.code).toBe(
      'management_contract.resolution_invalid',
    );
    await t.http
      .patch(`/v1/owner/juristic/management-contracts/${ids.cA1}`)
      .set(H(ja.token))
      .send({ resolutionId: ids.resA1, version: 2 })
      .expect(200);
    const offered = await offer(ja.token, ids.cA1).expect(200);
    expect(offered.body).toMatchObject({ state: 'offered', nextActions: ['cancel'] });
    await t.http
      .patch(`/v1/owner/juristic/management-contracts/${ids.cA1}`)
      .set(H(ja.token))
      .send({ fee: '1.00' })
      .expect(409);

    ids.cA2 = (
      await draft(ja.token, {
        ...base,
        buildingId: ids.A2,
        vendorId: ids.vendorA,
        fee: '30000.00',
        feePeriod: 'quarterly',
        expenseAccountId: ids.accA,
        resolutionId: ids.resA2,
      }).expect(201)
    ).body.id;
    await offer(ja.token, ids.cA2).expect(200);
    ids.cB1 = (
      await draft(jb.token, {
        ...base,
        buildingId: ids.B1,
        vendorId: ids.vendorB,
        fee: '50000.00',
        expenseAccountId: ids.accB,
        resolutionId: ids.resB1,
      }).expect(201)
    ).body.id;
    await offer(jb.token, ids.cB1).expect(200);

    // one manager at a time: another PM company for overlapping dates of A1 is refused
    const other = await draft(ja.token, {
      ...base,
      pmTenantId: pm2.tenantId,
      buildingId: ids.A1,
      vendorId: ids.vendorA,
      fee: '70000.00',
      startsOn: '2027-06-01',
      endsOn: '2028-05-31',
      expenseAccountId: ids.accA,
      resolutionId: ids.resA1,
    }).expect(201);
    expect((await offer(ja.token, other.body.id).expect(409)).body.code).toBe('management_contract.overlap');
    await t.http
      .post(`/v1/owner/juristic/management-contracts/${other.body.id}/actions/cancel`)
      .set(H(ja.token))
      .set(idem())
      .send({ reason: 'เลือกบริษัทเดิม' })
      .expect(200);

    const pmList = await t.http.get('/v1/owner/pm/management-contracts').set(H(pm.token)).expect(200);
    expect((pmList.body.data as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [ids.cA1, ids.cA2, ids.cB1].sort(),
    );
    const pmView = (pmList.body.data as Record<string, unknown>[]).find((r) => r.id === ids.cA1)!;
    // juristic-internal references are not shown to the PM
    expect(pmView).toMatchObject({
      vendorId: null,
      expenseAccountId: null,
      resolutionId: null,
      juristicName: 'Tenant j33-jur-a',
      buildingName: 'อาคาร A1',
      nextActions: ['accept', 'decline'],
    });
    // the other PM company sees none of them
    expect(
      (await t.http.get('/v1/owner/pm/management-contracts').set(H(pm2.token)).expect(200)).body.data,
    ).toEqual([]);
    await t.http.get(`/v1/owner/pm/management-contracts/${ids.cA1}`).set(H(pm2.token)).expect(404);
  });

  it('the PM accepts → a read grant on the building (module juristic) for the term; the PM cannot change terms', async () => {
    for (const id of [ids.cA1!, ids.cA2!, ids.cB1!]) {
      const r = await t.http
        .post(`/v1/owner/pm/management-contracts/${id}/actions/accept`)
        .set(H(pm.token))
        .set(idem())
        .expect(200);
      expect(r.body).toMatchObject({
        state: 'active',
        nextActions: ['terminate'],
        access: { active: false },
      });
    }
    await t.http
      .post(`/v1/owner/pm/management-contracts/${ids.cA1}/actions/accept`)
      .set(H(pm.token))
      .set(idem())
      .expect(409);
    const g = await one<Record<string, unknown>>(
      `SELECT g.tenant_id, g.grantee_tenant_id, g.scope::text, g.modules, g.access::text, g.reason::text, g.valid_from, g.valid_to
         FROM core.asset_access_grant g JOIN juristic.management_contract c ON c.grant_id = g.id WHERE c.id = $1`,
      [ids.cA1],
    );
    expect(g).toMatchObject({
      tenant_id: ja.tenantId,
      grantee_tenant_id: pm.tenantId,
      scope: 'building',
      modules: ['juristic'],
      access: 'read',
      reason: 'pm_contract',
    });
    expect((g.valid_from as Date).toISOString()).toBe('2026-12-31T17:00:00.000Z');
    expect((g.valid_to as Date).toISOString()).toBe('2027-12-31T17:00:00.000Z');
    // not started yet: nothing in the portfolio
    expect((await portfolio(pm.token)).buildings).toEqual([]);
    // the PM side may never change the offered terms (trigger), even with RLS write access to the row
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: pm.tenantId }, (tx) =>
          tx.$executeRawUnsafe(`UPDATE juristic.management_contract SET fee = 1 WHERE id = '${ids.cA1}'`),
        ),
    ).rejects.toThrow(/cannot change the terms/);
    // only the juristic inserts
    await expect(
      db.prisma().withTenant({ tenantId: pm.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO juristic.management_contract (tenant_id, pm_tenant_id, building_id, vendor_id, title, fee, starts_on, ends_on)
             VALUES ('${ja.tenantId}', '${pm.tenantId}', '${ids.A1}', '${ids.vendorA}', 'x', 1, '2030-01-01', '2030-12-31')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('PM sees 3 buildings with KPIs; committee of A sees only A1; B never sees A; other tenants 404', async () => {
    await goTo('2027-01-02');
    const p = await portfolio(pm.token);
    expect(p.buildings.map((b) => b.buildingId).sort()).toEqual([ids.A1, ids.A2, ids.B1].sort());
    const a1 = p.buildings.find((b) => b.buildingId === ids.A1)!;
    expect(a1.kpis).toMatchObject({
      units: 0,
      collection: { billed: '0.00', collected: '0.00', collectionRatePct: null, kpiDays: 30 },
      arrears: { overdueAmount: '0.00', overdueInvoices: 0, over90Amount: '0.00' },
      budget: null,
      work: { openRequests: 0, slaBreachedRequests: 0, openWorkOrders: 0 },
      expiring: { withinDays: 90, vendorContracts: 0, items: [] },
    });
    expect(p.totals).toMatchObject({
      buildings: 3,
      billed: '0.00',
      overdueAmount: '0.00',
      collectionRatePct: null,
    });
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.B1}`).set(H(pm.token)).expect(200);
    // the other PM company: nothing, every building 404
    expect((await portfolio(pm2.token)).buildings).toEqual([]);
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.A1}`).set(H(pm2.token)).expect(404);
    // juristic tenants have no PM surface, the PM company no juristic surface
    await t.http.get('/v1/owner/pm/portfolio').set(H(ja.token)).expect(404);
    await t.http.get('/v1/owner/pm/staff-board').set(H(ja.token)).expect(404);
    await t.http.get('/v1/owner/juristic/management-contracts').set(H(pm.token)).expect(404);

    // committee of A (limited to A1): sees A1 only — A2 (same tenant, other building) and B1 (other tenant) are 404
    const listA = await t.http
      .get('/v1/owner/juristic/management-contracts?state=active')
      .set(H(committeeA))
      .expect(200);
    expect((listA.body.data as { id: string }[]).map((r) => r.id)).toEqual([ids.cA1]);
    expect(listA.body.data[0].nextActions).toEqual([]);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA1}`).set(H(committeeA)).expect(200);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA2}`).set(H(committeeA)).expect(404);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cB1}`).set(H(committeeA)).expect(404);
    await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA2}/charges`)
      .set(H(committeeA))
      .expect(404);
    await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA2}/staff`)
      .set(H(committeeA))
      .expect(404);
    // committee of B sees B1 only
    const listB = await t.http.get('/v1/owner/juristic/management-contracts').set(H(committeeB)).expect(200);
    expect((listB.body.data as { id: string }[]).map((r) => r.id)).toEqual([ids.cB1]);
    for (const id of [ids.cA1, ids.cA2])
      await t.http.get(`/v1/owner/juristic/management-contracts/${id}`).set(H(committeeB)).expect(404);
    // the committee reads but never manages
    await t.http
      .post(`/v1/owner/juristic/management-contracts/${ids.cA1}/actions/terminate`)
      .set(H(committeeA))
      .set(idem())
      .send({ reason: 'ทดสอบสิทธิ์' })
      .expect(403);

    // RLS: tenant pair only
    const sql = `SELECT id FROM juristic.management_contract WHERE id IN ('${ids.cA1}', '${ids.cB1}') ORDER BY id`;
    expect((await rowsAs(ja.tenantId, sql)).map((r) => r.id)).toEqual([ids.cA1]);
    expect((await rowsAs(jb.tenantId, sql)).map((r) => r.id)).toEqual([ids.cB1]);
    expect(await rowsAs(pm.tenantId, sql)).toHaveLength(2);
    expect(await rowsAs(pm2.tenantId, sql)).toHaveLength(0);
  });

  it('staff board: assignments inside the term; PM staff see only the buildings they are assigned to', async () => {
    const bad = await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm.token))
      .send({
        contractId: ids.cA1,
        userId: ids.pmOwnerUser,
        role: 'building_manager',
        startsOn: '2026-12-01',
      })
      .expect(422);
    expect(bad.body.code).toBe('pm_staff.outside_term');
    const jaOwner = await one<{ user_id: string }>(
      `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`,
      [ja.tenantId],
    );
    const notMember = await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm.token))
      .send({ contractId: ids.cA1, userId: jaOwner.user_id, role: 'technician' })
      .expect(422);
    expect(notMember.body.code).toBe('pm_staff.not_member');
    // another PM company's contract is 404
    await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm2.token))
      .send({ contractId: ids.cA1, userId: ids.pmStaffUser, role: 'technician' })
      .expect(404);
    const a = await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm.token))
      .send({
        contractId: ids.cA1,
        userId: ids.pmStaffUser,
        role: 'building_manager',
        shift: 'จ.–ศ. 08:00–17:00',
      })
      .expect(201);
    expect(a.body).toMatchObject({
      buildingId: ids.A1,
      startsOn: '2027-01-02',
      endsOn: null,
      role: 'building_manager',
    });
    ids.assignment = a.body.id;
    const dup = await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm.token))
      .send({ contractId: ids.cA1, userId: ids.pmStaffUser, role: 'technician', startsOn: '2027-03-01' })
      .expect(409);
    expect(dup.body.code).toBe('pm_staff.overlap');
    await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pm.token))
      .send({ contractId: ids.cB1, userId: ids.pmOwnerUser, role: 'accountant' })
      .expect(201);

    const board = await t.http.get('/v1/owner/pm/staff-board').set(H(pm.token)).expect(200);
    expect(board.body.buildings).toHaveLength(3);
    expect((board.body.members as { userId: string }[]).map((m) => m.userId).sort()).toEqual(
      [ids.pmStaffUser, ids.pmOwnerUser].sort(),
    );
    const a1 = (board.body.buildings as { buildingId: string; staff: unknown[] }[]).find(
      (b) => b.buildingId === ids.A1,
    );
    expect(a1?.staff).toEqual([
      expect.objectContaining({
        userId: ids.pmStaffUser,
        role: 'building_manager',
        shift: 'จ.–ศ. 08:00–17:00',
      }),
    ]);

    // the PM staff member: only A1 in the portfolio, only himself on the board
    const mine = await portfolio(pmStaff);
    expect(mine.buildings.map((b) => b.buildingId)).toEqual([ids.A1]);
    expect(mine.buildings[0]!.staffToday).toHaveLength(1);
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.B1}`).set(H(pmStaff)).expect(404);
    const sb = await t.http.get('/v1/owner/pm/staff-board').set(H(pmStaff)).expect(200);
    expect((sb.body.members as { userId: string }[]).map((m) => m.userId)).toEqual([ids.pmStaffUser]);
    expect((sb.body.buildings as { buildingId: string }[]).map((b) => b.buildingId)).toEqual([ids.A1]);
    // staff read, never manage, never see contracts
    await t.http
      .post('/v1/owner/pm/staff-assignments')
      .set(H(pmStaff))
      .send({ contractId: ids.cA2, userId: ids.pmStaffUser, role: 'technician' })
      .expect(403);
    await t.http.get('/v1/owner/pm/management-contracts').set(H(pmStaff)).expect(403);

    // the juristic sees who works in its building; the other juristic does not
    const staffA1 = await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA1}/staff`)
      .set(H(committeeA))
      .expect(200);
    expect(staffA1.body).toEqual([
      expect.objectContaining({ userId: ids.pmStaffUser, buildingName: 'อาคาร A1' }),
    ]);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA1}/staff`).set(H(jb.token)).expect(404);
    // RLS: the PM's rows, the juristic reads those of its contracts only
    const sql = `SELECT id FROM juristic.pm_staff_assignment`;
    expect(await rowsAs(pm.tenantId, sql)).toHaveLength(2);
    expect(await rowsAs(ja.tenantId, sql)).toHaveLength(1);
    expect(await rowsAs(jb.tenantId, sql)).toHaveLength(1);
    expect(await rowsAs(pm2.tenantId, sql)).toHaveLength(0);
    // other tenants: 404 on the assignment
    await t.http
      .post(`/v1/owner/pm/staff-assignments/${ids.assignment}/actions/end`)
      .set(H(pm2.token))
      .send({})
      .expect(404);
    const listed = await t.http
      .get('/v1/owner/pm/staff-assignments?current=true')
      .set(H(pmStaff))
      .expect(200);
    expect((listed.body.data as { id: string }[]).map((r) => r.id)).toEqual([ids.assignment]);
  });

  it('every ended period becomes one submitted expense request of the juristic — never paid, idempotent', async () => {
    expect(await job()).toEqual({ requested: 0, ended: 0 });
    await goTo('2027-02-01');
    expect(await job()).toEqual({ requested: 2, ended: 0 }); // A1 and B1 January; A2 is quarterly
    expect(await job()).toEqual({ requested: 0, ended: 0 });
    const charges = await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA1}/charges`)
      .set(H(ja.token))
      .expect(200);
    expect(charges.body).toEqual([
      expect.objectContaining({
        periodKey: '2027-01',
        serviceDays: 31,
        periodDays: 31,
        amount: '85600.00',
        vatAmount: '5600.00',
        dueOn: '2027-02-05',
        expenseRequest: expect.objectContaining({ state: 'submitted' }),
      }),
    ]);
    const expenseId = charges.body[0].expenseRequest.id as string;
    const exp = await t.http
      .get(`/v1/owner/juristic/expense-requests/${expenseId}`)
      .set(H(ja.token))
      .expect(200);
    expect(exp.body).toMatchObject({
      state: 'submitted',
      amount: '85600.00',
      vendorId: ids.vendorA,
      buildingId: ids.A1,
      approvalsRequired: 2,
    });
    // the PM sees what it billed, not the juristic's expense request
    const pmCharges = await t.http
      .get(`/v1/owner/pm/management-contracts/${ids.cA1}/charges`)
      .set(H(pm.token))
      .expect(200);
    expect(pmCharges.body).toEqual([expect.objectContaining({ periodKey: '2027-01', expenseRequest: null })]);
    await t.http.get(`/v1/owner/pm/management-contracts/${ids.cA1}/charges`).set(H(pm2.token)).expect(404);
    await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA1}/charges`)
      .set(H(jb.token))
      .expect(404);
    // maker-checker: the owner who offered the contract is the requester and never approves it
    const self = await t.http
      .post(`/v1/owner/juristic/expense-requests/${expenseId}/actions/approve`)
      .set(H(ja.token))
      .set(idem())
      .send({})
      .expect(403);
    expect(self.body.code).toBe('expense.maker_checker');
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${expenseId}/actions/approve`)
      .set(H(committeeA))
      .set(idem())
      .send({})
      .expect(200);
    const approved = await t.http
      .post(`/v1/owner/juristic/expense-requests/${expenseId}/actions/approve`)
      .set(H(managerA))
      .set(idem())
      .send({})
      .expect(200);
    expect(approved.body.state).toBe('approved'); // approved, still not paid — payment is the juristic's act
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM juristic.expense_request WHERE management_contract_id IS NOT NULL AND state = 'paid'`,
        )
      ).n,
    ).toBe(0);
    // the fee row is append-only and unique per contract × period
    await expect(
      q(
        `INSERT INTO juristic.management_fee_charge (tenant_id, contract_id, period_key, period_start, period_end, service_days, period_days, amount, due_on, expense_request_id)
         VALUES ($1, $2, '2027-01', '2027-01-01', '2027-01-31', 31, 31, 1, '2027-02-05', $3)`,
        [ja.tenantId, ids.cA1, expenseId],
      ),
    ).rejects.toThrow(/duplicate key/);
    // RLS: the PM reads its charges, the other juristic and PM do not
    const sql = `SELECT id FROM juristic.management_fee_charge`;
    expect(await rowsAs(pm.tenantId, sql)).toHaveLength(2);
    expect(await rowsAs(ja.tenantId, sql)).toHaveLength(1);
    expect(await rowsAs(pm2.tenantId, sql)).toHaveLength(0);
  });

  it('termination ends access (at once or at the date) and prorates the last period; the end date ends it too', async () => {
    // the PM terminates B1 from 15 Feb: B1 visible until then
    const term = await t.http
      .post(`/v1/owner/pm/management-contracts/${ids.cB1}/actions/terminate`)
      .set(H(pm.token))
      .set(idem())
      .send({ reason: 'บริษัทยุติการให้บริการในพื้นที่นี้', effectiveOn: '2027-02-15' })
      .expect(200);
    expect(term.body).toMatchObject({ state: 'terminated', terminatedOn: '2027-02-15', terminatedBy: 'pm' });
    await goTo('2027-02-14');
    expect((await portfolio(pm.token)).buildings.map((b) => b.buildingId)).toContain(ids.B1);
    await goTo('2027-02-15');
    expect((await portfolio(pm.token)).buildings.map((b) => b.buildingId).sort()).toEqual(
      [ids.A1, ids.A2].sort(),
    );
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.B1}`).set(H(pm.token)).expect(404);
    // the juristic terminates A2 effective today: the PM loses it at once
    await t.http
      .post(`/v1/owner/juristic/management-contracts/${ids.cA2}/actions/terminate`)
      .set(H(ja.token))
      .set(idem())
      .send({ reason: 'ผลงานไม่เป็นไปตามสัญญา ตามมติคณะกรรมการ' })
      .expect(200);
    expect((await portfolio(pm.token)).buildings.map((b) => b.buildingId)).toEqual([ids.A1]);
    const a2 = await t.http
      .get(`/v1/owner/juristic/management-contracts/${ids.cA2}`)
      .set(H(ja.token))
      .expect(200);
    expect(a2.body).toMatchObject({
      state: 'terminated',
      terminatedBy: 'juristic',
      access: { active: false },
    });
    expect(a2.body.access.revokedAt).not.toBeNull();
    // last periods prorated: B1 February 14/28 days, A2 Q1 45/90 days (1 Jan – 14 Feb)
    expect(await job()).toEqual({ requested: 2, ended: 0 });
    const b1 = await one<{ amount: string; service_days: number }>(
      `SELECT amount::text, service_days FROM juristic.management_fee_charge WHERE contract_id = $1 AND period_key = '2027-02'`,
      [ids.cB1],
    );
    expect(b1).toEqual({ amount: '25000.00', service_days: 14 });
    const q1 = await one<{ amount: string; service_days: number; period_days: number }>(
      `SELECT amount::text, service_days, period_days FROM juristic.management_fee_charge WHERE contract_id = $1`,
      [ids.cA2],
    );
    expect(q1).toEqual({ amount: '15000.00', service_days: 45, period_days: 90 });
    // nothing after termination, ever
    await goTo('2027-06-01');
    const r = await job();
    expect(r.requested).toBe(4); // A1 Feb–May only
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM juristic.management_fee_charge WHERE contract_id = $1`,
          [ids.cB1],
        )
      ).n,
    ).toBe(2);

    // the end date: A1 ends 31 Dec 2027 → the job ends it, the grant is revoked, access is gone
    await goTo('2028-01-01');
    expect(await job()).toEqual({ requested: 7, ended: 1 }); // Jun–Dec of A1
    expect((await portfolio(pm.token)).buildings).toEqual([]);
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.A1}`).set(H(pm.token)).expect(404);
    const ended = await t.http
      .get(`/v1/owner/pm/management-contracts/${ids.cA1}`)
      .set(H(pm.token))
      .expect(200);
    expect(ended.body).toMatchObject({
      state: 'ended',
      access: { active: false },
      feesRequested: 12,
      nextActions: [],
    });
    // assignments closed with the contract
    const asg = await one<{ ends_on: string }>(
      `SELECT ends_on::text FROM juristic.pm_staff_assignment WHERE id = $1`,
      [ids.assignment],
    );
    expect(asg.ends_on).toBe('2028-01-01');
    expect(await job()).toEqual({ requested: 0, ended: 0 });
    // audit + outbox
    const events = await q<{ type: string }>(
      `SELECT DISTINCT type FROM platform.domain_event WHERE aggregate_type = 'management_contract' ORDER BY type`,
    );
    expect(events.map((e) => e.type)).toEqual([
      'juristic.management_contract.accepted',
      'juristic.management_contract.cancelled',
      'juristic.management_contract.changed',
      'juristic.management_contract.ended',
      'juristic.management_contract.offered',
      'juristic.management_contract.terminated',
      'juristic.management_fee.requested',
    ]);
    const audits = await q<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM platform.audit_log WHERE action = 'juristic.management_contract_accepted'`,
    );
    expect(audits.map((a) => a.tenant_id).sort()).toEqual([ja.tenantId, jb.tenantId, pm.tenantId].sort());
  });

  it('cross-tenant ids are 404 on every endpoint', async () => {
    const X = H(pm2.token);
    const JB = H(jb.token);
    const reason = { reason: 'ทดสอบข้ามผู้เช่า' };
    // juristic side, another juristic tenant
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA1}`).set(JB).expect(404);
    await t.http
      .patch(`/v1/owner/juristic/management-contracts/${ids.cA1}`)
      .set(JB)
      .send({ title: 'x' })
      .expect(404);
    for (const action of ['offer', 'cancel', 'terminate'])
      await t.http
        .post(`/v1/owner/juristic/management-contracts/${ids.cA1}/actions/${action}`)
        .set(JB)
        .set(idem())
        .send(reason)
        .expect(404);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA1}/charges`).set(JB).expect(404);
    await t.http.get(`/v1/owner/juristic/management-contracts/${ids.cA1}/staff`).set(JB).expect(404);
    expect(
      (await t.http.get(`/v1/owner/juristic/management-contracts?buildingId=${ids.A1}`).set(JB).expect(200))
        .body.data,
    ).toEqual([]);
    // PM side, another PM company
    await t.http.get(`/v1/owner/pm/management-contracts/${ids.cA1}`).set(X).expect(404);
    for (const action of ['accept', 'decline', 'terminate'])
      await t.http
        .post(`/v1/owner/pm/management-contracts/${ids.cA1}/actions/${action}`)
        .set(X)
        .set(idem())
        .send(reason)
        .expect(404);
    await t.http.get(`/v1/owner/pm/management-contracts/${ids.cA1}/charges`).set(X).expect(404);
    await t.http.get(`/v1/owner/pm/portfolio/buildings/${ids.A1}`).set(X).expect(404);
    await t.http
      .post(`/v1/owner/pm/staff-assignments/${ids.assignment}/actions/end`)
      .set(X)
      .send({})
      .expect(404);
    expect((await t.http.get(`/v1/owner/pm/staff-assignments`).set(X).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/pm/staff-board').set(X).expect(200)).body.buildings).toEqual([]);
  });
});
