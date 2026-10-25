import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

/** B7.5 part 1 acceptance — landlord lease templates per kind and language, stamp duty, the unit document list. */
describe('landlord documents: templates, stamp duty, document list (B7.5, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let condo: string;
  let house: string;
  let lessee: string;
  let enLease: string;
  let thLease: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });

  const pdfOf = async (path: string) => {
    const res = await t.http
      .get(path)
      .set(as())
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return FakePdfRenderer.textOf(res.body as Buffer);
  };

  const addUnit = async (body: Record<string, unknown>) =>
    (await t.http.post('/v1/owner/portfolio/units').set(as()).send(body).expect(201)).body.unitId as string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_landlord_docs' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', E_STAMP_MODE: 'fake' });
    t.clock.advance(61_000);
    const phone = '+66810009501';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'มาลี มีสุข',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    condo = await addUnit({
      kind: 'condo_unit',
      projectName: 'ไอดีโอ โมบิ อารีย์',
      unitNo: '12/345',
      address: ADDRESS,
      areaSqm: '28.50',
      bedrooms: 1,
      bathrooms: 1,
    });
    house = await addUnit({ kind: 'house', unitNo: '88/8', address: ADDRESS, bedrooms: 3, bathrooms: 2 });
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'Alex Example',
          phone: '+66810009502',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X1234567',
        })
        .expect(201)
    ).body.id as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('writes a landlord lease on the template of the unit kind, in English on request', async () => {
    const res = await t.http.post('/v1/owner/leases').set(as()).send({
      unitId: condo,
      lesseePartyId: lessee,
      startDate: '2026-11-01',
      months: 12,
      rent: '15000',
      depositAmount: '30000',
      advanceRentAmount: '15000',
      language: 'en',
      stampDutyPayer: 'shared',
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    enLease = res.body.id as string;
    expect(res.body).toMatchObject({
      template: { key: 'landlord_condo_unit', version: 1, language: 'en' },
      stampDutyPayer: 'shared',
    });
    const text = await pdfOf(`/v1/owner/leases/${enLease}/contract-preview`);
    expect(text).toContain('Condominium Unit Lease Agreement');
    expect(text).toContain('Fifteen thousand baht only');
    expect(text).toContain('One hundred eighty baht only');
    expect(text).toContain('in equal shares');
    expect(text).toContain('1 November 2026');

    const th = await t.http
      .post('/v1/owner/leases')
      .set(as())
      .send({ unitId: house, lesseePartyId: lessee, startDate: '2026-11-01', months: 6, rent: '9000' })
      .expect(201);
    thLease = th.body.id as string;
    expect(th.body.template).toEqual({ key: 'landlord_house', version: 1, language: 'th' });
    expect(await pdfOf(`/v1/owner/leases/${thLease}/contract-preview`)).toContain('สัญญาเช่าบ้าน');

    const templates = await t.http.get('/v1/owner/lease-templates').set(as()).expect(200);
    expect((templates.body as { key: string }[]).map((x) => x.key).sort()).toEqual([
      'landlord_condo_unit',
      'landlord_house',
      'landlord_room',
    ]);
  });

  it('switches the language of a draft', async () => {
    const current = await t.http.get(`/v1/owner/leases/${thLease}`).set(as()).expect(200);
    const res = await t.http
      .patch(`/v1/owner/leases/${thLease}`)
      .set(as())
      .set('If-Match', current.headers.etag as string)
      .send({ language: 'en' })
      .expect(200);
    expect(res.body.template.language).toBe('en');
    expect(await pdfOf(`/v1/owner/leases/${thLease}/contract-preview`)).toContain('House Lease Agreement');
  });

  it('estimates the stamp duty on a draft and fixes it at send-for-signature', async () => {
    const draft = await t.http.get(`/v1/owner/leases/${enLease}/stamp-duty`).set(as()).expect(200);
    expect(draft.body).toMatchObject({
      amount: '180.00',
      fixed: false,
      payer: 'shared',
      dueDate: null,
      paid: null,
    });
    const early = await t.http.post(`/v1/owner/leases/${enLease}/stamp-duty`).set(as()).set(idem()).send({});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('lease.stamp_duty_not_fixed');

    await t.http
      .post(`/v1/owner/leases/${enLease}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    const sent = await t.http.get(`/v1/owner/leases/${enLease}/stamp-duty`).set(as()).expect(200);
    expect(sent.body).toMatchObject({ amount: '180.00', fixed: true, eStampAvailable: false });
    const online = await t.http
      .post(`/v1/owner/leases/${enLease}/stamp-duty/actions/pay-online`)
      .set(as())
      .set(idem());
    expect(online.status).toBe(409);
    expect(online.body.code).toBe('lease.e_stamp_unavailable');
  });

  it('pays through e-Stamp once the lease is signed and keeps the receipt with the unit documents', async () => {
    // The B2 signing flow is covered by leases.int-spec; here the lease is put in force directly.
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [enLease],
    );
    const ready = await t.http.get(`/v1/owner/leases/${enLease}/stamp-duty`).set(as()).expect(200);
    expect(ready.body.eStampAvailable).toBe(true);
    expect(ready.body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const paid = await t.http
      .post(`/v1/owner/leases/${enLease}/stamp-duty/actions/pay-online`)
      .set(as())
      .set(idem())
      .expect(200);
    expect(paid.body.paid).toMatchObject({ channel: 'e_stamp' });
    expect(paid.body.paid.reference).toMatch(/^ES-/);
    expect(paid.body.eStampAvailable).toBe(false);
    const again = await t.http.post(`/v1/owner/leases/${enLease}/stamp-duty`).set(as()).set(idem()).send({});
    expect(again.body.code).toBe('lease.stamp_duty_paid');

    const docs = await t.http.get(`/v1/owner/documents?unitId=${condo}`).set(as()).expect(200);
    const kinds = (docs.body.data as { kind: string; unitId: string }[]).map((d) => d.kind).sort();
    expect(kinds).toEqual(['contract', 'other']);
    expect((docs.body.data as { unitId: string }[]).every((d) => d.unitId === condo)).toBe(true);
    const contracts = await t.http.get('/v1/owner/documents?kind=contract').set(as()).expect(200);
    expect(contracts.body.data).toHaveLength(1);
    const audit = await db.admin.query(
      `SELECT metadata->>'channel' AS channel FROM platform.audit_log WHERE action = 'lease.stamp_duty_paid' AND subject_id = $1`,
      [enLease],
    );
    expect(audit.rows).toEqual([{ channel: 'e_stamp' }]);
  });

  it('records a stamp duty paid by hand, with the date and reference', async () => {
    await t.http
      .post(`/v1/owner/leases/${thLease}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    const res = await t.http
      .post(`/v1/owner/leases/${thLease}/stamp-duty`)
      .set(as())
      .set(idem())
      .send({ reference: 'อ.ส.4 0012345' })
      .expect(200);
    expect(res.body).toMatchObject({
      amount: '54.00',
      fixed: true,
      paid: { channel: 'manual', reference: 'อ.ส.4 0012345' },
    });
  });
});
