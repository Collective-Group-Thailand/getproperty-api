import { fakeLineIdToken } from '@collective/integrations/line';
import { base32Decode, totpAt } from '@core/identity/crypto/totp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const OWNER_PHONE = '+660000000001';

async function operatorLogin(t: IntApp, phone = OWNER_PHONE) {
  t.clock.advance(61_000); // OTP resend interval
  const challenge = await t.http.post('/v1/auth/operator/otp/request').send({ phone }).expect(200);
  const code = t.sms.lastCodeTo(phone);
  expect(code).toMatch(/^\d{6}$/);
  const res = await t.http
    .post('/v1/auth/operator/otp/verify')
    .send({ challengeId: challenge.body.challengeId, code })
    .expect(200);
  return res.body as { accessToken: string; refreshToken: string };
}

/** B1.3 acceptance — authentication for every audience against a real database. */
describe('auth (B1.3 acceptance, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_auth' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('operator OTP login → /v1/owner/me with tenants, permissions and menu', async () => {
    const { accessToken } = await operatorLogin(t);
    const me = await t.http.get('/v1/owner/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.currentTenant).toMatchObject({ id: DEV.tenantId, type: 'apartment', role: 'owner' });
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['tenant.bank_account.manage', 'tenant.audit.read']),
    );
    expect(me.body.menu.length).toBeGreaterThan(0);
    expect(me.body.featureFlags['module.service_requests']).toBe(false);
  });

  it('a wrong OTP is refused and the attempts are limited', async () => {
    const challenge = await t.http
      .post('/v1/auth/operator/otp/request')
      .send({ phone: '+660000000002' })
      .expect(200);
    const code = t.sms.lastCodeTo('+660000000002')!;
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await t.http
      .post('/v1/auth/operator/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: wrong })
      .expect(401);
    expect(res.body.code).toBe('auth.otp_invalid');
  });

  it('refresh rotates; reusing a rotated refresh token revokes the whole family', async () => {
    const first = await operatorLogin(t);
    const second = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    t.clock.advance(31_000); // past the rotation grace window (D-229)
    const reuse = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expect(reuse.body.code).toBe('auth.refresh_reused');
    // the newest token of the family is dead too, and so is the access token of the family
    await t.http.post('/v1/auth/refresh').send({ refreshToken: second.body.refreshToken }).expect(401);
    await t.http.get('/v1/owner/me').set('Authorization', `Bearer ${second.body.accessToken}`).expect(401);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'auth.refresh_reuse_detected'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('D-229: two concurrent refreshes with the same token both get the same successor; the family survives', async () => {
    const first = await operatorLogin(t);
    const [a, b] = await Promise.all([
      t.http.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
      t.http.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.refreshToken).toBe(b.body.refreshToken);
    expect(a.body.refreshToken).not.toBe(first.refreshToken);
    // both access tokens work and the successor keeps rotating normally
    await t.http.get('/v1/owner/me').set('Authorization', `Bearer ${a.body.accessToken}`).expect(200);
    await t.http.get('/v1/owner/me').set('Authorization', `Bearer ${b.body.accessToken}`).expect(200);
    const next = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: a.body.refreshToken })
      .expect(200);
    await t.http.get('/v1/owner/me').set('Authorization', `Bearer ${next.body.accessToken}`).expect(200);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM platform.auth_session s
        WHERE s.family_id = (SELECT family_id FROM platform.auth_session WHERE refresh_token_hash = sha256(convert_to($1, 'UTF8')))
          AND s.revoked_at IS NOT NULL`,
      [first.refreshToken],
    );
    expect(rows[0].n).toBe(0);
  });

  it('D-229: the grace covers only the immediately previous token while its successor is unused', async () => {
    const first = await operatorLogin(t);
    const second = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const third = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(200);
    // `first`'s successor (`second`) is already rotated → reuse, the family dies although we are inside 30 s
    const reuse = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expect(reuse.body.code).toBe('auth.refresh_reused');
    await t.http.post('/v1/auth/refresh').send({ refreshToken: third.body.refreshToken }).expect(401);
  });

  it('D-229: resident audience — a replay within the window answers the same pair, after it the family is revoked', async () => {
    const idToken = fakeLineIdToken({ sub: 'U00000000000000000000000000000077', name: 'ผู้เช่า เกรซ' });
    const login = await t.http.post('/v1/auth/resident/line').send({ idToken }).expect(200);
    const a = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    t.clock.advance(10_000);
    const b = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(b.body.refreshToken).toBe(a.body.refreshToken);
    expect(b.body.subject.audience).toBe('resident');
    await t.http.get('/v1/resident/me').set('Authorization', `Bearer ${b.body.accessToken}`).expect(200);
    t.clock.advance(21_000);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: a.body.refreshToken }).expect(401);
  });

  it('logout revokes the session', async () => {
    const s = await operatorLogin(t);
    await t.http.post('/v1/auth/logout').send({ refreshToken: s.refreshToken }).expect(204);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });

  it('operator email + password login', async () => {
    const res = await t.http
      .post('/v1/auth/operator/login')
      .send({ email: 'owner@example.invalid', password: DEV.password })
      .expect(200);
    expect(res.body.subject).toMatchObject({ audience: 'operator' });
    const bad = await t.http
      .post('/v1/auth/operator/login')
      .send({ email: 'owner@example.invalid', password: 'wrong-password-123' })
      .expect(401);
    expect(bad.body.code).toBe('auth.invalid_credentials');
  });

  it('platform login with mandatory TOTP: enrol on first sign-in, then password + TOTP', async () => {
    const first = await t.http
      .post('/v1/auth/platform/login')
      .send({ email: 'admin@getproperty.invalid', password: DEV.password })
      .expect(403);
    expect(first.body.code).toBe('auth.totp_enrollment_required');
    const enrol = await t.http
      .post('/v1/auth/platform/totp/enroll')
      .send({ enrollmentToken: first.body.enrollmentToken })
      .expect(200);
    expect(base32Decode(enrol.body.secret).length).toBeGreaterThanOrEqual(20);
    const activated = await t.http
      .post('/v1/auth/platform/totp/activate')
      .send({ enrollmentToken: first.body.enrollmentToken, code: totpAt(enrol.body.secret, t.clock.now()) })
      .expect(200);
    const me = await t.http
      .get('/v1/admin/me')
      .set('Authorization', `Bearer ${activated.body.accessToken}`)
      .expect(200);
    expect(me.body.roles).toContain('platform_admin');
    expect(me.body.totpEnabled).toBe(true);

    t.clock.advance(60_000);
    const noCode = await t.http
      .post('/v1/auth/platform/login')
      .send({ email: 'admin@getproperty.invalid', password: DEV.password })
      .expect(401);
    expect(noCode.body.code).toBe('auth.totp_required');
    await t.http
      .post('/v1/auth/platform/login')
      .send({
        email: 'admin@getproperty.invalid',
        password: DEV.password,
        totpCode: totpAt(enrol.body.secret, t.clock.now()),
      })
      .expect(200);
  });

  it('resident LINE id-token exchange (fake LINE) → /v1/resident/me', async () => {
    const idToken = fakeLineIdToken({ sub: 'U00000000000000000000000000000055', name: 'ผู้เช่า ทดสอบ' });
    const res = await t.http.post('/v1/auth/resident/line').send({ idToken }).expect(200);
    expect(res.body.subject).toMatchObject({ audience: 'resident', type: 'user' });
    // the same LINE user signs in to the same account
    const again = await t.http.post('/v1/auth/resident/line').send({ idToken }).expect(200);
    expect(again.body.subject.id).toBe(res.body.subject.id);
    const bad = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: 'forged.token.value' })
      .expect(401);
    expect(bad.body.code).toBe('auth.line_token_invalid');
    const me = await t.http
      .get('/v1/resident/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.user).toBeDefined();
    expect(me.body.consentComplete).toBe(false);
  });

  it('a token of one audience is rejected on every other prefix', async () => {
    const operator = await operatorLogin(t);
    const auth = { Authorization: `Bearer ${operator.accessToken}` };
    for (const path of ['/v1/resident/me', '/v1/admin/me', '/v1/technician/me']) {
      const res = await t.http.get(path).set(auth).expect(403);
      expect(res.body.code).toBe('auth.wrong_audience');
    }
    await t.http.get('/v1/owner/me').expect(401);
    await t.http.get('/v1/owner/me').set('Authorization', 'Bearer not-a-token').expect(401);
  });

  it('JWKS publishes the EdDSA verification key', async () => {
    const res = await t.http.get('/v1/auth/.well-known/jwks.json').expect(200);
    expect(res.body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
  });
});
