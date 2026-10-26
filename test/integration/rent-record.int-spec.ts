import { fakeLineIdToken } from '@collective/integrations/line';
import sharp from 'sharp';

import { ListingLeadsService } from '../../src/modules/ops-listings/listing-leads.service';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '20:00' }));
const LINE_SUB = 'U000000000000000000000000000b7111';

/** B7.11 acceptance — the portable rent record (D-256) and the vacancy view (D-261). */
describe('rent record and vacancy view (B7.11, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let unitId: string;
  let vacantUnitId: string;
  let buildingId: string;
  let lessee: string;
  let leaseId: string;
  let resident: string;
  let prospect: string;
  let listing: { id: string; slug: string };
  let seq = 0;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });

  /** An issued invoice of the lease, paid (or not) through `via`. */
  async function invoice(month: string, due: string, paid: { at: string; via: string } | null) {
    seq += 1;
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, snapshot, period_start,
         period_end, issued_at, due_date, status, subtotal, total, paid_total, balance)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', $7::date, ($7::date + interval '1 month - 1 day')::date, $7::date, $8::date,
         $9, 15000, 15000, $10, $11) RETURNING id`,
      [
        owner.tenantId,
        buildingId,
        unitId,
        lessee,
        leaseId,
        `INV-T-${seq}`,
        `${month}-01`,
        due,
        paid ? 'paid' : 'overdue',
        paid ? 15000 : 0,
        paid ? 0 : 15000,
      ],
    );
    if (!paid) return;
    const payment = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.payment (tenant_id, building_id, unit_id, payer_party_id, lease_id, invoice_id, amount, method, paid_at,
         status, confirmed_at, confirmed_via)
       VALUES ($1, $2, $3, $4, $5, $6, 15000, 'qr', $7, 'confirmed', $7, $8) RETURNING id`,
      [owner.tenantId, buildingId, unitId, lessee, leaseId, rows[0]!.id, paid.at, paid.via],
    );
    await db.admin.query(
      `INSERT INTO ops.payment_allocation (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, 15000)`,
      [owner.tenantId, payment.rows[0]!.id, rows[0]!.id],
    );
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_rent_record' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009711';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'มาลี มีสุข',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    const addUnit = async (unitNo: string) =>
      (
        await t.http
          .post('/v1/owner/portfolio/units')
          .set(as())
          .send({
            kind: 'condo_unit',
            projectName: 'ไอดีโอ โมบิ อารีย์',
            unitNo,
            address: ADDRESS,
            areaSqm: '28.50',
            bedrooms: 1,
            bathrooms: 1,
          })
          .expect(201)
      ).body.unitId as string;
    unitId = await addUnit('12/711');
    vacantUnitId = await addUnit('12/712');
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'สมศรี ใจดี',
          phone: '+66810009712',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X7654322',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as())
      .send({ unitId, lesseePartyId: lessee, startDate: '2026-01-01', months: 24, rent: '15000' });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    leaseId = draft.body.id as string;
    buildingId = draft.body.buildingId as string;
    const sent = await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/send-for-signature`)
      .set(as())
      .set(idem());
    if (sent.status !== 200) throw new Error(JSON.stringify(sent.body));
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [leaseId],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'สมศรี' }) })
      .expect(200);
    await db.admin.query(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
       SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [owner.tenantId, lessee, LINE_SUB],
    );
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)
    ).body.accessToken as string;

    // a listing of the vacant unit, published
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as())
      .send({
        unitId: vacantUnitId,
        titleTh: 'คอนโด 1 ห้องนอน ว่างพร้อมอยู่',
        rent: '14000',
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
        scopeId: vacantUnitId,
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
    // the same LINE account asks about it as a prospect
    prospect = (
      await t.http
        .post('/v1/auth/prospect/line')
        .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'สมศรี' }) })
        .expect(200)
    ).body.accessToken as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('is empty until a month is confirmed; then on time, late and outstanding from getproperty-confirmed payments', async () => {
    const empty = await t.http.get('/v1/resident/me/rent-record').set(bearer(resident)).expect(200);
    expect(empty.body).toEqual({
      record: {
        months: [],
        onTime: 0,
        late: 0,
        outstanding: 0,
        notConfirmed: 0,
        firstMonth: null,
        lastMonth: null,
      },
      shares: [],
    });
    await t.http
      .post('/v1/resident/me/rent-record/letters')
      .set(bearer(resident))
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('rent_record.empty'));

    await invoice('2026-06', '2026-06-05', { at: '2026-06-03T03:00:00Z', via: 'webhook' });
    await invoice('2026-07', '2026-07-05', { at: '2026-07-05T16:00:00Z', via: 'slip_verified' }); // 23:00 Bangkok
    await invoice('2026-08', '2026-08-05', { at: '2026-08-09T03:00:00Z', via: 'settlement_file' });
    await invoice('2026-09', '2026-09-05', { at: '2026-09-02T03:00:00Z', via: 'manual' }); // owner-recorded cash
    await invoice('2026-10', '2026-10-05', null);

    const record = await t.http.get('/v1/resident/me/rent-record').set(bearer(resident)).expect(200);
    const expected = t.clock.now() > new Date('2026-10-05T17:00:00Z');
    expect(record.body.record).toMatchObject({
      onTime: 2,
      late: 1,
      outstanding: expected ? 1 : 0,
      notConfirmed: 1,
      firstMonth: '2026-06',
    });
    expect((record.body.record.months as unknown[]).slice(-3)).toEqual([
      { month: '2026-08', status: 'late' },
      { month: '2026-07', status: 'on_time' },
      { month: '2026-06', status: 'on_time' },
    ]);
    // the same person as a prospect sees the same record
    const same = await t.http.get('/v1/prospect/me/rent-record').set(bearer(prospect)).expect(200);
    expect(same.body.record).toEqual(record.body.record);
  });

  it('shares with one enquiry only when asked; the owner sees it until it is revoked', async () => {
    const lead = await t.http
      .post(`/v1/prospect/listings/${listing.slug}/enquiries`)
      .set(bearer(prospect))
      .send({ message: 'สนใจห้องนี้ค่ะ', consent: true })
      .expect(201);
    const leadId = lead.body.id as string;
    const before = await t.http.get(`/v1/owner/leads/${leadId}`).set(as()).expect(200);
    expect(before.body.rentRecord).toBeNull();

    const shared = await t.http
      .post(`/v1/prospect/enquiries/${leadId}/rent-record`)
      .set(bearer(prospect))
      .expect(200);
    expect(shared.body).toMatchObject({
      kind: 'enquiry',
      state: 'live',
      lead: { id: leadId, listingTitle: 'คอนโด 1 ห้องนอน ว่างพร้อมอยู่', ownerName: 'มาลี มีสุข' },
    });
    const again = await t.http
      .post(`/v1/prospect/enquiries/${leadId}/rent-record`)
      .set(bearer(prospect))
      .expect(200);
    expect(again.body.id).toBe(shared.body.id);

    const seen = await t.http.get(`/v1/owner/leads/${leadId}`).set(as()).expect(200);
    expect(seen.body.rentRecord).toMatchObject({ onTime: 2, late: 1, notConfirmed: 1 });
    expect(seen.body.rentRecord.sharedAt).toEqual(expect.any(String));
    expect(JSON.stringify(seen.body.rentRecord)).not.toContain('15000');

    await t.http
      .post(`/v1/prospect/me/rent-record/shares/${shared.body.id}/actions/revoke`)
      .set(bearer(prospect))
      .expect(200)
      .expect((r) => expect(r.body.state).toBe('revoked'));
    const gone = await t.http.get(`/v1/owner/leads/${leadId}`).set(as()).expect(200);
    expect(gone.body.rentRecord).toBeNull();

    // someone else's enquiry or share is a 404
    const other = (
      await t.http
        .post('/v1/auth/prospect/line')
        .send({ idToken: fakeLineIdToken({ sub: 'U000000000000000000000000000b7112', name: 'อื่น' }) })
        .expect(200)
    ).body.accessToken as string;
    await t.http.post(`/v1/prospect/enquiries/${leadId}/rent-record`).set(bearer(other)).expect(404);
    await t.http
      .post(`/v1/prospect/me/rent-record/shares/${shared.body.id}/actions/revoke`)
      .set(bearer(other))
      .expect(404);

    const audit = await db.admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 ORDER BY id`,
      [shared.body.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['rent_record.shared', 'rent_record.share_revoked']);
  });

  it('a letter code checks publicly while it is live, and stops once revoked or expired', async () => {
    const letter = await t.http.post('/v1/resident/me/rent-record/letters').set(bearer(resident)).expect(201);
    const code = letter.body.code as string;
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{10}$/);
    expect(letter.body.verifyUrl).toBe(`http://localhost:3001/rent-record/${code}`);
    expect(letter.body.share).toMatchObject({
      kind: 'letter',
      state: 'live',
      codeHint: code.slice(-4),
      lead: null,
    });
    const stored = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.rent_record_share WHERE code_hint = $1 AND code_hash IS NOT NULL`,
      [code.slice(-4)],
    );
    expect(stored.rows[0]!.n).toBe(1);

    const checked = await t.http.get(`/v1/public/rent-records/${code.toLowerCase()}`).expect(200);
    expect(checked.body).toMatchObject({ holderName: 'สมศรี', record: { onTime: 2, late: 1 } });
    await t.http.get('/v1/public/rent-records/ZZZZZZZZZZ').expect(404);

    // the letter's validity ran out
    await db.admin.query(
      `UPDATE platform.rent_record_share SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [letter.body.share.id],
    );
    await t.http.get(`/v1/public/rent-records/${code}`).expect(404);
    const mine = await t.http.get('/v1/resident/me/rent-record').set(bearer(resident)).expect(200);
    const shares = mine.body.shares as { id: string; state: string }[];
    expect(shares.find((s) => s.id === letter.body.share.id)?.state).toBe('expired');

    const fresh = await t.http.post('/v1/resident/me/rent-record/letters').set(bearer(resident)).expect(201);
    await t.http.get(`/v1/public/rent-records/${fresh.body.code}`).expect(200);
    await t.http
      .post(`/v1/resident/me/rent-record/shares/${fresh.body.share.id}/actions/revoke`)
      .set(bearer(resident))
      .expect(200);
    await t.http.get(`/v1/public/rent-records/${fresh.body.code}`).expect(404);
  });

  it('reminds the resident and the owner once before a landlord’s lease ends (D-261)', async () => {
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000);
    const end = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    await db.admin.query(`UPDATE ops.lease SET end_date = $2 WHERE id = $1`, [leaseId, end]);
    const leads = t.app.get(ListingLeadsService);
    expect((await leads.remind()).leaseEnds).toBe(1);
    expect((await leads.remind()).leaseEnds).toBe(0);
    await t.worker.tick();
    const { rows } = await db.admin.query<{ recipient_type: string; n: number }>(
      `SELECT n.recipient_type::text, count(*)::int AS n FROM platform.notification n
         JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'lease.end_approaching' AND e.tenant_id = $1 GROUP BY 1 ORDER BY 1`,
      [owner.tenantId],
    );
    expect(rows.map((r) => r.recipient_type)).toEqual(['party', 'user']);
  });

  it('the portfolio shows each unit’s listing and open enquiries, and since when a unit is vacant (D-261)', async () => {
    const portfolio = await t.http.get('/v1/owner/portfolio').set(as()).expect(200);
    const units = portfolio.body.units as {
      unitId: string;
      state: string;
      vacantSince: string | null;
      listing: { id: string; state: string; slug: string; openLeads: number } | null;
    }[];
    const vacant = units.find((u) => u.unitId === vacantUnitId)!;
    expect(vacant).toMatchObject({
      state: 'vacant',
      vacantSince: null,
      listing: { id: listing.id, state: 'published', slug: listing.slug, openLeads: 1 },
    });
    const leased = units.find((u) => u.unitId === unitId)!;
    expect(leased).toMatchObject({ state: 'leased', listing: null, vacantSince: null });

    await db.admin.query(`UPDATE ops.lease SET status = 'ended', end_date = '2026-12-31' WHERE id = $1`, [
      leaseId,
    ]);
    const after = await t.http.get('/v1/owner/portfolio').set(as()).expect(200);
    expect((after.body.units as { unitId: string }[]).find((u) => u.unitId === unitId)).toMatchObject({
      state: 'vacant',
      vacantSince: '2026-12-31',
    });
  });
});
