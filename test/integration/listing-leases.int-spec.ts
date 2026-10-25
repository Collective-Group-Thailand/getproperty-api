import { fakeLineIdToken } from '@collective/integrations/line';
import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import sharp from 'sharp';

import { ListingLeadsService } from '../../src/modules/ops-listings/listing-leads.service';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));

/** B7.4 acceptance — lead → lease draft, auto-close on activation, other leads lost, re-list reminder and re-open. */
describe('lead → lease (B7.4, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let listing: { id: string; slug: string };
  let leadA: string;
  let leadB: string;
  let leaseId: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });

  async function prospect(sub: string, name: string): Promise<string> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function planned(eventType: string, recipientType: 'user' | 'party') {
    await t.worker.tick();
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = $1 AND n.recipient_type::text = $2 AND e.tenant_id = $3`,
      [eventType, recipientType, owner.tenantId],
    );
    return rows[0]!.n;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_leases_b74' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009401';
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

    const a = await prospect('U000000000000000000000000000b7401', 'สมศรี ใจดี');
    const b = await prospect('U000000000000000000000000000b7402', 'เล็ก');
    leadA = (
      await t.http
        .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
        .set(bearer(a))
        .send({ message: 'สนใจเช่า 12 เดือนค่ะ', termMonths: 12, consent: true })
        .expect(201)
    ).body.id as string;
    leadB = (
      await t.http
        .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
        .set(bearer(b))
        .send({ message: 'ยังว่างไหมครับ', consent: true })
        .expect(201)
    ).body.id as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it("drafts a lease from the listing's terms with the prospect as lessee; once only", async () => {
    const res = await t.http.post(`/v1/owner/leads/${leadA}/lease-draft`).set(as()).send({});
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    leaseId = res.body.leaseId as string;
    expect(res.body.lead).toMatchObject({ state: 'applied', leaseId });
    const lease = await t.http.get(`/v1/owner/leases/${leaseId}`).set(as()).expect(200);
    expect(lease.body).toMatchObject({ status: 'draft', rent: '15000.00', depositAmount: '30000.00' });
    const again = await t.http.post(`/v1/owner/leads/${leadA}/lease-draft`).set(as()).send({}).expect(409);
    expect(again.body.code).toBe('listing.lease_exists');
  });

  it('closes the listing when the lease is activated: this lead won, the others lost with a polite message', async () => {
    // The B2 signing flow is covered by leases.int-spec; here the lease is put in force directly.
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', number = 'LS-B74-0001', activated_at = now() WHERE id = $1`,
      [leaseId],
    );
    await t.app.get(TenantTx).platform((tx) =>
      t.app.get(DomainEvents).record(tx, {
        type: 'lease.activated',
        aggregateType: 'lease',
        aggregateId: leaseId,
        tenantId: owner.tenantId,
        payload: { leaseId, occupied: false },
      }),
    );
    await t.worker.tick();
    await t.worker.tick();
    const { rows } = await db.admin.query<{ state: string; closed_reason: string; lease_id: string }>(
      'SELECT state::text, closed_reason::text, lease_id FROM ops.listing WHERE id = $1',
      [listing.id],
    );
    expect(rows[0]).toEqual({ state: 'closed', closed_reason: 'leased', lease_id: leaseId });
    const a = await t.http.get(`/v1/owner/leads/${leadA}`).set(as()).expect(200);
    const b = await t.http.get(`/v1/owner/leads/${leadB}`).set(as()).expect(200);
    expect(a.body.state).toBe('won');
    expect(b.body).toMatchObject({ state: 'lost', lostReason: 'unit_leased' });
    expect(await planned('listing.lead_state_changed', 'party')).toBe(1);
    await t.http.get(`/v1/public/listings/${listing.slug}`).expect(404);
  });

  it('reminds the owner once before the lease ends and re-opens the listing in one step', async () => {
    const { rows } = await db.admin.query<{ end_date: string }>(
      `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM ops.lease WHERE id = $1`,
      [leaseId],
    );
    t.clock.set(new Date(Date.parse(`${rows[0]!.end_date}T00:00:00+07:00`) - 30 * 86_400_000));
    const leads = t.app.get(ListingLeadsService);
    expect((await leads.remind()).relists).toBe(1);
    expect((await leads.remind()).relists).toBe(0);
    expect(await planned('listing.relist_due', 'user')).toBeGreaterThan(0);

    t.clock.advance(61_000);
    const challenge = await t.http
      .post('/v1/auth/operator/otp/request')
      .send({ phone: '+66810009401' })
      .expect(200);
    const login = await t.http
      .post('/v1/auth/operator/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo('+66810009401') })
      .expect(200);
    owner = { ...owner, token: login.body.accessToken as string };
    const relisted = await t.http
      .post(`/v1/owner/listings/${listing.id}/actions/relist`)
      .set(as())
      .expect(201);
    expect(relisted.body).toMatchObject({
      state: 'draft',
      titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
      rent: '15000.00',
    });
    expect(relisted.body.id).not.toBe(listing.id);
    expect(relisted.body.photos).toHaveLength(5);
    expect(relisted.body.availability.weekly).toHaveLength(7);
    const open = await t.http
      .post(`/v1/owner/listings/${relisted.body.id}/actions/relist`)
      .set(as())
      .expect(409);
    expect(open.body.code).toBe('listing.invalid_state');
  });
});
