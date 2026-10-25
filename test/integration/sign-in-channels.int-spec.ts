import { fakeLineIdToken } from '@collective/integrations/line';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const google = (uid: string, email?: string) =>
  `fake-firebase.google.${uid}${email ? `.${encodeURIComponent(email)}` : ''}`;
const apple = (uid: string, email?: string) =>
  `fake-firebase.apple.${uid}${email ? `.${encodeURIComponent(email)}` : ''}`;

/** B7.8 sign-in (D-255, D-283) — Google, Apple, LINE and phone on every audience, against the fake verifiers. */
describe('sign-in on every channel (B7.8, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { token: string; tenantId: string };

  async function landlordByPhone(phone: string, name: string) {
    t.clock.advance(61_000);
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const res = await t.http
      .post('/v1/public/signup/landlord')
      .send({
        provider: 'phone_otp',
        challengeId: challenge.body.challengeId,
        code: t.sms.lastCodeTo(phone),
        displayName: name,
      })
      .expect(201);
    return { token: res.body.tokens.accessToken as string, tenantId: res.body.tenant.id as string };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_sign_in' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await landlordByPhone('+66810009801', 'มาลี มีสุข');
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('signs an operator in with Google only once the identity is linked on the profile', async () => {
    const before = await t.http
      .post('/v1/auth/operator/identity')
      .send({ provider: 'firebase_google', idToken: google('g-owner-1', 'malee@example.com') });
    expect(before.status).toBe(401);
    expect(before.body.code).toBe('auth.identity_not_linked');

    const linked = await t.http
      .post('/v1/owner/me/identities')
      .set(bearer(owner.token))
      .send({ provider: 'firebase_google', idToken: google('g-owner-1', 'malee@example.com') })
      .expect(200);
    expect(linked.body).toMatchObject({ phoneMasked: expect.stringContaining('1'), hasPassword: false });
    expect(linked.body.identities).toEqual([
      expect.objectContaining({ provider: 'firebase_google', email: 'malee@example.com', removable: true }),
    ]);
    // idempotent
    await t.http
      .post('/v1/owner/me/identities')
      .set(bearer(owner.token))
      .send({ provider: 'firebase_google', idToken: google('g-owner-1', 'malee@example.com') })
      .expect(200);

    const signed = await t.http
      .post('/v1/auth/operator/identity')
      .send({ provider: 'firebase_google', idToken: google('g-owner-1') })
      .expect(200);
    expect(signed.body.subject).toMatchObject({ audience: 'operator', scopes: [`tenant:${owner.tenantId}`] });
    const bad = await t.http
      .post('/v1/auth/operator/identity')
      .send({ provider: 'firebase_google', idToken: 'not-a-token-at-all' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('auth.identity_token_invalid');
  });

  it('never moves an identity from one account to another', async () => {
    const other = await landlordByPhone('+66810009802', 'สมชาย ใจดี');
    const taken = await t.http
      .post('/v1/owner/me/identities')
      .set(bearer(other.token))
      .send({ provider: 'firebase_google', idToken: google('g-owner-1') });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('auth.identity_in_use');
  });

  it('adds LINE to an operator (kept: it carries notifications) and removes Google while the phone remains', async () => {
    const withLine = await t.http
      .post('/v1/owner/me/identities')
      .set(bearer(owner.token))
      .send({
        provider: 'line',
        idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b7801', name: 'Malee' }),
      })
      .expect(200);
    type Row = { id: string; provider: string; removable: boolean };
    const rows = withLine.body.identities as Row[];
    const line = rows.find((i) => i.provider === 'line')!;
    const g = rows.find((i) => i.provider === 'firebase_google')!;
    expect(line.removable).toBe(false);
    await t.http
      .post('/v1/auth/operator/identity')
      .send({ provider: 'line', idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b7801' }) })
      .expect(200);
    const locked = await t.http.delete(`/v1/owner/me/identities/${line.id}`).set(bearer(owner.token));
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('auth.identity_locked');
    const removed = await t.http
      .delete(`/v1/owner/me/identities/${g.id}`)
      .set(bearer(owner.token))
      .expect(200);
    expect((removed.body.identities as Row[]).map((i) => i.provider)).toEqual(['line']);
    const gone = await t.http
      .post('/v1/auth/operator/identity')
      .send({ provider: 'firebase_google', idToken: google('g-owner-1') });
    expect(gone.body.code).toBe('auth.identity_not_linked');
  });

  it('signs a prospect in by phone outside LINE, and with Google (created on first use)', async () => {
    const phone = '+66810009803';
    const challenge = await t.http
      .post('/v1/auth/prospect/otp/request')
      .send({ phone, language: 'en' })
      .expect(200);
    const wrong = await t.http
      .post('/v1/auth/prospect/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: '000000' });
    expect(wrong.status).toBe(401);
    const signed = await t.http
      .post('/v1/auth/prospect/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(phone) })
      .expect(200);
    expect(signed.body.subject).toMatchObject({ audience: 'prospect', scopes: [] });
    await t.http.get('/v1/prospect/me').set(bearer(signed.body.accessToken)).expect(200);

    const noEmail = await t.http
      .post('/v1/auth/prospect/identity')
      .send({ provider: 'firebase_apple', idToken: apple('a-prospect-0') });
    expect(noEmail.status).toBe(422);
    expect(noEmail.body.code).toBe('auth.identity_contact_required');
    const first = await t.http
      .post('/v1/auth/prospect/identity')
      .send({ provider: 'firebase_google', idToken: google('g-prospect-1', 'alex@example.com') })
      .expect(200);
    const again = await t.http
      .post('/v1/auth/prospect/identity')
      .send({ provider: 'firebase_google', idToken: google('g-prospect-1', 'alex@example.com') })
      .expect(200);
    expect(again.body.subject.id).toBe(first.body.subject.id);
    const sameEmail = await t.http
      .post('/v1/auth/prospect/identity')
      .send({ provider: 'firebase_apple', idToken: apple('a-prospect-2', 'alex@example.com') });
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.code).toBe('auth.identity_email_in_use');
  });

  it('opens the resident app with Apple once linked, and keeps one way to sign in', async () => {
    const unknown = await t.http
      .post('/v1/auth/resident/identity')
      .send({ provider: 'firebase_apple', idToken: apple('a-resident-1', 'res@example.com') });
    expect(unknown.body.code).toBe('auth.identity_not_linked');
    const viaLine = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b7802', name: 'Res' }) })
      .expect(200);
    await t.http
      .post('/v1/resident/me/identities')
      .set(bearer(viaLine.body.accessToken))
      .send({ provider: 'firebase_apple', idToken: apple('a-resident-1', 'res@example.com') })
      .expect(200);
    const apples = await t.http
      .post('/v1/auth/resident/identity')
      .send({ provider: 'firebase_apple', idToken: apple('a-resident-1') })
      .expect(200);
    expect(apples.body.subject).toMatchObject({ audience: 'resident', id: viaLine.body.subject.id });

    // a Google-only account (a prospect) may not remove its only sign-in
    const only = await t.http
      .post('/v1/auth/resident/identity')
      .send({ provider: 'firebase_google', idToken: google('g-prospect-1') })
      .expect(200);
    const list = await t.http
      .get('/v1/resident/me/identities')
      .set(bearer(only.body.accessToken))
      .expect(200);
    expect(list.body).toMatchObject({ phoneMasked: null, hasPassword: false });
    const last = await t.http
      .delete(`/v1/resident/me/identities/${list.body.identities[0].id}`)
      .set(bearer(only.body.accessToken));
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('auth.identity_last');
  });

  it('records the failed and the linked identities in the audit log', async () => {
    const { rows } = await db.admin.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM platform.audit_log
        WHERE action IN ('auth.identity_linked', 'auth.identity_unlinked', 'auth.login_failed') GROUP BY action`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
    expect(by['auth.identity_linked']).toBeGreaterThanOrEqual(3);
    expect(by['auth.identity_unlinked']).toBe(1);
    expect(by['auth.login_failed']).toBeGreaterThanOrEqual(3);
  });
});
