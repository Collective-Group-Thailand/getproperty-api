import { fakeLineIdToken } from '@collective/integrations/line';
import sharp from 'sharp';

import { ListingLeadsService } from '../../src/modules/ops-listings/listing-leads.service';
import { ListingModerationService } from '../../src/modules/ops-listings/listing-moderation.service';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, operatorToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));

interface Landlord {
  tenantId: string;
  token: string;
}
interface Slot {
  startsAt: string;
  endsAt: string;
}

/** B7.3 part 2 acceptance — prospects, enquiries, viewings, the owner's inbox and reminders (D-252). */
describe('listing leads (B7.3, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let malee: Landlord;
  let somchai: Landlord;
  let listing: { id: string; slug: string };
  let somsri: string;
  let lek: string;
  let leadId: string;
  let viewingId: string;

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

  async function prospect(sub: string, name: string): Promise<string> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    expect(res.body.subject).toMatchObject({ audience: 'prospect', scopes: [] });
    return res.body.accessToken as string;
  }

  async function slots(): Promise<Slot[]> {
    const res = await t.http.get(`/v1/public/listings/${listing.slug}/viewing-slots?days=7`).expect(200);
    expect(res.body.slotMinutes).toBe(30);
    return res.body.slots as Slot[];
  }

  /** Planned notifications of an event: the owner's go to the login (`user`), the prospect's to the party. */
  async function notifications(eventType: string, audience: 'owner' | 'prospect') {
    await t.worker.tick();
    const { rows } = await db.admin.query<{ state: string; channel: string }>(
      `SELECT n.state::text, n.channel::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = $1 AND n.recipient_type::text = $2 AND e.tenant_id = $3`,
      [eventType, audience === 'owner' ? 'user' : 'party', malee.tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_leads' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    malee = await signUp('+66810009301', 'มาลี มีสุข');
    somchai = await signUp('+66810009302', 'สมชาย ใจดี');
    const unit = await t.http
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
      })
      .expect(201);
    const unitId = unit.body.unitId as string;
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as(malee))
      .send({ unitId, titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', rent: '15000' })
      .expect(201);
    listing = { id: created.body.id as string, slug: created.body.slug as string };
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, malee.token, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unitId,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
        tenantId: malee.tenantId,
      });
      await t.http
        .post(`/v1/owner/listings/${listing.id}/photos`)
        .set(as(malee))
        .send({ documentId })
        .expect(201);
    }
    await t.http
      .put(`/v1/owner/listings/${listing.id}/availability`)
      .set(as(malee))
      .send({ weekly: EVERY_DAY, exceptions: [], slotMinutes: 30 })
      .expect(200);
    await t.http.post(`/v1/owner/listings/${listing.id}/actions/submit`).set(as(malee)).expect(200);
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

  it('signs a prospect in with LINE into its own audience', async () => {
    somsri = await prospect('U000000000000000000000000000ead01', 'สมศรี ใจดี');
    const me = await t.http.get('/v1/prospect/me').set(bearer(somsri)).expect(200);
    expect(me.body).toMatchObject({
      openEnquiries: 0,
      upcomingViewings: 0,
      user: { displayName: 'สมศรี ใจดี' },
    });
    const wrong = await t.http.get('/v1/resident/me').set(bearer(somsri)).expect(403);
    expect(wrong.body.code).toBe('auth.wrong_audience');
    const resident = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U000000000000000000000000000ead01' }) })
      .expect(200);
    await t.http
      .get('/v1/prospect/me')
      .set(bearer(resident.body.accessToken as string))
      .expect(403);
  });

  it('needs consent for the first enquiry; records the party in the owner’s tenant and the consent', async () => {
    const refused = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(somsri))
      .send({ message: 'ห้องยังว่างไหมคะ', consent: false })
      .expect(422);
    expect(refused.body.code).toBe('listing.consent_required');
    await t.http
      .post('/v1/prospect/listings/no-such-listing/enquiries')
      .set(bearer(somsri))
      .send({ message: 'ห้องยังว่างไหมคะ', consent: true })
      .expect(404);

    const sent = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(somsri))
      .send({
        message: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้',
        moveInDate: '2026-12-01',
        occupants: 2,
        consent: true,
      })
      .expect(201);
    leadId = sent.body.id as string;
    expect(sent.body).toMatchObject({
      open: true,
      occupants: 2,
      moveInDate: '2026-12-01',
      listing: { slug: listing.slug, rent: '15000.00', ownerName: 'มาลี มีสุข', available: true },
    });
    expect(sent.body.messages).toHaveLength(1);

    const again = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(somsri))
      .send({ message: 'ขอเบอร์ติดต่อด้วยค่ะ', consent: false })
      .expect(201);
    expect(again.body.id).toBe(leadId);
    expect(again.body.messages).toHaveLength(2);

    const { rows: parties } = await db.admin.query<{
      tenant_id: string;
      line_user_id: string;
      linked_via: string;
    }>(
      `SELECT p.tenant_id, p.line_user_id, l.linked_via::text FROM ops.listing_lead ll
         JOIN core.party p ON p.id = ll.party_id JOIN core.party_user_link l ON l.party_id = p.id WHERE ll.id = $1`,
      [leadId],
    );
    expect(parties).toEqual([
      {
        tenant_id: malee.tenantId,
        line_user_id: 'U000000000000000000000000000ead01',
        linked_via: 'line_match',
      },
    ]);
    const { rows: consents } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.consent c JOIN platform.consent_purpose_version v ON v.id = c.purpose_version_id
         JOIN platform.consent_purpose p ON p.id = v.purpose_id
        WHERE p.key = 'prospect.enquiry' AND c.tenant_id = $1 AND c.granted`,
      [malee.tenantId],
    );
    expect(consents[0]!.n).toBe(1);

    const inbox = await t.http.get('/v1/owner/leads?open=true').set(as(malee)).expect(200);
    expect(inbox.body).toEqual([
      expect.objectContaining({
        id: leadId,
        state: 'new',
        awaitingReply: true,
        lastMessage: 'ขอเบอร์ติดต่อด้วยค่ะ',
        prospect: expect.objectContaining({ name: 'สมศรี ใจดี', lineLinked: true }),
      }),
    ]);
    expect((await notifications('listing.lead_received', 'owner')).length).toBeGreaterThan(0);
  });

  it('books a free slot; double booking and a second live viewing are refused', async () => {
    const free = await slots();
    expect(free.length).toBeGreaterThan(4);
    const odd = new Date(new Date(free[0]!.startsAt).getTime() + 10 * 60_000).toISOString();
    const unavailable = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/viewings`)
      .set(bearer(somsri))
      .send({ startsAt: odd, consent: true })
      .expect(422);
    expect(unavailable.body.code).toBe('listing.viewing_slot_unavailable');

    const booked = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/viewings`)
      .set(bearer(somsri))
      .send({ startsAt: free[0]!.startsAt, note: 'จะมากับแฟนค่ะ', consent: true })
      .expect(201);
    expect(booked.body.id).toBe(leadId);
    expect(booked.body.viewings[0]).toMatchObject({ state: 'requested', note: 'จะมากับแฟนค่ะ' });
    viewingId = booked.body.viewings[0].id as string;
    expect((await slots()).map((s) => s.startsAt)).not.toContain(free[0]!.startsAt);

    lek = await prospect('U000000000000000000000000000ead02', 'เล็ก');
    const taken = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/viewings`)
      .set(bearer(lek))
      .send({ startsAt: free[0]!.startsAt, consent: true })
      .expect(409);
    expect(taken.body.code).toBe('listing.viewing_slot_taken');
    const second = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/viewings`)
      .set(bearer(somsri))
      .send({ startsAt: free[2]!.startsAt, consent: true })
      .expect(409);
    expect(second.body.code).toBe('listing.viewing_exists');

    const lead = await t.http.get(`/v1/owner/leads/${leadId}`).set(as(malee)).expect(200);
    expect(lead.body).toMatchObject({ state: 'viewing_booked', nextViewing: { id: viewingId } });
    expect((await notifications('listing.viewing_requested', 'owner')).length).toBeGreaterThan(0);
  });

  it('the owner replies (to the prospect in LINE) and confirms; the prospect reschedules', async () => {
    const replied = await t.http
      .post(`/v1/owner/leads/${leadId}/messages`)
      .set(as(malee))
      .send({ body: 'ยังว่างค่ะ เจอกันวันนัดนะคะ' })
      .expect(201);
    expect(replied.body).toMatchObject({
      state: 'viewing_booked',
      awaitingReply: false,
      lastMessageBy: 'owner',
    });
    const toProspect = await notifications('listing.lead_replied', 'prospect');
    expect(toProspect).toEqual([expect.objectContaining({ channel: 'line' })]);
    expect(toProspect[0]!.state).not.toBe('held_no_consent');

    await t.http.post(`/v1/owner/listing-viewings/${viewingId}/actions/confirm`).set(as(malee)).expect(200);
    const again = await t.http
      .post(`/v1/owner/listing-viewings/${viewingId}/actions/confirm`)
      .set(as(malee))
      .expect(409);
    expect(again.body.code).toBe('listing.viewing_invalid_state');
    expect((await notifications('listing.viewing_confirmed', 'prospect')).length).toBe(1);

    const free = await slots();
    const moved = await t.http
      .post(`/v1/prospect/viewings/${viewingId}/actions/reschedule`)
      .set(bearer(somsri))
      .send({ startsAt: free[3]!.startsAt })
      .expect(200);
    const [next, old] = moved.body.viewings as { id: string; state: string; rescheduledTo: string | null }[];
    expect(old).toMatchObject({ id: viewingId, state: 'cancelled', rescheduledTo: next!.id });
    expect(next).toMatchObject({ state: 'requested' });
    viewingId = next!.id;

    const calendar = await t.http.get('/v1/owner/listing-viewings').set(as(malee)).expect(200);
    expect((calendar.body as { id: string }[]).map((v) => v.id)).toEqual([viewingId]);
    const mine = await t.http.get('/v1/prospect/me').set(bearer(somsri)).expect(200);
    expect(mine.body).toMatchObject({ openEnquiries: 1, upcomingViewings: 1 });
  });

  it('keeps enquiries private: other owners and other prospects get 404', async () => {
    await t.http.get(`/v1/owner/leads/${leadId}`).set(as(somchai)).expect(404);
    expect((await t.http.get('/v1/owner/leads').set(as(somchai)).expect(200)).body).toEqual([]);
    await t.http.get(`/v1/prospect/enquiries/${leadId}`).set(bearer(lek)).expect(404);
    await t.http
      .post(`/v1/prospect/viewings/${viewingId}/actions/cancel`)
      .set(bearer(lek))
      .send({})
      .expect(404);
    expect((await t.http.get('/v1/prospect/enquiries').set(bearer(somsri)).expect(200)).body).toHaveLength(1);
  });

  it('reminds both sides before a confirmed viewing and nudges the owner about an unanswered enquiry', async () => {
    await t.http.post(`/v1/owner/listing-viewings/${viewingId}/actions/confirm`).set(as(malee)).expect(200);
    await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(lek))
      .send({ message: 'รับสัตว์เลี้ยงไหมครับ', consent: true })
      .expect(201);
    const leads = t.app.get(ListingLeadsService);
    const { rows } = await db.admin.query<{ starts_at: Date }>(
      'SELECT starts_at FROM ops.listing_viewing WHERE id = $1',
      [viewingId],
    );
    t.clock.set(new Date(rows[0]!.starts_at.getTime() - 2 * 3_600_000));
    expect(await leads.remind()).toEqual({ viewings: 1, leads: 1 });
    expect(await leads.remind()).toEqual({ viewings: 0, leads: 0 });
    expect((await notifications('listing.viewing_reminder', 'owner')).length).toBeGreaterThan(0);
    expect((await notifications('listing.viewing_reminder', 'prospect')).length).toBe(1);
    expect((await notifications('listing.lead_unanswered', 'owner')).length).toBeGreaterThan(0);
  });

  it('records the visit, closes the lead lost with a reason, and the prospect sees it closed', async () => {
    t.clock.advance(3 * 3_600_000);
    malee = { ...malee, token: await reauth(malee) };
    somsri = await prospect('U000000000000000000000000000ead01', 'สมศรี ใจดี');
    const done = await t.http
      .post(`/v1/owner/listing-viewings/${viewingId}/actions/complete`)
      .set(as(malee))
      .send({ outcome: 'completed' })
      .expect(200);
    expect(done.body.state).toBe('viewed');
    await t.http
      .patch(`/v1/owner/leads/${leadId}`)
      .set(as(malee))
      .send({ notes: 'ชอบห้อง แต่ขอต่อราคา' })
      .expect(200);
    const noReason = await t.http
      .post(`/v1/owner/leads/${leadId}/actions/set-state`)
      .set(as(malee))
      .send({ state: 'lost' })
      .expect(422);
    expect(noReason.body.code).toBe('validation.failed');
    const lost = await t.http
      .post(`/v1/owner/leads/${leadId}/actions/set-state`)
      .set(as(malee))
      .send({ state: 'lost', lostReason: 'price', lostNote: 'งบ 12,000' })
      .expect(200);
    expect(lost.body).toMatchObject({ state: 'lost', lostReason: 'price', notes: 'ชอบห้อง แต่ขอต่อราคา' });

    const seen = await t.http.get(`/v1/prospect/enquiries/${leadId}`).set(bearer(somsri)).expect(200);
    expect(seen.body.open).toBe(false);
    expect(seen.body).not.toHaveProperty('notes');
    expect(seen.body).not.toHaveProperty('lostReason');
    const closed = await t.http
      .post(`/v1/prospect/enquiries/${leadId}/messages`)
      .set(bearer(somsri))
      .send({ body: 'ลดได้ไหมคะ' })
      .expect(409);
    expect(closed.body.code).toBe('listing.lead_invalid_state');
    // writing on the listing again starts a new enquiry (consent already given)
    const fresh = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(somsri))
      .send({ message: 'ถ้า 13,000 ได้ไหมคะ', consent: false })
      .expect(201);
    expect(fresh.body.id).not.toBe(leadId);
  });

  it('tells the owner when moderation rejects a listing', async () => {
    await t.app.get(ListingModerationService).reject(listing.id, 'รูปไม่ตรงกับห้องจริง');
    expect((await notifications('listing.rejected', 'owner')).length).toBeGreaterThan(0);
  });

  async function reauth(l: Landlord): Promise<string> {
    t.clock.advance(61_000);
    return operatorToken(t, l.tenantId === malee.tenantId ? '+66810009301' : '+66810009302');
  }
});
