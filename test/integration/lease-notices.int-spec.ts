import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { PDF_RENDERER } from '@integrations/pdf/pdf-renderer.port';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

/** B7.5 part 2 acceptance — written notices: numbered letters as PDFs, the D-020 / D-024 rules, the lease kept in step. */
describe('lease notices (B7.5, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let unitId: string;
  let lessee: string;
  let leaseId: string;
  let endDate: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const issue = (body: Record<string, unknown>) =>
    t.http.post(`/v1/owner/leases/${leaseId}/notices`).set(as()).set(idem()).send(body);
  const lastPdfText = () => t.app.get<FakePdfRenderer>(PDF_RENDERER).rendered.at(-1)!.text;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_lease_notices' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009601';
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
          displayName: 'สมศรี ใจดี',
          phone: '+66810009602',
          nationality: 'TH',
          idDocumentType: 'thai_national_id',
          idNumber: '1100700000001',
        })
        .expect(201)
    ).body.id as string;
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const draft = await t.http.post('/v1/owner/leases').set(as()).send({
      unitId,
      lesseePartyId: lessee,
      startDate: today,
      months: 12,
      rent: '15000',
      depositAmount: '30000',
    });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    leaseId = draft.body.id as string;
    endDate = draft.body.endDate as string;
    await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    // The B2 signing flow is covered by leases.int-spec; here the lease is put in force directly.
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [leaseId],
    );
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('offers a renewal: numbered letter, PDF with the unit, LINE event for the resident', async () => {
    const res = await issue({ kind: 'renewal_offer', newRent: '15500', renewalMonths: 12 });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    expect(res.body).toMatchObject({
      kind: 'renewal_offer',
      newRent: '15500.00',
      renewalMonths: 12,
      language: 'th',
    });
    expect(res.body.number).toMatch(/^NTC-\d{4}-00001$/);
    expect(res.body.respondBy <= endDate).toBe(true);
    expect(lastPdfText()).toContain('หนังสือเสนอต่อสัญญาเช่า');
    expect(lastPdfText()).toContain('หนึ่งหมื่นห้าพันห้าร้อยบาทถ้วน');
    const docs = await t.http
      .get(`/v1/owner/documents?unitId=${unitId}&kind=pdf_notice`)
      .set(as())
      .expect(200);
    expect(docs.body.data).toHaveLength(1);
    const link = await t.http.get(`/v1/owner/lease-notices/${res.body.id}/document`).set(as()).expect(200);
    expect(link.body.number).toBe(res.body.number);
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'lease.notice_issued' AND aggregate_id = $1`,
      [leaseId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a mid-term rent increase and a too-short notice; accepts one from the next term', async () => {
    const midterm = await issue({ kind: 'rent_increase', newRent: '16000', effectiveDate: endDate });
    expect(midterm.status).toBe(422);
    expect(midterm.body.errors[0]).toMatchObject({ path: 'effectiveDate', code: 'midterm' });
    const next = new Date(Date.parse(`${endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const ok = await issue({ kind: 'rent_increase', newRent: '16000', effectiveDate: next, language: 'en' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ language: 'en', newRent: '16000.00' });
    expect(lastPdfText()).toContain('Notice of rent change');
    expect(lastPdfText()).toContain('Sixteen thousand baht only');
  });

  it('lists the overdue invoices in a late-payment letter, and refuses one with nothing overdue', async () => {
    const none = await issue({ kind: 'late_payment' });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('lease.notice_nothing_overdue');
    const { rows } = await db.admin.query<{ building_id: string }>(
      'SELECT building_id FROM ops.lease WHERE id = $1',
      [leaseId],
    );
    await db.admin.query(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                number, status, issued_at, due_date, snapshot, subtotal, total, balance)
       VALUES ($1, $2, $3, $4, $5, '2026-09-01', '2026-09-30', 'INV-2026-00077', 'overdue', now() - interval '40 days',
               '2026-09-05', '{}'::jsonb, 15000, 15000, 15000)`,
      [owner.tenantId, rows[0]!.building_id, unitId, lessee, leaseId],
    );
    const res = await issue({ kind: 'late_payment', message: 'หากติดขัดโทรคุยกันได้ค่ะ' });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    expect(res.body).toMatchObject({
      kind: 'late_payment',
      amountDue: '15000.00',
      items: [{ number: 'INV-2026-00077', dueDate: '2026-09-05', balance: '15000.00' }],
    });
    expect(lastPdfText()).toContain('ไม่ใช่การบอกเลิกสัญญา');
    expect(lastPdfText()).toContain('หากติดขัดโทรคุยกันได้ค่ะ');
  });

  it('sends a non-renewal letter that also records the notice on the lease; termination then waits', async () => {
    const res = await issue({ kind: 'non_renewal' });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    expect(res.body).toMatchObject({ kind: 'non_renewal', effectiveDate: endDate });
    const lease = await t.http.get(`/v1/owner/leases/${leaseId}`).set(as()).expect(200);
    expect(lease.body.status).toBe('notice_given');
    expect(lease.body.notice).toMatchObject({
      by: 'lessor',
      reasonCode: 'end_of_term',
      effectiveDate: endDate,
    });
    const after = await issue({ kind: 'termination', reasonCode: 'lessee_breach', effectiveDate: endDate });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('lease.invalid_state');
    const list = await t.http.get(`/v1/owner/leases/${leaseId}/notices`).set(as()).expect(200);
    expect((list.body as { kind: string }[]).map((n) => n.kind)).toEqual(
      expect.arrayContaining(['non_renewal', 'late_payment', 'rent_increase', 'renewal_offer']),
    );
    expect(list.body).toHaveLength(4);
  });
});
