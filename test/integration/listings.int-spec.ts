import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import sharp from 'sharp';

import { ListingModerationService } from '../../src/modules/ops-listings/listing-moderation.service';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

interface Landlord {
  tenantId: string;
  token: string;
}

/** B7.2 acceptance (+ the public read of B7.3) — listings, photos without EXIF, review, verification, reports (D-252). */
describe('listings (B7.2, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let malee: Landlord;
  let somchai: Landlord;
  let condoUnit: string;
  let houseUnit: string;

  async function signUp(phone: string, name: string): Promise<Landlord> {
    t.clock.advance(61_000);
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const res = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: name,
    });
    if (res.status !== 201 && res.status !== 200) throw new Error(`signup ${res.status}`);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
  }

  const as = (l: Landlord) => ({ ...bearer(l.token), 'X-Tenant-Id': l.tenantId });

  async function photo(l: Landlord, unitId: string, withGps = false): Promise<string> {
    let image = sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#7aa6c2' } }).jpeg();
    if (withGps)
      image = image.withExif({
        IFD0: { Copyright: 'owner', Make: 'PhoneCam' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '13/1 46/1 48/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '100/1 32/1 41/1',
        },
      });
    return uploadFile(t, db, l.token, {
      kind: 'listing_photo',
      scopeType: 'unit',
      scopeId: unitId,
      fileName: 'room.jpg',
      mimeType: 'image/jpeg',
      body: await image.toBuffer(),
      tenantId: l.tenantId,
    });
  }

  async function stored(key: string): Promise<Buffer> {
    const stream = await t.app.get<FakeObjectStorage>(OBJECT_STORAGE).getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async function draft(l: Landlord, unitId: string, extra: Record<string, unknown> = {}) {
    const res = await t.http
      .post('/v1/owner/listings')
      .set(as(l))
      .send({ unitId, titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', rent: '15000', ...extra })
      .expect(201);
    return res.body as { id: string; slug: string; state: string };
  }

  async function withPhotos(l: Landlord, listingId: string, unitId: string, n = 5) {
    for (let i = 0; i < n; i++) {
      const documentId = await photo(l, unitId);
      await t.http
        .post(`/v1/owner/listings/${listingId}/photos`)
        .set(as(l))
        .send({ documentId, caption: `รูป ${i + 1}` })
        .expect(201);
    }
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_listings' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    malee = await signUp('+66810009201', 'มาลี มีสุข');
    somchai = await signUp('+66810009202', 'สมชาย ใจดี');
    const condo = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(malee))
      .send({
        kind: 'condo_unit',
        projectName: 'ไอดีโอ โมบิ อารีย์',
        unitNo: '12/345',
        address: ADDRESS,
        lat: 13.7799,
        lng: 100.5446,
        areaSqm: '28.50',
        bedrooms: 1,
        bathrooms: 1,
        floorLabel: '12',
        furnishing: 'fully_furnished',
      })
      .expect(201);
    condoUnit = condo.body.unitId as string;
    const house = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(malee))
      .send({
        kind: 'house',
        projectName: 'บ้านสวนนนทบุรี',
        address: {
          line1: '99/12 ถนนรัตนาธิเบศร์',
          district: 'เมืองนนทบุรี',
          province: 'นนทบุรี',
          postcode: '11000',
        },
        areaSqm: '180',
        bedrooms: 3,
        bathrooms: 2,
      })
      .expect(201);
    houseUnit = house.body.unitId as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('strips EXIF and location from a listing photo and stores three WebP renditions', async () => {
    const id = await photo(malee, condoUnit, true);
    const { rows } = await db.admin.query<{
      storage_key: string;
      mime_type: string;
      scan_status: string;
      width: number;
    }>('SELECT storage_key, mime_type, scan_status, width FROM core.document WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ mime_type: 'image/jpeg', scan_status: 'clean', width: 1800 });
    const meta = await sharp(await stored(rows[0]!.storage_key)).metadata();
    expect(meta.exif).toBeUndefined();
    for (const w of [480, 960, 1600]) {
      const rendition = await sharp(await stored(`${rows[0]!.storage_key}.w${w}.webp`)).metadata();
      expect(rendition).toMatchObject({ format: 'webp', width: w });
      expect(rendition.exif).toBeUndefined();
    }
  });

  let first: { id: string; slug: string };

  it('refuses to submit an incomplete listing, then queues the first listing of an unverified owner', async () => {
    first = await draft(malee, condoUnit, {
      transit: { name: 'BTS อารีย์', line: 'BTS สายสุขุมวิท', distanceM: 350 },
      facilities: ['pool', 'fitness'],
    });
    expect(first.slug).toMatch(/^condo-1br-[0-9a-f]{10}$/);
    const incomplete = await t.http
      .post(`/v1/owner/listings/${first.id}/actions/submit`)
      .set(as(malee))
      .expect(422);
    expect(incomplete.body.code).toBe('listing.incomplete');
    expect(incomplete.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'photos' })]),
    );

    await withPhotos(malee, first.id, condoUnit);
    const submitted = await t.http
      .post(`/v1/owner/listings/${first.id}/actions/submit`)
      .set(as(malee))
      .expect(200);
    expect(submitted.body).toMatchObject({
      state: 'pending_review',
      reviewReasons: ['first_listing'],
      verifiedOwner: false,
    });
    expect(submitted.body.photos).toHaveLength(5);
    expect(submitted.body.address).toBe('ถนนพหลโยธิน, พญาไท, กรุงเทพมหานคร 10400');

    const search = await t.http.get('/v1/public/listings').expect(200);
    expect(search.body.total).toBe(0);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(404);
  });

  it('a moderator approves; the listing is public with its full address, photos and map pin', async () => {
    const queue = await t.http
      .get('/v1/admin/listings/queue?kind=pending_review')
      .set(bearer(admin))
      .expect(200);
    expect((queue.body as { id: string }[]).map((l) => l.id)).toContain(first.id);
    await t.http
      .post(`/v1/admin/listings/${first.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);

    const search = await t.http
      .get('/v1/public/listings?kind=condo_unit&maxRent=20000&bedrooms=1')
      .expect(200);
    expect(search.headers['cache-control']).toContain('max-age=300');
    expect(search.body).toMatchObject({ total: 1, nextCursor: null });
    expect(search.body.data[0]).toMatchObject({
      slug: first.slug,
      rent: '15000.00',
      sizeSqm: '28.50',
      address: 'ถนนพหลโยธิน, พญาไท, กรุงเทพมหานคร 10400',
      nearestTransit: { name: 'BTS อารีย์', line: 'BTS สายสุขุมวิท', distanceM: 350 },
      verifiedOwner: false,
      cover: expect.objectContaining({ width: 960, height: 640 }),
    });
    const detail = await t.http.get(`/v1/public/listings/${first.slug}`).expect(200);
    expect(detail.body).toMatchObject({
      ownerDisplayName: 'มาลี มีสุข',
      geo: { lat: 13.7799, lng: 100.5446 },
      floor: '12',
      facilities: ['pool', 'fitness'],
    });
    expect(detail.body.photos).toHaveLength(5);
    expect((await t.http.get('/v1/public/listings?q=อารีย์').expect(200)).body.total).toBe(1);
    expect((await t.http.get('/v1/public/listings?minRent=16000').expect(200)).body.total).toBe(0);
    const sitemap = await t.http.get('/v1/public/listings/sitemap').expect(200);
    expect((sitemap.body.data as { slug: string }[]).map((e) => e.slug)).toContain(first.slug);
  });

  it('allows one live listing per unit and keeps listings tenant-scoped', async () => {
    const second = await draft(malee, condoUnit);
    await withPhotos(malee, second.id, condoUnit);
    const dup = await t.http
      .post(`/v1/owner/listings/${second.id}/actions/submit`)
      .set(as(malee))
      .expect(409);
    expect(dup.body.code).toBe('listing.duplicate_unit');
    await t.http.get(`/v1/owner/listings/${first.id}`).set(as(somchai)).expect(404);
    await t.http
      .post('/v1/owner/listings')
      .set(as(somchai))
      .send({ unitId: condoUnit, titleTh: 'x', rent: '1' })
      .expect(404);
  });

  it('verifies the owner from evidence; the badge shows on the public page', async () => {
    const evidence = await uploadFile(t, db, malee.token, {
      kind: 'certificate',
      scopeType: 'unit',
      scopeId: condoUnit,
      fileName: 'condo-title.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 condo title'),
      tenantId: malee.tenantId,
    });
    const requested = await t.http
      .post(`/v1/owner/units/${condoUnit}/verification`)
      .set(as(malee))
      .send({ evidenceKind: 'condo_title', documentIds: [evidence] })
      .expect(201);
    expect(requested.body.state).toBe('pending');
    await t.http
      .post(`/v1/owner/units/${condoUnit}/verification`)
      .set(as(malee))
      .send({ evidenceKind: 'condo_title', documentIds: [evidence] })
      .expect(409);

    const detail = await t.http
      .get(`/v1/admin/listing-verifications/${requested.body.id}`)
      .set(bearer(admin))
      .expect(200);
    expect(detail.body.evidence).toHaveLength(1);
    const rejectWithoutNote = await t.http
      .post(`/v1/admin/listing-verifications/${requested.body.id}/actions/decide`)
      .set(bearer(admin))
      .set(idem())
      .send({ approve: false })
      .expect(422);
    expect(rejectWithoutNote.body.code).toBe('validation.failed');
    await t.http
      .post(`/v1/admin/listing-verifications/${requested.body.id}/actions/decide`)
      .set(bearer(admin))
      .set(idem())
      .send({ approve: true })
      .expect(200);

    const mine = await t.http.get(`/v1/owner/units/${condoUnit}/verification`).set(as(malee)).expect(200);
    expect(mine.body).toMatchObject({ verified: true, latest: { state: 'approved' } });
    expect((await t.http.get(`/v1/public/listings/${first.slug}`).expect(200)).body.verifiedOwner).toBe(true);

    // O-018: the evidence goes away after the retention; the decision stays
    t.clock.advance(91 * 86_400_000);
    expect(await t.app.get(ListingModerationService).purgeEvidence()).toBe(1);
    // the jump expired every session: sign in again (the same phone answers the same landlord tenant)
    malee = await signUp('+66810009201', 'มาลี มีสุข');
    somchai = await signUp('+66810009202', 'สมชาย ใจดี');
    admin = await adminToken(t);
    const { rows } = await db.admin.query('SELECT deleted_at FROM core.document WHERE id = $1', [evidence]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(
      (await t.http.get(`/v1/owner/units/${condoUnit}/verification`).set(as(malee)).expect(200)).body.latest
        .evidenceCount,
    ).toBe(0);
  });

  it('sends flagged words to review even for a known owner; a rejection carries the reason', async () => {
    const house = await draft(malee, houseUnit, {
      titleTh: 'บ้านเดี่ยว 3 ห้องนอน นนทบุรี',
      rent: '35000',
      descriptionTh: 'ต้องโอนก่อนดูห้อง เพื่อยืนยันการจอง',
    });
    expect(house.slug).toMatch(/^house-3br-/);
    await withPhotos(malee, house.id, houseUnit);
    const submitted = await t.http
      .post(`/v1/owner/listings/${house.id}/actions/submit`)
      .set(as(malee))
      .expect(200);
    expect(submitted.body).toMatchObject({ state: 'pending_review', reviewReasons: ['flagged_words'] });
    await t.http
      .post(`/v1/admin/listings/${house.id}/actions/reject`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'ห้ามขอให้โอนเงินก่อนดูห้อง' })
      .expect(200);
    const mine = await t.http.get(`/v1/owner/listings/${house.id}`).set(as(malee)).expect(200);
    expect(mine.body).toMatchObject({ state: 'rejected', rejectedReason: 'ห้ามขอให้โอนเงินก่อนดูห้อง' });

    // fixed text: resubmitted, published at once (not the first listing any more, no flagged words)
    await t.http
      .patch(`/v1/owner/listings/${house.id}`)
      .set(as(malee))
      .send({ descriptionTh: 'บ้านเดี่ยวพร้อมสวน นัดดูบ้านได้ทุกเสาร์' })
      .expect(200);
    const again = await t.http
      .post(`/v1/owner/listings/${house.id}/actions/submit`)
      .set(as(malee))
      .expect(200);
    expect(again.body.state).toBe('published');
  });

  it('hides a listing after enough reports from different viewers; a moderator restores it', async () => {
    const report = (agent: string) =>
      t.http
        .post(`/v1/public/listings/${first.slug}/reports`)
        .set('User-Agent', agent)
        .send({ reason: 'scam' });
    expect((await report('viewer-1')).status).toBe(201);
    const dup = await report('viewer-1');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('listing.report_duplicate');
    expect((await report('viewer-2')).status).toBe(201);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(200);
    expect((await report('viewer-3')).status).toBe(201);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(404);

    const owner = await t.http.get(`/v1/owner/listings/${first.id}`).set(as(malee)).expect(200);
    expect(owner.body).toMatchObject({ state: 'published', hidden: true, reportCount: 3 });
    const queue = await t.http.get('/v1/admin/listings/queue?kind=hidden').set(bearer(admin)).expect(200);
    const row = (queue.body as { id: string; reports: unknown[] }[]).find((l) => l.id === first.id)!;
    expect(row.reports).toHaveLength(3);
    expect(JSON.stringify(row)).not.toContain('viewer-');

    await t.http
      .post(`/v1/admin/listings/${first.id}/actions/restore`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(200);
    const { rows } = await db.admin.query(
      `SELECT state, count(*)::int AS n FROM platform.listing_report GROUP BY state`,
    );
    expect(rows).toEqual([{ state: 'dismissed', n: 3 }]);
  });

  it('pauses, resumes and closes; a closed listing is gone from the public pages', async () => {
    await t.http.post(`/v1/owner/listings/${first.id}/actions/pause`).set(as(malee)).expect(200);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(404);
    await t.http.post(`/v1/owner/listings/${first.id}/actions/resume`).set(as(malee)).expect(200);
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(200);
    const closed = await t.http
      .post(`/v1/owner/listings/${first.id}/actions/close`)
      .set(as(malee))
      .expect(200);
    expect(closed.body).toMatchObject({ state: 'closed', closedReason: 'withdrawn' });
    await t.http.get(`/v1/public/listings/${first.slug}`).expect(404);
    const bad = await t.http.post(`/v1/owner/listings/${first.id}/actions/pause`).set(as(malee)).expect(409);
    expect(bad.body.code).toBe('listing.invalid_state');
    const audit = await db.admin.query(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 ORDER BY occurred_at`,
      [first.id],
    );
    expect((audit.rows as { action: string }[]).map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'listing.created',
        'listing.submitted',
        'listing.approved',
        'listing.reported',
        'listing.restored',
        'listing.paused',
        'listing.closed',
      ]),
    );
  });
});
