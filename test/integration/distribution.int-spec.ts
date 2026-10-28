import { createHmac } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import { bangkokDate } from '@common/time/bangkok';
import { FACEBOOK_PAGES } from '@integrations/facebook/facebook-pages.port';
import { type FakeFacebookPages } from '@integrations/facebook/fake-facebook-pages';
import { type FakeLineChannelApi } from '@integrations/line-channels/fake-line-channel-api';
import { LINE_CHANNEL_API } from '@integrations/line-channels/line-channel-api.port';
import { ListingSocialService } from '@modules/ops-listings/listing-social.service';
import { MessagingAddonsService } from '@modules/platform-subscriptions/messaging-addons.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));
const PAGE_ID = '102345678901234';
const AGENCY_SECRET = 'agency-oa-channel-secret-0001';
const LANDLORD_SECRET = 'landlord-oa-channel-secret-01';

interface Signed {
  tenantId: string;
  token: string;
}

/**
 * G4 acceptance (docs/prompts/G-growth-api.md G4; D-288, D-296, D-287, D-254; real PostgreSQL): the public listing
 * carries the verified-vacant badge only from lease data, the schema.org JSON-LD and a 1200 × 630 Open Graph card;
 * the tenant's own Facebook Page gets a post on publish, an edit on a new rent and a delete when the listing closes
 * (fake Graph API); the share kit adds the image bundle; an agency's own LINE OA: integration fee only once priced,
 * tenant-routed webhooks, prospects link it. Cross-tenant ids are 404 on every new endpoint.
 */
