import { createHash } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import { SettingsService } from '@core/settings/settings.service';
import { type FakeIntegrationTransport } from '@integrations/integration-webhooks/integration-transport';
import { type FakeListingWriter } from '@integrations/listing-writer/fake-listing-writer';
import { LISTING_WRITER } from '@integrations/listing-writer/listing-writer.port';
import { IntegrationDeliveryService } from '@modules/bridge-integrations/integration-delivery.service';
import { EnergyInsightService } from '@modules/smart-energy/energy-insight.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const RESIDENT_SUB = 'U-g9-resident';
const OTHER_SUB = 'U-g9-other';

/**
 * G9 acceptance (docs/prompts/G-growth-api.md G9; D-301, D-289 (6), D-161, O-028, O-035, O-036; real PostgreSQL, fake
 * AI and fake getenergy transport): a review only from verified tenure (after 3 months or after move-out), with the
 * explicit consent, without personal data, moderated, publicly anonymous, answered but never deletable by the owner,
 * withdrawable by the author; the listing assistant records AI usage per call, respects the monthly limit, never
 * touches photos; energy insight leaves nothing before the owner opts in, then sends aggregates only through the
 * signed port, and withdraws the lead on opt-out. Cross-tenant ids are 404 on every new owner endpoint.
 */
describe('G9 reviews, listing assistant & energy insight (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let stranger: { tenantId: string; token: string };
  let resident: Record<string, string>;
  let otherResident: Record<string, string>;
  let listing: { id: string; slug: string };
  let reviewId: string;

  const dev = () => ({ ...bearer(owner), 'X-Tenant-Id': DEV.tenantId });
  const other = () => ({ ...bearer(stranger.token), 'X-Tenant-Id': stranger.tenantId });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const writer = () => t.app.get<FakeListingWriter>(LISTING_WRITER);
  const getenergy = () =>
    t.app.get(IntegrationDeliveryService).transportFor('getenergy') as FakeIntegrationTransport;

  async function residentLogin(sub: string, name: string, partyId?: string): Promise<Record<string, string>> {
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    if (partyId)
      await db.admin.query(
        `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
         SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
        [DEV.tenantId, partyId, sub],
      );
    const refreshed = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    return bearer(refreshed.body.accessToken as string);
  }

  async function setting(key: string, value: unknown): Promise<void> {
    t.clock.advance(1_000);
    await t.http
      .put(`/v1/admin/settings/${key}`)
      .set(bearer(admin))
      .send({ value, reason: 'ทดสอบ G9' })
      .expect(200);
    t.app.get(SettingsService).invalidate(key);
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g9' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    owner = await ownerToken(t);
    stranger = await onboardTenant(t, admin, {
      slug: 'g9-stranger',
      phone: '+660000000991',
      type: 'landlord',
    });
    resident = await residentLogin(RESIDENT_SUB, 'Somchai', DEV.residentPartyId);
    otherResident = await residentLogin(OTHER_SUB, 'Somsri');
    // a published listing of the dev building (its public page carries the building's reviews)
    const rows = await q<{ id: string; slug: string }>(
      `INSERT INTO ops.listing (tenant_id, unit_id, building_id, state, slug, title_th, rent, unit_kind, size_sqm,
                               bedrooms, bathrooms, province, district, facilities, published_at)
       SELECT u.tenant_id, u.id, u.building_id, 'published', 'room-1br-g9review01', 'ห้องพักใกล้ BTS', 4500, 'room', 24,
              1, 1, 'กรุงเทพมหานคร', 'พญาไท', ARRAY['wifi'], now()
         FROM core.unit u WHERE u.building_id = $1 AND u.unit_no = 'A-102' RETURNING id, slug`,
      [DEV.buildingId],
    );
    listing = rows[0]!;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  // ------------------------------------------------------------------------------------------- reviews

  it('a review needs verified tenure: refused before 3 months, with the first eligible day', async () => {
    const view = await t.http.get(`/v1/resident/leases/${DEV.leaseId}/review`).set(resident).expect(200);
    expect(view.body).toMatchObject({
      eligibility: { eligible: false, reason: 'too_early', eligibleFrom: '2027-01-01' },
      review: null,
      consent: { purposeKey: 'review.publish', version: 1 },
    });
    const refused = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(idem())
      .send({ rating: 4, body: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว', consentVersion: 1 })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'review.not_eligible', reviewEligibleFrom: '2027-01-01' });
    // someone without this lease: 404, not a hint
    await t.http.get(`/v1/resident/leases/${DEV.leaseId}/review`).set(otherResident).expect(404);
    await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(otherResident)
      .set(idem())
      .send({ rating: 1, body: 'ไม่เคยอยู่แต่อยากรีวิว', consentVersion: 1 })
      .expect(404);
  });

  it('after 3 months: explicit consent, no personal data, one per lease, waits for moderation', async () => {
    await q(`UPDATE ops.lease SET move_in_at = '2026-05-20T10:00:00+07:00' WHERE id = $1`, [DEV.leaseId]);
    const view = await t.http.get(`/v1/resident/leases/${DEV.leaseId}/review`).set(resident).expect(200);
    expect(view.body.eligibility).toEqual({
      eligible: true,
      reason: null,
      eligibleFrom: null,
      tenure: { from: '2026-05', to: null },
    });
    const body = { rating: 4, body: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย', consentVersion: 1 };
    await t.http.post(`/v1/resident/leases/${DEV.leaseId}/review`).set(resident).send(body).expect(400);
    const noConsent = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(idem())
      .send({ ...body, consentVersion: 7 })
      .expect(409);
    expect(noConsent.body.code).toBe('review.consent_required');
    const pii = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(idem())
      .send({ ...body, body: 'ห้องดีมาก ติดต่อผมได้ที่ 081-234-5678 นะครับ' })
      .expect(422);
    expect(pii.body.code).toBe('review.personal_data');
    expect(pii.body.errors[0]).toMatchObject({ path: 'body', code: 'phone' });

    const key = idem();
    const created = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(key)
      .send(body)
      .expect(201);
    reviewId = created.body.id as string;
    expect(created.body).toMatchObject({
      state: 'pending_moderation',
      rating: 4,
      tenure: { from: '2026-05', to: null },
      publishedAt: null,
    });
    // replay of the same key answers the first response; a second review of the lease is refused
    const replay = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(reviewId);
    const again = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review`)
      .set(resident)
      .set(idem())
      .send(body)
      .expect(409);
    expect(again.body.code).toBe('review.already_submitted');
    // consent row with tenant NULL (Collective controls the public review); the audit row carries no text
    const consent = await q<{ tenant_id: string | null; granted: boolean }>(
      `SELECT c.tenant_id, c.granted FROM ops.building_review r JOIN platform.consent c ON c.id = r.consent_id WHERE r.id = $1`,
      [reviewId],
    );
    expect(consent).toEqual([{ tenant_id: null, granted: true }]);
    const audit = await q<{ m: string }>(
      `SELECT coalesce(metadata::text, '') || coalesce(after::text, '') AS m FROM platform.audit_log
        WHERE action = 'building_review.submitted' AND subject_id = $1`,
      [reviewId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.m).not.toContain('ที่จอดรถ');
    // pending: not public, not in the owner's list
    const pub = await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200);
    expect(pub.body).toMatchObject({ summary: { count: 0, average: null }, data: [] });
    const own = await t.http.get('/v1/owner/reviews').set(dev()).expect(200);
    expect(own.body.meta.total).toBe(0);
  });

  it('moderation publishes it anonymously; the owner replies and reports but cannot delete', async () => {
    const queue = await t.http
      .get('/v1/admin/reviews?state=pending_moderation')
      .set(bearer(admin))
      .expect(200);
    expect((queue.body.data as { id: string }[]).map((r) => r.id)).toEqual([reviewId]);
    await t.http.post(`/v1/admin/reviews/${reviewId}/actions/approve`).set(bearer(admin)).expect(400);
    await t.http
      .post(`/v1/admin/reviews/${reviewId}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    await t.http
      .post(`/v1/admin/reviews/${reviewId}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(409);
    await t.http.get(`/v1/admin/reviews/${reviewId}`).set(dev()).expect(403);

    const pub = await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200);
    expect(pub.body.summary).toEqual({ count: 1, average: '4.0', distribution: [0, 0, 0, 1, 0] });
    expect(pub.body.data[0]).toMatchObject({
      id: reviewId,
      rating: 4,
      verifiedTenant: true,
      tenure: { from: '2026-05', to: null },
      ownerReply: null,
    });
    const text = JSON.stringify(pub.body);
    for (const secret of ['ผู้เช่า ตัวอย่าง', 'A-101', DEV.residentPartyId, DEV.leaseId, '2026-05-20'])
      expect(text).not.toContain(secret);
    await t.http.get('/v1/public/listings/no-such-listing/reviews').expect(404);

    // the owner sees it, replies (screened) and edits the reply
    const own = await t.http.get('/v1/owner/reviews').set(dev()).expect(200);
    expect(own.body.data).toHaveLength(1);
    expect(JSON.stringify(own.body)).not.toContain(DEV.residentPartyId);
    await t.http
      .put(`/v1/owner/reviews/${reviewId}/reply`)
      .set(dev())
      .send({ reply: 'โทรหาเราที่ 081-234-5678' })
      .expect(422);
    await t.http
      .put(`/v1/owner/reviews/${reviewId}/reply`)
      .set(dev())
      .send({ reply: 'ขอบคุณครับ' })
      .expect(200);
    const replied = await t.http
      .put(`/v1/owner/reviews/${reviewId}/reply`)
      .set(dev())
      .send({ reply: 'ขอบคุณครับ เดือนหน้าเพิ่มที่จอดรถ 10 คัน' })
      .expect(200);
    expect(replied.body.ownerReply).toBe('ขอบคุณครับ เดือนหน้าเพิ่มที่จอดรถ 10 คัน');
    const withReply = await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200);
    expect(withReply.body.data[0].ownerReply).toBe('ขอบคุณครับ เดือนหน้าเพิ่มที่จอดรถ 10 คัน');

    // reporting keeps it public; there is no owner path that removes it, and the database refuses a delete
    const reported = await t.http
      .post(`/v1/owner/reviews/${reviewId}/actions/report`)
      .set(dev())
      .send({ reason: 'ข้อความไม่เป็นความจริงเรื่องที่จอดรถ' })
      .expect(200);
    expect(reported.body).toMatchObject({
      state: 'published',
      reportReason: 'ข้อความไม่เป็นความจริงเรื่องที่จอดรถ',
    });
    expect(
      (await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200)).body.summary.count,
    ).toBe(1);
    await t.http.delete(`/v1/owner/reviews/${reviewId}`).set(dev()).expect(404);
    await expect(db.admin.query('DELETE FROM ops.building_review WHERE id = $1', [reviewId])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      db.admin.query('UPDATE ops.building_review SET rating = 5 WHERE id = $1', [reviewId]),
    ).rejects.toThrow(/cannot change/);
    const reports = await t.http.get('/v1/admin/reviews?reported=true').set(bearer(admin)).expect(200);
    expect(reports.body.meta.total).toBe(1);
    await t.http.post(`/v1/admin/reviews/${reviewId}/actions/dismiss-report`).set(bearer(admin)).expect(200);
    expect(
      (await t.http.get('/v1/admin/reviews?reported=true').set(bearer(admin)).expect(200)).body.meta.total,
    ).toBe(0);

    // another tenant: 404 on every owner path, nothing listed
    await t.http.get(`/v1/owner/reviews/${reviewId}`).set(other()).expect(404);
    await t.http.put(`/v1/owner/reviews/${reviewId}/reply`).set(other()).send({ reply: 'x' }).expect(404);
    await t.http
      .post(`/v1/owner/reviews/${reviewId}/actions/report`)
      .set(other())
      .send({ reason: 'ไม่ชอบรีวิวนี้เลย' })
      .expect(404);
    expect((await t.http.get('/v1/owner/reviews').set(other()).expect(200)).body.meta.total).toBe(0);
  });

  it('the platform hides and restores; the author withdraws and the text is erased', async () => {
    await t.http
      .post(`/v1/admin/reviews/${reviewId}/actions/hide`)
      .set(bearer(admin))
      .set(idem())
      .send({})
      .expect(422);
    await t.http
      .post(`/v1/admin/reviews/${reviewId}/actions/hide`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'ตรวจสอบข้อร้องเรียน' })
      .expect(200);
    expect(
      (await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200)).body.summary.count,
    ).toBe(0);
    const hidden = await t.http.get(`/v1/owner/reviews/${reviewId}`).set(dev()).expect(200);
    expect(hidden.body).toMatchObject({ state: 'hidden', moderationReason: 'ตรวจสอบข้อร้องเรียน' });
    await t.http
      .put(`/v1/owner/reviews/${reviewId}/reply`)
      .set(dev())
      .send({ reply: 'ขอบคุณครับ' })
      .expect(409);
    await t.http
      .post(`/v1/admin/reviews/${reviewId}/actions/restore`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    expect(
      (await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200)).body.summary.count,
    ).toBe(1);

    const gone = await t.http
      .post(`/v1/resident/leases/${DEV.leaseId}/review/actions/withdraw`)
      .set(resident)
      .expect(200);
    expect(gone.body).toMatchObject({ state: 'withdrawn', body: null });
    await t.http.post(`/v1/resident/leases/${DEV.leaseId}/review/actions/withdraw`).set(resident).expect(200);
    expect(
      (await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200)).body.summary.count,
    ).toBe(0);
    expect(await q('SELECT body FROM ops.building_review WHERE id = $1', [reviewId])).toEqual([
      { body: null },
    ]);
    await t.http.get(`/v1/owner/reviews/${reviewId}`).set(dev()).expect(404);
    const view = await t.http.get(`/v1/resident/leases/${DEV.leaseId}/review`).set(resident).expect(200);
    expect(view.body.review).toMatchObject({ state: 'withdrawn', body: null });
  });

  it('after move-out a former resident may review at once (verified tenure, months only)', async () => {
    // the same person under a second, short lease that ended last week
    const lease = await q<{ id: string }>(
      `INSERT INTO ops.lease (tenant_id, building_id, unit_id, lessee_party_id, template_version_id, number, status,
                              start_date, end_date, months, move_in_at, move_out_at, rent, activated_at, ended_at)
       SELECT l.tenant_id, l.building_id, u.id, l.lessee_party_id, l.template_version_id, 'CTR-G9-2', 'ended',
              '2026-08-01', '2026-10-20', 3, '2026-08-01T10:00:00+07:00', '2026-10-20T10:00:00+07:00', 4500,
              '2026-07-30T10:00:00+07:00', '2026-10-20T10:00:00+07:00'
         FROM ops.lease l JOIN core.unit u ON u.building_id = l.building_id AND u.unit_no = 'A-103'
        WHERE l.id = $1 RETURNING id`,
      [DEV.leaseId],
    );
    const leaseId = lease[0]!.id;
    await q(
      `INSERT INTO ops.lease_party (tenant_id, lease_id, party_id, role, is_signer) VALUES ($1, $2, $3, 'lessee', true)`,
      [DEV.tenantId, leaseId, DEV.residentPartyId],
    );
    const fresh = await residentLogin(RESIDENT_SUB, 'Somchai');
    await setting('review.moderation.premoderate', false);
    const created = await t.http
      .post(`/v1/resident/leases/${leaseId}/review`)
      .set(fresh)
      .set(idem())
      .send({ rating: 2, body: 'น้ำไม่ค่อยแรงช่วงเย็น แต่ทำเลดี', language: 'th', consentVersion: 1 })
      .expect(201);
    expect(created.body).toMatchObject({ state: 'published', tenure: { from: '2026-08', to: '2026-10' } });
    const pub = await t.http.get(`/v1/public/listings/${listing.slug}/reviews`).expect(200);
    expect(pub.body.summary).toMatchObject({ count: 1, average: '2.0' });
    await setting('review.moderation.premoderate', true);
  });

  // ------------------------------------------------------------------------------------------- listing assistant

  it('the listing assistant drafts th/en/zh, records AI usage, reads photos without touching them', async () => {
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#7aa6c2' } })
      .jpeg()
      .toBuffer();
    const documentId = await uploadFile(t, db, owner, {
      kind: 'listing_photo',
      scopeType: 'unit',
      scopeId: (
        await q<{ unit_id: string }>('SELECT unit_id FROM ops.listing WHERE id = $1', [listing.id])
      )[0]!.unit_id,
      fileName: 'room.jpg',
      mimeType: 'image/jpeg',
      body: photo,
      tenantId: DEV.tenantId,
    });
    await settle();
    await q(
      `INSERT INTO ops.listing_photo (tenant_id, listing_id, document_id, sort_order) VALUES ($1, $2, $3, 0)`,
      [DEV.tenantId, listing.id, documentId],
    );
    const before = await q<{ sha256: Buffer; size_bytes: string; storage_key: string }>(
      'SELECT sha256, size_bytes::text, storage_key FROM core.document WHERE id = $1',
      [documentId],
    );

    await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .send({ languages: ['th'] })
      .expect(400);
    const key = idem();
    const r = await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .set(key)
      .send({ languages: ['th', 'en', 'zh'], includePhotos: true })
      .expect(200);
    expect(r.body).toMatchObject({
      model: 'fake-listing-writer',
      photosUsed: 1,
      usedThisMonth: 1,
      monthlyLimit: 30,
    });
    expect(r.body.drafts.th.description).toContain('4,500 บาท/เดือน');
    expect(r.body.drafts.en.title).toBeTruthy();
    expect(r.body.drafts.zh.description).toContain('泰铢');
    expect(r.body.disclaimer).toContain('AI');
    // the request carried the listing facts only and the photo bytes, unchanged
    const req = writer().requests.at(-1)!;
    expect(req.photos).toHaveLength(1);
    expect(createHash('sha256').update(req.photos[0]!.data).digest()).toEqual(before[0]!.sha256);
    expect(JSON.stringify(req.facts)).not.toMatch(/ผู้เช่า|A-102|\+66/);
    const after = await q('SELECT sha256, size_bytes::text, storage_key FROM core.document WHERE id = $1', [
      documentId,
    ]);
    expect(after).toEqual(before);
    // nothing written to the listing
    expect(await q('SELECT description_th FROM ops.listing WHERE id = $1', [listing.id])).toEqual([
      { description_th: '' },
    ]);
    // a replay answers the first response without a second AI call
    const calls = writer().requests.length;
    await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .set(key)
      .send({ languages: ['th', 'en', 'zh'], includePhotos: true })
      .expect(200);
    expect(writer().requests.length).toBe(calls);
    const usage = await q<{ feature: string; outcome: string; subject_id: string; tenant_id: string }>(
      `SELECT feature, outcome, subject_id, tenant_id FROM platform.ai_usage_record WHERE feature = 'listing_assistant'`,
    );
    expect(usage).toEqual([
      { feature: 'listing_assistant', outcome: 'ok', subject_id: listing.id, tenant_id: DEV.tenantId },
    ]);

    // a gateway failure and an unusable answer are recorded as errors and answered with problems
    writer().failNext = true;
    const down = await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .set(idem())
      .send({ languages: ['en'] })
      .expect(503);
    expect(down.body.code).toBe('assistant.unavailable');
    writer().nextDrafts = { en: { title: 'Nice room', description: 'Call 081-234-5678 to book' } };
    const rejected = await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .set(idem())
      .send({ languages: ['en'] })
      .expect(502);
    expect(rejected.body.code).toBe('assistant.output_rejected');
    expect(
      await q(
        `SELECT outcome, count(*)::int AS n FROM platform.ai_usage_record WHERE feature = 'listing_assistant' GROUP BY 1 ORDER BY 1`,
      ),
    ).toEqual([
      { outcome: 'error', n: 2 },
      { outcome: 'ok', n: 1 },
    ]);

    // the monthly limit (per tenant) and the quota view
    await setting('listing.assistant.monthly_limit', 1);
    const limited = await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(dev())
      .set(idem())
      .send({ languages: ['th'] })
      .expect(429);
    expect(limited.body.code).toBe('assistant.limit_reached');
    expect(limited.headers['retry-after']).toBeTruthy();
    const quota = await t.http.get('/v1/owner/listing-assistant').set(dev()).expect(200);
    expect(quota.body).toEqual({ enabled: true, usedThisMonth: 1, monthlyLimit: 1 });

    // another tenant's listing: 404
    await t.http
      .post(`/v1/owner/listings/${listing.id}/assistant`)
      .set(other())
      .set(idem())
      .send({ languages: ['th'] })
      .expect(404);
  });

  // ------------------------------------------------------------------------------------------- energy insight

  it('energy insight: score from rollups, nothing leaves before the owner opts in', async () => {
    const empty = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/energy-insight`)
      .set(dev())
      .expect(200);
    expect(empty.body).toMatchObject({
      score: null,
      reason: 'insufficient_data',
      canOptIn: true,
      optin: null,
    });
    expect(empty.body.consent).toMatchObject({ purposeKey: 'energy.insight', version: 1 });

    // a main meter, a corridor meter and a pump meter with 20 days of hourly data
    const meters: Record<string, string> = {};
    for (const [name, purpose, label] of [
      ['main', 'main', null],
      ['corridor', 'common_area', 'ไฟทางเดิน'],
      ['pump', 'common_area', 'ปั๊มน้ำ'],
    ] as const) {
      const item = await q<{ id: string }>(
        `INSERT INTO core.asset_item (tenant_id, building_id, category, name) VALUES ($1, $2, 'meter_electric', $3) RETURNING id`,
        [DEV.tenantId, DEV.buildingId, `G9 ${name}`],
      );
      meters[name] = item[0]!.id;
      await q(
        `INSERT INTO core.meter_assignment (tenant_id, building_id, asset_item_id, purpose, utility, code, common_area_label, valid_from)
         VALUES ($1, $2, $3, $4, 'electric', $5, $6, '2026-01-01T00:00:00+07:00')`,
        [DEV.tenantId, DEV.buildingId, item[0]!.id, purpose, `G9-${name}`, label],
      );
    }
    await q(
      `INSERT INTO smart.telemetry_1h (asset_item_id, bucket, tenant_id, building_id, unit, first_time, last_time,
                                       first_register, last_register, min_register, max_register, points, usage)
       SELECT m.id, b, $1, $2, 'kwh', b, b + interval '45 minutes', 0, 0, 0, 0, 4,
              CASE m.kind WHEN 'main' THEN 14 WHEN 'corridor' THEN 2
                          ELSE (CASE WHEN extract(hour FROM b AT TIME ZONE 'Asia/Bangkok') < 6 THEN 1.5 ELSE 0 END) END
         FROM (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok' AS today) d,
              generate_series(d.today - interval '20 days', d.today - interval '1 hour', interval '1 hour') b,
              (VALUES ($3::uuid, 'main'), ($4::uuid, 'corridor'), ($5::uuid, 'pump')) AS m(id, kind)`,
      [DEV.tenantId, DEV.buildingId, meters.main, meters.corridor, meters.pump],
    );
    const scored = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/energy-insight`)
      .set(dev())
      .expect(200);
    expect(scored.body).toMatchObject({
      reason: 'ok',
      metrics: { dataDays: 20, basis: 'main', totalKwh: '6720.000', pumpHoursPerDay: '6.00' },
    });
    expect(scored.body.score).toBeGreaterThan(0);
    expect(await q(`SELECT id FROM bridge.integration_event WHERE platform = 'getenergy'`)).toEqual([]);

    // other tenant: 404; consent must be explicit and current; Idempotency-Key required
    await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/energy-insight`).set(other()).expect(404);
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(other())
      .set(idem())
      .send({ consentVersion: 1 })
      .expect(404);
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(dev())
      .send({ consentVersion: 1 })
      .expect(400);
    const noConsent = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(dev())
      .set(idem())
      .send({ consentVersion: 3 })
      .expect(409);
    expect(noConsent.body.code).toBe('energy.consent_required');
    await settle();
    expect(await q(`SELECT id FROM bridge.integration_event WHERE platform = 'getenergy'`)).toEqual([]);

    // an operator that does not own the building reads but cannot opt in
    await q('UPDATE core.building SET owner_tenant_id = $1 WHERE id = $2', [
      stranger.tenantId,
      DEV.buildingId,
    ]);
    const asOperator = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/energy-insight`)
      .set(dev())
      .expect(200);
    expect(asOperator.body.canOptIn).toBe(false);
    const notOwner = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(dev())
      .set(idem())
      .send({ consentVersion: 1 })
      .expect(403);
    expect(notOwner.body.code).toBe('energy.owner_required');
    await q('UPDATE core.building SET owner_tenant_id = NULL WHERE id = $1', [DEV.buildingId]);
  });

  it('opt-in shares aggregates only with getenergy through the signed port; opt-out withdraws the lead', async () => {
    const opted = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(dev())
      .set(idem())
      .send({ consentVersion: 1 })
      .expect(200);
    expect(opted.body.optin).toMatchObject({ state: 'opted_in', optedOutAt: null });
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-in`)
      .set(dev())
      .set(idem())
      .send({ consentVersion: 1 })
      .expect(200);
    await settle();
    const events = await q<{
      event_type: string;
      payload: Record<string, unknown>;
      contract_version: string;
    }>(
      `SELECT event_type, payload, contract_version FROM bridge.integration_event WHERE platform = 'getenergy' ORDER BY created_at`,
    );
    expect(events.map((e) => [e.event_type, e.contract_version])).toEqual([
      ['energy.insight.shared', '0.1.0'],
    ]);
    const payload = JSON.stringify(events[0]!.payload);
    for (const secret of ['A-101', 'ผู้เช่า', '+66', DEV.residentPartyId, 'อาคาร', 'G9 pump', 'ปั๊มน้ำ'])
      expect(payload).not.toContain(secret);
    expect(events[0]!.payload).toMatchObject({
      type: 'energy.insight.shared',
      sourcePlatform: 'getproperty',
      payload: {
        building: { ref: DEV.buildingId, unitCountBand: '11-30' },
        metrics: { basis: 'main', totalKwh: '6720.000' },
        consent: { purposeKey: 'energy.insight', version: 1 },
      },
    });
    // the consent row belongs to the tenant (the owner shares its building's data)
    const consent = await q<{ tenant_id: string; granted: boolean }>(
      `SELECT c.tenant_id, c.granted FROM platform.energy_insight_optin o JOIN platform.consent c ON c.id = o.consent_id`,
    );
    expect(consent).toEqual([{ tenant_id: DEV.tenantId, granted: true }]);

    // the delivery job sends it through the (fake) signed port; the job does not re-share before it is due
    await t.app.get(IntegrationDeliveryService).sweep();
    expect(await q(`SELECT status FROM bridge.integration_event WHERE platform = 'getenergy'`)).toEqual([
      { status: 'acked' },
    ]);
    expect(getenergy().received).toHaveLength(1);
    expect(getenergy().received[0]!.envelope).toMatchObject({ type: 'energy.insight.shared' });
    expect(await t.app.get(EnergyInsightService).run()).toBe(0);
    const view = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/energy-insight`)
      .set(dev())
      .expect(200);
    expect(view.body.optin.lastScore).toBe(view.body.score);

    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-out`)
      .set(other())
      .expect(404);
    // a day later a fresh snapshot is due and waits unsent when the owner opts out
    t.clock.advance(86_400_000);
    owner = await ownerToken(t);
    await q(`UPDATE platform.energy_insight_optin SET last_shared_at = now() - interval '40 days'`);
    expect(await t.app.get(EnergyInsightService).run()).toBe(1);
    const out = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-out`)
      .set(dev())
      .expect(200);
    expect(out.body.optin).toMatchObject({ state: 'opted_out' });
    await settle();
    await t.app.get(IntegrationDeliveryService).sweep();
    const after = await q<{ event_type: string; status: string; last_error: string | null }>(
      `SELECT event_type, status, last_error FROM bridge.integration_event WHERE platform = 'getenergy' ORDER BY created_at`,
    );
    expect(after.map((e) => [e.event_type, e.status])).toEqual([
      ['energy.insight.shared', 'acked'],
      ['energy.insight.shared', 'dead'],
      ['energy.insight.withdrawn', 'acked'],
    ]);
    expect(after[1]!.last_error).toContain('opted out');
    expect(getenergy().received.map((r) => (r.envelope as { type: string }).type)).toEqual([
      'energy.insight.shared',
      'energy.insight.withdrawn',
    ]);
    const withdrawn = await q<{ granted: boolean }>(
      `SELECT c.granted FROM platform.consent c JOIN platform.consent_purpose_version v ON v.id = c.purpose_version_id
        JOIN platform.consent_purpose p ON p.id = v.purpose_id WHERE p.key = 'energy.insight' ORDER BY c.captured_at`,
    );
    expect(withdrawn.map((c) => c.granted)).toEqual([true, false]);
    // nothing more is shared while opted out
    expect(await t.app.get(EnergyInsightService).run()).toBe(0);
    const again = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/energy-insight/actions/opt-out`)
      .set(dev())
      .expect(409);
    expect(again.body.code).toBe('energy.invalid_state');
  });
});
