import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { bangkokDate } from '@common/time/bangkok';
import { type FakeLineMulticast } from '@integrations/line-multicast/fake-line-multicast';
import { LINE_MULTICAST } from '@integrations/line-multicast/line-multicast.port';
import { SponsoredCampaignsService } from '@modules/platform-audience/sponsored-campaigns.service';
import sharp from 'sharp';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const SOMSRI = 'U-g6-somsri';
const MAI = 'U-g6-mai';
const DAO = 'U-g6-dao';
const LEK = 'U-g6-lek';
const NOI = 'U-g6-noi';

interface Signed {
  tenantId: string;
  token: string;
  phone: string;
}

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

/**
 * G6 acceptance (docs/prompts/G-growth-api.md G6; D-287, D-291, D-300, O-023, O-027; real PostgreSQL, LINE fake):
 * the recommendations consent is separate and never assumed; preferences need it; nobody without consent is ever
 * targeted; a campaign is refused while switched off / not priced / below the minimum; sending re-checks consent and
 * honours quiet hours and the weekly cap; a withdrawal between selection and sending cancels the message; the buyer
 * sees aggregates only; billing is per delivered recipient; history and DSR export / erasure for the person; a new
 * consent text asks everyone again; cross-tenant ids are 404 on every owner endpoint.
 */
