import { fakeLineIdToken } from '@collective/integrations/line';
import { signEkycBody } from '@integrations/ekyc/ekyc.port';
import { FAKE_EKYC_SECRET } from '@integrations/ekyc/fake-ekyc';
import sharp from 'sharp';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));

type Status = {
  verified: boolean;
  verifiedAt: string | null;
  available: boolean;
  latest: {
    id: string;
    state: string;
    verificationUrl: string | null;
    failureReason: string | null;
  } | null;
};

/** B7.10 part 2 acceptance — verified people through the e-KYC port (D-267; O-021: fake provider). */
describe('identity verification (B7.10 part 2, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let listing: { id: string; slug: string; unitId: string };

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const sessionOf = (url: string) => url.split('/webhooks/ekyc/fake/sessions/')[1]!;

  /** The provider's signed outcome. */
  function deliver(sessionId: string, outcome: 'approved' | 'rejected', reason?: string) {
    const raw = JSON.stringify({ sessionId, outcome, ...(reason ? { reason } : {}) });
    return t.http
      .post('/webhooks/ekyc/fake')
      .set('Content-Type', 'application/json')
      .set('X-Ekyc-Signature', signEkycBody(raw, FAKE_EKYC_SECRET))
      .send(raw);
  }

  async function prospect(sub: string, name: string): Promise<string> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_ekyc_b710' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', EKYC_MODE: 'fake' });
    t.clock.advance(61_000);
    const phone = '+66810009410';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'มาลี มีสุข',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as())
      .send({
        kind: 'condo_unit',
        projectName: 'ไอดีโอ โมบิ อารีย์',
        unitNo: '12/410',
        address: ADDRESS,
        areaSqm: '28.50',
        bedrooms: 1,
        bathrooms: 1,
      })
      .expect(201);
    const unitId = unit.body.unitId as string;
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as())
      .send({
        unitId,
        titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
        rent: '15000',
        depositMonths: 2,
        minTermMonths: 12,
      })
      .expect(201);
    listing = { id: created.body.id as string, slug: created.body.slug as string, unitId };
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, owner.token, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unitId,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
        tenantId: owner.tenantId,
      });
      await t.http.post(`/v1/owner/listings/${listing.id}/photos`).set(as()).send({ documentId }).expect(201);
    }
    await t.http
      .put(`/v1/owner/listings/${listing.id}/availability`)
      .set(as())
      .send({ weekly: EVERY_DAY, exceptions: [], slotMinutes: 30 })
      .expect(200);
    await t.http.post(`/v1/owner/listings/${listing.id}/actions/submit`).set(as()).expect(200);
    const admin = await adminToken(t);
    await t.http
      .post(`/v1/admin/listings/${listing.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    // the unit's ownership is verified, so the owner page is public (D-274)
    await db.admin.query(
      `INSERT INTO platform.listing_verification (tenant_id, unit_id, state, evidence_kind, evidence_document_ids, decided_at)
       VALUES ($1, $2, 'approved', 'condo_title', ARRAY[gen_random_uuid()], now())`,
      [owner.tenantId, unitId],
    );
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('owner: start → the provider approves (signed) → the badge on the listing and the owner page', async () => {
    const before = await t.http.get('/v1/owner/me/identity-verification').set(as()).expect(200);
    expect(before.body).toEqual({ verified: false, verifiedAt: null, available: true, latest: null });
    const listed = await t.http.get(`/v1/public/listings/${listing.slug}`).expect(200);
    expect(listed.body.ownerIdentityVerified).toBe(false);

    const started = await t.http
      .post('/v1/owner/me/identity-verification')
      .set(as())
      .send({ language: 'th' })
      .expect(200);
    const s = started.body as Status;
    expect(s.verified).toBe(false);
    expect(s.latest).toMatchObject({ state: 'pending', failureReason: null });
    expect(s.latest!.verificationUrl).toMatch(/\/webhooks\/ekyc\/fake\/sessions\/fake-ekyc-/);
    // a pending attempt is answered again
    const again = await t.http.post('/v1/owner/me/identity-verification').set(as()).send({}).expect(200);
    expect((again.body as Status).latest!.id).toBe(s.latest!.id);

    const sessionId = sessionOf(s.latest!.verificationUrl!);
    const ack = await deliver(sessionId, 'approved').expect(200);
    expect(ack.body).toEqual({ handled: true, state: 'approved' });
    // a repeated delivery is answered once
    const repeat = await deliver(sessionId, 'rejected', 'late').expect(200);
    expect(repeat.body).toEqual({ handled: false, state: 'approved' });

    const after = await t.http.get('/v1/owner/me/identity-verification').set(as()).expect(200);
    expect(after.body).toMatchObject({
      verified: true,
      latest: { state: 'approved', verificationUrl: null },
    });
    expect(after.body.verifiedAt).toEqual(expect.any(String));
    await t.http
      .post('/v1/owner/me/identity-verification')
      .set(as())
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('identity.already_verified'));

    const shown = await t.http.get(`/v1/public/listings/${listing.slug}`).expect(200);
    expect(shown.body.ownerIdentityVerified).toBe(true);
    const slug = shown.body.ownerProfileSlug as string;
    expect(slug).toEqual(expect.any(String));
    const page = await t.http.get(`/v1/public/owners/${slug}`).expect(200);
    expect(page.body.verification).toMatchObject({
      level: 'unit_ownership',
      verifiedUnits: 1,
      identityVerified: true,
    });
    const search = await t.http.get('/v1/public/listings').expect(200);
    const card = (search.body.data as { slug: string; ownerIdentityVerified: boolean }[]).find(
      (l) => l.slug === listing.slug,
    );
    expect(card?.ownerIdentityVerified).toBe(true);

    // only the outcome is kept, audited, with an event
    const { rows } = await db.admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 ORDER BY id`,
      [s.latest!.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['identity.verification_started', 'identity.verified']);
    const events = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'identity.verified' AND aggregate_id = $1`,
      [s.latest!.id],
    );
    expect(events.rows[0]!.n).toBe(1);
  });

  it('prospect: a rejection keeps the reason, a new attempt is approved, the owner sees it on the lead', async () => {
    const token = await prospect('U000000000000000000000000000b7101', 'สมศรี ใจดี');
    const lead = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(token))
      .send({ message: 'สนใจห้องนี้ค่ะ', consent: true })
      .expect(201);
    const unverified = await t.http.get(`/v1/owner/leads/${lead.body.id}`).set(as()).expect(200);
    expect(unverified.body.prospect.identityVerified).toBe(false);

    const first = await t.http
      .post('/v1/prospect/me/identity-verification')
      .set(bearer(token))
      .send({ language: 'en' })
      .expect(200);
    const firstSession = sessionOf((first.body as Status).latest!.verificationUrl!);
    await deliver(firstSession, 'rejected', 'The ID card photo is blurred.').expect(200);
    const rejected = await t.http.get('/v1/prospect/me/identity-verification').set(bearer(token)).expect(200);
    expect(rejected.body).toMatchObject({
      verified: false,
      latest: { state: 'rejected', failureReason: 'The ID card photo is blurred.', verificationUrl: null },
    });

    const second = await t.http
      .post('/v1/prospect/me/identity-verification')
      .set(bearer(token))
      .send({})
      .expect(200);
    expect((second.body as Status).latest!.id).not.toBe((first.body as Status).latest!.id);
    // the fake provider's own page decides too (demos)
    const secondSession = sessionOf((second.body as Status).latest!.verificationUrl!);
    await t.http.get(`/webhooks/ekyc/fake/sessions/${secondSession}`).expect(200);
    await t.http.post(`/webhooks/ekyc/fake/sessions/${secondSession}/approve`).expect(200);

    const verified = await t.http.get(`/v1/owner/leads/${lead.body.id}`).set(as()).expect(200);
    expect(verified.body.prospect.identityVerified).toBe(true);
    const list = await t.http.get('/v1/owner/leads').set(as()).expect(200);
    expect(
      (list.body as { id: string; prospect: { identityVerified: boolean } }[]).find(
        (l) => l.id === lead.body.id,
      )?.prospect.identityVerified,
    ).toBe(true);
  });

  it('refuses an unsigned or wrongly signed webhook, a malformed body and an unknown provider', async () => {
    const raw = JSON.stringify({ sessionId: 'fake-ekyc-nothing', outcome: 'approved' });
    await t.http
      .post('/webhooks/ekyc/fake')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(401)
      .expect((r) => expect(r.body.code).toBe('webhook.signature_invalid'));
    await t.http
      .post('/webhooks/ekyc/fake')
      .set('Content-Type', 'application/json')
      .set('X-Ekyc-Signature', signEkycBody(raw, 'another-secret-of-16+'))
      .send(raw)
      .expect(401);
    const bad = JSON.stringify({ sessionId: 'x', outcome: 'maybe' });
    await t.http
      .post('/webhooks/ekyc/fake')
      .set('Content-Type', 'application/json')
      .set('X-Ekyc-Signature', signEkycBody(bad, FAKE_EKYC_SECRET))
      .send(bad)
      .expect(422);
    await deliver('fake-ekyc-unknown', 'approved').expect(404);
    await t.http
      .post('/webhooks/ekyc/other')
      .set('Content-Type', 'application/json')
      .set('X-Ekyc-Signature', signEkycBody(raw, FAKE_EKYC_SECRET))
      .send(raw)
      .expect(404);
  });

  it('answers ekyc.unavailable while no provider is configured (EKYC_MODE=off, O-021)', async () => {
    const off = await createIntApp(db, { EKYC_MODE: 'off' });
    try {
      const token = (
        await off.http
          .post('/v1/auth/prospect/line')
          .send({ idToken: fakeLineIdToken({ sub: 'U000000000000000000000000000b7102', name: 'สมชาย' }) })
          .expect(200)
      ).body.accessToken as string;
      const status = await off.http
        .get('/v1/prospect/me/identity-verification')
        .set(bearer(token))
        .expect(200);
      expect(status.body).toMatchObject({ verified: false, available: false, latest: null });
      const refused = await off.http
        .post('/v1/prospect/me/identity-verification')
        .set(bearer(token))
        .send({})
        .expect(503);
      expect(refused.body.code).toBe('ekyc.unavailable');
      await off.http.get('/webhooks/ekyc/fake/sessions/fake-ekyc-x').expect(404);
    } finally {
      await off.close();
      process.env.EKYC_MODE = 'fake';
    }
  });
});
