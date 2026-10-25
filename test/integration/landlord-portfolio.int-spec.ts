import { fakeLineIdToken } from '@collective/integrations/line';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const PROJECT = 'ไอดีโอ โมบิ อารีย์';
const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

interface Signed {
  status: number;
  created: boolean;
  tenantId: string;
  token: string;
}

/** B7.1 acceptance — landlord self sign-up (D-251, D-255), the one-step unit wizard, condo stubs and their hand-over (D-280). */
describe('landlord portfolio (B7.1, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_landlord' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  async function signup(body: Record<string, unknown>): Promise<Signed> {
    const res = await t.http.post('/v1/public/signup/landlord').send(body);
    if (res.status !== 201 && res.status !== 200)
      throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`);
    return {
      status: res.status,
      created: res.body.created as boolean,
      tenantId: res.body.tenant.id as string,
      token: res.body.tokens.accessToken as string,
    };
  }

  async function phoneSignup(phone: string, displayName: string): Promise<Signed> {
    t.clock.advance(61_000);
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    return signup({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName,
    });
  }

  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });

  const addUnit = (s: Signed, body: Record<string, unknown>) =>
    t.http
      .post('/v1/owner/portfolio/units')
      .set(as(s))
      .send({ address: ADDRESS, ...body });

  let somchai: Signed;
  let malee: Signed;

  it('signs a landlord up by phone OTP: a free landlord tenant, its party and an Owner membership', async () => {
    somchai = await phoneSignup('+66810009001', 'สมชาย ใจดี');
    expect(somchai).toMatchObject({ status: 201, created: true });
    const { rows } = await db.admin.query(
      `SELECT t.type, t.legal_form, t.status, p.display_name, m.role, m.status AS m_status
         FROM core.tenant t
         JOIN core.party p ON p.id = t.legal_party_id
         JOIN core.membership m ON m.tenant_id = t.id
        WHERE t.id = $1`,
      [somchai.tenantId],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'landlord',
        legal_form: 'person',
        status: 'active',
        display_name: 'สมชาย ใจดี',
        role: 'owner',
        m_status: 'active',
      }),
    ]);
    const keys = await db.admin.query(
      `SELECT count(*)::int AS n FROM core.tenant_data_key WHERE tenant_id = $1`,
      [somchai.tenantId],
    );
    expect(keys.rows[0].n).toBe(1);
  });

  it('is idempotent per identity: the same phone again answers 200 with the same tenant', async () => {
    const again = await phoneSignup('+66810009001', 'ชื่ออื่น');
    expect(again).toMatchObject({ status: 200, created: false, tenantId: somchai.tenantId });
  });

  it('signs up by LINE, Google and Apple; an identity is never merged by e-mail', async () => {
    malee = await signup({
      provider: 'line',
      idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b71001', name: 'มาลี' }),
      displayName: 'มาลี มีสุข',
    });
    expect(malee).toMatchObject({ status: 201, created: true });
    const google = await signup({
      provider: 'firebase_google',
      idToken: 'fake-firebase.google.g-b71-1.owner%40example.com',
      displayName: 'Owner G',
    });
    const sameEmail = await t.http
      .post('/v1/public/signup/landlord')
      .send({
        provider: 'firebase_apple',
        idToken: 'fake-firebase.apple.a-b71-1.owner%40example.com',
        displayName: 'A',
      })
      .expect(409);
    expect(sameEmail.body.code).toBe('auth.identity_email_in_use'); // never merged by e-mail
    const apple = await signup({
      provider: 'firebase_apple',
      idToken: 'fake-firebase.apple.a-b71-1.relay%40privaterelay.appleid.com',
      displayName: 'Owner A',
    });
    expect(google.created && apple.created).toBe(true);
    expect(apple.tenantId).not.toBe(google.tenantId);
    const noEmail = await t.http
      .post('/v1/public/signup/landlord')
      .send({ provider: 'firebase_apple', idToken: 'fake-firebase.apple.a-b71-2', displayName: 'A' })
      .expect(422);
    expect(noEmail.body.code).toBe('auth.identity_contact_required');
    const replay = await signup({
      provider: 'firebase_google',
      idToken: 'fake-firebase.google.g-b71-1',
      displayName: 'Owner G',
    });
    expect(replay).toMatchObject({ status: 200, tenantId: google.tenantId });
  });

  it('refuses a token of another provider and a missing code', async () => {
    const wrong = await t.http
      .post('/v1/public/signup/landlord')
      .send({ provider: 'firebase_apple', idToken: 'fake-firebase.google.g-b71-2', displayName: 'X' })
      .expect(401);
    expect(wrong.body.code).toBe('auth.identity_token_invalid');
    const missing = await t.http
      .post('/v1/public/signup/landlord')
      .send({ provider: 'phone_otp', displayName: 'X' })
      .expect(422);
    expect(missing.body.code).toBe('validation.failed');
  });

  it('shows the landlord a portfolio menu instead of the building operator menu', async () => {
    const me = await t.http.get('/v1/owner/me').set(as(somchai)).expect(200);
    const keys = me.body.menu as string[];
    expect(keys).toContain('portfolio');
    expect(keys).not.toContain('buildings');
    expect(me.body.currentTenant).toMatchObject({ id: somchai.tenantId, type: 'landlord', role: 'owner' });
  });

  let stubId: string;

  it('adds a house as a one-unit property and building owned and operated by the landlord', async () => {
    const res = await addUnit(somchai, {
      kind: 'house',
      projectName: 'บ้านสวนอารีย์',
      bedrooms: 3,
      bathrooms: 2,
      furnishing: 'partly_furnished',
      defaultRent: '35000.00',
    }).expect(201);
    expect(res.body.stub).toBe(false);
    const { rows } = await db.admin.query(
      `SELECT b.type, b.status, b.owner_tenant_id, b.operator_tenant_id, d.kind, d.bedrooms, uo.source, uo.share_pct
         FROM core.unit u
         JOIN core.building b ON b.id = u.building_id
         JOIN ops.unit_detail d ON d.unit_id = u.id
         JOIN core.unit_ownership uo ON uo.unit_id = u.id
        WHERE u.id = $1`,
      [res.body.unitId],
    );
    expect(rows[0]).toMatchObject({
      type: 'house',
      status: 'active',
      owner_tenant_id: somchai.tenantId,
      operator_tenant_id: somchai.tenantId,
      kind: 'house',
      bedrooms: 3,
      source: 'self_declared',
    });
    expect(Number(rows[0].share_pct)).toBe(100);
  });

  it('puts condo units of one project into one shared stub; each landlord sees only its own units', async () => {
    const a = await addUnit(somchai, {
      kind: 'condo_unit',
      projectName: PROJECT,
      unitNo: '12/345',
      floorLabel: '12',
      areaSqm: '28.50',
      defaultRent: '15000.00',
    }).expect(201);
    const b = await addUnit(malee, {
      kind: 'condo_unit',
      projectName: `  คอนโด ${PROJECT.replace(/ /g, '')} `,
      unitNo: '8/101',
    }).expect(201);
    expect(a.body.stub && b.body.stub).toBe(true);
    expect(b.body.buildingId).toBe(a.body.buildingId);
    stubId = a.body.buildingId as string;

    const stub = await db.admin.query(
      `SELECT status, tenant_id, owner_tenant_id, operator_tenant_id FROM core.building WHERE id = $1`,
      [stubId],
    );
    expect(stub.rows[0]).toEqual({
      status: 'external',
      tenant_id: somchai.tenantId,
      owner_tenant_id: null,
      operator_tenant_id: null,
    });

    const mine = await t.http.get('/v1/owner/portfolio').set(as(malee)).expect(200);
    expect((mine.body.units as { unitNo: string }[]).map((u) => u.unitNo)).toEqual(['8/101']);
    expect(mine.body.units[0]).toMatchObject({ state: 'vacant', building: { id: stubId, external: true } });

    const his = await t.http.get('/v1/owner/portfolio').set(as(somchai)).expect(200);
    expect((his.body.units as { unitNo: string }[]).map((u) => u.unitNo).sort()).toEqual(['1', '12/345']);
    expect(his.body.totals).toMatchObject({ expected: '0.00', collected: '0.00', overdue: '0.00' });
    const condo = (his.body.units as { unitNo: string; defaultRent: string; areaSqm: string }[]).find(
      (u) => u.unitNo === '12/345',
    );
    expect(condo).toMatchObject({ defaultRent: '15000.00', areaSqm: '28.50', kind: 'condo_unit' });
  });

  it('refuses a unit number another landlord already registered in the project', async () => {
    const res = await addUnit(malee, { kind: 'condo_unit', projectName: PROJECT, unitNo: '12/345' }).expect(
      409,
    );
    expect(res.body.code).toBe('portfolio.unit_claimed');
    const own = await addUnit(malee, { kind: 'condo_unit', projectName: PROJECT, unitNo: '8/101' }).expect(
      409,
    );
    expect(own.body.code).toBe('http.conflict');
  });

  it('only landlords use the portfolio wizard', async () => {
    const pm = await onboardTenant(t, admin, { slug: 'pm-b71', phone: '+66810009101', type: 'pm_company' });
    const res = await t.http
      .post('/v1/owner/portfolio/units')
      .set(bearer(pm.token))
      .send({ kind: 'house', address: ADDRESS })
      .expect(403);
    expect(res.body.code).toBe('auth.forbidden');
  });

  it('hands the stub over to the condo juristic person; landlords keep their units (D-280)', async () => {
    const pm = await onboardTenant(t, admin, {
      slug: 'pm-b71-claim',
      phone: '+66810009102',
      type: 'pm_company',
    });
    const bad = await t.http
      .post(`/v1/admin/buildings/${stubId}/actions/claim-stub`)
      .set(bearer(admin))
      .set(idem())
      .send({ ownerTenantId: pm.tenantId })
      .expect(422);
    expect(bad.body.code).toBe('portfolio.claimant_invalid');

    const juristic = await onboardTenant(t, admin, {
      slug: 'ideo-mobi-ari',
      phone: '+66810009103',
      type: 'condo_juristic',
    });
    const res = await t.http
      .post(`/v1/admin/buildings/${stubId}/actions/claim-stub`)
      .set(bearer(admin))
      .set(idem())
      .send({ ownerTenantId: juristic.tenantId, operatorTenantId: pm.tenantId })
      .expect(200);
    expect(res.body).toEqual({
      buildingId: stubId,
      ownerTenantId: juristic.tenantId,
      operatorTenantId: pm.tenantId,
    });

    const { rows } = await db.admin.query(
      `SELECT b.status, b.tenant_id, p.reason
         FROM core.building b JOIN core.building_operator_period p ON p.building_id = b.id
        WHERE b.id = $1`,
      [stubId],
    );
    expect(rows).toEqual([{ status: 'active', tenant_id: pm.tenantId, reason: 'juristic_formed' }]);
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'building.operator_changed' AND subject_id = $1`,
      [stubId],
    );
    expect(audit.rows[0].n).toBe(1);

    const mine = await t.http.get('/v1/owner/portfolio').set(as(malee)).expect(200);
    expect(mine.body.units[0]).toMatchObject({ unitNo: '8/101', building: { id: stubId, external: false } });

    const again = await t.http
      .post(`/v1/admin/buildings/${stubId}/actions/claim-stub`)
      .set(bearer(admin))
      .set(idem())
      .send({ ownerTenantId: juristic.tenantId })
      .expect(409);
    expect(again.body.code).toBe('portfolio.not_a_stub');
  });
});
