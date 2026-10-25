import { fakeLineIdToken } from '@collective/integrations/line';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนสุขุมวิท', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postcode: '10110' };
const LINE_SUB = 'U000000000000000000000000000b7601';

/**
 * B7 deliverable 7.8 acceptance (D-263): a landlord's tenant reports a repair in LINE → the owner decides who fixes
 * and who pays → receipts attached → the tenant's share billed on the next invoice (and a credit when the tenant paid
 * more than their share) → the owner's share in the annual income summary.
 */
describe('landlord service requests: who fixes, who pays (D-263, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let unitId: string;
  let lessee: string;
  let resident: string;
  let requestId: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_service_costs' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009901';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'สมศรี เช่าดี',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    unitId = (
      await t.http
        .post('/v1/owner/portfolio/units')
        .set(as())
        .send({
          kind: 'house',
          projectName: 'หมู่บ้านตัวอย่าง',
          unitNo: '99/1',
          address: ADDRESS,
          bedrooms: 3,
          bathrooms: 2,
        })
        .expect(201)
    ).body.unitId as string;
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'Ben Example',
          phone: '+66810009902',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X1234567',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as())
      .send({ unitId, lesseePartyId: lessee, startDate: today(), months: 12, rent: '25000' })
      .expect(201);
    await t.http
      .post(`/v1/owner/leases/${draft.body.id}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [draft.body.id],
    );
    // What activation does (the signature flow is another spec): the lessee occupies the unit from the start date.
    await db.admin.query(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from, lease_id)
       SELECT tenant_id, building_id, unit_id, $2, 'tenant', start_date, id FROM ops.lease WHERE id = $1`,
      [draft.body.id, lessee],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'Ben' }) })
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

  it('opens a repair from LINE; the owner decides who fixes and who pays (kept as history)', async () => {
    const { rows } = await db.admin.query<{ id: string }>(
      `SELECT id FROM ops.service_category WHERE tenant_id IS NULL AND key = 'plumbing'`,
    );
    const created = await t.http
      .post('/v1/resident/service-requests')
      .set(bearer(resident))
      .set(idem())
      .send({ unitId, categoryId: rows[0]!.id, description: 'ท่อน้ำใต้ซิงก์แตก' });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    requestId = created.body.id as string;
    expect(created.body.decision).toBeNull();

    const empty = await t.http.get(`/v1/owner/service-requests/${requestId}/costs`).set(as()).expect(200);
    expect(empty.body).toMatchObject({ decision: null, costs: [], nextActions: ['decide', 'add-cost'] });

    const bad = await t.http
      .post(`/v1/owner/service-requests/${requestId}/actions/decide`)
      .set(as())
      .send({ handledBy: 'owner_technician', costBearer: 'shared' });
    expect(bad.status).toBe(422);
    await t.http
      .post(`/v1/owner/service-requests/${requestId}/actions/decide`)
      .set(as())
      .send({ handledBy: 'tenant', costBearer: 'owner' })
      .expect(200);
    const decided = await t.http
      .post(`/v1/owner/service-requests/${requestId}/actions/decide`)
      .set(as())
      .send({
        handledBy: 'owner_technician',
        costBearer: 'shared',
        tenantSharePercent: '50',
        note: 'ผู้เช่าทำท่อแตก',
      })
      .expect(200);
    expect(decided.body.decision).toMatchObject({
      handledBy: 'owner_technician',
      costBearer: 'shared',
      tenantSharePercent: '50.00',
    });
    expect(decided.body.decisions).toHaveLength(2);

    const mine = await t.http
      .get(`/v1/resident/service-requests/${requestId}`)
      .set(bearer(resident))
      .expect(200);
    expect(mine.body.decision).toMatchObject({ costBearer: 'shared', tenantSharePercent: '50.00' });
  });

  it('bills the tenant’s share of a receipt the owner paid, then credits what the tenant paid over their share', async () => {
    const url = `/v1/owner/service-requests/${requestId}`;
    await t.http
      .post(`${url}/costs`)
      .set(as())
      .send({ kind: 'quotation', description: 'ใบเสนอราคาเปลี่ยนท่อ', amount: '2500.00', issuedOn: today() })
      .expect(201);
    const noPayer = await t.http
      .post(`${url}/costs`)
      .set(as())
      .send({ kind: 'receipt', description: 'ค่าช่าง', amount: '1800.00', issuedOn: today() });
    expect(noPayer.status).toBe(422);
    const receipt = await t.http
      .post(`${url}/costs`)
      .set(as())
      .send({
        kind: 'receipt',
        description: 'ค่าช่างเปลี่ยนท่อ',
        amount: '1800.00',
        paidBy: 'owner',
        vendorName: 'ช่างสมศักดิ์',
        issuedOn: today(),
      })
      .expect(201);
    expect(receipt.body.settlement).toMatchObject({
      receiptsTotal: '1800.00',
      tenantShare: '900.00',
      ownerShare: '900.00',
      due: '900.00',
    });
    expect(receipt.body.nextActions).toContain('settle');

    const settled = await t.http.post(`${url}/actions/settle`).set(as()).set(idem()).expect(200);
    expect(settled.body.settlement).toMatchObject({ settled: '900.00', due: '0.00' });
    const chargeId = settled.body.settlements[0].invoiceChargeId as string;
    const { rows: charges } = await db.admin.query<{
      amount: string;
      line_kind: string;
      status: string;
      party_id: string;
    }>(`SELECT amount::text, line_kind::text, status::text, party_id FROM ops.invoice_charge WHERE id = $1`, [
      chargeId,
    ]);
    expect(charges[0]).toEqual({
      amount: '900.00',
      line_kind: 'service_charge_work',
      status: 'pending',
      party_id: lessee,
    });
    const again = await t.http.post(`${url}/actions/settle`).set(as()).set(idem());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('service_request.nothing_to_settle');

    // The tenant bought a part themselves: 600 paid by them, their share of it is 300 → the owner owes 300.
    await t.http
      .post(`${url}/costs`)
      .set(as())
      .send({
        kind: 'receipt',
        description: 'อะไหล่ที่ผู้เช่าซื้อเอง',
        amount: '600.00',
        paidBy: 'tenant',
        issuedOn: today(),
      })
      .expect(201);
    const credit = await t.http.post(`${url}/actions/settle`).set(as()).set(idem()).expect(200);
    const settlements = credit.body.settlements as { amount: string; invoiceChargeId: string }[];
    expect(settlements.map((s) => s.amount)).toEqual(['900.00', '-300.00']);
    const { rows: credits } = await db.admin.query<{ line_kind: string }>(
      `SELECT line_kind::text FROM ops.invoice_charge WHERE id = $1`,
      [settlements[1]!.invoiceChargeId],
    );
    expect(credits[0]!.line_kind).toBe('discount');
  });

  it('voids a wrong quotation once', async () => {
    const url = `/v1/owner/service-requests/${requestId}`;
    const costs = await t.http.get(`${url}/costs`).set(as()).expect(200);
    type Cost = { id: string; kind: string; voidReason: string | null };
    const quotation = (costs.body.costs as Cost[]).find((c) => c.kind === 'quotation')!;
    const voided = await t.http
      .post(`${url}/costs/${quotation.id}/actions/void`)
      .set(as())
      .send({ reason: 'ราคาเก่า' })
      .expect(200);
    expect((voided.body.costs as Cost[]).find((c) => c.id === quotation.id)!.voidReason).toBe('ราคาเก่า');
    const twice = await t.http
      .post(`${url}/costs/${quotation.id}/actions/void`)
      .set(as())
      .send({ reason: 'ซ้ำ' });
    expect(twice.body.code).toBe('service_cost.voided');
  });

  it('counts the owner’s share as the repair expense of the year', async () => {
    const year = Number(today().slice(0, 4));
    const res = await t.http.get(`/v1/owner/income-summaries?year=${year}`).set(as()).expect(200);
    expect(res.body.totals).toMatchObject({ expenses: '1200.00' });
    expect(res.body.units[0].expenseItems).toEqual([
      { categoryKey: 'plumbing', nameTh: expect.any(String), nameEn: 'Plumbing', amount: '1200.00' },
    ]);
  });

  it('keeps apartments on the technician queue', async () => {
    await db.admin.query(`UPDATE core.tenant SET type = 'apartment' WHERE id = $1`, [owner.tenantId]);
    const refused = await t.http.get(`/v1/owner/service-requests/${requestId}/costs`).set(as());
    await db.admin.query(`UPDATE core.tenant SET type = 'landlord' WHERE id = $1`, [owner.tenantId]);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('service_request.decision_unavailable');
  });
});
