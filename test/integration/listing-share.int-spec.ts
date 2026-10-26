import { fakeLineIdToken } from '@collective/integrations/line';
import sharp from 'sharp';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));

/** B7.9 part 2 acceptance — the share kit: links per channel, captions, th/en cards, clicks and enquiries per channel (D-268). */
describe('listing share kit (B7.9 part 2, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let listing: { id: string; slug: string };

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });

  async function prospect(sub: string, name: string): Promise<string> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_share_b79' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009402';
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
        unitNo: '12/345',
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
    listing = { id: created.body.id as string, slug: created.body.slug as string };
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
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  type Link = {
    channel: string;
    url: string;
    clicks: number;
    enquiries: number;
    captionTh: string;
    captionEn: string;
    shareUrl: string | null;
  };
  const kit = async () => {
    const res = await t.http.post(`/v1/owner/listings/${listing.id}/share-kit`).set(as());
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return res.body as {
      links: Link[];
      cards: { th: { documentId: string; url: string }; en: { documentId: string } };
    };
  };
  const code = (url: string) => url.split('/s/')[1]!;

  it('gives a link per channel, Thai and English captions and the two cards; the same kit again', async () => {
    const first = await kit();
    expect(first.links.map((l) => l.channel)).toEqual([
      'line',
      'facebook_group',
      'facebook_marketplace',
      'qr',
      'link',
    ]);
    const group = first.links.find((l) => l.channel === 'facebook_group')!;
    expect(group.url).toMatch(/^http:\/\/localhost:3001\/s\/[a-z0-9]{8}$/);
    expect(group.captionTh).toContain('ค่าเช่า ฿15,000/เดือน');
    expect(group.captionTh).toContain(group.url);
    expect(group.captionEn).toContain('Rent ฿15,000/month');
    expect(group.captionEn).toContain('Phaya Thai, Bangkok');
    expect(first.links.find((l) => l.channel === 'line')!.shareUrl).toMatch(
      /^https:\/\/line\.me\/R\/share\?text=/,
    );
    expect(new Set(first.links.map((l) => l.url)).size).toBe(5);

    const { rows } = await db.admin.query<{ mime_type: string; size_bytes: string; kind: string }>(
      'SELECT mime_type, size_bytes::text, kind::text FROM core.document WHERE id = ANY($1::uuid[]) ORDER BY title',
      [[first.cards.th.documentId, first.cards.en.documentId]],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mime_type === 'image/png' && Number(r.size_bytes) > 10_000)).toBe(true);

    const again = await kit();
    expect(again.links.map((l) => l.url)).toEqual(first.links.map((l) => l.url));
    expect(again.cards.th.documentId).toBe(first.cards.th.documentId);

    // a new rent is a new card
    await t.http.patch(`/v1/owner/listings/${listing.id}`).set(as()).send({ rent: '14500' }).expect(200);
    const changed = await kit();
    expect(changed.cards.th.documentId).not.toBe(first.cards.th.documentId);
    expect(changed.links.find((l) => l.channel === 'facebook_group')!.captionTh).toContain('฿14,500');
    const audit = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'listing.share_kit_generated' AND subject_id = $1`,
      [listing.id],
    );
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('counts clicks and enquiries per channel; the lead keeps where it came from', async () => {
    const before = await kit();
    const group = before.links.find((l) => l.channel === 'facebook_group')!;
    const opened = await t.http.post(`/v1/public/share-links/${code(group.url)}/open`).expect(200);
    expect(opened.body).toEqual({
      slug: listing.slug,
      channel: 'facebook_group',
      utm: { source: 'facebook_group', medium: 'share', campaign: 'listing' },
    });
    await t.http.post(`/v1/public/share-links/${code(group.url)}/open`).expect(200);

    const token = await prospect('U000000000000000000000000000b7901', 'สมศรี ใจดี');
    const lead = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(token))
      .send({ message: 'สนใจห้องนี้ค่ะ', consent: true, channel: 'facebook_group' })
      .expect(201);
    await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(token))
      .send({ message: 'ขอดูห้องวันเสาร์ได้ไหมคะ', consent: false, channel: 'line' })
      .expect(201);

    const after = await kit();
    expect(after.links.find((l) => l.channel === 'facebook_group')).toMatchObject({
      clicks: 2,
      enquiries: 1,
    });
    expect(after.links.find((l) => l.channel === 'line')).toMatchObject({ clicks: 0, enquiries: 0 });
    const owned = await t.http.get(`/v1/owner/leads/${lead.body.id}`).set(as()).expect(200);
    expect(owned.body.channel).toBe('facebook_group');

    await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(token))
      .send({ message: 'x', consent: false, channel: 'tiktok' })
      .expect(422);
  });

  it('refuses a listing that is not public and a link to one; an unknown code is 404', async () => {
    await t.http.post('/v1/public/share-links/zzzzzzzz/open').expect(404);
    const kitNow = await kit();
    await t.http.post(`/v1/owner/listings/${listing.id}/actions/pause`).set(as()).expect(200);
    const refused = await t.http.post(`/v1/owner/listings/${listing.id}/share-kit`).set(as()).expect(409);
    expect(refused.body.code).toBe('listing.invalid_state');
    await t.http.post(`/v1/public/share-links/${code(kitNow.links[0]!.url)}/open`).expect(404);
  });
});
