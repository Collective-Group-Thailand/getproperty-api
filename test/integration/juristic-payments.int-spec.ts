import 'reflect-metadata';

import { fakeLineIdToken } from '@collective/integrations/line';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { type FakeRecurringPayments } from '@integrations/recurring-payments/fake-recurring-payments';
import { RECURRING_PAYMENTS } from '@integrations/recurring-payments/recurring-payments.port';
import { PaymentPlansService } from '@modules/ops-juristic/payment-plans.service';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { RecurringPaymentsService } from '@modules/ops-payments/recurring-payments.service';
import { SlipsService } from '@modules/ops-payments/slips.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import {
  adminToken,
  bearer,
  idem,
  onboardTenant,
  operatorToken,
  otpSignIn,
  ownerToken,
} from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
);
const slipImage = (j: Record<string, string>) =>
  Buffer.concat([PNG, Buffer.from(JSON.stringify(j))]).toString('base64');
const LINE_SUB = 'U00000000000000000000000000j12a01';
const PHONE_J = '+660000000251';
const PHONE_OWNER = '+66810002501';

/**
 * J1.2a acceptance (D-306, D-308, D-325) on the DEV apartment tenant and a juristic tenant: a verified slip's bank
 * reference pays once on the whole platform (reuse at another tenant refused, owner approve 409, DB unique), slip date
 * window; allocation oldest-first / surcharge-first with exact satang, overpayment credit used by the next invoice,
 * the manual channel rule of juristic tenants; a resident's payment plan → approval (credit notes, instalments Σ) →
 * instalment billed → default (event, future instalments cancelled, the rest billed); the recurring channel (mandate,
 * signed idempotent webhook, advance invoice charged and paid); debt clearance refused with 0.01 outstanding, issued
 * at 0 (DCL number, PDF), public verification minimal; cross-tenant 404 on every new endpoint.
 */