describe('G4 distribution (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let fb: FakeFacebookPages;
  let line: FakeLineChannelApi;
  let landlord: Signed;
  let stranger: Signed;
  let agency: Signed;
  let admin: string;
  let listing: { id: string; slug: string; unitId: string; buildingId: string };
  let channelId: string;

  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const posts = () => t.app.get(ListingSocialService, { strict: false }).sweep();

  async function signup(kind: 'agency' | 'landlord', phone: string, displayName: string): Promise<Signed> {
    t.clock.advance(61_000);
    const challenge = await t.http.post(`/v1/public/signup/${kind}/otp`).send({ phone }).expect(200);
    const res = await t.http.post(`/v1/public/signup/${kind}`).send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName,
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
  }

  /** A lease of the listed unit copied from the seeded DEV lease (only the columns the badge reads change). */
  async function leaseOnUnit(status: string, start: string, end: string): Promise<string> {
    const rows = await q<{ id: string }>(
      `INSERT INTO ops.lease
       SELECT (jsonb_populate_record(l, jsonb_build_object(
                 'id', uuidv7(), 'tenant_id', $1::uuid, 'building_id', $2::uuid, 'unit_id', $3::uuid,
                 'number', 'G4-' || substr(md5(random()::text), 1, 8), 'status', $4::text,
                 'start_date', $5::date, 'end_date', $6::date, 'move_out_at', null,
                 'ended_at', CASE WHEN $4 = 'ended' THEN now() END))).*
         FROM ops.lease l WHERE l.id = $7
       RETURNING id`,
      [landlord.tenantId, listing.buildingId, listing.unitId, status, start, end, DEV.leaseId],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g4' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', FACEBOOK_MODE: 'fake' });
    fb = t.app.get<FakeFacebookPages>(FACEBOOK_PAGES, { strict: false });
    line = t.app.get<FakeLineChannelApi>(LINE_CHANNEL_API, { strict: false });
    admin = await adminToken(t);
    landlord = await signup('landlord', '+660000000941', 'มาลี มีสุข');
    stranger = await signup('landlord', '+660000000942', 'สมชาย ทดสอบ');
    agency = await signup('agency', '+660000000943', 'บ้านดี พร็อพเพอร์ตี้');

    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(landlord))
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
      .set(as(landlord))
      .send({ unitId, titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', rent: '15000', depositMonths: 2 })
      .expect(201);
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, landlord.token, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unitId,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
        tenantId: landlord.tenantId,
      });
      await t.http
        .post(`/v1/owner/listings/${created.body.id}/photos`)
        .set(as(landlord))
        .send({ documentId })
        .expect(201);
    }
    await t.http
      .put(`/v1/owner/listings/${created.body.id}/availability`)
      .set(as(landlord))
      .send({ weekly: EVERY_DAY, exceptions: [], slotMinutes: 30 })
      .expect(200);
    await t.http.post(`/v1/owner/listings/${created.body.id}/actions/submit`).set(as(landlord)).expect(200);
    await t.http
      .post(`/v1/admin/listings/${created.body.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    const row = (
      await q<{ building_id: string }>('SELECT building_id FROM ops.listing WHERE id = $1', [created.body.id])
    )[0]!;
    listing = {
      id: created.body.id as string,
      slug: created.body.slug as string,
      unitId,
      buildingId: row.building_id,
    };
    await settle();
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('shows "verified vacant" only from lease data, with JSON-LD and the Open Graph card URL', async () => {
    const detail = async () =>
      (await t.http.get(`/v1/public/listings/${listing.slug}`).expect(200)).body as {
        verifiedVacant: boolean;
        vacantSince: string | null;
        ogImageUrl: string;
        jsonLd: Record<string, unknown>;
      };
    // no lease history on getproperty: no evidence, no badge
    let d = await detail();
    expect(d).toMatchObject({ verifiedVacant: false, vacantSince: null });
    expect(d.ogImageUrl).toMatch(new RegExp(`/v1/public/listings/${listing.slug}/og-image$`));
    expect(d.jsonLd).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Offer',
      price: '15000.00',
      priceCurrency: 'THB',
      priceSpecification: { unitCode: 'MON' },
      image: [d.ogImageUrl],
      itemOffered: { '@type': 'Apartment', numberOfBedrooms: 1, address: { addressCountry: 'TH' } },
    });

    // a lease that ended on the platform: verified vacant since its end
    const past = await leaseOnUnit('ended', '2025-01-01', '2025-12-31');
    d = await detail();
    expect(d).toMatchObject({ verifiedVacant: true, vacantSince: '2025-12-31' });
    const search = await t.http.get('/v1/public/listings').expect(200);
    const cards = search.body.data as { slug: string; verifiedVacant: boolean }[];
    expect(cards.find((x) => x.slug === listing.slug)).toMatchObject({
      verifiedVacant: true,
    });

    // a lease in force (or waiting for signature): not vacant, whatever the owner says
    const current = await leaseOnUnit('pending_signature', '2027-01-01', '2027-12-31');
    expect((await detail()).verifiedVacant).toBe(false);
    await q(`UPDATE ops.lease SET status = 'cancelled' WHERE id = $1`, [current]);
    expect((await detail()).verifiedVacant).toBe(true);
    expect(past).toBeTruthy();
  });

  it('serves a 1200 × 630 PNG Open Graph card, rendered once per content', async () => {
    const res = await t.http.get(`/v1/public/listings/${listing.slug}/og-image`).buffer(true).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const meta = await sharp(res.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 630]);
    await t.http.get(`/v1/public/listings/${listing.slug}/og-image`).expect(200);
    const docs = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.document WHERE source_ref = $1`,
      [`listing:${listing.id}:og-image`],
    );
    expect(docs[0]!.n).toBe(1);
    await t.http.get('/v1/public/listings/no-such-listing/og-image').expect(404);
  });

  it('share kit: the image bundle; a direct listing says "no agent fee"', async () => {
    const kit = await t.http.post(`/v1/owner/listings/${listing.id}/share-kit`).set(as(landlord)).expect(200);
    expect(kit.body.photos).toHaveLength(5);
    expect(kit.body.photos[0].url).toContain('w1600');
    const kitLinks = kit.body.links as { channel: string; captionTh: string }[];
    expect(kitLinks.find((l) => l.channel === 'facebook_group')!.captionTh).toContain('ไม่มีค่านายหน้า');
  });

  it('connects a Facebook Page: refused tokens store nothing; the token is sealed and never echoed', async () => {
    const refused = await t.http
      .post('/v1/owner/social-channels')
      .set(as(landlord))
      .set(idem())
      .send({ pageId: PAGE_ID, pageAccessToken: 'fake-page-token-revoked-1' })
      .expect(422);
    expect(refused.body.code).toBe('facebook.page_refused');
    expect(await q('SELECT 1 FROM platform.social_channel')).toHaveLength(0);

    const token = 'fake-page-token-BaanDee';
    const connected = await t.http
      .post('/v1/owner/social-channels')
      .set(as(landlord))
      .set(idem())
      .send({ pageId: PAGE_ID, pageAccessToken: token })
      .expect(201);
    channelId = connected.body.id as string;
    expect(connected.body).toMatchObject({
      pageId: PAGE_ID,
      pageName: 'BaanDee',
      state: 'verified',
      autoPost: true,
    });
    expect(JSON.stringify(connected.body)).not.toContain(token);
    const stored = await q<{ token_enc: Buffer }>(
      'SELECT token_enc FROM platform.social_channel WHERE id = $1',
      [channelId],
    );
    expect(Buffer.from(stored[0]!.token_enc).toString('utf8')).not.toContain(token);
    const leaks = await q<{ n: number }>(
      `SELECT (SELECT count(*) FROM platform.audit_log WHERE coalesce(after::text, '') LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.domain_event WHERE payload::text LIKE '%' || $1 || '%') AS n`,
      [token],
    );
    expect(Number(leaks[0]!.n)).toBe(0);
    const listed = await t.http.get('/v1/owner/social-channels').set(as(landlord)).expect(200);
    expect((listed.body as { id: string }[]).map((c) => c.id)).toEqual([channelId]);

    // another tenant: 404 on the Page, empty list
    await t.http.post(`/v1/owner/social-channels/${channelId}/actions/verify`).set(as(stranger)).expect(404);
    await t.http.post(`/v1/owner/social-channels/${channelId}/actions/revoke`).set(as(stranger)).expect(404);
    expect((await t.http.get('/v1/owner/social-channels').set(as(stranger)).expect(200)).body).toEqual([]);
    await t.http.post(`/v1/owner/social-channels/${channelId}/actions/verify`).set(as(landlord)).expect(200);
  });

  it('posts on publish, edits on a new rent, deletes when the listing closes (fake Graph API)', async () => {
    // already published before the Page was connected: re-publishing posts it
    await t.http.post(`/v1/owner/listings/${listing.id}/actions/pause`).set(as(landlord)).expect(200);
    await t.http.post(`/v1/owner/listings/${listing.id}/actions/resume`).set(as(landlord)).expect(200);
    await settle();
    expect(await posts()).toBe(1);
    let mine = await t.http
      .get(`/v1/owner/listings/${listing.id}/social-posts`)
      .set(as(landlord))
      .expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({ channelId, state: 'posted', pageId: PAGE_ID, attempts: 0 }),
    ]);
    const postUrl = mine.body[0].postUrl as string;
    expect(postUrl).toMatch(/^https:\/\/www\.facebook\.com\/102345678901234\/posts\/\d+$/);
    const [postId, onPage] = [...fb.posts.entries()].find(([, p]) => p.pageId === PAGE_ID)!;
    expect(onPage.message).toContain('ค่าเช่า ฿15,000/เดือน');
    expect(onPage.message).toContain(onPage.link);
    expect(onPage.link).toMatch(/\/s\/[a-z0-9]{8}$/);
    const links = await q<{ channel: string }>(
      'SELECT channel::text FROM ops.listing_share_link WHERE listing_id = $1',
      [listing.id],
    );
    expect(links.map((l) => l.channel)).toContain('facebook_page');

    // a new rent edits the post
    await t.http
      .patch(`/v1/owner/listings/${listing.id}`)
      .set(as(landlord))
      .send({ rent: '14500' })
      .expect(200);
    await settle();
    await posts();
    expect(fb.posts.get(postId)!.message).toContain('฿14,500');
    mine = await t.http.get(`/v1/owner/listings/${listing.id}/social-posts`).set(as(landlord)).expect(200);
    expect(mine.body[0].updatedOnPageAt).not.toBeNull();

    // another tenant: 404 on the listing's posts and on retry
    await t.http.get(`/v1/owner/listings/${listing.id}/social-posts`).set(as(stranger)).expect(404);
    await t.http
      .post(`/v1/owner/listings/${listing.id}/social-posts/${mine.body[0].id}/actions/retry`)
      .set(as(stranger))
      .set(idem())
      .expect(404);
    // only a failed post can be retried
    const notFailed = await t.http
      .post(`/v1/owner/listings/${listing.id}/social-posts/${mine.body[0].id}/actions/retry`)
      .set(as(landlord))
      .set(idem())
      .expect(409);
    expect(notFailed.body.code).toBe('social.post_invalid_state');

    // a failed edit is retried once with its key (replays answer the same)
    await q(`UPDATE ops.listing_social_post SET state = 'failed', last_error = 'x' WHERE id = $1`, [
      mine.body[0].id,
    ]);
    const key = idem();
    const retried = await t.http
      .post(`/v1/owner/listings/${listing.id}/social-posts/${mine.body[0].id}/actions/retry`)
      .set(as(landlord))
      .set(key)
      .expect(200);
    expect(retried.body).toMatchObject({ state: 'queued', pendingAction: 'update' });
    await t.http
      .post(`/v1/owner/listings/${listing.id}/social-posts/${mine.body[0].id}/actions/retry`)
      .set(as(landlord))
      .set(key)
      .expect(200);
    await posts();

    // the listing closes (let or withdrawn): the post is deleted
    await t.http
      .post(`/v1/owner/listings/${listing.id}/actions/close`)
      .set(as(landlord))
      .send({})
      .expect(200);
    await settle();
    await posts();
    expect(fb.removed).toContain(postId);
    mine = await t.http.get(`/v1/owner/listings/${listing.id}/social-posts`).set(as(landlord)).expect(200);
    expect(mine.body[0]).toMatchObject({ state: 'deleted', postUrl: null });
    const events = await q<{ type: string }>(
      `SELECT type FROM platform.domain_event WHERE aggregate_id = $1 AND type LIKE 'listing.social%' ORDER BY occurred_at`,
      [listing.id],
    );
    expect(events.map((e) => e.type)).toEqual([
      'listing.social_posted',
      'listing.social_posted',
      'listing.social_posted',
      'listing.social_post_deleted',
    ]);
    // the public card of a closed listing is gone
    await t.http.get(`/v1/public/listings/${listing.slug}/og-image`).expect(404);

    // disconnecting stops everything
    await t.http.post(`/v1/owner/social-channels/${channelId}/actions/revoke`).set(as(landlord)).expect(204);
    expect((await t.http.get('/v1/owner/social-channels').set(as(landlord)).expect(200)).body).toEqual([]);
  });

  it('agency LINE OA: free until priced, then terms accepted, setup once and monthly fee once a month', async () => {
    const connect = (s: Signed, lineChannelId: string, secret: string, accept?: string) =>
      t.http
        .post('/v1/owner/messaging/channels')
        .set(as(s))
        .send({
          lineChannelId,
          channelSecret: secret,
          accessToken: `fake-token-${lineChannelId}`,
          ...(accept ? { acceptAddonVersionId: accept } : {}),
        });
    let addons = await t.http.get('/v1/owner/messaging/addons').set(as(agency)).expect(200);
    expect(addons.body).toMatchObject({
      offer: { planKey: 'line_oa_integration', onSale: false, monthlyFee: null },
      setupCharged: false,
      invoices: [],
    });
    expect((await connect(agency, '1657000941', AGENCY_SECRET)).status).toBe(201);

    // the admin prices the add-on for agencies (O-027): connecting now needs the terms accepted
    const plan = (
      await q<{ id: string }>(`SELECT id FROM platform.price_plan WHERE key = 'line_oa_integration'`)
    )[0]!;
    const version = await t.http
      .post(`/v1/admin/price-plans/${plan.id}/versions`)
      .set(bearer(admin))
      .set(idem())
      .send({
        effectiveFrom: bangkokDate(t.clock.now()),
        billingUnit: 'per_tenant',
        unitPrice: '990',
        setupFee: '1500',
        vatRate: '0.07',
      })
      .expect(201);
    await t.http
      .post(`/v1/admin/price-plans/versions/${version.body.id}/actions/publish`)
      .set(bearer(admin))
      .expect(200);
    const asked = await connect(agency, '1657000942', AGENCY_SECRET);
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({
      code: 'messaging.addon_terms_required',
      addon: { versionId: version.body.id, monthlyFee: '990.00', setupFee: '1500.00', currency: 'THB' },
    });
    const ok = await connect(agency, '1657000942', AGENCY_SECRET, version.body.id as string);
    expect(ok.status).toBe(201);
    // connecting again with the accepted terms replaces the OA (new webhook URL); the setup fee is not charged twice
    const again = await connect(agency, '1657000942', AGENCY_SECRET, version.body.id as string);
    expect(again.status).toBe(201);
    const agencyWebhook = again.body.webhookUrl as string;
    addons = await t.http.get('/v1/owner/messaging/addons').set(as(agency)).expect(200);
    expect(addons.body.offer).toMatchObject({ onSale: true, monthlyFee: '990.00', setupFee: '1500.00' });
    expect(addons.body.setupCharged).toBe(true);
    expect(addons.body.invoices).toEqual([
      expect.objectContaining({ charge: 'setup', total: '1605.00', state: 'issued' }),
    ]);
    // landlords are not priced by this plan: connecting stays free
    const own = await connect(landlord, '1657000943', LANDLORD_SECRET);
    expect(own.status).toBe(201);

    // the monthly fee: from the next month on, once
    const addonsService = t.app.get(MessagingAddonsService, { strict: false });
    expect(await addonsService.maintain()).toBe(0); // connected this month: the first partial month is free
    const next = new Date(t.clock.now());
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCHours(5, 0, 0, 0);
    t.clock.set(next);
    expect(await addonsService.maintain()).toBe(1);
    expect(await addonsService.maintain()).toBe(0);
    // (the month jump expired the access tokens: read the invoices directly)
    const charges = await q<{ tenant_id: string; charge: string }>(
      `SELECT tenant_id, snapshot->>'charge' AS charge FROM platform.platform_invoice
        WHERE kind = 'purchase' AND snapshot->>'product' = 'line_oa_integration' ORDER BY 2`,
    );
    expect(charges).toEqual([
      { tenant_id: agency.tenantId, charge: 'monthly' },
      { tenant_id: agency.tenantId, charge: 'setup' },
    ]);

    // tenant-routed webhooks: the agency's signature does not open the landlord's URL
    const body = JSON.stringify({
      destination: 'U0123456789abcdef0123456789abcdef',
      events: [
        {
          type: 'follow',
          replyToken: 'rt-g4-1',
          source: { type: 'user', userId: 'U0000000000000000000000000000c941' },
        },
      ],
    });
    const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('base64');
    const path = (url: string) => new URL(url).pathname;
    await t.http
      .post(path(own.body.webhookUrl as string))
      .set('content-type', 'application/json')
      .set('x-line-signature', sign(AGENCY_SECRET))
      .send(body)
      .expect(401);
    await t.http
      .post(path(agencyWebhook))
      .set('content-type', 'application/json')
      .set('x-line-signature', sign(AGENCY_SECRET))
      .send(body)
      .expect(200);
    const reply = line.replied.find((r) => r.replyToken === 'rt-g4-1')!;
    expect(reply.token).toBe('fake-token-1657000942');
    const link = decodeURIComponent(
      /\/link\/oa\?t=([^\s]+)/.exec((reply.messages[0] as { text: string }).text)![1]!,
    );

    // a prospect (an enquirer of the agency) links the agency's OA
    const prospect = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U000000000000000000000000000c9401', name: 'สมศรี ใจดี' }) })
      .expect(200);
    const preview = await t.http
      .get(`/v1/prospect/messaging-links/${encodeURIComponent(link)}`)
      .set(bearer(prospect.body.accessToken as string))
      .expect(200);
    expect(preview.body).toMatchObject({ tenantName: 'บ้านดี พร็อพเพอร์ตี้', state: 'valid' });
    const confirmed = await t.http
      .post(`/v1/prospect/messaging-links/${encodeURIComponent(link)}/actions/confirm`)
      .set(bearer(prospect.body.accessToken as string))
      .expect(200);
    expect(confirmed.body.state).toBe('used');
    const linked = await q<{ tenant_id: string }>(
      `SELECT c.tenant_id FROM platform.messaging_channel_user u JOIN platform.messaging_channel c ON c.id = u.channel_id
        WHERE u.line_user_id = 'U0000000000000000000000000000c941' AND u.unlinked_at IS NULL`,
    );
    expect(linked).toEqual([{ tenant_id: agency.tenantId }]);
  });
});
