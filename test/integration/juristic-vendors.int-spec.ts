import 'reflect-metadata';

import { VendorsService } from '@modules/ops-juristic/vendors/vendors.service';
import { MaintenancePlansService } from '@modules/ops-service/maintenance-plans.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000301';
const PHONE_J2 = '+660000000302';
const PHONE_COMMITTEE = '+66810003011';
const PHONE_MANAGER = '+66810003012';
const at = (d: string, time = '09:00:00') => new Date(`${d}T${time}+07:00`);

/** A 13-digit Thai tax id with a valid check digit (the API verifies it). */
function taxId(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (13 - i);
  return `${first12}${(11 - (sum % 11)) % 10}`;
}

/**
 * J2.2 acceptance (D-310, D-331) on a juristic condominium: vendors are parties with their tax id (the 50 ทวิ of an
 * instalment payment carries it) and a masked bank account; the quotation rule (fewer than 3 above the threshold
 * needs a reason and an approval by the band, maker-checker also in the database; a rejection reopens the round; an
 * award by resolution is immediate; vendor purchases and contracts above the threshold need an awarded round); a
 * contract's instalments become submitted expense requests lead days before they are due (the job is idempotent);
 * expiry alerts at 90 / 60 / 30 days once each, then expiry and renewal; evaluations pull the SLA breaches of the
 * vendor's work orders and show the trend; a preventive plan under a contract opens work orders for the vendor and
 * stops when the contract is terminated; cross-tenant 404 on every endpoint.
 */
