import { fakeLineIdToken } from '@collective/integrations/line';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { PDF_RENDERER } from '@integrations/pdf/pdf-renderer.port';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const LINE_SUB = 'U000000000000000000000000000b7531';

/** B7.5 part 3 acceptance — rent certificates (resident asks, owner issues / declines), income summary, bilingual lease. */
describe('rent certificates, income summary, bilingual lease (B7.5, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let unitId: string;
  let buildingId: string;
  let lessee: string;
  let leaseId: string;
  let resident: string;
  let requestId: string;
  let receiptSeq = 0;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const R = () => bearer(resident);
  const lastPdfText = () => t.app.get<FakePdfRenderer>(PDF_RENDERER).rendered.at(-1)!.text;
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

  async function receipt(amount: string, issuedAt: Date) {
    receiptSeq += 1;
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.payment (tenant_id, building_id, unit_id, payer_party_id, lease_id, amount, method, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'cash', $7) RETURNING id`,
      [owner.tenantId, buildingId, unitId, lessee, leaseId, amount, issuedAt],
    );
    await db.admin.query(
      `INSERT INTO ops.receipt (tenant_id, building_id, unit_id, kind, payment_id, payer_party_id, number, issued_at, amount)
       VALUES ($1, $2, $3, 'payment', $4, $5, $6, $7, $8)`,
      [owner.tenantId, buildingId, unitId, rows[0]!.id, lessee, `RCP-T-${receiptSeq}`, issuedAt, amount],
    );
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_rent_certs' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009701';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'มาลี มีสุข',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    unitId = (
      await t.http
        .post('/v1/owner/portfolio/units')
        .set(as())
        .send({
          kind: 'condo_unit',
          projectName: 'ไอดีโอ โมบิ อารีย์',
          unitNo: '12/345',
          address: ADDRESS,
          bedrooms: 1,
          bathrooms: 1,
        })
        .expect(201)
    ).body.unitId as string;
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'Alex Example',
          phone: '+66810009702',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X7654321',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http.post('/v1/owner/leases').set(as()).send({
      unitId,
      lesseePartyId: lessee,
      startDate: today(),
      months: 12,
      rent: '15000',
      bilingual: true,
    });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    leaseId = draft.body.id as string;
    expect(draft.body.bilingual).toBe(true);
    buildingId = draft.body.buildingId as string;
    await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [leaseId],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'Alex' }) })
      .expect(200);
    await db.admin.query(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
       SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [owner.tenantId, lessee, LINE_SUB],
    );
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)
    ).body.accessToken as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('writes a bilingual lease: Thai then English in one document', async () => {
    const pdf = await t.http
      .get(`/v1/owner/leases/${leaseId}/contract-preview`)
      .set(as())
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    const text = FakePdfRenderer.textOf(pdf.body as Buffer);
    expect(text.indexOf('สัญญาเช่าห้องชุด')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Condominium Unit Lease Agreement')).toBeGreaterThan(
      text.indexOf('สัญญาเช่าห้องชุด'),
    );
  });

  it('lets the resident ask once; the owner sees it and issues it with the receipts of the period', async () => {
    const future = await t.http
      .post(`/v1/resident/leases/${leaseId}/rent-certificates`)
      .set(R())
      .send({ purpose: 'visa', periodTo: '2099-01-01' });
    expect(future.status).toBe(422);
    const asked = await t.http
      .post(`/v1/resident/leases/${leaseId}/rent-certificates`)
      .set(R())
      .send({ purpose: 'visa', language: 'en', note: 'For my visa extension' });
    if (asked.status !== 201) throw new Error(JSON.stringify(asked.body));
    requestId = asked.body.id as string;
    expect(asked.body).toMatchObject({
      state: 'requested',
      purpose: 'visa',
      language: 'en',
      requestedByResident: true,
    });
    const again = await t.http
      .post(`/v1/resident/leases/${leaseId}/rent-certificates`)
      .set(R())
      .send({ purpose: 'bank' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('rent_certificate.request_open');

    const waiting = await t.http.get('/v1/owner/rent-certificates?state=requested').set(as()).expect(200);
    expect(waiting.body).toHaveLength(1);
    expect(waiting.body[0]).toMatchObject({ id: requestId, unitNo: '12/345' });

    await receipt('15000.00', t.clock.now());
    const issued = await t.http
      .post(`/v1/owner/rent-certificates/${requestId}/actions/issue`)
      .set(as())
      .set(idem())
      .expect(200);
    expect(issued.body).toMatchObject({ state: 'issued', totalPaid: '15000.00' });
    expect(issued.body.number).toMatch(/^RPC-\d{4}-00001$/);
    expect(lastPdfText()).toContain('Certificate of rent payment');
    expect(lastPdfText()).toContain('Fifteen thousand baht only');
    expect(lastPdfText()).toContain('a visa application or extension');
    const twice = await t.http
      .post(`/v1/owner/rent-certificates/${requestId}/actions/issue`)
      .set(as())
      .set(idem());
    expect(twice.status).toBe(409);

    const mine = await t.http.get(`/v1/resident/leases/${leaseId}/rent-certificates`).set(R()).expect(200);
    expect(mine.body[0]).toMatchObject({ id: requestId, state: 'issued' });
    const link = await t.http
      .get(`/v1/resident/leases/${leaseId}/rent-certificates/${requestId}/document`)
      .set(R())
      .expect(200);
    expect(link.body.number).toBe(issued.body.number);
  });

  it('declines a new request with a reason', async () => {
    const asked = await t.http
      .post(`/v1/resident/leases/${leaseId}/rent-certificates`)
      .set(R())
      .send({ purpose: 'bank' })
      .expect(201);
    const declined = await t.http
      .post(`/v1/owner/rent-certificates/${asked.body.id}/actions/decline`)
      .set(as())
      .send({ reason: 'ขอให้รอบิลเดือนนี้ก่อน' })
      .expect(200);
    expect(declined.body).toMatchObject({ state: 'declined', declineReason: 'ขอให้รอบิลเดือนนี้ก่อน' });
  });

  it('sums the receipts of the year per unit and makes the 40(5) summary PDF', async () => {
    const year = Number(today().slice(0, 4));
    await receipt('15000.00', t.clock.now());
    const res = await t.http.get(`/v1/owner/income-summaries?year=${year}`).set(as()).expect(200);
    expect(res.body).toMatchObject({
      year,
      deductionPercent: '30',
      totals: {
        rent: '30000.00',
        charges: '0.00',
        retained: '0.00',
        gross: '30000.00',
        deduction: '9000.00',
        net: '21000.00',
      },
    });
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].months).toHaveLength(12);
    const made = await t.http
      .post('/v1/owner/income-summaries')
      .set(as())
      .set(idem())
      .send({ year, unitId })
      .expect(201);
    expect(made.body.number).toMatch(/^ISM-\d{4}-00001$/);
    expect(lastPdfText()).toContain('สรุปรายได้ค่าเช่ารายปี');
    expect(lastPdfText()).toContain('ไม่ใช่การยื่นภาษี');
    const docs = await t.http
      .get(`/v1/owner/documents?unitId=${unitId}&kind=pdf_summary`)
      .set(as())
      .expect(200);
    expect(docs.body.data).toHaveLength(1);
    const later = await t.http.get(`/v1/owner/income-summaries?year=${year + 1}`).set(as());
    expect(later.status).toBe(422);
  });
});