describe('G6 audience, consent & sponsored broadcast (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let buyer: Signed;
  let stranger: Signed;
  let listing: { id: string; slug: string };
  let area: string;
  const people: Record<string, { token: string; userId: string }> = {};
  let campaignId: string;

  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const line = () => t.app.get<FakeLineMulticast>(LINE_MULTICAST);
  const run = () => t.app.get(SponsoredCampaignsService).run();
  const me = (who: string) => bearer(people[who]!.token);

  async function signup(phone: string, displayName: string): Promise<Signed> {
    t.clock.advance(61_000);
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const res = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName,
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string, phone };
  }

  async function relogin(): Promise<void> {
    admin = await adminToken(t);
    for (const s of [buyer, stranger]) {
      t.clock.advance(61_000);
      const challenge = await t.http
        .post('/v1/auth/operator/otp/request')
        .send({ phone: s.phone })
        .expect(200);
      const res = await t.http
        .post('/v1/auth/operator/otp/verify')
        .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(s.phone) })
        .expect(200);
      s.token = res.body.accessToken as string;
    }
    for (const [sub, p] of Object.entries(people)) p.token = (await prospect(sub, sub)).token;
  }

  async function prospect(sub: string, name: string): Promise<{ token: string; userId: string }> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    return { token: res.body.accessToken as string, userId: res.body.subject.id as string };
  }

  async function publishListing(s: Signed, unitNo: string, title: string, rent: string) {
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(s))
      .send({
        kind: 'condo_unit',
        projectName: `ไอดีโอ ${unitNo}`,
        unitNo,
        address: ADDRESS,
        areaSqm: '28.50',
        bedrooms: 1,
        bathrooms: 1,
      })
      .expect(201);
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as(s))
      .send({ unitId: unit.body.unitId, titleTh: title, rent, depositMonths: 2 })
      .expect(201);
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, s.token, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unit.body.unitId as string,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
        tenantId: s.tenantId,
      });
      await t.http
        .post(`/v1/owner/listings/${created.body.id}/photos`)
        .set(as(s))
        .send({ documentId })
        .expect(201);
    }
    await t.http.post(`/v1/owner/listings/${created.body.id}/actions/submit`).set(as(s)).expect(200);
    await t.http
      .post(`/v1/admin/listings/${created.body.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    return { id: created.body.id as string, slug: created.body.slug as string };
  }

  async function price(body: Record<string, unknown>): Promise<void> {
    const plan = (
      await q<{ id: string }>(`SELECT id FROM platform.price_plan WHERE key = 'sponsored_broadcast'`)
    )[0]!;
    const version = await t.http
      .post(`/v1/admin/price-plans/${plan.id}/versions`)
      .set(bearer(admin))
      .set(idem())
      .send({
        effectiveFrom: bangkokDate(t.clock.now()),
        vatRate: '0.07',
        billingUnit: 'per_recipient',
        ...body,
      })
      .expect(201);
    await t.http
      .post(`/v1/admin/price-plans/versions/${version.body.id}/actions/publish`)
      .set(bearer(admin))
      .expect(200);
  }

  const consentVersion = async (who: string) =>
    (await t.http.get('/v1/prospect/me/recommendations').set(me(who)).expect(200)).body.consent
      .version as number;

  async function optIn(who: string, preferences: Record<string, unknown>) {
    const version = await consentVersion(who);
    return t.http
      .put('/v1/prospect/me/recommendations')
      .set(me(who))
      .send({ consentVersion: version, preferences })
      .expect(200);
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g6' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    buyer = await signup('+660000000961', 'มาลี มีสุข');
    stranger = await signup('+660000000962', 'สมชาย ทดสอบ');
    listing = await publishListing(buyer, '12/345', 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', '12000');
    for (const sub of [SOMSRI, MAI, DAO, LEK, NOI]) people[sub] = await prospect(sub, sub);
    const areas = await t.http.get('/v1/public/listings/areas').expect(200);
    area = (areas.body.data as { slug: string; kind: string }[]).find((a) => a.kind === 'district')!.slug;
    await settle();
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('consent is separate and never pre-ticked; preferences need it; only whitelisted fields exist', async () => {
    const first = await t.http.get('/v1/prospect/me/recommendations').set(me(SOMSRI)).expect(200);
    expect(first.body).toMatchObject({
      consent: { purposeKey: 'platform.recommendations', version: 1, granted: false, grantedVersion: null },
      preferences: null,
      maxPerWeek: 2,
    });
    expect(first.body.consent.bodyMarkdown).toContain('profiling');
    // other LIFF languages read the English text until translations are reviewed (O-023 ⚖)
    const en = await t.http
      .get('/v1/prospect/me/recommendations')
      .set(me(SOMSRI))
      .set('Accept-Language', 'my')
      .expect(200);
    expect(en.body.consent.language).toBe('en');

    const prefs = {
      areas: [area],
      budgetMin: '8000',
      budgetMax: '15000',
      unitKinds: ['condo_unit'],
      language: 'th',
    };
    const refused = await t.http
      .put('/v1/prospect/me/recommendations')
      .set(me(SOMSRI))
      .send({ preferences: prefs })
      .expect(409);
    expect(refused.body.code).toBe('recommendations.consent_required');
    const outdated = await t.http
      .put('/v1/prospect/me/recommendations')
      .set(me(SOMSRI))
      .send({ consentVersion: 9, preferences: prefs })
      .expect(409);
    expect(outdated.body.code).toBe('recommendations.consent_outdated');
    // a field outside the whitelist (special-category data) cannot even be sent
    await t.http
      .put('/v1/prospect/me/recommendations')
      .set(me(SOMSRI))
      .send({ consentVersion: 1, preferences: { ...prefs, religion: 'x' } })
      .expect(422);
    await t.http
      .put('/v1/prospect/me/recommendations')
      .set(me(SOMSRI))
      .send({ consentVersion: 1, preferences: { ...prefs, areas: ['no-such-area'] } })
      .expect(422);
    expect(await q(`SELECT 1 FROM platform.audience_preference`)).toEqual([]);

    const saved = await optIn(SOMSRI, prefs);
    expect(saved.body).toMatchObject({
      consent: { granted: true, grantedVersion: 1 },
      preferences: { areas: [area], budgetMin: '8000.00', budgetMax: '15000.00', unitKinds: ['condo_unit'] },
    });
    // Collective is the controller: the consent row has no tenant; the audit row has no preference values
    const rows = await q<{ tenant_id: string | null }>(
      `SELECT c.tenant_id FROM platform.consent c JOIN platform.consent_purpose_version v ON v.id = c.purpose_version_id
        JOIN platform.consent_purpose p ON p.id = v.purpose_id WHERE p.key = 'platform.recommendations' AND c.subject_id = $1`,
      [people[SOMSRI]!.userId],
    );
    expect(rows).toEqual([{ tenant_id: null }]);
    const audit = await q<{ metadata: unknown }>(
      `SELECT metadata FROM platform.audit_log WHERE action = 'audience.preferences_updated'`,
    );
    expect(JSON.stringify(audit)).not.toContain('15000');

    await optIn(MAI, { areas: [area], budgetMax: '20000' });
    // dao's own quiet hours cover now
    const now = t.clock.now();
    await optIn(DAO, {
      areas: [],
      quietHours: {
        start: hhmm(new Date(now.getTime() - 30 * 60_000)),
        end: hhmm(new Date(now.getTime() + 60 * 60_000)),
      },
    });
    // lek wants something cheaper than anything on offer
    await optIn(LEK, { areas: [area], budgetMax: '5000' });
    // noi never consented — even a preference row (planted here) must never make her a recipient
    await q(`INSERT INTO platform.audience_preference (user_id, area_slugs) VALUES ($1, ARRAY[$2])`, [
      people[NOI]!.userId,
      area,
    ]);
  });

  it('campaigns: switched off, not on sale, below the minimum, cross-tenant 404; aggregate estimate only', async () => {
    const product = await t.http.get('/v1/owner/sponsored-campaigns/product').set(as(buyer)).expect(200);
    expect(product.body).toMatchObject({
      enabled: false,
      onSale: false,
      pricePerRecipient: null,
      minimumRecipients: 500,
    });
    const body = { listingIds: [listing.id], segment: { areas: [area] }, maxRecipients: 100 };
    const estimate = await t.http
      .post('/v1/owner/sponsored-campaigns/estimate')
      .set(as(buyer))
      .send(body)
      .expect(200);
    expect(estimate.body).toMatchObject({ estimated: null, belowMinimum: true, cost: null });
    await t.http
      .post('/v1/owner/sponsored-campaigns/estimate')
      .set(as(buyer))
      .send({ ...body, segment: { nationality: 'MM' } })
      .expect(422);

    const key = idem();
    const created = await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(buyer))
      .set(key)
      .send({ name: 'คอนโดพญาไท', ...body })
      .expect(201);
    campaignId = created.body.id as string;
    expect(created.body).toMatchObject({
      state: 'draft',
      estimated: null,
      delivered: 0,
      listings: [{ id: listing.id }],
    });
    const replay = await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(buyer))
      .set(key)
      .send({ name: 'คอนโดพญาไท', ...body })
      .expect(201);
    expect(replay.body.id).toBe(campaignId);

    // cross-tenant: every owner path is a 404 for another tenant, and its listing too
    for (const path of ['', '/report'])
      await t.http.get(`/v1/owner/sponsored-campaigns/${campaignId}${path}`).set(as(stranger)).expect(404);
    for (const action of ['schedule', 'cancel'])
      await t.http
        .post(`/v1/owner/sponsored-campaigns/${campaignId}/actions/${action}`)
        .set(as(stranger))
        .set(idem())
        .send({})
        .expect(404);
    await t.http.post('/v1/owner/sponsored-campaigns/estimate').set(as(stranger)).send(body).expect(404);
    await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(stranger))
      .set(idem())
      .send({ name: 'x', ...body })
      .expect(404);
    expect(
      (await t.http.get('/v1/owner/sponsored-campaigns').set(as(stranger)).expect(200)).body.data,
    ).toEqual([]);

    const schedule = () =>
      t.http
        .post(`/v1/owner/sponsored-campaigns/${campaignId}/actions/schedule`)
        .set(as(buyer))
        .set(idem())
        .send({});
    expect((await schedule()).body.code).toBe('broadcast.sponsored_disabled');
    // nothing is sent while switched off, whatever is scheduled
    expect(await run()).toEqual({ started: 0, sent: 0, completed: 0 });

    // the platform admin switches it on (LINE Thailand confirmed — O-023 answered in the test)
    const on = await t.http
      .put('/v1/admin/broadcast/settings')
      .set(bearer(admin))
      .send({
        enabled: true,
        // platform quiet hours far from now (dao's own window decides below)
        quietHours: {
          start: hhmm(new Date(t.clock.now().getTime() + 6 * 3_600_000)),
          end: hhmm(new Date(t.clock.now().getTime() + 6.5 * 3_600_000)),
          timezone: 'Asia/Bangkok',
        },
        reason: 'LINE Thailand confirmed (test)',
      })
      .expect(200);
    expect(on.body).toMatchObject({
      enabled: true,
      maxPerWeek: 2,
      consentText: { version: 1 },
      consenting: 4,
    });
    expect((await schedule()).body.code).toBe('broadcast.not_on_sale');

    await price({ unitPrice: '0.5', terms: { product: 'sponsored_broadcast', minimumRecipients: 2 } });
    const priced = await t.http.get('/v1/owner/sponsored-campaigns/product').set(as(buyer)).expect(200);
    expect(priced.body).toMatchObject({
      enabled: true,
      onSale: true,
      pricePerRecipient: '0.5000',
      minimumRecipients: 2,
    });

    // a segment nobody fits stays below the minimum (and the count is not shown)
    const none = await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(buyer))
      .set(idem())
      .send({ name: 'อังกฤษ', ...body, segment: { languages: ['en'] } })
      .expect(201);
    const below = await t.http
      .post(`/v1/owner/sponsored-campaigns/${none.body.id}/actions/schedule`)
      .set(as(buyer))
      .set(idem())
      .send({})
      .expect(409);
    expect(below.body.code).toBe('broadcast.below_minimum');
    await t.http
      .post(`/v1/owner/sponsored-campaigns/${none.body.id}/actions/cancel`)
      .set(as(buyer))
      .expect(200);
    const again = await t.http
      .post(`/v1/owner/sponsored-campaigns/${none.body.id}/actions/cancel`)
      .set(as(buyer))
      .expect(409);
    expect(again.body.code).toBe('broadcast.invalid_state');

    // somsri, mai, dao fit (consented, area / budget); lek's budget is too low; noi never consented
    const fits = await t.http
      .post('/v1/owner/sponsored-campaigns/estimate')
      .set(as(buyer))
      .send(body)
      .expect(200);
    expect(fits.body).toMatchObject({
      estimated: 3,
      belowMinimum: false,
      cost: { recipients: 3, subtotal: '1.50', vatAmount: '0.11', total: '1.61' },
    });
  });

  it('sends only to consenting people that fit, at send time: withdrawal, quiet hours, cap; bills per delivered recipient', async () => {
    const key = idem();
    const scheduled = await t.http
      .post(`/v1/owner/sponsored-campaigns/${campaignId}/actions/schedule`)
      .set(as(buyer))
      .set(key)
      .send({})
      .expect(200);
    expect(scheduled.body).toMatchObject({
      state: 'scheduled',
      estimated: 3,
      pricePerRecipient: '0.5000',
      vatRate: '0.0700',
      minimumRecipients: 2,
    });
    const replay = await t.http
      .post(`/v1/owner/sponsored-campaigns/${campaignId}/actions/schedule`)
      .set(as(buyer))
      .set(key)
      .send({})
      .expect(200);
    expect(replay.body.state).toBe('scheduled');

    // first pass: somsri and mai selected (dao is in her quiet hours); LINE refuses the batch
    line().failNext = true;
    const first = await run();
    expect(first).toMatchObject({ started: 1, sent: 0 });
    const pending = await q<{ user_id: string; state: string; attempts: number }>(
      `SELECT user_id, state::text, attempts FROM platform.sponsored_delivery WHERE campaign_id = $1 ORDER BY user_id`,
      [campaignId],
    );
    expect(pending.map((p) => p.user_id).sort()).toEqual(
      [people[SOMSRI]!.userId, people[MAI]!.userId].sort(),
    );
    expect(pending.every((p) => p.state === 'pending' && p.attempts === 1)).toBe(true);

    // mai withdraws in one tap before the retry: her message is cancelled at once and never sent
    const withdrawn = await t.http
      .post('/v1/prospect/me/recommendations/actions/withdraw')
      .set(me(MAI))
      .expect(200);
    expect(withdrawn.body).toMatchObject({ consent: { granted: false }, preferences: null });
    expect(
      (
        await q<{ state: string }>(
          `SELECT state::text FROM platform.sponsored_delivery WHERE campaign_id = $1 AND user_id = $2`,
          [campaignId, people[MAI]!.userId],
        )
      )[0]!.state,
    ).toBe('cancelled');
    await settle();

    const second = await run();
    expect(second).toMatchObject({ sent: 1, completed: 0 });
    expect(line().recipients()).toEqual([SOMSRI]);
    const message = JSON.stringify(line().sent[0]!.messages);
    expect(message).toContain('โฆษณา');
    expect(message).toContain('/s/');
    expect(message).toContain('/recommendations');

    // dao's quiet hours end: she gets it now; nobody else fits → sent, billed for 2 recipients
    t.clock.advance(2 * 3_600_000);
    await relogin();
    const third = await run();
    expect(third).toMatchObject({ sent: 1, completed: 1 });
    expect(line().recipients().sort()).toEqual([DAO, SOMSRI].sort());
    expect(line().recipients()).not.toContain(NOI);
    expect(line().recipients()).not.toContain(LEK);
    expect(line().recipients()).not.toContain(MAI);

    const sent = await t.http.get(`/v1/owner/sponsored-campaigns/${campaignId}`).set(as(buyer)).expect(200);
    expect(sent.body).toMatchObject({
      state: 'sent',
      delivered: 2,
      invoice: { total: '1.07', state: 'issued' },
    });
    const lines = await q<{ kind: string; quantity: string; unit_price: string; amount: string }>(
      `SELECT kind::text, quantity::text, unit_price::text, amount::text FROM platform.platform_invoice_line WHERE invoice_id = $1`,
      [sent.body.invoice.id],
    );
    expect(lines).toEqual([
      { kind: 'sponsored_broadcast', quantity: '2.000', unit_price: '0.5000', amount: '1.00' },
    ]);

    // the weekly cap (now 1): a second campaign reaches nobody, completes empty and is not billed
    await t.http
      .put('/v1/admin/broadcast/settings')
      .set(bearer(admin))
      .send({ maxPerWeek: 1, reason: 'ทดสอบเพดาน' })
      .expect(200);
    const second2 = await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(buyer))
      .set(idem())
      .send({ name: 'รอบสอง', listingIds: [listing.id], segment: {}, maxRecipients: 100 })
      .expect(201);
    await t.http
      .post(`/v1/owner/sponsored-campaigns/${second2.body.id}/actions/schedule`)
      .set(as(buyer))
      .set(idem())
      .send({})
      .expect(200);
    const before = line().sent.length;
    expect(await run()).toMatchObject({ started: 1, sent: 0, completed: 1 });
    expect(line().sent.length).toBe(before);
    const empty = await t.http
      .get(`/v1/owner/sponsored-campaigns/${second2.body.id}`)
      .set(as(buyer))
      .expect(200);
    expect(empty.body).toMatchObject({ state: 'sent', delivered: 0, invoice: null });
  });

  it('buyer sees aggregates only: clicks per link, leads by recipients; the person sees the history', async () => {
    const [link] = await q<{ code: string }>(
      `SELECT code FROM platform.sponsored_campaign_link WHERE campaign_id = $1`,
      [campaignId],
    );
    const opened = await t.http.post(`/v1/public/share-links/${link!.code}/open`).expect(200);
    expect(opened.body).toEqual({
      slug: listing.slug,
      channel: 'line_sponsored',
      utm: { source: 'line', medium: 'sponsored', campaign: 'sponsored_broadcast' },
    });
    await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(me(SOMSRI))
      .send({ message: 'ห้องยังว่างไหมคะ', consent: true, channel: 'line_sponsored' })
      .expect(201);

    const report = await t.http
      .get(`/v1/owner/sponsored-campaigns/${campaignId}/report`)
      .set(as(buyer))
      .expect(200);
    expect(report.body).toMatchObject({ sent: 2, opened: null, clicks: 1, leads: 1, attributionDays: 7 });
    const text = JSON.stringify(report.body);
    for (const who of [SOMSRI, DAO]) {
      expect(text).not.toContain(who);
      expect(text).not.toContain(people[who]!.userId);
    }

    const history = await t.http.get('/v1/prospect/me/recommendations/history').set(me(SOMSRI)).expect(200);
    expect(history.body.data).toEqual([
      expect.objectContaining({
        label: 'โฆษณา',
        sponsor: 'มาลี มีสุข',
        listings: [expect.objectContaining({ slug: listing.slug, public: true })],
      }),
    ]);
    expect(
      (await t.http.get('/v1/prospect/me/recommendations/history').set(me(LEK)).expect(200)).body.data,
    ).toEqual([]);
  });

  it('admin rejects a campaign; a new consent text asks everyone again; DSR export and erasure', async () => {
    const draft = await t.http
      .post('/v1/owner/sponsored-campaigns')
      .set(as(buyer))
      .set(idem())
      .send({ name: 'รอบสาม', listingIds: [listing.id], segment: {}, maxRecipients: 100 })
      .expect(201);
    const rejected = await t.http
      .post(`/v1/admin/sponsored-campaigns/${draft.body.id}/actions/reject`)
      .set(bearer(admin))
      .send({ reason: 'ข้อความไม่ตรงกับห้องจริง' })
      .expect(200);
    expect(rejected.body).toMatchObject({ state: 'rejected', tenantId: buyer.tenantId, invoice: null });
    const list = await t.http.get('/v1/admin/sponsored-campaigns?state=sent').set(bearer(admin)).expect(200);
    expect((list.body.data as { id: string }[]).map((c) => c.id)).toContain(campaignId);
    await t.http.get('/v1/admin/sponsored-campaigns').set(as(buyer)).expect(403);

    // DSR: dao's export carries her preferences and what was sent; erasure removes both
    const dsr = async (kind: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO platform.data_subject_request (tenant_id, subject_type, subject_id, requester_contact_enc, kind, due_at)
           VALUES (NULL, 'user', $1, '\\x00', $2::platform.dsr_kind, now() + interval '30 days') RETURNING id`,
          [people[DAO]!.userId, kind],
        )
      )[0]!.id;
    const act = (id: string, action: string) =>
      t.http
        .post(`/v1/admin/data-subject-requests/${id}/actions/${action}`)
        .set(bearer(admin))
        .send({ notes: 'ok' });
    const access = await dsr('access');
    await act(access, 'verify').expect(200);
    await act(access, 'start').expect(200);
    const fulfilled = await act(access, 'fulfil').expect(200);
    const [doc] = await q<{ storage_key: string }>(`SELECT storage_key FROM core.document WHERE id = $1`, [
      fulfilled.body.exportDocumentId,
    ]);
    const exported = JSON.parse(
      t.app.get<FakeObjectStorage>(OBJECT_STORAGE).objects.get(doc!.storage_key)!.body.toString('utf8'),
    ) as { recommendationPreferences: unknown; sponsoredMessages: unknown[] };
    expect(exported.recommendationPreferences).toMatchObject({ areas: [] });
    expect(exported.sponsoredMessages).toEqual([
      expect.objectContaining({ state: 'sent', sponsor: 'มาลี มีสุข' }),
    ]);
    const erase = await dsr('erasure');
    await act(erase, 'start').expect(200);
    await act(erase, 'fulfil').expect(200);
    expect(
      await q(`SELECT 1 FROM platform.audience_preference WHERE user_id = $1`, [people[DAO]!.userId]),
    ).toEqual([]);
    expect(
      await q(`SELECT 1 FROM platform.sponsored_delivery WHERE user_id = $1`, [people[DAO]!.userId]),
    ).toEqual([]);
    // campaign totals stay
    expect(
      (await t.http.get(`/v1/owner/sponsored-campaigns/${campaignId}`).set(as(buyer)).expect(200)).body
        .delivered,
    ).toBe(2);

    // a new consent text: every earlier grant no longer counts until people consent again
    await t.http
      .post('/v1/admin/broadcast/consent-texts')
      .set(bearer(admin))
      .set(idem())
      .send({
        th: {
          title: 'รับห้องแนะนำ (ฉบับ 2)',
          bodyMarkdown: 'ร่าง ⚖ ฉบับ 2 — เลือกรับหรือไม่ก็ได้ เลิกรับได้ทุกเมื่อ',
        },
        en: {
          title: 'Recommended places (v2)',
          bodyMarkdown: 'Draft ⚖ v2 — optional, stop any time with one tap.',
        },
      })
      .expect(201);
    const v2 = await t.http.get('/v1/prospect/me/recommendations').set(me(SOMSRI)).expect(200);
    expect(v2.body).toMatchObject({
      consent: { version: 2, granted: false, grantedVersion: 1 },
      preferences: null,
    });
    const estimate = await t.http
      .post('/v1/owner/sponsored-campaigns/estimate')
      .set(as(buyer))
      .send({ listingIds: [listing.id], segment: {}, maxRecipients: 100 })
      .expect(200);
    expect(estimate.body).toMatchObject({ estimated: null, belowMinimum: true });
  });
});