describe('J1.2a slips, allocation, plans, recurring, debt clearance (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let dev: string;
  let devResident: string;
  let jur: { tenantId: string; token: string };
  let coOwner: string;
  const ids: Record<string, string> = {};
  let invSeq = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const R = () => bearer(coOwner);
  /** Fresh tokens after the clock moved (access tokens are short-lived). */
  const relogin = async () => {
    jur = { ...jur, token: await operatorToken(t, PHONE_J) };
    dev = await ownerToken(t);
    coOwner = (await otpSignIn(t, 'resident', PHONE_OWNER, jur.token)).accessToken;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า' }) })
      .expect(200);
    devResident = login.body.accessToken;
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

  /** An issued invoice of the juristic tenant (lines: [kind, amount, charge id?]): draft + lines, then issued. */
  async function invoice(
    unitId: string,
    lines: [string, string, string?][],
    opts: { issuedAt?: string; dueDate?: string; cycleId?: string } = {},
  ): Promise<string> {
    invSeq += 1;
    const total = lines.reduce((s, [, a]) => s + Math.round(Number(a) * 100), 0) / 100;
    const issuedAt = opts.issuedAt ?? `2026-12-${String(invSeq).padStart(2, '0')}T09:00:00+07:00`;
    const id = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, billing_cycle_id, period_start, period_end,
                                  subtotal, total, balance)
         VALUES ($1, $2, $3, $4, $5, '2026-12-01', '2026-12-31', $6, $6, $6) RETURNING id`,
        [jur.tenantId, ids.building, unitId, ids.party, opts.cycleId ?? null, total.toFixed(2)],
      )
    ).id;
    let n = 0;
    for (const [kind, amount, sourceId] of lines) {
      n += 1;
      const source =
        kind === 'late_fee' ? 'penalty' : kind === 'plan_instalment' ? 'adjustment' : 'common_fee';
      await q(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount, source_id)
         VALUES ($1, $2, $3, $4::ops.invoice_line_source_type, $5::ops.invoice_line_kind, $5, 1, 'month', $6, $6, $7)`,
        [jur.tenantId, id, n, source, kind, amount, sourceId ?? null],
      );
    }
    await q(
      `UPDATE ops.invoice SET status = 'issued', number = $2, issued_at = $3, due_date = $4, snapshot = '{}' WHERE id = $1`,
      [id, `INV-2026-9${String(invSeq).padStart(4, '0')}`, issuedAt, opts.dueDate ?? '2027-01-05'],
    );
    return id;
  }
  const inv = (id: string) =>
    one<{ status: string; balance: string }>(
      'SELECT status::text, balance::text FROM ops.invoice WHERE id = $1',
      [id],
    );
  const pay = (invoiceId: string, amount: string, extra: Record<string, unknown> = {}) =>
    t.http
      .post('/v1/owner/payments')
      .set(J())
      .set(idem())
      .send({
        invoiceId,
        amount,
        method: 'bank_transfer_manual',
        paidAt: t.clock.now().toISOString(),
        evidenceDocumentId: ids.evidence,
        notes: 'โอนจากต่างประเทศ SWIFT BKKBTHBK',
        ...extra,
      });

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_payments' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(new Date('2027-01-10T09:00:00+07:00'));
    dev = await ownerToken(t);
    jur = await onboardTenant(t, await adminToken(t), {
      slug: 'j12a-juristic',
      phone: PHONE_J,
      type: 'juristic',
    });
    // juristic estate: a condo building, five units, one co-owner of them all
    const property = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโด J1.2a', kind: 'condo' })
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
    ids.property = property.body.id;
    for (const n of [1, 2, 3, 4, 5]) {
      ids[`u${n}`] = (
        await t.http
          .post('/v1/owner/units')
          .set(J())
          .send({ buildingId: ids.building, unitNo: `A-10${n}`, type: 'condo_unit', areaSqm: '40.00' })
          .expect(201)
      ).body.id;
      const added = await t.http
        .post(`/v1/owner/juristic/register/units/${ids[`u${n}`]}/owners`)
        .set(J())
        .send(
          n === 1
            ? {
                party: { type: 'person', displayName: 'สมชาย ใจดี', phone: PHONE_OWNER },
                sharePct: '100',
                validFrom: '2020-01-01',
              }
            : { partyId: ids.party, sharePct: '100', validFrom: '2020-01-01' },
        )
        .expect(201);
      ids.party ??= added.body.owners[0].party.id;
    }
    ids.evidence = await doc(jur.tenantId);
    coOwner = (await otpSignIn(t, 'resident', PHONE_OWNER, jur.token)).accessToken;
    // DEV: the apartment resident of A-101 (LINE + lease invitation), slips allowed, a receiving account
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(dev))
        .send({ channel: 'link' })
        .expect(201)
    ).body.code;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า' }) })
      .expect(200);
    const R0 = bearer(login.body.accessToken as string);
    const purposes = await t.http.get('/v1/resident/consents').set(R0).expect(200);
    await t.http
      .post('/v1/resident/consents')
      .set(R0)
      .send({
        items: (purposes.body as { key: string; version: number; required: boolean }[])
          .filter((x) => x.required)
          .map((x) => ({ purposeKey: x.key, version: x.version, granted: true })),
      })
      .expect(201);
    await t.http.post(`/v1/resident/invitations/${code}/accept`).set(R0).expect(200);
    devResident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)
    ).body.accessToken;
    const acct = await t.http
      .post('/v1/owner/bank-accounts')
      .set(bearer(dev))
      .set(idem())
      .send({
        bankCode: '004',
        bankNameTh: 'ธนาคารตัวอย่าง',
        accountNo: '123-4-56789-0',
        accountName: 'บริษัท ตัวอย่าง จำกัด',
        isDefault: true,
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/bank-accounts/${acct.body.account.id}/actions/confirm`)
      .set(bearer(dev))
      .send({ challengeId: acct.body.otp.challengeId, code: t.sms.lastCodeTo('+660000000001') })
      .expect(200);
    for (const token of [dev, jur.token])
      await t.http
        .put('/v1/owner/settings/payments.allow_partial')
        .set(bearer(token))
        .send({ value: true, reason: 'J1.2a test' })
        .expect(200);
  }, 600_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  // --------------------------------------------------------------------------------------- slips

  it('a slip reference that paid at one tenant is refused at another (platform-unique, RLS-safe, D-308)', async () => {
    const devUnit = (
      await one<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    ).id;
    const devInv = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, period_start, period_end,
                                  issued_at, due_date, status, subtotal, total, balance, snapshot)
         VALUES ($1, $2, $3, $4, $5, 'INV-2027-90001', '2027-01-01', '2027-01-31', now(), '2027-01-20', 'issued', 1000, 1000, 1000, '{}')
         RETURNING id`,
        [DEV.tenantId, DEV.buildingId, devUnit, DEV.residentPartyId, DEV.leaseId],
      )
    ).id;
    await t.http
      .post(`/v1/resident/invoices/${devInv}/slips`)
      .set(bearer(devResident))
      .send({
        image: slipImage({
          transRef: 'XT-REUSE-0001',
          amount: '1000.00',
          paidAt: t.clock.now().toISOString(),
          receiverBankCode: '004',
          receiverAccount: 'xxx-x-x7890-x',
        }),
        mimeType: 'image/png',
      })
      .expect(201);
    await settle();
    expect(
      await one(
        `SELECT status::text FROM ops.slip_review WHERE trans_ref = 'XT-REUSE-0001' AND tenant_id = $1`,
        [DEV.tenantId],
      ),
    ).toEqual({ status: 'auto_confirmed' });

    // the same transfer slip sent to the juristic office of another building
    const jInv = await invoice(ids.u1!, [['common_fee', '1000.00']]);
    const slipDoc = await doc(jur.tenantId);
    const slip = (
      await one<{ id: string }>(
        `INSERT INTO ops.slip_review (tenant_id, building_id, unit_id, invoice_id, payer_party_id, slip_document_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [jur.tenantId, ids.building, ids.u1, jInv, ids.party, slipDoc],
      )
    ).id;
    await t.app.get(TenantTx).platform((tx) =>
      t.app.get(SlipsService).verify(tx, slip, {
        valid: true,
        transRef: 'XT-REUSE-0001',
        amount: '1000.00',
        paidAt: t.clock.now(),
        receiverBankCode: '004',
        receiverAccount: 'xxx-x-x7890-x',
        receiverName: null,
        senderName: 'นาย ทดสอบ',
        raw: {},
      }),
    );
    expect(
      await one(
        `SELECT status::text, reasons, reject_reason, payment_id FROM ops.slip_review WHERE id = $1`,
        [slip],
      ),
    ).toEqual({
      status: 'rejected',
      reasons: ['duplicate_reference_platform'],
      reject_reason: 'payment.duplicate_slip',
      payment_id: null,
    });
    expect(await inv(jInv)).toEqual({ status: 'issued', balance: '1000.00' });
    // the resident is told — without anything about the other tenant
    const ev = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'slip.duplicate_rejected' AND aggregate_id = $1`,
      [slip],
    );
    expect(JSON.stringify(ev.payload)).not.toContain(DEV.tenantId);
    await settle();
    const sent = await q<{ channel: string }>(
      `SELECT n.channel::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.aggregate_id = $1 ORDER BY 1`,
      [slip],
    );
    expect(sent.map((s) => s.channel)).toEqual(expect.arrayContaining(['line']));

    // the owner cannot approve a (same-tenant duplicate) slip of that reference: 409 payment.duplicate_slip
    const dup = (
      await one<{ id: string }>(
        `INSERT INTO ops.slip_review (tenant_id, building_id, unit_id, invoice_id, payer_party_id, slip_document_id, status, trans_ref, amount_detected)
         VALUES ($1, $2, $3, $4, $5, $6, 'duplicate', 'XT-REUSE-0001', 1000) RETURNING id`,
        [jur.tenantId, ids.building, ids.u1, jInv, ids.party, slipDoc],
      )
    ).id;
    const refused = await t.http
      .post(`/v1/owner/slip-reviews/${dup}/actions/decide`)
      .set(J())
      .set(idem())
      .send({ action: 'approve' })
      .expect(409);
    expect(refused.body.code).toBe('payment.duplicate_slip');
    // the database refuses a second live slip with the reference, whatever the tenant
    await expect(
      q(
        `INSERT INTO ops.slip_review (tenant_id, building_id, unit_id, invoice_id, payer_party_id, slip_document_id, status, trans_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_review', 'XT-REUSE-0001')`,
        [jur.tenantId, ids.building, ids.u1, jInv, ids.party, slipDoc],
      ),
    ).rejects.toThrow(/slip_review_trans_ref_key/);
    ids.jInvSlip = jInv;
  });

  it('a slip dated outside payments.slip_max_age_days waits for the owner (date_out_of_window)', async () => {
    const devUnit = (
      await one<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    ).id;
    const devInv = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, period_start, period_end,
                                  issued_at, due_date, status, subtotal, total, balance, snapshot)
         VALUES ($1, $2, $3, $4, $5, 'INV-2027-90002', '2027-02-01', '2027-02-28', now(), '2027-02-20', 'issued', 500, 500, 500, '{}')
         RETURNING id`,
        [DEV.tenantId, DEV.buildingId, devUnit, DEV.residentPartyId, DEV.leaseId],
      )
    ).id;
    const r = await t.http
      .post(`/v1/resident/invoices/${devInv}/slips`)
      .set(bearer(devResident))
      .send({
        image: slipImage({
          transRef: 'XT-OLD-0001',
          amount: '500.00',
          paidAt: new Date(t.clock.now().getTime() - 40 * 86_400_000).toISOString(),
          receiverBankCode: '004',
          receiverAccount: 'xxx-x-x7890-x',
        }),
        mimeType: 'image/png',
      })
      .expect(201);
    await settle();
    expect(await one(`SELECT status::text, reasons FROM ops.slip_review WHERE id = $1`, [r.body.id])).toEqual(
      {
        status: 'pending_review',
        reasons: ['date_out_of_window'],
      },
    );
  });

  // --------------------------------------------------------------------------------------- allocation

  it('manual payments of a juristic tenant need evidence and a note (foreign transfers, D-325)', async () => {
    const noNote = await pay(ids.jInvSlip!, '10.00', { notes: undefined, reference: undefined }).expect(422);
    expect(noNote.body.errors).toEqual([expect.objectContaining({ path: 'notes' })]);
    const cash = await pay(ids.jInvSlip!, '10.00', { method: 'cash', evidenceDocumentId: undefined }).expect(
      422,
    );
    expect(cash.body.errors).toEqual([expect.objectContaining({ path: 'evidenceDocumentId' })]);
  });

  it('oldest_first: invoice by invoice, each one’s surcharge first — exact satang', async () => {
    // A-102: January 3,000.00; February 3,000.00 + the January late fee 150.00
    const jan = await invoice(ids.u2!, [['common_fee', '3000.00']], {
      issuedAt: '2027-01-01T09:00:00+07:00',
    });
    const feb = await invoice(
      ids.u2!,
      [
        ['common_fee', '3000.00'],
        ['late_fee', '150.00'],
      ],
      {
        issuedAt: '2027-01-02T09:00:00+07:00',
      },
    );
    const r = await pay(feb, '3100.00').expect(201);
    expect(r.body.allocations).toEqual([
      expect.objectContaining({ invoiceId: jan, amount: '3000.00', surchargeAmount: '0.00' }),
      expect.objectContaining({ invoiceId: feb, amount: '100.00', surchargeAmount: '100.00' }),
    ]);
    expect(await inv(jan)).toEqual({ status: 'paid', balance: '0.00' });
    expect(await inv(feb)).toMatchObject({ balance: '3050.00' });
    // overpayment: 3,100.00 against 3,050.00 → 50.00 credit, used by the next invoice
    const over = await pay(feb, '3100.00').expect(201);
    expect(over.body).toMatchObject({ allocatedTotal: '3050.00', creditedAmount: '50.00' });
    const next = await invoice(ids.u2!, [['common_fee', '3000.00']], {
      issuedAt: '2027-01-03T09:00:00+07:00',
    });
    // what the invoice.issued subscriber does first (payment-ready): the payer's credit pays the new invoice
    await t.app.get(TenantTx).platform((tx) => t.app.get(PaymentsService).applyCredit(tx, next));
    expect(await inv(next)).toMatchObject({ balance: '2950.00' });
    expect(
      await one(
        `SELECT COALESCE(sum(amount), 0)::text AS c FROM ops.payer_credit WHERE party_id = $1 AND unit_id = $2`,
        [ids.party, ids.u2],
      ),
    ).toEqual({ c: '0.00' });
  });

  it('surcharge_first: every open late fee first, then the principal oldest first', async () => {
    t.clock.advance(60_000);
    await t.http
      .put('/v1/owner/settings/payments.allocation_policy')
      .set(J())
      .send({ value: 'surcharge_first', reason: 'นโยบายนิติบุคคล' })
      .expect(200);
    const jan = await invoice(ids.u3!, [['common_fee', '3000.00']], {
      issuedAt: '2027-01-01T09:00:00+07:00',
    });
    const feb = await invoice(
      ids.u3!,
      [
        ['common_fee', '3000.00'],
        ['late_fee', '150.00'],
      ],
      {
        issuedAt: '2027-01-02T09:00:00+07:00',
      },
    );
    const r = await pay(jan, '3100.00').expect(201);
    expect(r.body.allocations).toEqual([
      expect.objectContaining({ invoiceId: jan, amount: '2950.00', surchargeAmount: '0.00' }),
      expect.objectContaining({ invoiceId: feb, amount: '150.00', surchargeAmount: '150.00' }),
    ]);
    expect(await inv(jan)).toMatchObject({ balance: '50.00' });
    expect(await inv(feb)).toMatchObject({ balance: '3000.00' });
    // the surcharge is paid once: the next payment goes to principal oldest first
    const r2 = await pay(jan, '100.00').expect(201);
    expect(r2.body.allocations).toEqual([
      expect.objectContaining({ invoiceId: jan, amount: '50.00', surchargeAmount: '0.00' }),
      expect.objectContaining({ invoiceId: feb, amount: '50.00', surchargeAmount: '0.00' }),
    ]);
    t.clock.advance(60_000);
    await t.http
      .put('/v1/owner/settings/payments.allocation_policy')
      .set(J())
      .send({ value: 'oldest_first', reason: 'กลับค่าเดิม' })
      .expect(200);
  });

  // --------------------------------------------------------------------------------------- payment plans

  it('payment plan: resident request → approval (credit notes, Σ instalments) → default cancels the future', async () => {
    const a = await invoice(ids.u4!, [['common_fee', '4000.00']]);
    const b = await invoice(ids.u4!, [['common_fee', '6000.00']]);
    const req = await t.http
      .post(`/v1/resident/units/${ids.u4}/payment-plan-requests`)
      .set(R())
      .set(idem())
      .send({ instalments: 3, note: 'ขอผ่อน 3 งวด' })
      .expect(201);
    expect(req.body).toMatchObject({
      state: 'proposed',
      proposedBy: 'resident',
      proposedPrincipal: '10000.00',
      firstDueOn: '2027-02-01',
      nextActions: ['withdraw'],
    });
    ids.plan = req.body.id;
    expect(
      (
        await t.http
          .post(`/v1/resident/units/${ids.u4}/payment-plan-requests`)
          .set(R())
          .set(idem())
          .send({ instalments: 2 })
          .expect(409)
      ).body.code,
    ).toBe('payment_plan.open_exists');
    // tenancy: another tenant / another resident
    await t.http.get(`/v1/owner/juristic/payment-plans/${ids.plan}`).set(bearer(dev)).expect(404);
    await t.http
      .post(`/v1/owner/juristic/payment-plans/${ids.plan}/actions/approve`)
      .set(bearer(dev))
      .set(idem())
      .expect(404);
    await t.http
      .post(`/v1/resident/units/${ids.u4}/payment-plan-requests`)
      .set(bearer(devResident))
      .set(idem())
      .send({ instalments: 2 })
      .expect(404);
    await t.http.get(`/v1/resident/units/${ids.u4}/payment-plans`).set(bearer(devResident)).expect(404);

    const approved = await t.http
      .post(`/v1/owner/juristic/payment-plans/${ids.plan}/actions/approve`)
      .set(J())
      .set(idem())
      .expect(200);
    expect(approved.body).toMatchObject({ state: 'active', principal: '10000.00', defaultAfterDays: 30 });
    expect(
      (approved.body.instalments as { amount: string; dueOn: string }[]).map((i) => [i.amount, i.dueOn]),
    ).toEqual([
      ['3333.33', '2027-02-01'],
      ['3333.33', '2027-03-01'],
      ['3333.34', '2027-04-01'],
    ]);
    expect(approved.body.creditNoteIds).toHaveLength(2);
    expect(await inv(a)).toMatchObject({ balance: '0.00' });
    expect(await inv(b)).toMatchObject({ balance: '0.00' });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM ops.credit_note WHERE id = ANY($1::uuid[]) AND reason = 'payment_plan'`,
        [approved.body.creditNoteIds],
      ),
    ).toEqual({ n: 2 });

    const plans = t.app.get(PaymentPlansService);
    expect((await plans.maintain()).queued).toBe(0); // January: nothing due yet
    t.clock.set(new Date('2027-02-01T09:00:00+07:00'));
    expect((await plans.maintain()).queued).toBe(1);
    const charge = await one<{ id: string; amount: string; line_kind: string; status: string }>(
      `SELECT c.id, c.amount::text, c.line_kind::text, c.status::text FROM ops.invoice_charge c
         JOIN juristic.payment_plan_instalment i ON i.invoice_charge_id = c.id WHERE i.plan_id = $1 AND i.seq = 1`,
      [ids.plan],
    );
    expect(charge).toMatchObject({ amount: '3333.33', line_kind: 'plan_instalment', status: 'pending' });
    // the monthly cycle bills it (issued 1 Feb, due 5 Feb) — and nobody pays
    const billed = await invoice(ids.u4!, [['plan_instalment', '3333.33', charge.id]], {
      issuedAt: '2027-02-01T09:00:00+07:00',
      dueDate: '2027-02-05',
    });
    const line = await one<{ id: string }>(`SELECT id FROM ops.invoice_line WHERE invoice_id = $1`, [billed]);
    await q(`UPDATE ops.invoice_charge SET status = 'applied', applied_invoice_line_id = $2 WHERE id = $1`, [
      charge.id,
      line.id,
    ]);
    t.clock.set(new Date('2027-03-07T09:00:00+07:00'));
    expect((await plans.maintain()).defaulted).toBe(0); // still inside 30 days after 5 Feb (the 2nd is queued)
    t.clock.set(new Date('2027-03-08T09:00:00+07:00'));
    expect((await plans.maintain()).defaulted).toBe(1);
    // back to the day the tokens were issued (the rest of the suite runs on 10 January)
    t.clock.set(new Date('2027-01-10T10:00:00+07:00'));
    await relogin();
    const plan = (await t.http.get(`/v1/owner/juristic/payment-plans/${ids.plan}`).set(J()).expect(200))
      .body as { state: string; instalments: { state: string }[]; acceleratedChargeId: string };
    expect(plan.state).toBe('defaulted');
    expect((plan.instalments as { state: string }[]).map((i) => i.state)).toEqual([
      'billed',
      'cancelled',
      'cancelled',
    ]);
    expect(
      await one(`SELECT amount::text, status::text, line_kind::text FROM ops.invoice_charge WHERE id = $1`, [
        plan.acceleratedChargeId,
      ]),
    ).toEqual({ amount: '6666.67', status: 'pending', line_kind: 'plan_instalment' });
    // the cancelled 2nd instalment's charge never bills on its own
    expect(
      await one(
        `SELECT c.status::text FROM ops.invoice_charge c JOIN juristic.payment_plan_instalment i ON i.invoice_charge_id = c.id
          WHERE i.plan_id = $1 AND i.seq = 2`,
        [ids.plan],
      ),
    ).toEqual({ status: 'cancelled' });
    // owed is preserved: the unpaid instalment invoice + the accelerated rest = the principal
    expect(3333.33 + 6666.67).toBeCloseTo(10000, 2);
    const ev = await one<{ payload: { accelerated: string; partyId: string } }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'juristic.payment_plan.defaulted' AND aggregate_id = $1`,
      [ids.plan],
    );
    expect(ev.payload).toMatchObject({ accelerated: '6666.67', partyId: ids.party });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'juristic.payment_plan_defaulted' AND subject_id = $1`,
        [ids.plan],
      ),
    ).toEqual({ n: 1 });
  });

  // --------------------------------------------------------------------------------------- recurring

  it('recurring: mandate activated by a signed webhook, an advance invoice charged and paid, replays idempotent', async () => {
    const fake = t.app.get<FakeRecurringPayments>(RECURRING_PAYMENTS);
    const created = await t.http
      .post(`/v1/resident/units/${ids.u5}/payment-mandates`)
      .set(R())
      .set(idem())
      .send({ method: 'direct_debit' })
      .expect(201);
    expect(created.body.mandate).toMatchObject({
      state: 'pending',
      scope: 'advance_invoices',
      provider: 'fake',
    });
    expect(created.body.setupUrl).toContain('/webhooks/recurring/fake/mandates/');
    const mandateId = created.body.mandate.id as string;
    const ref = (
      await one<{ r: string }>(`SELECT mandate_ref AS r FROM ops.payment_mandate WHERE id = $1`, [mandateId])
    ).r;
    await t.http
      .post(`/v1/resident/units/${ids.u5}/payment-mandates`)
      .set(R())
      .set(idem())
      .send({ method: 'card_token' })
      .expect(409);
    const hook = (e: { body: string; headers: Record<string, string> }) =>
      t.http
        .post('/webhooks/recurring/fake')
        .set(e.headers)
        .set('content-type', 'application/json')
        .send(e.body);
    const activated = fake.event({ type: 'mandate.activated', mandateRef: ref, masked: 'xxx-x-x1234-x' });
    expect((await hook(activated).expect(200)).body).toEqual({ received: true, duplicate: false });
    expect((await hook(activated).expect(200)).body).toEqual({ received: true, duplicate: true });
    await hook({ body: activated.body, headers: { 'x-recurring-signature': 'ab'.repeat(32) } }).expect(401);
    const list = await t.http.get(`/v1/resident/units/${ids.u5}/payment-mandates`).set(R()).expect(200);
    expect(list.body[0]).toMatchObject({ state: 'active', masked: 'xxx-x-x1234-x' });

    // an annual (advance) invoice is charged when it is ready; a monthly one is not (scope advance_invoices)
    const cycle = (
      await one<{ id: string }>(
        `INSERT INTO ops.billing_cycle (tenant_id, property_id, period_key, period_start, period_end, cut_off_at, readings_window_minutes,
                                        grace_deadline_at, estimate_policy, frequency)
         VALUES ($1, $2, '2027', '2027-01-01', '2027-12-31', '2027-01-01T00:00:00+07:00', 0, '2027-01-01T00:00:00+07:00', 'allow', 'annual')
         RETURNING id`,
        [jur.tenantId, ids.property],
      )
    ).id;
    const annual = await invoice(ids.u5!, [['common_fee', '16380.00']], { cycleId: cycle });
    const monthly = await invoice(ids.u5!, [['common_fee', '1365.00']]);
    // the recurring-charge subscriber of invoice.payment_ready, as the worker runs it
    for (const id of [annual, monthly])
      await t.app.get(TenantTx).platform((tx) =>
        t.app.get(RecurringPaymentsService).handle(
          {
            id: id,
            type: 'invoice.payment_ready',
            aggregateType: 'invoice',
            aggregateId: id,
            tenantId: jur.tenantId,
            buildingId: ids.building,
            payload: { invoiceId: id },
          } as unknown as DomainEventEnvelope,
          tx,
        ),
      );
    const charges = await q<{ invoice_id: string; amount: string; state: string; charge_ref: string }>(
      `SELECT invoice_id, amount::text, state::text, charge_ref FROM ops.recurring_charge WHERE mandate_id = $1`,
      [mandateId],
    );
    expect(charges).toEqual([
      { invoice_id: annual, amount: '16380.00', state: 'pending', charge_ref: expect.any(String) },
    ]);
    const succeeded = fake.event({
      type: 'charge.succeeded',
      mandateRef: ref,
      chargeRef: charges[0]!.charge_ref,
      amount: '16380.00',
    });
    expect((await hook(succeeded).expect(200)).body).toEqual({ received: true, duplicate: false });
    expect((await hook(succeeded).expect(200)).body).toEqual({ received: true, duplicate: true });
    // another delivery of the same outcome under a new event id changes nothing either
    await hook(
      fake.event({
        type: 'charge.succeeded',
        mandateRef: ref,
        chargeRef: charges[0]!.charge_ref,
        amount: '16380.00',
      }),
    ).expect(200);
    await settle();
    expect(await inv(annual)).toEqual({ status: 'paid', balance: '0.00' });
    expect(await inv(monthly)).toMatchObject({ balance: '1365.00' });
    const pays = await q<{ method: string; amount: string }>(
      `SELECT method::text, amount::text FROM ops.payment WHERE tenant_id = $1 AND method = 'recurring'`,
      [jur.tenantId],
    );
    expect(pays).toEqual([{ method: 'recurring', amount: '16380.00' }]);
    // tenancy
    const devList = await t.http.get('/v1/owner/payment-mandates').set(bearer(dev)).expect(200);
    expect(devList.body.data).toEqual([]);
    await t.http
      .post(`/v1/owner/payment-mandates/${mandateId}/actions/revoke`)
      .set(bearer(dev))
      .send({ reason: 'ทดสอบ' })
      .expect(404);
    await t.http.get(`/v1/resident/units/${ids.u5}/payment-mandates`).set(bearer(devResident)).expect(404);
    const ownerList = await t.http.get('/v1/owner/payment-mandates').set(J()).expect(200);
    expect(ownerList.body.data).toHaveLength(1);
    // the resident stops it
    const stopped = await t.http
      .post(`/v1/resident/units/${ids.u5}/payment-mandates/${mandateId}/actions/cancel`)
      .set(R())
      .expect(200);
    expect(stopped.body.state).toBe('revoked');
    await q(`UPDATE ops.invoice SET status = 'void', voided_at = now() WHERE id = $1`, [monthly]);
  });

  // --------------------------------------------------------------------------------------- debt clearance

  it('debt clearance: refused with 0.01 outstanding, issued at 0, verify page minimal, cross-tenant 404', async () => {
    // A-101 still owes the 1,000.00 invoice of the slip test: pay it but 0.01
    await pay(ids.jInvSlip!, '999.99').expect(201);
    const refused = await t.http
      .post(`/v1/resident/units/${ids.u1}/debt-clearance-requests`)
      .set(R())
      .set(idem())
      .send({})
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'debt_clearance.outstanding', outstanding: '0.01' });
    expect(
      await one(`SELECT count(*)::int AS n FROM juristic.debt_clearance WHERE unit_id = $1`, [ids.u1]),
    ).toEqual({
      n: 0,
    });
    await pay(ids.jInvSlip!, '0.01').expect(201);
    const issued = await t.http
      .post(`/v1/resident/units/${ids.u1}/debt-clearance-requests`)
      .set(R())
      .set(idem())
      .send({ asOf: '2027-01-15' })
      .expect(201);
    expect(issued.body).toMatchObject({
      state: 'issued',
      number: 'DCL-2027-00001',
      asOf: '2027-01-15',
      validUntil: '2027-02-09',
      fee: '0.00',
      verifyCode: expect.stringMatching(/^[0-9A-Z]{10}$/),
    });
    const code = issued.body.verifyCode as string;
    expect(await one(`SELECT kind::text FROM core.document WHERE id = $1`, [issued.body.documentId])).toEqual(
      {
        kind: 'pdf_certificate',
      },
    );
    expect(
      await one(`SELECT verify_code_hash IS NOT NULL AS h FROM juristic.debt_clearance WHERE id = $1`, [
        issued.body.id,
      ]),
    ).toEqual({ h: true });
    // public verification: type, number, validity, issuer, unit number, initials — nothing else
    const v = await t.http.get(`/v1/public/documents/verify/${code.toLowerCase()}`).expect(200);
    expect(v.body).toEqual({
      documentType: 'debt_clearance',
      number: 'DCL-2027-00001',
      status: 'valid',
      issuedAt: expect.any(String),
      validUntil: '2027-02-09',
      asOf: '2027-01-15',
      issuer: 'Tenant j12a-juristic',
      unitNo: 'A-101',
      holderInitials: 'ส. จ.',
    });
    expect(JSON.stringify(v.body)).not.toContain('สมชาย');
    await t.http.get('/v1/public/documents/verify/ZZZZZZZZZZ').expect(404);
    // documents and lists
    const list = await t.http.get(`/v1/resident/units/${ids.u1}/debt-clearances`).set(R()).expect(200);
    expect(list.body[0]).toMatchObject({ number: 'DCL-2027-00001', verifyCode: null });
    await t.http
      .get(`/v1/resident/units/${ids.u1}/debt-clearances/${issued.body.id}/document`)
      .set(R())
      .expect(200);
    const ownerDoc = await t.http
      .get(`/v1/owner/juristic/debt-clearances/${issued.body.id}/document`)
      .set(J())
      .expect(200);
    expect(ownerDoc.body.number).toBe('DCL-2027-00001');
    await settle();
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = 'juristic.debt_clearance.issued' AND e.aggregate_id = $1`,
        [issued.body.id],
      ),
    ).toMatchObject({ n: expect.any(Number) });
    // tenancy
    await t.http.get(`/v1/owner/juristic/debt-clearances/${issued.body.id}`).set(bearer(dev)).expect(404);
    await t.http
      .get(`/v1/owner/juristic/debt-clearances/${issued.body.id}/document`)
      .set(bearer(dev))
      .expect(404);
    await t.http
      .post(`/v1/resident/units/${ids.u1}/debt-clearance-requests`)
      .set(bearer(devResident))
      .set(idem())
      .send({})
      .expect(404);
    await t.http
      .post('/v1/owner/juristic/debt-clearances')
      .set(bearer(dev))
      .set(idem())
      .send({ unitId: ids.u1, partyId: ids.party })
      .expect(404);
    // with a fee the request waits; the office refuses it (fee charge cancelled)
    t.clock.advance(60_000);
    await t.http
      .put('/v1/owner/settings/juristic.debt_clearance.fee')
      .set(J())
      .send({ value: '100.00', reason: 'ค่าธรรมเนียมตามมติ' })
      .expect(200);
    const waiting = await t.http
      .post('/v1/owner/juristic/debt-clearances')
      .set(J())
      .set(idem())
      .send({ unitId: ids.u1, partyId: ids.party })
      .expect(201);
    expect(waiting.body).toMatchObject({
      state: 'requested',
      fee: '100.00',
      number: null,
      nextActions: ['issue', 'refuse'],
    });
    expect(
      (
        await t.http
          .post(`/v1/owner/juristic/debt-clearances/${waiting.body.id}/actions/issue`)
          .set(J())
          .set(idem())
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'debt_clearance.outstanding', outstanding: '100.00' });
    const no = await t.http
      .post(`/v1/owner/juristic/debt-clearances/${waiting.body.id}/actions/refuse`)
      .set(J())
      .send({ reason: 'ยังไม่ชำระค่าธรรมเนียม' })
      .expect(200);
    expect(no.body).toMatchObject({ state: 'refused', refuseReason: 'ยังไม่ชำระค่าธรรมเนียม' });
    expect(
      await one(`SELECT status::text FROM ops.invoice_charge WHERE source_id = $1`, [waiting.body.id]),
    ).toEqual({ status: 'cancelled' });
    // a party who does not own the unit
    await t.http
      .post('/v1/owner/juristic/debt-clearances')
      .set(J())
      .set(idem())
      .send({ unitId: ids.u1, partyId: DEV.residentPartyId })
      .expect(422);
    const owned = await t.http.get('/v1/owner/juristic/debt-clearances').set(J()).expect(200);
    expect(owned.body.data).toHaveLength(2);
    expect(
      (await t.http.get('/v1/owner/juristic/debt-clearances').set(bearer(dev)).expect(200)).body.data,
    ).toEqual([]);
    expect(
      (await t.http.get('/v1/owner/juristic/payment-plans').set(bearer(dev)).expect(200)).body.data,
    ).toEqual([]);
  });
});
