import 'reflect-metadata';

import { TenantTx } from '@database/tenant-tx';
import { DealsService } from '@modules/ops-listings/deals.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

interface Signed {
  tenantId: string;
  token: string;
}

/**
 * G2 acceptance (docs/prompts/G-growth-api.md G2, D-284, D-287, D-293; real PostgreSQL, asset-core 0.7.0): agency
 * sign-up; owner → agency mandate with its unit grant (landlord unit in a condo stub = the unit-holder grant path);
 * the agency sees only the mandated unit; an exclusive mandate refuses others; revoking cuts access at once and closes
 * the agency's listings; co-broke propose / sign; a deal closes once (lease activated + e-signed + first payment)
 * with fee accruals only when a price is published; cross-tenant 404; the core.document legal-hold guard.
 */
describe('G2 agency mandates, co-broke, deals (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string; // DEV apartment owner
  let landlord: Signed;
  let agency: Signed;
  let agency2: Signed;
  let stranger: Signed;
  let condoUnit: string;
  let unitA101: string;
  let landlordMandate: string;
  let a101Mandate: string;
  let a101Listing: string;
  let agreement: string;
  let dealId: string;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const O = () => ({ ...bearer(owner), 'X-Tenant-Id': DEV.tenantId });
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  /** Units the tenant sees under RLS as the application role. */
  const visibleUnits = async (tenantId: string): Promise<string[]> => {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE gp_app');
      await db.admin.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return (await db.admin.query<{ id: string }>('SELECT id FROM core.unit')).rows.map((r) => r.id);
    } finally {
      await db.admin.query('ROLLBACK');
    }
  };

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
    expect(res.body.tenant.type).toBe(kind);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g2' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    unitA101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('agencies sign up themselves: a free agency tenant with an agency menu (D-284)', async () => {
    agency = await signup('agency', '+660000000901', 'บ้านดี พร็อพเพอร์ตี้');
    agency2 = await signup('agency', '+660000000902', 'นายหน้าร่วม จำกัด');
    landlord = await signup('landlord', '+660000000903', 'สมชาย ใจดี');
    stranger = await signup('landlord', '+660000000904', 'มาลี ทดสอบ');
    const me = await t.http.get('/v1/owner/me').set(as(agency)).expect(200);
    expect(me.body.currentTenant).toMatchObject({ id: agency.tenantId, type: 'agency', role: 'owner' });
    expect(me.body.menu).toEqual(
      expect.arrayContaining(['listings', 'mandated_units', 'mandates', 'co_broke', 'deals']),
    );
    expect(me.body.menu).not.toContain('buildings');
    const found = await t.http.get('/v1/owner/agencies?q=บ้านดี').set(as(landlord)).expect(200);
    expect(found.body.data).toEqual([expect.objectContaining({ id: agency.tenantId })]);
  });

  it('a landlord mandates an agency for its condo unit; accepting writes the unit grant (D-293)', async () => {
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(landlord))
      .send({
        address: ADDRESS,
        kind: 'condo_unit',
        projectName: 'คอนโด จีทู ทดสอบ',
        unitNo: '9/901',
        bedrooms: 1,
        bathrooms: 1,
        areaSqm: '30.00',
        defaultRent: '15000.00',
      })
      .expect(201);
    expect(unit.body.stub).toBe(true);
    condoUnit = unit.body.unitId as string;
    expect(await visibleUnits(agency.tenantId)).toEqual([]);

    // only agencies can be mandated
    await t.http
      .post('/v1/owner/mandates')
      .set(as(landlord))
      .set(idem())
      .send({ agencyTenantId: stranger.tenantId, unitId: condoUnit })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('mandate.agency_required'));
    // a unit the tenant does not hold is a 404
    await t.http
      .post('/v1/owner/mandates')
      .set(as(stranger))
      .set(idem())
      .send({ agencyTenantId: agency.tenantId, unitId: condoUnit })
      .expect(404);

    const invited = await t.http
      .post('/v1/owner/mandates')
      .set(as(landlord))
      .set(idem())
      .send({
        agencyTenantId: agency.tenantId,
        unitId: condoUnit,
        scope: 'list_and_lease',
        commissionTerms: 'ค่านายหน้า 1 เดือน',
        commissionPercent: '100',
      })
      .expect(201);
    landlordMandate = invited.body.id as string;
    expect(invited.body).toMatchObject({
      state: 'invited',
      agencyName: 'บ้านดี พร็อพเพอร์ตี้',
      unitNo: '9/901',
    });
    // invited is not access yet
    await t.http
      .post('/v1/owner/listings')
      .set(as(agency))
      .send({ unitId: condoUnit, titleTh: 'คอนโด', rent: '15000.00' })
      .expect(404);

    const seen = await t.http.get('/v1/owner/mandates?role=agency').set(as(agency)).expect(200);
    expect((seen.body.data as { id: string }[]).map((m) => m.id)).toEqual([landlordMandate]);
    // only the agency accepts
    await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/accept`)
      .set(as(landlord))
      .set(idem())
      .expect(404);
    const accepted = await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/accept`)
      .set(as(agency))
      .set(idem())
      .expect(200);
    expect(accepted.body).toMatchObject({ state: 'active' });
    const grants = await q<{
      tenant_id: string;
      reason: string;
      modules: string[];
      scope: string;
      revoked_at: Date | null;
    }>(
      `SELECT g.tenant_id, g.reason::text AS reason, g.modules, g.scope::text AS scope, g.revoked_at
         FROM ops.listing_mandate m JOIN core.asset_access_grant g ON g.id = m.grant_id WHERE m.id = $1`,
      [landlordMandate],
    );
    expect(grants[0]).toEqual({
      tenant_id: landlord.tenantId,
      reason: 'listing_mandate',
      modules: ['ops.listing', 'ops.lease'],
      scope: 'unit',
      revoked_at: null,
    });
    // the agency sees exactly the mandated unit — and still not the stub building of other landlords
    expect(await visibleUnits(agency.tenantId)).toEqual([condoUnit]);
    expect(await visibleUnits(agency2.tenantId)).toEqual([]);
    const units = await t.http.get('/v1/owner/mandated-units').set(as(agency)).expect(200);
    expect(units.body.data).toEqual([
      expect.objectContaining({ unitId: condoUnit, unitNo: '9/901', district: 'พญาไท', listing: null }),
    ]);
  });

  it('the agency drafts a listing of the mandated unit (it owns the listing row)', async () => {
    const draft = await t.http
      .post('/v1/owner/listings')
      .set(as(agency))
      .send({ unitId: condoUnit, titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS', rent: '15000.00' })
      .expect(201);
    expect(draft.body).toMatchObject({
      mandateId: landlordMandate,
      unitId: condoUnit,
      bedrooms: 1,
      district: 'พญาไท',
    });
    const row = await q<{ tenant_id: string }>(`SELECT tenant_id FROM ops.listing WHERE id = $1`, [
      draft.body.id,
    ]);
    expect(row[0]!.tenant_id).toBe(agency.tenantId);
  });

  it('cross-tenant: other tenants get 404 for the mandate and see nothing', async () => {
    await t.http.get(`/v1/owner/mandates/${landlordMandate}`).set(as(stranger)).expect(404);
    await t.http.get(`/v1/owner/mandates/${landlordMandate}`).set(as(agency2)).expect(404);
    await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/end`)
      .set(as(agency2))
      .set(idem())
      .send({})
      .expect(404);
    expect((await t.http.get('/v1/owner/mandates').set(as(stranger)).expect(200)).body.data).toEqual([]);
  });

  it('revoking cuts access at once: grant revoked, agency listing closed, unit invisible', async () => {
    // the agency may not revoke (only end)
    await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/revoke`)
      .set(as(agency))
      .set(idem())
      .send({})
      .expect(409);
    const revoked = await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/revoke`)
      .set(as(landlord))
      .set(idem())
      .send({ reason: 'ขายห้องแล้ว' })
      .expect(200);
    expect(revoked.body).toMatchObject({ state: 'revoked', endReason: 'ขายห้องแล้ว' });
    expect(await visibleUnits(agency.tenantId)).toEqual([]);
    const listings = await q<{ state: string; closed_reason: string }>(
      `SELECT state::text AS state, closed_reason::text AS closed_reason FROM ops.listing WHERE mandate_id = $1`,
      [landlordMandate],
    );
    expect(listings).toEqual([{ state: 'closed', closed_reason: 'withdrawn' }]);
    const g = await q<{ revoked_at: Date | null }>(
      `SELECT g.revoked_at FROM ops.listing_mandate m JOIN core.asset_access_grant g ON g.id = m.grant_id WHERE m.id = $1`,
      [landlordMandate],
    );
    expect(g[0]!.revoked_at).not.toBeNull();
    await t.http
      .post('/v1/owner/listings')
      .set(as(agency))
      .send({ unitId: condoUnit, titleTh: 'x', rent: '1.00' })
      .expect(404);
    expect((await t.http.get('/v1/owner/mandated-units').set(as(agency)).expect(200)).body.data).toEqual([]);
    await t.http
      .post(`/v1/owner/mandates/${landlordMandate}/actions/revoke`)
      .set(as(landlord))
      .set(idem())
      .send({})
      .expect(409);
  });

  it('an exclusive mandate refuses any other agency on the unit (and vice versa)', async () => {
    const ex = await t.http
      .post('/v1/owner/mandates')
      .set(O())
      .set(idem())
      .send({ agencyTenantId: agency.tenantId, unitId: unitA101, exclusive: true, commissionPercent: '100' })
      .expect(201);
    a101Mandate = ex.body.id as string;
    await t.http
      .post(`/v1/owner/mandates/${a101Mandate}/actions/accept`)
      .set(as(agency))
      .set(idem())
      .expect(200);
    await t.http
      .post('/v1/owner/mandates')
      .set(O())
      .set(idem())
      .send({ agencyTenantId: agency2.tenantId, unitId: unitA101 })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('mandate.exclusive_conflict'));
    // a non-exclusive mandate held by one agency blocks a later exclusive one for another
    const a102 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    const open = await t.http
      .post('/v1/owner/mandates')
      .set(O())
      .set(idem())
      .send({ agencyTenantId: agency2.tenantId, unitId: a102 })
      .expect(201);
    await t.http
      .post(`/v1/owner/mandates/${open.body.id}/actions/accept`)
      .set(as(agency2))
      .set(idem())
      .expect(200);
    await t.http
      .post('/v1/owner/mandates')
      .set(O())
      .set(idem())
      .send({ agencyTenantId: agency.tenantId, unitId: a102, exclusive: true })
      .expect(409);
    const n = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM ops.listing_mandate WHERE unit_id = $1 AND exclusive AND state IN ('accepted','active')`,
      [unitA101],
    );
    expect(n[0]!.n).toBe('1');
  });

  it('co-broke: the listing agency proposes, only the co-agency signs', async () => {
    const draft = await t.http
      .post('/v1/owner/listings')
      .set(as(agency))
      .send({ unitId: unitA101, titleTh: 'ห้อง A-101 ใกล้ตลาด', rent: '5000.00' })
      .expect(201);
    a101Listing = draft.body.id as string;
    // published by the moderation path elsewhere; here the state is set directly to keep the test on G2
    await q(`UPDATE ops.listing SET state = 'published', published_at = now() WHERE id = $1`, [a101Listing]);
    const proposed = await t.http
      .post('/v1/owner/co-broke-agreements')
      .set(as(agency))
      .set(idem())
      .send({ listingId: a101Listing, coAgencyTenantId: agency2.tenantId, splitPercent: '40' })
      .expect(201);
    agreement = proposed.body.id as string;
    expect(proposed.body).toMatchObject({
      state: 'proposed',
      splitPercent: '40.0000',
      coAgencyName: 'นายหน้าร่วม จำกัด',
    });
    await t.http
      .post(`/v1/owner/co-broke-agreements/${agreement}/actions/sign`)
      .set(as(agency))
      .set(idem())
      .expect(409);
    await t.http.get(`/v1/owner/co-broke-agreements/${agreement}`).set(as(stranger)).expect(404);
    const signed = await t.http
      .post(`/v1/owner/co-broke-agreements/${agreement}/actions/sign`)
      .set(as(agency2))
      .set(idem())
      .expect(200);
    expect(signed.body.state).toBe('signed');
    // only agencies co-broke
    await t.http
      .post('/v1/owner/co-broke-agreements')
      .set(as(agency))
      .set(idem())
      .send({ listingId: a101Listing, coAgencyTenantId: stranger.tenantId, splitPercent: '10' })
      .expect(422);
  });

  it('a deal closes once (activated + e-signed + first payment) and fees accrue only with a price', async () => {
    const deals = t.app.get(DealsService);
    const tx = t.app.get(TenantTx);
    // the success fee gets a published price (10 % of the commission); the co-broke fee stays unpriced
    await q(
      `INSERT INTO platform.price_plan_version (plan_id, version, effective_from, billing_unit, unit_price, terms, state, published_at)
       SELECT id, 2, '2026-01-01', 'percent_of_amount', 10, '{"basis": "commission"}', 'published', now()
         FROM platform.price_plan WHERE key = 'success_fee'`,
    );
    // the seeded lease on A-101 was signed on paper: no deal
    expect(await tx.platform((p) => deals.tryClose(p, DEV.leaseId))).toBeNull();
    const [doc] = await q<{ id: string }>(
      `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
       VALUES ($1, 'tenant', 'signature', 'b', 'g2/sig.png', 'image/png', 10, decode(repeat('cd', 32), 'hex'), 'legal', 'verified')
       RETURNING id`,
      [DEV.tenantId],
    );
    await q(
      `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
       VALUES ($1, $2, 'lessee', $3, 'draw_web', $4, decode(repeat('ef', 32), 'hex'), now())`,
      [DEV.tenantId, DEV.leaseId, DEV.residentPartyId, doc!.id],
    );
    // e-signed, but the first payment is not confirmed yet
    const paid = await q(
      `SELECT 1 FROM ops.payment p JOIN ops.payment_allocation a ON a.payment_id = p.id JOIN ops.invoice i ON i.id = a.invoice_id
        WHERE i.lease_id = $1 AND p.status = 'confirmed'`,
      [DEV.leaseId],
    );
    if (!paid.length) expect(await tx.platform((p) => deals.tryClose(p, DEV.leaseId))).toBeNull();

    // an invoice of the lease paid in cash: payment.confirmed closes the deal in the worker
    const [inv] = await q<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end, subtotal, vat_amount, total, balance)
       VALUES ($1, $2, $3, $4, $5, '2025-06-01', '2025-06-30', 5000, 0, 5000, 5000) RETURNING id`,
      [DEV.tenantId, DEV.buildingId, unitA101, DEV.residentPartyId, DEV.leaseId],
    );
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
       VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', 5000, 5000)`,
      [DEV.tenantId, inv!.id],
    );
    await t.http
      .post(`/v1/owner/invoices/${inv!.id}/actions/issue`)
      .set(O())
      .set(idem())
      .send({})
      .expect(200);
    await settle();
    const pay = await t.http.post('/v1/owner/payments').set(O()).set(idem()).send({
      invoiceId: inv!.id,
      amount: '5000.00',
      method: 'cash',
      paidAt: t.clock.now().toISOString(),
      reference: 'เงินสด',
    });
    expect([200, 201]).toContain(pay.status);
    await settle(6);

    const rows = await q<{
      id: string;
      listing_id: string;
      mandate_id: string;
      co_agency_tenant_id: string;
      monthly_rent: string;
      commission_amount: string;
      co_broke_amount: string;
    }>(
      `SELECT id, listing_id, mandate_id, co_agency_tenant_id, monthly_rent::text, commission_amount::text, co_broke_amount::text
         FROM ops.deal WHERE lease_id = $1`,
      [DEV.leaseId],
    );
    expect(rows).toHaveLength(1);
    dealId = rows[0]!.id;
    const rent = rows[0]!.monthly_rent;
    expect(rows[0]).toMatchObject({
      listing_id: a101Listing,
      mandate_id: a101Mandate,
      co_agency_tenant_id: agency2.tenantId,
      commission_amount: rent, // 100 % of one month
      co_broke_amount: (Number(rent) * 0.4).toFixed(2),
    });
    // replays change nothing: one deal, one accrual
    expect(await tx.platform((p) => deals.tryClose(p, DEV.leaseId))).toBeNull();
    await tx.platform((p) =>
      deals.handle(
        {
          id: '0199f2a0-0000-7000-8000-00000000fff1',
          type: 'payment.confirmed',
          aggregateType: 'payment',
          aggregateId: pay.body.id as string,
          tenantId: DEV.tenantId,
          buildingId: DEV.buildingId,
          payload: { paymentId: pay.body.id as string },
          occurredAt: new Date().toISOString(),
        } as never,
        p,
      ),
    );
    const accruals = await q<{ tenant_id: string; kind: string; amount: string }>(
      `SELECT tenant_id, kind::text AS kind, amount::text FROM ops.fee_accrual WHERE deal_id = $1`,
      [dealId],
    );
    expect(accruals).toEqual([
      { tenant_id: agency.tenantId, kind: 'success_fee', amount: (Number(rent) * 0.1).toFixed(2) },
    ]);
    expect((await q(`SELECT 1 FROM ops.deal WHERE lease_id = $1`, [DEV.leaseId])).length).toBe(1);
  });

  it('owner, listing agency and co-agency read the deal; each sees only its own fees; others 404', async () => {
    const mine = await t.http.get(`/v1/owner/deals/${dealId}`).set(as(agency)).expect(200);
    expect(mine.body).toMatchObject({
      listingAgencyName: 'บ้านดี พร็อพเพอร์ตี้',
      coAgencyName: 'นายหน้าร่วม จำกัด',
    });
    expect(mine.body.accruals).toEqual([expect.objectContaining({ kind: 'success_fee', invoiced: false })]);
    const co = await t.http.get(`/v1/owner/deals/${dealId}`).set(as(agency2)).expect(200);
    expect(co.body.accruals).toEqual([]);
    const own = await t.http.get('/v1/owner/deals').set(O()).expect(200);
    expect((own.body.data as { id: string }[]).map((d) => d.id)).toContain(dealId);
    expect(own.body.data[0].accruals).toEqual([]);
    await t.http.get(`/v1/owner/deals/${dealId}`).set(as(stranger)).expect(404);
    expect((await t.http.get('/v1/owner/deals').set(as(stranger)).expect(200)).body.data).toEqual([]);
  });

  it('the database refuses deleting a document under a legal hold (asset-core 0.7.0 guard)', async () => {
    const held = await q<{ document_id: string; legal_hold: boolean }>(
      `SELECT h.document_id, d.legal_hold FROM platform.document_legal_hold h JOIN core.document d ON d.id = h.document_id
        WHERE h.released_at IS NULL LIMIT 1`,
    );
    expect(held[0]?.legal_hold).toBe(true);
    await expect(
      q(`UPDATE core.document SET deleted_at = now() WHERE id = $1`, [held[0]!.document_id]),
    ).rejects.toThrow(/core\.legal_hold/);
    await expect(q(`DELETE FROM core.document WHERE id = $1`, [held[0]!.document_id])).rejects.toThrow(
      /legal_hold/,
    );
  });
});