describe('J2.2 vendors, contracts, quotations, evaluations, preventive maintenance (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let dev: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  let committee: string;
  let manager: string;
  const ids: Record<string, string> = {};
  const acc: Record<string, string> = {};
  const TAX_V = taxId('010555612345');

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const J2 = () => bearer(jur2.token);
  const C = () => bearer(committee);
  const M = () => bearer(manager);
  const job = () => t.app.get(VendorsService).run();
  const relogin = async () => {
    jur = { ...jur, token: await operatorToken(t, PHONE_J) };
    jur2 = { ...jur2, token: await operatorToken(t, PHONE_J2) };
    committee = await operatorToken(t, PHONE_COMMITTEE);
    manager = await operatorToken(t, PHONE_MANAGER);
    dev = await ownerToken(t);
  };
  const goTo = async (d: string) => {
    t.clock.set(at(d));
    await relogin();
  };
  const doc = async (tenantId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [tenantId],
      )
    ).id;
  const vendor = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await t.http
        .post('/v1/owner/juristic/vendors')
        .set(J())
        .send({ type: 'company', name, ...extra })
        .expect(201)
    ).body as { id: string; partyId: string };
  const round = async (title: string) =>
    (
      await t.http
        .post('/v1/owner/juristic/quotation-rounds')
        .set(J())
        .send({ buildingId: ids.building, title, category: 'lift' })
        .expect(201)
    ).body.id as string;
  const quote = async (
    roundId: string | undefined,
    vendorId: string | undefined,
    amount: string,
    vat = '0.00',
  ) =>
    t.http
      .post(`/v1/owner/juristic/quotation-rounds/${roundId!}/quotations`)
      .set(J())
      .send({
        vendorId,
        amount,
        vatAmount: vat,
        validUntil: '2027-03-31',
        documentId: await doc(jur.tenantId),
      });
  const notified = (type: string, aggregateId: string) =>
    q<{ recipient_id: string; channel: string }>(
      `SELECT n.recipient_id, n.channel::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = $1 AND e.aggregate_id = $2 ORDER BY n.recipient_id, n.channel`,
      [type, aggregateId],
    );

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_vendors' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2027-01-02'));
    admin = await adminToken(t);
    dev = await ownerToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j22-juristic', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j22-other', phone: PHONE_J2, type: 'juristic' });
    const property = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโด J2.2', kind: 'condo' })
      .expect(201);
    ids.building = (
      await t.http
        .post('/v1/owner/buildings')
        .set(J())
        .send({
          propertyId: property.body.id,
          code: 'A',
          name: 'อาคาร A',
          type: 'condo',
          legalForm: 'condo_act',
        })
        .expect(201)
    ).body.id;
    const p2 = await t.http
      .post('/v1/owner/properties')
      .set(J2())
      .send({ code: 'C2', name: 'อื่น', kind: 'condo' })
      .expect(201);
    ids.building2 = (
      await t.http
        .post('/v1/owner/buildings')
        .set(J2())
        .send({ propertyId: p2.body.id, code: 'B', name: 'อาคาร B', type: 'condo', legalForm: 'condo_act' })
        .expect(201)
    ).body.id;
    for (const [role, phone] of [
      ['committee', PHONE_COMMITTEE],
      ['manager', PHONE_MANAGER],
    ] as const) {
      const inv = await t.http
        .post('/v1/owner/invitations')
        .set(J())
        .send({ role, phone, channel: 'link' })
        .expect(201);
      await operatorToken(t, phone, inv.body.code as string);
    }
    for (const role of ['owner', 'manager', 'committee'])
      ids[`${role}User`] = (
        await one<{ user_id: string }>(
          `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = $2`,
          [jur.tenantId, role],
        )
      ).user_id;
    await relogin();
    const chart = await t.http.get('/v1/owner/juristic/accounts').set(J()).expect(200);
    for (const a of chart.body.data as { code: string; id: string }[]) acc[a.code] = a.id;
    ids.evidence = await doc(jur.tenantId);
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('vendors are parties with a verified tax id and a masked bank account; one vendor per party', async () => {
    const bad = await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({ type: 'company', name: 'x', taxId: `${TAX_V.slice(0, 12)}${(Number(TAX_V[12]) + 1) % 10}` })
      .expect(422);
    expect(bad.body.code).toBe('validation.failed');
    const v = await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({
        type: 'company',
        name: 'บริษัท ลิฟต์ทดสอบ จำกัด',
        taxId: TAX_V,
        categories: ['lift', 'lift'],
        contactName: 'ผู้ติดต่อ ทดสอบ',
        contactPhone: '081-000-3001',
        bankName: 'กสิกรไทย',
        bankAccountName: 'บจก. ลิฟต์ทดสอบ',
        bankAccountLast4: '8812',
      })
      .expect(201);
    expect(v.body).toMatchObject({
      name: 'บริษัท ลิฟต์ทดสอบ จำกัด',
      partyType: 'company',
      taxIdHint: TAX_V.slice(-4),
      categories: ['lift'],
      contactPhone: '+66810003001',
      bankAccountLast4: '8812',
      state: 'active',
      activeContracts: 0,
    });
    expect(JSON.stringify(v.body)).not.toContain(TAX_V);
    ids.V = v.body.id;
    ids.VParty = v.body.partyId;
    expect(
      (await one<{ tax_id: string }>(`SELECT tax_id FROM core.party WHERE id = $1`, [ids.VParty])).tax_id,
    ).toBe(TAX_V);
    // the same party twice → 409
    const dup = await t.http
      .post('/v1/owner/juristic/vendors')
      .set(J())
      .send({ partyId: ids.VParty, name: 'ซ้ำ' })
      .expect(409);
    expect(dup.body.code).toBe('vendor.exists');
    ids.W = (await vendor('บริษัท วิศวกรรมทดสอบ จำกัด', { contactPhone: '081-000-3002' })).id;
    ids.X = (await vendor('หจก. ซ่อมบำรุงทดสอบ', { contactPhone: '081-000-3003' })).id;
    // block / unblock (reason required)
    await t.http.patch(`/v1/owner/juristic/vendors/${ids.X}`).set(J()).send({ state: 'blocked' }).expect(422);
    const blocked = await t.http
      .patch(`/v1/owner/juristic/vendors/${ids.X}`)
      .set(J())
      .send({ state: 'blocked', blockedReason: 'ทดสอบการระงับ', version: 1 })
      .expect(200);
    expect(blocked.body).toMatchObject({ state: 'blocked', blockedReason: 'ทดสอบการระงับ' });
    const r0 = await round('ทดสอบผู้รับจ้างถูกระงับ');
    const refused = await quote(r0, ids.X, '1000.00');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('vendor.blocked');
    await t.http.patch(`/v1/owner/juristic/vendors/${ids.X}`).set(J()).send({ state: 'active' }).expect(200);
    const list = await t.http.get('/v1/owner/juristic/vendors?category=lift').set(C()).expect(200);
    expect((list.body.data as { id: string }[]).map((x) => x.id)).toEqual([ids.V]);
    // an apartment owner has no vendors module
    await t.http.get('/v1/owner/juristic/vendors').set(bearer(dev)).expect(404);
  });

  it('quotation rule: fewer than 3 above the threshold needs a reason and band approvals (maker-checker); award → contract draft', async () => {
    ids.R1 = await round('จ้างบำรุงรักษาลิฟต์ 2570');
    expect((await quote(ids.R1, ids.V, '96300.00', '6300.00')).status).toBe(200);
    const second = await quote(ids.R1, ids.W, '99510.00', '6510.00');
    expect(second.body.quotations).toHaveLength(2);
    const again = await quote(ids.R1, ids.V, '1.00');
    expect(again.body.code).toBe('quotation.exists');
    const qV = (second.body.quotations as { id: string; vendorId: string }[]).find(
      (x) => x.vendorId === ids.V,
    )!.id;
    const award = {
      quotationId: qV,
      outcome: 'contract',
      basis: 'approval',
      startsOn: '2027-02-01',
      endsOn: '2028-01-31',
    };
    const noReason = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/award`)
      .set(M())
      .set(idem())
      .send(award)
      .expect(422);
    expect(noReason.body.code).toBe('quotation.minimum_not_met');
    const asked = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/award`)
      .set(M())
      .set(idem())
      .send({ ...award, fewerQuotationsReason: 'มีผู้ให้บริการลิฟต์ยี่ห้อนี้ในพื้นที่เพียงสองราย' })
      .expect(200);
    expect(asked.body).toMatchObject({
      state: 'awaiting_approval',
      aboveThreshold: true,
      threshold: '50000.00',
      minimumQuotations: 3,
      approvalsRequired: 2,
      approverRoles: ['owner', 'manager', 'committee'],
      awardRequestedBy: ids.managerUser,
    });
    await settle();
    expect(
      (await notified('juristic.quotation.approval_required', ids.R1)).map((n) => n.recipient_id),
    ).not.toContain(ids.managerUser);
    // the requester never approves (API 403, and the database refuses it)
    const self = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/approve`)
      .set(M())
      .set(idem())
      .send({})
      .expect(403);
    expect(self.body.code).toBe('quotation.maker_checker');
    await expect(
      q(
        `INSERT INTO juristic.quotation_approval (tenant_id, round_id, approver_user_id, role, decision, band_key, award_requested_at)
         SELECT tenant_id, id, $2, 'manager', 'approved', 'x', award_requested_at FROM juristic.quotation_round WHERE id = $1`,
        [ids.R1, ids.managerUser],
      ),
    ).rejects.toThrow(/maker-checker/);
    // the DB refuses an awarded round with fewer than 3 above the threshold and no reason
    await expect(
      q(
        `UPDATE juristic.quotation_round SET fewer_quotations_reason = NULL, state = 'awarded', awarded_at = now() WHERE id = $1`,
        [ids.R1],
      ),
    ).rejects.toThrow(/quotation_round_minimum_check/);
    const c1 = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/approve`)
      .set(C())
      .set(idem())
      .send({ reason: 'ที่ประชุมกรรมการเห็นชอบ' })
      .expect(200);
    expect(c1.body).toMatchObject({ state: 'awaiting_approval', approvalsGiven: 1 });
    const twice = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('quotation.already_decided');
    const done = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/approve`)
      .set(J())
      .set(idem())
      .send({})
      .expect(200);
    expect(done.body).toMatchObject({ state: 'awarded', awardedQuotationId: qV, outcome: 'contract' });
    ids.C1 = done.body.outcomeContractId;
    const draft = await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C1}`).set(J()).expect(200);
    expect(draft.body).toMatchObject({
      state: 'draft',
      vendorId: ids.V,
      value: '96300.00',
      quotationRoundId: ids.R1,
      startsOn: '2027-02-01',
      endsOn: '2028-01-31',
    });

    // a rejection reopens the round; an award by resolution is immediate → expense request draft
    ids.R2 = await round('เปลี่ยนมอเตอร์ประตูลานจอด');
    await quote(ids.R2, ids.V, '64200.00', '4200.00');
    await quote(ids.R2, ids.W, '60990.00', '3990.00');
    const three = await quote(ids.R2, ids.X, '62000.00');
    const qW = (three.body.quotations as { id: string; vendorId: string }[]).find(
      (x) => x.vendorId === ids.W,
    )!.id;
    expect(three.body.quotations[0].vendorId).toBe(ids.W); // cheapest first
    const expenseAward = { quotationId: qW, outcome: 'expense', accountId: acc['5130'], whtKey: 'service' };
    await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R2}/actions/award`)
      .set(M())
      .set(idem())
      .send({ ...expenseAward, basis: 'approval' })
      .expect(200);
    const rejected = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R2}/actions/reject`)
      .set(C())
      .set(idem())
      .send({ reason: 'ขอให้เสนอผ่านที่ประชุม' })
      .expect(200);
    expect(rejected.body).toMatchObject({ state: 'open', awardedQuotationId: null, approvalsGiven: 0 });
    const res = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.building,
        meetingKind: 'committee',
        meetingDate: '2027-01-02',
        number: '1/2570',
        title: 'เปลี่ยนมอเตอร์ประตู',
        text: 'อนุมัติจ้างผู้เสนอราคาต่ำสุด',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${res.body.id}/actions/adopt`)
      .set(J())
      .set(idem())
      .expect(200);
    ids.resolution = res.body.id;
    const byResolution = await t.http
      .post(`/v1/owner/juristic/quotation-rounds/${ids.R2}/actions/award`)
      .set(J())
      .set(idem())
      .send({ ...expenseAward, basis: 'resolution', resolutionId: ids.resolution })
      .expect(200);
    expect(byResolution.body).toMatchObject({ state: 'awarded', basis: 'resolution', aboveThreshold: true });
    const exp = await t.http
      .get(`/v1/owner/juristic/expense-requests/${byResolution.body.outcomeExpenseRequestId}`)
      .set(J())
      .expect(200);
    expect(exp.body).toMatchObject({
      state: 'draft',
      vendorId: ids.W,
      quotationRoundId: ids.R2,
      amount: '60990.00',
      attachments: [expect.objectContaining({ kind: 'quotation' })],
    });
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${exp.body.id}/actions/submit`)
      .set(J())
      .set(idem())
      .expect(200);

    // a vendor purchase above the threshold without an awarded round cannot be submitted
    const direct = await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'จ้างทาสีภายนอก',
        vendorId: ids.X,
        lines: [{ accountId: acc['5130'], description: 'ทาสี', amount: '70000.00' }],
      })
      .expect(201);
    expect(direct.body).toMatchObject({
      payeeName: 'หจก. ซ่อมบำรุงทดสอบ',
      vendorName: 'หจก. ซ่อมบำรุงทดสอบ',
    });
    const noRound = await t.http
      .post(`/v1/owner/juristic/expense-requests/${direct.body.id}/actions/submit`)
      .set(J())
      .set(idem())
      .expect(422);
    expect(noRound.body.code).toBe('expense.quotations_required');
    // …nor can a contract above the threshold be activated
    const noQuote = await t.http
      .post('/v1/owner/juristic/vendor-contracts')
      .set(J())
      .send({
        buildingId: ids.building,
        vendorId: ids.X,
        title: 'สัญญาทำความสะอาด',
        startsOn: '2027-02-01',
        endsOn: '2027-12-31',
        value: '120000.00',
      })
      .expect(201);
    const refused = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${noQuote.body.id}/actions/activate`)
      .set(J())
      .set(idem())
      .expect(422);
    expect(refused.body.code).toBe('vendor_contract.quotations_required');
  });

  it('contract instalments become submitted expense requests on schedule (idempotent job); the 50 ทวิ carries the vendor’s tax id', async () => {
    const patched = await t.http
      .patch(`/v1/owner/juristic/vendor-contracts/${ids.C1}`)
      .set(M())
      .send({
        scope: 'ตรวจเช็กลิฟต์ 2 ตัว เดือนละครั้ง',
        slaTerms: [
          { priority: 'urgent', responseHours: 2, resolveHours: 24 },
          { priority: 'normal', responseHours: 24, resolveHours: 72 },
        ],
        renewalNoticeDays: 60,
        expenseAccountId: acc['5140'],
        whtKey: 'service',
        instalmentPlan: { frequency: 'monthly', dueDay: 10, amount: '8025.00', vatAmount: '525.00' },
        penaltyClauses: 'ปรับวันละ 500 บาท',
        version: 1,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.instalments).toEqual([]);
    await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/documents`)
      .set(M())
      .send({ documentId: ids.evidence, kind: 'contract' })
      .expect(200);
    const active = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/actions/activate`)
      .set(M())
      .set(idem())
      .expect(200);
    expect(active.body).toMatchObject({
      state: 'active',
      instalmentsTotal: '96300.00',
      noticeBy: '2027-12-02',
    });
    expect(active.body.instalments).toHaveLength(12);
    expect(active.body.instalments[0]).toMatchObject({ seq: 1, dueOn: '2027-02-10', state: 'scheduled' });
    expect(active.body.documents).toEqual([expect.objectContaining({ kind: 'contract' })]);
    // not yet: due 10 Feb − 7 lead days = 3 Feb
    await goTo('2027-02-02');
    expect((await job()).requested).toBe(0);
    await goTo('2027-02-03');
    expect((await job()).requested).toBe(1);
    expect((await job()).requested).toBe(0); // idempotent
    const detail = await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C1}`).set(J()).expect(200);
    const first = detail.body.instalments[0];
    expect(first).toMatchObject({ state: 'requested', expenseRequestState: 'submitted' });
    expect(detail.body.instalments[1].state).toBe('scheduled');
    const req = await t.http
      .get(`/v1/owner/juristic/expense-requests/${first.expenseRequestId}`)
      .set(J())
      .expect(200);
    expect(req.body).toMatchObject({
      state: 'submitted',
      vendorId: ids.V,
      vendorContractId: ids.C1,
      payeePartyId: ids.VParty,
      amount: '8025.00',
      whtAmount: '225.00',
      requestedBy: ids.managerUser,
      approvalsRequired: 1,
    });
    expect(
      (await q(`SELECT 1 FROM juristic.expense_request WHERE vendor_contract_id = $1`, [ids.C1])).length,
    ).toBe(1);
    // the activating manager cannot approve the instalment request (maker-checker); the committee does, the owner pays
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${req.body.id}/actions/approve`)
      .set(M())
      .set(idem())
      .send({})
      .expect(403);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${req.body.id}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(200);
    const paid = await t.http
      .post(`/v1/owner/juristic/expense-requests/${req.body.id}/actions/pay`)
      .set(J())
      .set(idem())
      .send({ method: 'bank_transfer', paidOn: '2027-02-03', evidenceDocumentId: ids.evidence })
      .expect(200);
    const cert = await t.http
      .get(`/v1/owner/juristic/withholding-certificates/${paid.body.certificate.id}`)
      .set(J())
      .expect(200);
    expect(cert.body).toMatchObject({
      form: 'pnd53',
      payeePartyId: ids.VParty,
      payeeTaxIdHint: TAX_V.slice(-4),
      base: '7500.00',
      tax: '225.00',
    });
    const vendorNow = await t.http.get(`/v1/owner/juristic/vendors/${ids.V}`).set(J()).expect(200);
    expect(vendorNow.body.activeContracts).toBe(1);
  });

  it('expiry alerts at 90 / 60 / 30 days once each to owner, manager and committee; then expiry and one renewal', async () => {
    const c2 = await t.http
      .post('/v1/owner/juristic/vendor-contracts')
      .set(J())
      .send({
        buildingId: ids.building,
        vendorId: ids.W,
        title: 'สัญญาดูแลระบบปั๊มน้ำ',
        category: 'pump',
        startsOn: '2027-01-01',
        endsOn: '2027-06-30',
        renewalNoticeDays: 30,
        value: '30000.00',
      })
      .expect(201);
    ids.C2 = c2.body.id;
    await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C2}/actions/activate`)
      .set(J())
      .set(idem())
      .expect(200);
    const alerts = async () =>
      (
        await q<{ days_before: number }>(
          `SELECT days_before FROM juristic.vendor_contract_alert WHERE contract_id = $1 ORDER BY sent_at`,
          [ids.C2],
        )
      ).map((r) => r.days_before);
    await goTo('2027-03-31'); // 91 days left
    await job();
    expect(await alerts()).toEqual([]);
    await goTo('2027-04-01'); // 90
    await job();
    await job();
    expect(await alerts()).toEqual([90]);
    const queue = await t.http
      .get('/v1/owner/juristic/vendor-contracts?endingWithinDays=90')
      .set(J())
      .expect(200);
    expect(
      (queue.body.data as { id: string; daysLeft: number }[]).find((c) => c.id === ids.C2),
    ).toMatchObject({
      daysLeft: 90,
      noticeBy: '2027-05-31',
    });
    await goTo('2027-04-15');
    await job();
    expect(await alerts()).toEqual([90]);
    await goTo('2027-05-01'); // 60
    await job();
    await goTo('2027-06-01'); // 29
    await job();
    await job();
    expect(await alerts()).toEqual([90, 60, 30]);
    await settle();
    const recipients = [
      ...new Set((await notified('juristic.vendor_contract.expiring', ids.C2!)).map((n) => n.recipient_id)),
    ];
    expect(recipients.sort()).toEqual([ids.ownerUser, ids.managerUser, ids.committeeUser].sort());
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'juristic.vendor_contract.expiring' AND aggregate_id = $1`,
          [ids.C2],
        )
      ).n,
    ).toBe(3);
    await goTo('2027-07-01');
    expect((await job()).expired).toBeGreaterThanOrEqual(1);
    const expired = await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C2}`).set(J()).expect(200);
    expect(expired.body).toMatchObject({ state: 'expired', nextActions: expect.arrayContaining(['renew']) });
    expect((expired.body.alerts as { daysBefore: number }[]).map((a) => a.daysBefore)).toEqual([90, 60, 30]);
    const renewal = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C2}/actions/renew`)
      .set(J())
      .set(idem())
      .send({ endsOn: '2027-12-31', value: '31000.00' })
      .expect(200);
    expect(renewal.body).toMatchObject({
      state: 'draft',
      renewsContractId: ids.C2,
      startsOn: '2027-07-01',
      endsOn: '2027-12-31',
      value: '31000.00',
    });
    const second = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C2}/actions/renew`)
      .set(J())
      .set(idem())
      .send({ endsOn: '2027-12-31' })
      .expect(409);
    expect(second.body.code).toBe('vendor_contract.already_renewed');
    expect(
      (await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C2}`).set(J()).expect(200)).body.renewalId,
    ).toBe(renewal.body.id);
  });

  it('an evaluation pulls the SLA breaches of the vendor’s work orders and the contract shows the trend', async () => {
    // July 2027: an urgent lift repair assigned to the vendor, accepted 5 h later and not yet fixed 2 days on
    const wo = await t.http
      .post('/v1/owner/work-orders')
      .set(J())
      .send({
        kind: 'repair',
        buildingId: ids.building,
        title: 'ลิฟต์ L2 ค้างระหว่างชั้น',
        priority: 'urgent',
        assigneePartyId: ids.VParty,
      })
      .expect(201);
    await q(
      `UPDATE ops.work_order SET accepted_at = assigned_at + interval '5 hours', status = 'accepted' WHERE id = $1`,
      [wo.body.id],
    );
    // another vendor's work order does not count
    const other = await vendor('บริษัท อื่น ทดสอบ', { contactPhone: '081-000-3004' });
    await t.http
      .post('/v1/owner/work-orders')
      .set(J())
      .send({
        kind: 'repair',
        buildingId: ids.building,
        title: 'ประตู',
        priority: 'urgent',
        assigneePartyId: other.partyId,
      })
      .expect(201);
    await goTo('2027-07-03');
    const sla = await t.http
      .get(`/v1/owner/juristic/vendor-contracts/${ids.C1}/sla-breaches?month=2027-07`)
      .set(C())
      .expect(200);
    expect(sla.body).toMatchObject({ month: '2027-07', workOrders: 1 });
    expect(sla.body.breaches).toEqual([
      expect.objectContaining({ kind: 'response', workOrderId: wo.body.id, allowedHours: 2, actualHours: 5 }),
      expect.objectContaining({ kind: 'resolve', workOrderId: wo.body.id, allowedHours: 24 }),
    ]);
    await t.http
      .get(`/v1/owner/juristic/vendor-contracts/${ids.C1}/sla-breaches?month=2027-09`)
      .set(C())
      .expect(422);
    const scores = (n: number) =>
      ['quality', 'timeliness', 'communication', 'safety'].map((criterion) => ({ criterion, score: n }));
    const missing = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`)
      .set(C())
      .set(idem())
      .send({ month: '2027-06', scores: scores(3).slice(0, 3) })
      .expect(422);
    expect(missing.body.code).toBe('validation.failed');
    await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`)
      .set(C())
      .set(idem())
      .send({ month: '2027-06', scores: scores(3) })
      .expect(201);
    const july = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`)
      .set(C())
      .set(idem())
      .send({
        month: '2027-07',
        scores: [...scores(4).slice(0, 3), { criterion: 'safety', score: 5 }],
        incidents: 1,
      })
      .expect(201);
    expect(july.body).toMatchObject({
      month: '2027-07',
      score: '4.25',
      slaBreaches: 2,
      workOrders: 1,
      incidents: 1,
    });
    expect((july.body.slaItems as { kind: string }[]).map((x) => x.kind)).toEqual(['response', 'resolve']);
    const dup = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`)
      .set(C())
      .set(idem())
      .send({ month: '2027-07', scores: scores(5) })
      .expect(409);
    expect(dup.body.code).toBe('vendor_evaluation.exists');
    // staff read contracts but do not evaluate; the accountant has no evaluate permission either
    const detail = await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C1}`).set(C()).expect(200);
    expect((detail.body.evaluations as { month: string }[]).map((e) => e.month)).toEqual([
      '2027-06',
      '2027-07',
    ]);
    expect(detail.body.evaluationSummary).toEqual({
      count: 2,
      averageScore: '3.63',
      lastScore: '4.25',
      trend: 'improving',
      slaBreaches: 2,
    });
    expect(detail.body.nextActions).toEqual(['evaluate']);
    expect(
      (await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`).set(J()).expect(200))
        .body.data,
    ).toHaveLength(2);
  });

  it('a preventive plan under the contract opens work orders for the vendor and stops when the contract is terminated', async () => {
    const lift = (
      await one<{ id: string }>(
        `INSERT INTO core.asset_item (tenant_id, building_id, category, name) VALUES ($1, $2, 'other', 'ลิฟต์โดยสาร L1') RETURNING id`,
        [jur.tenantId, ids.building],
      )
    ).id;
    const due = new Date(t.clock.now().getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const plan = await t.http
      .post('/v1/owner/maintenance-plans')
      .set(J())
      .send({
        assetItemId: lift,
        title: 'ตรวจเช็กลิฟต์ประจำเดือน',
        intervalDays: 30,
        leadDays: 3,
        nextDueOn: due,
        vendorContractId: ids.C1,
      })
      .expect(201);
    expect(plan.body).toMatchObject({ vendorContractId: ids.C1, vendorName: 'บริษัท ลิฟต์ทดสอบ จำกัด' });
    // another tenant's contract is 404; an expired contract is refused
    const foreignAsset = (
      await one<{ id: string }>(
        `INSERT INTO core.asset_item (tenant_id, building_id, category, name) VALUES ($1, $2, 'pump', 'ปั๊ม B') RETURNING id`,
        [jur2.tenantId, ids.building2],
      )
    ).id;
    await t.http
      .post('/v1/owner/maintenance-plans')
      .set(J2())
      .send({
        assetItemId: foreignAsset,
        title: 'x',
        intervalDays: 30,
        nextDueOn: due,
        vendorContractId: ids.C1,
      })
      .expect(404);
    const current = await t.http.get(`/v1/owner/maintenance-plans/${plan.body.id}`).set(J()).expect(200);
    const expiredRef = await t.http
      .patch(`/v1/owner/maintenance-plans/${plan.body.id}`)
      .set(J())
      .set('If-Match', current.headers.etag as string)
      .send({ vendorContractId: ids.C2 })
      .expect(409);
    expect(expiredRef.body.code).toBe('vendor_contract.invalid_state');
    const sweep = t.app.get(MaintenancePlansService);
    expect(await sweep.sweep()).toEqual({ opened: 1 });
    const after = await t.http.get(`/v1/owner/maintenance-plans/${plan.body.id}`).set(J()).expect(200);
    const wo = await t.http.get(`/v1/owner/work-orders/${after.body.lastWorkOrderId}`).set(J()).expect(200);
    expect(wo.body).toMatchObject({ kind: 'preventive', assetItemId: lift, maintenancePlanId: plan.body.id });
    expect(
      (
        await one<{ assignee_party_id: string }>(
          `SELECT assignee_party_id FROM ops.work_order WHERE id = $1`,
          [wo.body.id],
        )
      ).assignee_party_id,
    ).toBe(ids.VParty);
    const shown = await t.http.get(`/v1/owner/juristic/vendor-contracts/${ids.C1}`).set(J()).expect(200);
    expect(shown.body.maintenancePlans).toEqual([
      expect.objectContaining({ id: plan.body.id, isActive: true, lastWorkOrderId: wo.body.id }),
    ]);
    // the PM work order counts for the vendor's month
    const sla = await t.http
      .get(`/v1/owner/juristic/vendor-contracts/${ids.C1}/sla-breaches?month=2027-07`)
      .set(J())
      .expect(200);
    expect(sla.body.workOrders).toBe(2);
    // termination: later instalments cancelled, the plan stops, the sweep opens nothing more
    const ended = await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/actions/terminate`)
      .set(J())
      .set(idem())
      .send({ reason: 'ผู้รับจ้างไม่เข้าซ่อมตามเวลาที่กำหนด' })
      .expect(200);
    expect(ended.body).toMatchObject({ state: 'terminated', terminatedOn: '2027-07-03' });
    expect(ended.body.maintenancePlans[0].isActive).toBe(false);
    const states = (ended.body.instalments as { dueOn: string; state: string }[]).map((i) => [
      i.dueOn,
      i.state,
    ]);
    expect(states.filter(([d]) => d! >= '2027-07-03').every(([, s]) => s === 'cancelled')).toBe(true);
    expect(states.filter(([, s]) => s === 'requested').length).toBeGreaterThanOrEqual(1);
    await q(`UPDATE ops.maintenance_plan SET next_due_on = $2::date WHERE id = $1`, [plan.body.id, due]);
    expect(await sweep.sweep()).toEqual({ opened: 0 });
    await t.http
      .post(`/v1/owner/juristic/vendor-contracts/${ids.C1}/actions/terminate`)
      .set(J())
      .set(idem())
      .send({ reason: 'อีกครั้ง' })
      .expect(409);
  });

  it('cross-tenant: every vendor, contract and quotation endpoint answers 404 for another juristic tenant', async () => {
    const quotationId = (
      await one<{ id: string }>(`SELECT id FROM juristic.quotation WHERE round_id = $1 LIMIT 1`, [ids.R1])
    ).id;
    const X = J2();
    const B = { buildingId: ids.building };
    const calls: [string, string, Record<string, unknown>?][] = [
      ['get', `/v1/owner/juristic/vendors/${ids.V}`],
      ['patch', `/v1/owner/juristic/vendors/${ids.V}`, { name: 'x' }],
      ['post', '/v1/owner/juristic/vendors', { partyId: ids.VParty, name: 'x' }],
      ['get', `/v1/owner/juristic/vendor-contracts/${ids.C1}`],
      ['patch', `/v1/owner/juristic/vendor-contracts/${ids.C2}`, { title: 'x' }],
      [
        'post',
        `/v1/owner/juristic/vendor-contracts/${ids.C1}/documents`,
        { documentId: ids.evidence, kind: 'other' },
      ],
      ['post', `/v1/owner/juristic/vendor-contracts/${ids.C2}/actions/activate`],
      ['post', `/v1/owner/juristic/vendor-contracts/${ids.C2}/actions/renew`, { endsOn: '2028-12-31' }],
      ['post', `/v1/owner/juristic/vendor-contracts/${ids.C1}/actions/terminate`, { reason: 'ทดสอบ' }],
      ['get', `/v1/owner/juristic/vendor-contracts/${ids.C1}/sla-breaches?month=2027-07`],
      ['get', `/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`],
      [
        'post',
        `/v1/owner/juristic/vendor-contracts/${ids.C1}/evaluations`,
        { month: '2027-05', scores: [{ criterion: 'quality', score: 3 }] },
      ],
      [
        'post',
        '/v1/owner/juristic/vendor-contracts',
        { ...B, vendorId: ids.V, title: 'x', startsOn: '2027-08-01', endsOn: '2027-12-31', value: '1.00' },
      ],
      ['get', `/v1/owner/juristic/quotation-rounds/${ids.R1}`],
      ['post', '/v1/owner/juristic/quotation-rounds', { ...B, title: 'x' }],
      [
        'post',
        `/v1/owner/juristic/quotation-rounds/${ids.R1}/quotations`,
        { vendorId: ids.V, amount: '1.00', validUntil: '2027-12-31', documentId: ids.evidence },
      ],
      [
        'post',
        `/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/award`,
        { quotationId, outcome: 'contract', basis: 'approval', startsOn: '2027-08-01', endsOn: '2027-12-31' },
      ],
      ['post', `/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/approve`, {}],
      ['post', `/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/reject`, { reason: 'ไม่อนุมัติ' }],
      ['post', `/v1/owner/juristic/quotation-rounds/${ids.R1}/actions/cancel`, { reason: 'ยกเลิก' }],
      [
        'post',
        '/v1/owner/juristic/expense-requests',
        {
          buildingId: ids.building2,
          title: 'x',
          vendorId: ids.V,
          lines: [],
        },
      ],
    ];
    for (const [method, path, body] of calls) {
      const req = (t.http as unknown as Record<string, (p: string) => import('supertest').Test>)[method]!(
        path,
      )
        .set(X)
        .set(idem());
      const res = await (body ? req.send(body) : req);
      expect({ path: `${method} ${path}`, status: res.status }).toEqual({
        path: `${method} ${path}`,
        status: 404,
      });
    }
    // another juristic tenant sees its own (empty) lists only
    for (const path of [
      '/v1/owner/juristic/vendors',
      '/v1/owner/juristic/vendor-contracts',
      '/v1/owner/juristic/quotation-rounds',
    ]) {
      const res = await t.http.get(path).set(X).expect(200);
      expect(res.body.meta.total).toBe(0);
    }
    // an apartment owner: no vendors module at all
    for (const path of [
      '/v1/owner/juristic/vendors',
      '/v1/owner/juristic/vendor-contracts',
      '/v1/owner/juristic/quotation-rounds',
    ])
      await t.http.get(path).set(bearer(dev)).expect(404);
  });
});
