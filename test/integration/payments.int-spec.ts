import 'reflect-metadata';

import { bangkokDate } from '@common/time/bangkok';
import { TenantTx } from '@database/tenant-tx';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import {
  type FakePaymentProviders,
  fakeWebhookSecret,
  signFakeWebhook,
} from '@integrations/payments/fake-payment-providers';
import { PAYMENT_PROVIDERS } from '@integrations/payments/payment-provider.port';
import { parseThaiQr } from '@integrations/payments/thai-qr';
import { MerchantResolver } from '@modules/ops-payments/merchants';
import { PaymentWebhooksService } from '@modules/ops-payments/payment-webhooks.service';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { SettlementsService } from '@modules/ops-payments/settlements.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
);
const LINE_SUB = 'U00000000000000000000000000b4b401';
const MERCHANT_A = '010555000000101';
const MERCHANT_B = '010555000000202';
const PHONE_B = '+660000000144';

/** A slip image the fake verifier reads (a PNG followed by the JSON the verifier would return). */
const slipImage = (j: Record<string, string>) =>
  Buffer.concat([PNG, Buffer.from(JSON.stringify({ transRef: j.transRef, ...j }))]).toString('base64');

/**
 * B4.4 acceptance (payments): the Thai QR (Tag 30) of each invoice through the tenant's own merchant; provider
 * callback → paid → receipt; duplicate callbacks ignored; tenant B's callback cannot pay tenant A's invoice;
 * partial payments only when enabled; overpayment → credit → used by the next invoice → refunded; slips verified
 * automatically, forged / duplicate / wrong-account / wrong-amount slips to the owner's review; the settlement file
 * and the daily reconcile create the payment of a missed callback; reversal voids the receipt; cross-tenant 404s
 * and RLS.
 */
describe('B4.4 payments, slips, settlement, receipts (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let resident: string;
  let other: { tenantId: string; token: string };
  let unitId = '';
  let accountA = '';
  let fake: ReturnType<FakePaymentProviders['adapter']>;
  let month = 0;
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const R = () => bearer(resident);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };

  async function bankAccount(token: string, phone: string, input: Record<string, unknown>): Promise<string> {
    const res = await t.http
      .post('/v1/owner/bank-accounts')
      .set(bearer(token))
      .set(idem())
      .send(input)
      .expect(201);
    await t.http
      .post(`/v1/owner/bank-accounts/${res.body.account.id}/actions/confirm`)
      .set(bearer(token))
      .send({ challengeId: res.body.otp.challengeId, code: t.sms.lastCodeTo(phone) })
      .expect(200);
    return res.body.account.id as string;
  }

  /** A ready draft of A-101 for `total`, issued through the API; the worker then sets up its QR and PDF. */
  async function issue(total: string): Promise<{ id: string; number: string; ref: string }> {
    month += 1;
    const start = `2025-${String(month).padStart(2, '0')}-01`;
    const id = (
      await q<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                  subtotal, total, balance)
         VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, $7, $7, $7)
         RETURNING id`,
        [DEV.tenantId, DEV.buildingId, unitId, DEV.residentPartyId, DEV.leaseId, start, total],
      )
    )[0]!.id;
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
       VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', $3, $3)`,
      [DEV.tenantId, id, total],
    );
    const res = await t.http
      .post(`/v1/owner/invoices/${id}/actions/issue`)
      .set(O())
      .set(idem())
      .send({})
      .expect(200);
    await settle();
    const ref = (await q<{ r: string }>('SELECT promptpay_ref AS r FROM ops.invoice WHERE id = $1', [id]))[0]!
      .r;
    return { id, number: res.body.number as string, ref };
  }

  const invoice = async (id: string) =>
    (
      await q<{ status: string; balance: string; paid_total: string }>(
        'SELECT status::text, balance::text, paid_total::text FROM ops.invoice WHERE id = $1',
        [id],
      )
    )[0]!;

  const callback = (provider: string, body: string, headers: Record<string, string>) =>
    t.http
      .post(`/webhooks/payments/${provider}`)
      .set(headers)
      .set('content-type', 'application/json')
      .send(body);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_pay' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b44',
      phone: PHONE_B,
      type: 'apartment',
    });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    fake = t.app.get<FakePaymentProviders>(PAYMENT_PROVIDERS).adapter('kbank');
    accountA = await bankAccount(owner, '+660000000001', {
      bankCode: '004',
      bankNameTh: 'ธนาคารตัวอย่าง',
      accountNo: '123-4-56789-0',
      accountName: 'บริษัท ตัวอย่าง จำกัด',
      isDefault: true,
      paymentProvider: 'kbank',
      providerMerchantRef: MERCHANT_A,
    });
    await bankAccount(other.token, PHONE_B, {
      bankCode: '014',
      bankNameTh: 'ธนาคารอื่น',
      accountNo: '999-9-99999-1',
      accountName: 'บริษัท อื่น จำกัด',
      isDefault: true,
      paymentProvider: 'kbank',
      providerMerchantRef: MERCHANT_B,
    });
    // the resident of A-101 signs in through LINE and accepts the lease invitation
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(O())
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
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)
    ).body.accessToken as string;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('issuing an invoice creates its Thai QR (Tag 30) for what is due, through my own merchant account', async () => {
    const inv = await issue('5344.00');
    ids.inv1 = inv.id;
    ids.ref1 = inv.ref;
    expect(inv.ref).toBe(inv.number.replace(/-/g, ''));
    const qr = await q<{
      amount: string;
      reference: string;
      payload: string;
      bank_account_id: string;
      status: string;
    }>(
      `SELECT amount::text, reference, payload, bank_account_id, status::text FROM ops.payment_qr_code WHERE invoice_id = $1`,
      [inv.id],
    );
    expect(qr).toHaveLength(1);
    expect(qr[0]).toMatchObject({
      amount: '5344.00',
      reference: inv.ref,
      bank_account_id: accountA,
      status: 'active',
    });
    expect(parseThaiQr(qr[0]!.payload)).toMatchObject({
      dynamic: true,
      billerId: MERCHANT_A,
      ref1: inv.ref,
      amount: '5344.00',
      currency: '764',
      crcValid: true,
    });
    const stored = await q<{ qr_payload: string }>('SELECT qr_payload FROM ops.invoice WHERE id = $1', [
      inv.id,
    ]);
    expect(stored[0]!.qr_payload).toBe(qr[0]!.payload);
    // the payment_ready event carries it to the PDF / Flex
    const ready = await q<{ payload: { qr: boolean } }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'invoice.payment_ready' AND aggregate_id = $1`,
      [inv.id],
    );
    expect(ready[0]!.payload.qr).toBe(true);
    // the resident's payment page shows the same QR and the account (masked)
    const page = await t.http.get(`/v1/resident/invoices/${inv.id}/payment`).set(R()).expect(200);
    expect(page.body).toMatchObject({
      number: inv.number,
      due: '5344.00',
      qr: { payload: qr[0]!.payload, amount: '5344.00', reference: inv.ref },
      // LIFF #20 (D-209): the full receiving account and its bank while something is due (the reveal is audited)
      account: { accountNoMasked: expect.stringMatching(/7890$/), accountNo: '1234567890', bankCode: '004' },
      allowSlip: true,
      allowPartial: false,
    });
  });

  it('provider callback → paid → receipt; a repeated callback is ignored; a bad signature is refused', async () => {
    const cb = fake.simulatePayment({
      merchantRef: MERCHANT_A,
      reference: ids.ref1!,
      amount: '5344.00',
      providerRef: 'KB-0001',
      paidAt: t.clock.now(),
    });
    const res = await callback('kbank', cb.body, cb.headers).expect(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
    await settle();
    expect(await invoice(ids.inv1!)).toEqual({ status: 'paid', balance: '0.00', paid_total: '5344.00' });
    const pays = await t.http.get(`/v1/owner/payments?invoiceId=${ids.inv1}`).set(O()).expect(200);
    expect(pays.body.data).toHaveLength(1);
    const p = pays.body.data[0];
    expect(p).toMatchObject({
      status: 'confirmed',
      method: 'qr',
      confirmedVia: 'webhook',
      amount: '5344.00',
      allocatedTotal: '5344.00',
      creditedAmount: '0.00',
      provider: 'kbank',
      providerRef: 'KB-0001',
      allocations: [{ invoiceId: ids.inv1, amount: '5344.00', reversedAt: null }],
      receipts: [{ number: expect.stringMatching(/^RCP-\d{4}-00001$/), kind: 'payment', voided: false }],
      nextActions: ['reverse'],
    });
    ids.pay1 = p.id;
    ids.receipt1 = p.receipts[0].id;
    const qr = await q<{ status: string }>(
      `SELECT status::text FROM ops.payment_qr_code WHERE invoice_id = $1`,
      [ids.inv1],
    );
    expect(qr[0]!.status).toBe('paid');
    // receipt PDF stored, receipt.issued announced
    const doc = await t.http.get(`/v1/owner/receipts/${ids.receipt1}/document`).set(O()).expect(200);
    expect(doc.body).toMatchObject({ number: expect.stringMatching(/^RCP-/), url: expect.any(String) });
    const issued = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'receipt.issued' AND aggregate_id = $1`,
      [ids.receipt1],
    );
    expect(issued[0]!.n).toBe(1);
    // the same callback again: acknowledged as a duplicate, nothing new
    const again = await callback('kbank', cb.body, cb.headers).expect(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    // a second event for the same provider transaction: processed, no second payment
    const body2 = cb.body.replace('evt_KB-0001', 'evt_KB-0001-retry');
    await callback('kbank', body2, {
      'x-provider-signature': signFakeWebhook(body2, fakeWebhookSecret('kbank', MERCHANT_A)),
    }).expect(200);
    await settle();
    const count = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.payment WHERE provider_ref = 'KB-0001'`,
    );
    expect(count[0]!.n).toBe(1);
    const hooks = await q<{ outcome: string; detail: string }>(
      `SELECT outcome::text, detail FROM ops.payment_webhook WHERE event_id = 'evt_KB-0001-retry'`,
    );
    expect(hooks[0]).toEqual({ outcome: 'processed', detail: 'duplicate' });
    // tampered body or no signature → 401, logged without the body
    const forged = cb.body.replace('KB-0001', 'KB-0666');
    const bad = await callback('kbank', forged, cb.headers).expect(401);
    expect(bad.body.code).toBe('webhook.signature_invalid');
    const rejected = await q<{ outcome: string; payload: unknown }>(
      `SELECT outcome::text, payload FROM ops.payment_webhook WHERE signature_valid = false`,
    );
    expect(rejected[0]).toMatchObject({ outcome: 'rejected' });
    expect((await callback('kbank', '{"nope":true}', {}).expect(422)).body.code).toBe('webhook.malformed');
    await callback('unknownbank', cb.body, cb.headers).expect(404);
  });

  it('tenant B’s callback with my invoice reference cannot pay my invoice', async () => {
    const inv = await issue('1000.00');
    ids.inv2 = inv.id;
    ids.ref2 = inv.ref;
    // B's own merchant, validly signed by B, quoting A's reference
    const cb = fake.simulatePayment({
      merchantRef: MERCHANT_B,
      reference: inv.ref,
      amount: '1000.00',
      providerRef: 'KB-B-0001',
      paidAt: t.clock.now(),
    });
    await callback('kbank', cb.body, cb.headers).expect(200);
    await settle();
    expect(await invoice(inv.id)).toMatchObject({ status: 'issued', balance: '1000.00' });
    const hook = await q<{ outcome: string; detail: string; tenant_id: string }>(
      `SELECT outcome::text, detail, tenant_id FROM ops.payment_webhook WHERE event_id = 'evt_KB-B-0001'`,
    );
    expect(hook[0]).toEqual({ outcome: 'ignored', detail: 'other_merchant', tenant_id: other.tenantId });
    expect((await q(`SELECT 1 FROM ops.payment WHERE provider_ref = 'KB-B-0001'`)).length).toBe(0);
    // B pretending to be A's merchant: signed with B's secret → refused
    const spoof = cb.body.replace(MERCHANT_B, MERCHANT_A);
    await callback('kbank', spoof, {
      'x-provider-signature': signFakeWebhook(spoof, fakeWebhookSecret('kbank', MERCHANT_B)),
    }).expect(401);
  });

  it('partial payments only when enabled; a transfer recorded by hand needs its evidence', async () => {
    const cash = (amount: string) =>
      t.http.post('/v1/owner/payments').set(O()).set(idem()).send({
        invoiceId: ids.inv2,
        amount,
        method: 'cash',
        paidAt: t.clock.now().toISOString(),
        reference: 'เงินสด',
      });
    const refused = await cash('400.00').expect(422);
    expect(refused.body).toMatchObject({ code: 'payment.partial_not_allowed' });
    await t.http
      .put('/v1/owner/settings/payments.allow_partial')
      .set(O())
      .send({ value: true, reason: 'รับชำระบางส่วน' })
      .expect(200);
    const ok = await cash('400.00').expect(201);
    expect(ok.body).toMatchObject({
      method: 'cash',
      confirmedVia: 'manual',
      amount: '400.00',
      allocations: [{ invoiceId: ids.inv2, amount: '400.00' }],
    });
    ids.payCash = ok.body.id;
    expect(await invoice(ids.inv2!)).toMatchObject({ status: 'partially_paid', balance: '600.00' });
    await settle();
    // the QR follows what is still due
    const page = await t.http.get(`/v1/resident/invoices/${ids.inv2}/payment`).set(R()).expect(200);
    expect(page.body).toMatchObject({ due: '600.00', qr: { amount: '600.00' }, allowPartial: true });
    const noEvidence = await t.http
      .post('/v1/owner/payments')
      .set(O())
      .set(idem())
      .send({
        invoiceId: ids.inv2,
        amount: '100.00',
        method: 'bank_transfer_manual',
        paidAt: t.clock.now().toISOString(),
      })
      .expect(422);
    expect(noEvidence.body.errors[0]).toMatchObject({ path: 'evidenceDocumentId' });
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'payment.recorded' AND subject_id = $1`,
      [ids.payCash],
    );
    expect(audit[0]!.n).toBe(1);
  });

  it('overpayment becomes the payer’s credit, pays the next invoice first, the rest is refunded with evidence', async () => {
    const cb = fake.simulatePayment({
      merchantRef: MERCHANT_A,
      reference: ids.ref2!,
      amount: '700.00',
      providerRef: 'KB-0002',
      paidAt: t.clock.now(),
    });
    await callback('kbank', cb.body, cb.headers).expect(200);
    await settle();
    expect(await invoice(ids.inv2!)).toMatchObject({ status: 'paid', balance: '0.00' });
    const qrPays = (await t.http.get('/v1/owner/payments?method=qr').set(O()).expect(200)).body.data as {
      id: string;
      providerRef: string;
    }[];
    const p = qrPays.find((x) => x.providerRef === 'KB-0002')!;
    expect(p).toMatchObject({ amount: '700.00', allocatedTotal: '600.00', creditedAmount: '100.00' });
    ids.pay2 = p.id;
    const lines = await q<{ lines: { amount: string }[] }>(
      'SELECT lines FROM ops.receipt WHERE payment_id = $1',
      [p.id],
    );
    expect(lines[0]!.lines.map((l) => l.amount)).toEqual(['600.00', '100.00']);
    const credits = await t.http
      .get(`/v1/owner/payer-credits?partyId=${DEV.residentPartyId}`)
      .set(O())
      .expect(200);
    expect(credits.body).toEqual([
      expect.objectContaining({ partyId: DEV.residentPartyId, unitId, unitNo: 'A-101', balance: '100.00' }),
    ]);

    // the next invoice is paid by the credit first; its QR asks for the rest
    const inv3 = await issue('1000.00');
    ids.inv3 = inv3.id;
    expect(await invoice(inv3.id)).toMatchObject({ status: 'partially_paid', balance: '900.00' });
    const offset = await q<{ method: string; confirmed_via: string; amount: string }>(
      `SELECT method::text, confirmed_via::text, amount::text FROM ops.payment WHERE invoice_id = $1`,
      [inv3.id],
    );
    expect(offset).toEqual([{ method: 'offset', confirmed_via: 'credit', amount: '100.00' }]);
    const qr = await q<{ amount: string }>(
      `SELECT amount::text FROM ops.payment_qr_code WHERE invoice_id = $1 AND status = 'active'`,
      [inv3.id],
    );
    expect(qr[0]!.amount).toBe('900.00');
    // the credit used, the payment that made it cannot be reversed any more
    const used = await t.http
      .post(`/v1/owner/payments/${ids.pay2}/actions/reverse`)
      .set(O())
      .set(idem())
      .send({ reason: 'ทดสอบ' })
      .expect(409);
    expect(used.body.code).toBe('payment.credit_used');

    // 950 by transfer (with evidence) for 900 due → 50 credit → refunded
    const evidence = await uploadFile(t, db, owner, {
      kind: 'slip',
      scopeType: 'unit',
      scopeId: unitId,
      fileName: 'transfer.png',
      mimeType: 'image/png',
      body: PNG,
    });
    const transfer = await t.http
      .post('/v1/owner/payments')
      .set(O())
      .set(idem())
      .send({
        invoiceId: inv3.id,
        amount: '950.00',
        method: 'bank_transfer_manual',
        paidAt: t.clock.now().toISOString(),
        evidenceDocumentId: evidence,
      })
      .expect(201);
    expect(transfer.body).toMatchObject({
      allocatedTotal: '900.00',
      creditedAmount: '50.00',
      evidenceDocumentId: evidence,
    });
    const refund = (amount: string) =>
      t.http.post('/v1/owner/refunds').set(O()).set(idem()).send({
        partyId: DEV.residentPartyId,
        unitId,
        amount,
        method: 'cash',
        refundedAt: t.clock.now().toISOString(),
        note: 'คืนเงินส่วนเกิน',
      });
    expect((await refund('60.00').expect(422)).body.code).toBe('refund.exceeds_credit');
    expect((await refund('50.00').expect(201)).body).toMatchObject({ amount: '50.00', creditAfter: '0.00' });
    const ledger = await q<{ kind: string; amount: string }>(
      `SELECT kind::text, amount::text FROM ops.payer_credit WHERE party_id = $1 ORDER BY created_at, id`,
      [DEV.residentPartyId],
    );
    expect(ledger).toEqual([
      { kind: 'overpayment', amount: '100.00' },
      { kind: 'applied', amount: '-100.00' },
      { kind: 'overpayment', amount: '50.00' },
      { kind: 'refunded', amount: '-50.00' },
    ]);
    // the credit ledger is append-only
    await expect(db.admin.query(`UPDATE ops.payer_credit SET amount = 0`)).rejects.toThrow();
  });

  it('a real slip for what is due is confirmed automatically', async () => {
    const inv = await issue('1000.00');
    ids.inv4 = inv.id;
    const res = await t.http
      .post(`/v1/resident/invoices/${inv.id}/slips`)
      .set(R())
      .send({
        image: slipImage({
          transRef: 'SLIP-T-0001',
          amount: '1000.00',
          paidAt: t.clock.now().toISOString(),
          receiverBankCode: '004',
          receiverAccount: 'xxx-x-x7890-x',
          senderName: 'นาย ทดสอบ',
        }),
        mimeType: 'image/png',
      })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'pending_verification' });
    await settle();
    const slip = await q<{ status: string; reasons: string[]; payment_id: string }>(
      'SELECT status::text, reasons, payment_id FROM ops.slip_review WHERE id = $1',
      [res.body.id],
    );
    expect(slip[0]).toMatchObject({ status: 'auto_confirmed', reasons: [] });
    expect(await invoice(inv.id)).toMatchObject({ status: 'paid', balance: '0.00' });
    const pay = (await t.http.get(`/v1/owner/payments/${slip[0]!.payment_id}`).set(O()).expect(200)).body;
    expect(pay).toMatchObject({
      method: 'transfer_slip',
      confirmedVia: 'slip_verified',
      slipReviewId: res.body.id,
    });
    ids.paySlip = pay.id;
    // the slip image is a scanned, PDPA-audited document
    const doc = await q<{ kind: string }>(
      'SELECT d.kind::text FROM core.document d JOIN ops.slip_review s ON s.slip_document_id = d.id WHERE s.id = $1',
      [res.body.id],
    );
    expect(doc[0]!.kind).toBe('slip');
  });

  it('forged, duplicate, wrong-account and wrong-amount slips wait for the owner; the owner decides', async () => {
    const inv = await issue('1000.00');
    ids.inv5 = inv.id;
    const send = async (image: string) =>
      (
        await t.http
          .post(`/v1/resident/invoices/${inv.id}/slips`)
          .set(R())
          .send({ image, mimeType: 'image/png' })
          .expect(201)
      ).body.id as string;
    const good = { amount: '1000.00', receiverBankCode: '004', receiverAccount: 'xxx-x-x7890-x' };
    const dup = await send(slipImage({ transRef: 'SLIP-T-0001', ...good }));
    const forged = await send(PNG.toString('base64'));
    const above = await send(slipImage({ transRef: 'SLIP-T-0002', ...good, amount: '1200.00' }));
    const wrongAccount = await send(
      slipImage({ transRef: 'SLIP-T-0003', ...good, receiverAccount: 'xxx-x-x1111-x' }),
    );
    await settle();
    const queue = await t.http.get('/v1/owner/slip-reviews').set(O()).expect(200);
    const byId = new Map((queue.body.data as { id: string }[]).map((s) => [s.id, s]));
    expect(byId.get(dup)).toMatchObject({ status: 'duplicate', reasons: ['duplicate_reference'] });
    expect(byId.get(forged)).toMatchObject({ status: 'pending_review', reasons: ['not_recognised'] });
    expect(byId.get(above)).toMatchObject({ status: 'pending_review', reasons: ['amount_above_due'] });
    expect(byId.get(wrongAccount)).toMatchObject({
      status: 'pending_review',
      reasons: ['receiver_mismatch'],
      receiverAccountMasked: 'xxx1111',
      nextActions: ['approve', 'reject'],
    });
    const dupDetail = await t.http.get(`/v1/owner/slip-reviews/${dup}`).set(O()).expect(200);
    expect(dupDetail.body).toMatchObject({ duplicateOfId: expect.any(String), imageUrl: expect.any(String) });
    const events = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'slip.review_requested' AND payload->>'invoiceId' = $1`,
      [inv.id],
    );
    expect(events[0]!.n).toBe(4);
    expect(await invoice(inv.id)).toMatchObject({ status: 'issued' });

    const decide = (id: string, body: Record<string, unknown>) =>
      t.http.post(`/v1/owner/slip-reviews/${id}/actions/decide`).set(O()).set(idem()).send(body);
    // a transfer already used by an earlier slip cannot pay twice
    expect((await decide(dup, { action: 'approve' }).expect(409)).body.code).toBe('slip.invalid_state');
    await decide(dup, { action: 'reject' }).expect(422);
    expect((await decide(forged, { action: 'reject', reason: 'สลิปปลอม' }).expect(200)).body).toMatchObject({
      status: 'rejected',
      rejectReason: 'สลิปปลอม',
      nextActions: [],
    });
    const approved = await decide(wrongAccount, { action: 'approve', amount: '1000.00' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'approved', paymentId: expect.any(String) });
    expect(await invoice(inv.id)).toMatchObject({ status: 'paid' });
    expect((await decide(above, { action: 'approve' }).expect(409)).body.code).toBe('invoice.nothing_due');
    await decide(above, { action: 'reject', reason: 'ชำระแล้ว' }).expect(200);
    await decide(forged, { action: 'reject', reason: 'ซ้ำ' }).expect(409);
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'slip.reviewed' AND subject_id = ANY($1::uuid[])`,
      [[forged, wrongAccount, above]],
    );
    expect(audit[0]!.n).toBe(3);
  });

  it('a settlement file with a missed callback creates the payment; known rows match; strangers are discrepancies', async () => {
    const inv = await issue('1000.00');
    ids.inv6 = inv.id;
    fake.simulatePayment({
      merchantRef: MERCHANT_A,
      reference: inv.ref,
      amount: '1000.00',
      providerRef: 'KB-0006',
      paidAt: t.clock.now(),
    }); // the callback never arrives
    const csv = [
      'provider_ref,reference,amount,paid_at,status',
      `KB-0001,${ids.ref1},5344.00,${t.clock.now().toISOString()},paid`,
      `KB-0006,${inv.ref},1000.00,${t.clock.now().toISOString()},paid`,
      `KB-0099,NOSUCHREF,10.00,${t.clock.now().toISOString()},paid`,
    ].join('\n');
    const file = await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'kbank-statement.csv',
      mimeType: 'text/csv',
      body: Buffer.from(csv),
    });
    const today = bangkokDate(t.clock.now());
    const upload = (documentId: string, statementDate: string) =>
      t.http
        .post('/v1/owner/payment-settlements')
        .set(O())
        .set(idem())
        .send({ bankAccountId: accountA, statementDate, documentId });
    const res = await upload(file, today).expect(201);
    expect(res.body).toMatchObject({
      provider: 'kbank',
      statementDate: today,
      status: 'processed',
      rowsTotal: 3,
      rowsMatched: 1,
      rowsCreated: 1,
      rowsUnmatched: 1,
      discrepancies: [{ providerRef: 'KB-0099', reason: 'unknown_reference' }],
    });
    expect(await invoice(inv.id)).toMatchObject({ status: 'paid' });
    const created = await q<{ confirmed_via: string; reconciled_at: Date | null }>(
      `SELECT confirmed_via::text, reconciled_at FROM ops.payment WHERE provider_ref = 'KB-0006'`,
    );
    expect(created[0]).toMatchObject({ confirmed_via: 'settlement_file', reconciled_at: expect.any(Date) });
    const matched = await q<{ reconciled_at: Date | null }>(
      `SELECT reconciled_at FROM ops.payment WHERE provider_ref = 'KB-0001'`,
    );
    expect(matched[0]!.reconciled_at).not.toBeNull();
    expect((await upload(file, today).expect(409)).body.code).toBe('settlement.duplicate');
    const junk = await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'junk.csv',
      mimeType: 'text/csv',
      body: Buffer.from('a,b\n1,2\n'),
    });
    expect((await upload(junk, '2026-01-01').expect(422)).body.code).toBe('settlement.unreadable');
    const list = await t.http.get('/v1/owner/payment-settlements').set(O()).expect(200);
    expect(list.body.data).toHaveLength(1);
    await settle(); // the receipt of the created payment
    const receipts = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.receipt r JOIN ops.payment p ON p.id = r.payment_id WHERE p.provider_ref = 'KB-0006'`,
    );
    expect(receipts[0]!.n).toBe(1);
  });

  it('the daily reconcile fetches yesterday’s statement and creates the payment of a missed callback', async () => {
    const inv = await issue('1000.00');
    fake.simulatePayment({
      merchantRef: MERCHANT_A,
      reference: inv.ref,
      amount: '1000.00',
      providerRef: 'KB-0007',
      paidAt: new Date(t.clock.now().getTime() - 86_400_000),
    });
    const done = await t.app.get(SettlementsService).daily();
    expect(done).toBeGreaterThanOrEqual(1);
    expect(await invoice(inv.id)).toMatchObject({ status: 'paid' });
    const p = await q<{ confirmed_via: string }>(
      `SELECT confirmed_via::text FROM ops.payment WHERE provider_ref = 'KB-0007'`,
    );
    expect(p[0]!.confirmed_via).toBe('settlement_file');
    // run twice: one statement per account and day
    await t.app.get(SettlementsService).daily();
    const files = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.payment_settlement_file WHERE bank_account_id = $1 AND statement_date = $2::date`,
      [accountA, bangkokDate(new Date(t.clock.now().getTime() - 86_400_000))],
    );
    expect(files[0]!.n).toBe(1);
  });

  it('reversing a payment re-opens the invoice and voids its receipt; receipts for owner and resident', async () => {
    const rev = await t.http
      .post(`/v1/owner/payments/${ids.payCash}/actions/reverse`)
      .set(O())
      .set(idem())
      .send({ reason: 'บันทึกผิด' })
      .expect(200);
    expect(rev.body).toMatchObject({
      status: 'reversed',
      reverseReason: 'บันทึกผิด',
      nextActions: [],
      allocations: [{ invoiceId: ids.inv2, reversedAt: expect.any(String) }],
      receipts: [{ voided: true }],
    });
    expect(await invoice(ids.inv2!)).toMatchObject({ status: 'partially_paid', balance: '400.00' });
    await t.http
      .post(`/v1/owner/payments/${ids.payCash}/actions/reverse`)
      .set(O())
      .set(idem())
      .send({ reason: 'อีกครั้ง' })
      .expect(409);
    const voided = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'receipt.voided'`,
    );
    expect(voided[0]!.n).toBe(1);
    // receipts are immutable apart from the void
    await expect(
      db.admin.query(`UPDATE ops.receipt SET amount = 1 WHERE id = $1`, [ids.receipt1]),
    ).rejects.toThrow();

    const owners = await t.http.get('/v1/owner/receipts').set(O()).expect(200);
    expect(owners.body.data.length).toBeGreaterThanOrEqual(6);
    const numbers = (owners.body.data as { number: string }[]).map((r) => r.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const mine = await t.http.get('/v1/resident/receipts').set(R()).expect(200);
    expect(mine.body.data.length).toBe(owners.body.data.length);
    expect(mine.body.data[0]).toMatchObject({ issuerName: expect.any(String), unitNo: 'A-101' });
    const dl = await t.http.get(`/v1/resident/receipts/${ids.receipt1}/document`).set(R()).expect(200);
    expect(dl.body).toMatchObject({ url: expect.any(String) });
  });

  // ------------------------------------------------------------------ release review #2 / #3 (D-220)
  const due = async (invoiceId: string) =>
    (await t.http.get(`/v1/resident/invoices/${invoiceId}/payment`).set(R()).expect(200)).body.due as string;
  const credit = async () =>
    (
      await q<{ s: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS s FROM ops.payer_credit WHERE party_id = $1 AND unit_id = $2`,
        [DEV.residentPartyId, unitId],
      )
    )[0]!.s;
  const slipFor = async (invoiceId: string, transRef: string, amount: string) => {
    const res = await t.http
      .post(`/v1/resident/invoices/${invoiceId}/slips`)
      .set(R())
      .send({
        image: slipImage({
          transRef,
          amount,
          paidAt: t.clock.now().toISOString(),
          receiverBankCode: '004',
          receiverAccount: 'xxx-x-x7890-x',
          senderName: 'นาย ทดสอบ',
        }),
        mimeType: 'image/png',
      })
      .expect(201);
    await settle();
    return res.body.id as string;
  };
  const qrCallback = async (ref: string, amount: string, providerRef: string) => {
    const cb = fake.simulatePayment({
      merchantRef: MERCHANT_A,
      reference: ref,
      amount,
      providerRef,
      paidAt: t.clock.now(),
    });
    await callback('kbank', cb.body, cb.headers).expect(200);
    await settle();
  };
  /** Money received = allocated to invoices + kept as credit, for every booked payment (the two ledgers agree). */
  const ledgersAgree = async () => {
    const r = (
      await q<{ received: string; allocated: string; credited: string }>(
        `SELECT (SELECT coalesce(sum(amount + wht_amount), 0) FROM ops.payment WHERE status = 'confirmed' AND method <> 'offset')::text AS received,
                (SELECT coalesce(sum(a.amount), 0) FROM ops.payment_allocation a JOIN ops.payment p ON p.id = a.payment_id
                  WHERE p.status = 'confirmed' AND p.method <> 'offset' AND a.reversed_at IS NULL)::text AS allocated,
                (SELECT coalesce(sum(credited_amount), 0) FROM ops.payment WHERE status = 'confirmed' AND method <> 'offset')::text AS credited`,
      )
    )[0]!;
    expect(Number(r.allocated) + Number(r.credited)).toBeCloseTo(Number(r.received), 2);
  };

  it('a slip for a transfer the QR callback already booked waits for the owner (possible_qr_duplicate, D-220)', async () => {
    const inv = await issue('700.00');
    const amount = await due(inv.id);
    // the resident uploads the slip while the bank callback of the same transfer is being booked
    const slip = (
      await t.http
        .post(`/v1/resident/invoices/${inv.id}/slips`)
        .set(R())
        .send({
          image: slipImage({
            transRef: 'SLIP-DUP-0001',
            amount,
            paidAt: t.clock.now().toISOString(),
            receiverBankCode: '004',
            receiverAccount: 'xxx-x-x7890-x',
            senderName: 'นาย ทดสอบ',
          }),
          mimeType: 'image/png',
        })
        .expect(201)
    ).body.id as string;
    const tx = t.app.get(TenantTx);
    const ma = await tx.platform((p) => t.app.get(MerchantResolver).byId(p, accountA));
    expect(
      await tx.platform((p) =>
        t.app
          .get(PaymentWebhooksService)
          .match(
            p,
            'kbank',
            ma,
            { providerRef: 'KB-DUP-0001', reference: inv.ref, amount, paidAt: t.clock.now(), status: 'paid' },
            'webhook',
          ),
      ),
    ).toBe('created');
    expect((await invoice(inv.id)).status).toBe('paid');
    const before = await credit();
    await settle();
    const row = (
      await q<{ status: string; reasons: string[]; payment_id: string | null }>(
        'SELECT status::text, reasons, payment_id FROM ops.slip_review WHERE id = $1',
        [slip],
      )
    )[0]!;
    expect(row.status).toBe('pending_review');
    expect(row.reasons).toContain('possible_qr_duplicate');
    expect(row.payment_id).toBeNull();
    expect(await credit()).toBe(before);
    await ledgersAgree();
  });

  it('the QR callback of a transfer already booked by slip is held, never a second receipt or credit (review #2)', async () => {
    const inv = await issue('800.00');
    const amount = await due(inv.id);
    const slip = await slipFor(inv.id, 'SLIP-DUP-0002', amount);
    const slipPayment = (
      await q<{ payment_id: string }>('SELECT payment_id FROM ops.slip_review WHERE id = $1', [slip])
    )[0]!.payment_id;
    expect((await invoice(inv.id)).status).toBe('paid');
    const before = await credit();
    const receiptsBefore = (await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.receipt'))[0]!.n;
    // the same transfer arrives later through the bank callback (lost webhook / settlement file)
    await qrCallback(inv.ref, amount, 'KB-DUP-0002');
    const held = (await t.http.get('/v1/owner/payments?status=pending').set(O()).expect(200)).body.data as {
      id: string;
      providerRef: string;
    }[];
    const h = held.find((p) => p.providerRef === 'KB-DUP-0002')!;
    const view = (await t.http.get(`/v1/owner/payments/${h.id}`).set(O()).expect(200)).body;
    expect(view).toMatchObject({
      status: 'pending',
      heldReason: 'qr_already_paid',
      duplicateOfPaymentId: slipPayment,
      allocations: [],
      receipts: [],
      creditedAmount: '0.00',
      nextActions: ['confirm', 'dismiss'],
    });
    expect(await credit()).toBe(before);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.receipt'))[0]!.n).toBe(receiptsBefore);
    expect(
      (
        await q<{ outcome: string; detail: string }>(
          `SELECT outcome::text, detail FROM ops.payment_webhook WHERE detail = 'held_duplicate'`,
        )
      ).length,
    ).toBe(1);
    // the owner dismisses it: never booked
    const dismissed = await t.http
      .post(`/v1/owner/payments/${h.id}/actions/dismiss`)
      .set(O())
      .set(idem())
      .send({ reason: 'โอนครั้งเดียวกับสลิป' })
      .expect(200);
    expect(dismissed.body).toMatchObject({
      status: 'failed',
      dismissReason: 'โอนครั้งเดียวกับสลิป',
      nextActions: [],
    });
    await t.http.post(`/v1/owner/payments/${h.id}/actions/confirm`).set(O()).set(idem()).expect(409);
    await settle();
    expect(await credit()).toBe(before);
    await ledgersAgree();
  });

  it('a callback of the same amount as a recent slip on a re-issued QR is held; confirming books it as credit', async () => {
    const inv = await issue('900.00');
    const amount = await due(inv.id);
    const slip = await slipFor(inv.id, 'SLIP-DUP-0003', amount);
    const slipPayment = (
      await q<{ payment_id: string }>('SELECT payment_id FROM ops.slip_review WHERE id = $1', [slip])
    )[0]!.payment_id;
    // the QR the resident scanned had been replaced (expired) before the slip paid the invoice
    await q(`UPDATE ops.payment_qr_code SET status = 'expired' WHERE invoice_id = $1`, [inv.id]);
    const before = await credit();
    await qrCallback(inv.ref, amount, 'KB-DUP-0003');
    const p = (
      await q<{ id: string; status: string; held_reason: string; duplicate_of_payment_id: string }>(
        `SELECT id, status::text, held_reason, duplicate_of_payment_id FROM ops.payment WHERE provider_ref = 'KB-DUP-0003'`,
      )
    )[0]!;
    expect(p).toMatchObject({
      status: 'pending',
      held_reason: 'possible_duplicate_transfer',
      duplicate_of_payment_id: slipPayment,
    });
    expect(await credit()).toBe(before);
    // the owner checked the bank statement: two transfers really arrived → booked, the excess is credit
    const booked = await t.http
      .post(`/v1/owner/payments/${p.id}/actions/confirm`)
      .set(O())
      .set(idem())
      .expect(200);
    expect(booked.body).toMatchObject({
      status: 'confirmed',
      creditedAmount: amount,
      nextActions: ['reverse'],
    });
    await settle();
    expect(Number(await credit()) - Number(before)).toBeCloseTo(Number(amount), 2);
    expect(
      (await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.receipt WHERE payment_id = $1', [p.id]))[0]!
        .n,
    ).toBe(1);
    await ledgersAgree();
  });

  it('concurrent confirmations for one payer × unit never over-allocate: the excess is credit (review #3)', async () => {
    // two open invoices of the same payer × unit; two payments arrive at once, each for one of them — both allocate
    // oldest first, so without serialisation both would take the same open balance
    const older = await issue('1500.00');
    const newer = await issue('1600.00');
    const amount = (await invoice(older.id)).balance;
    expect(Number(amount)).toBeGreaterThan(0);
    const allocatedSum = async () =>
      Number(
        (
          await q<{ s: string }>(
            `SELECT coalesce(sum(a.amount), 0)::text AS s FROM ops.payment_allocation a JOIN ops.payment p ON p.id = a.payment_id
              WHERE p.unit_id = $1 AND p.status = 'confirmed' AND p.method <> 'offset' AND a.reversed_at IS NULL`,
            [unitId],
          )
        )[0]!.s,
      );
    const creditBefore = Number(await credit());
    const allocatedBefore = await allocatedSum();
    const payments = t.app.get(PaymentsService);
    const input = (invoiceId: string, n: number) =>
      ({
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
        unitId,
        invoiceId,
        payerPartyId: DEV.residentPartyId,
        leaseId: DEV.leaseId,
        amount,
        method: 'cash',
        confirmedVia: 'manual',
        paidAt: t.clock.now(),
        notes: `concurrent ${n}`,
      }) as const;
    // A confirms and keeps its transaction open; B confirms meanwhile (B must wait for A, then see A's allocation)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const aConfirmed = new Promise<void>((r) => (ready = r));
    const a = t.app.get(TenantTx).platform(
      async (tx) => {
        const r = await payments.confirm(tx, input(older.id, 1));
        ready();
        await gate;
        return r;
      },
      { timeout: 30_000 },
    );
    await aConfirmed;
    const b = t.app
      .get(TenantTx)
      .platform((tx) => payments.confirm(tx, input(newer.id, 2)), { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 500));
    release();
    await Promise.all([a, b]);
    // no invoice of the unit is paid beyond what it owed
    const over = await q(
      `SELECT id FROM ops.invoice WHERE unit_id = $1 AND paid_total > total + debited_total - credited_total`,
      [unitId],
    );
    expect(over).toEqual([]);
    // both payments are fully accounted for: allocated or kept as the payer's credit
    const allocatedDelta = (await allocatedSum()) - allocatedBefore;
    const creditDelta = Number(await credit()) - creditBefore;
    expect(allocatedDelta + creditDelta).toBeCloseTo(2 * Number(amount), 2);
    await ledgersAgree();
  });

  it('another tenant gets 404 on my payments, slips, receipts, credits; RLS hides the rows', async () => {
    const B = bearer(other.token);
    await t.http.get(`/v1/owner/payments/${ids.pay1}`).set(B).expect(404);
    await t.http
      .post(`/v1/owner/payments/${ids.paySlip}/actions/reverse`)
      .set(B)
      .set(idem())
      .send({ reason: 'xxx' })
      .expect(404);
    await t.http
      .post('/v1/owner/payments')
      .set(B)
      .set(idem())
      .send({ invoiceId: ids.inv2, amount: '400.00', method: 'cash', paidAt: t.clock.now().toISOString() })
      .expect(404);
    const slip = (await q<{ id: string }>('SELECT id FROM ops.slip_review LIMIT 1'))[0]!.id;
    await t.http.get(`/v1/owner/slip-reviews/${slip}`).set(B).expect(404);
    await t.http
      .post(`/v1/owner/slip-reviews/${slip}/actions/decide`)
      .set(B)
      .set(idem())
      .send({ action: 'reject', reason: 'xxx' })
      .expect(404);
    await t.http.get(`/v1/owner/receipts/${ids.receipt1}/document`).set(B).expect(404);
    await t.http
      .post('/v1/owner/refunds')
      .set(B)
      .set(idem())
      .send({
        partyId: DEV.residentPartyId,
        unitId,
        amount: '1.00',
        method: 'cash',
        refundedAt: t.clock.now().toISOString(),
      })
      .expect(404);
    await t.http
      .post('/v1/owner/payment-settlements')
      .set(B)
      .set(idem())
      .send({ bankAccountId: accountA, statementDate: '2026-02-01', documentId: ids.inv1 })
      .expect(404);
    expect((await t.http.get('/v1/owner/payments').set(B).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/receipts').set(B).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/slip-reviews').set(B).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/payer-credits').set(B).expect(200)).body).toEqual([]);
    // an operator token is not a resident token; another resident sees nothing of mine
    await t.http.get(`/v1/resident/receipts/${ids.receipt1}/document`).set(B).expect(403);
    const stranger = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b4b402', name: 'คนอื่น' }) })
      .expect(200);
    const S = bearer(stranger.body.accessToken as string);
    await t.http.get(`/v1/resident/receipts/${ids.receipt1}/document`).set(S).expect(404);
    expect((await t.http.get('/v1/resident/receipts').set(S).expect(200)).body.data).toEqual([]);
    await t.http.get(`/v1/resident/invoices/${ids.inv2}/payment`).set(S).expect(404);
    await t.http
      .post(`/v1/resident/invoices/${ids.inv2}/slips`)
      .set(S)
      .send({ image: PNG.toString('base64'), mimeType: 'image/png' })
      .expect(404);
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of [
      'ops.payment',
      'ops.payment_allocation',
      'ops.payment_qr_code',
      'ops.slip_review',
      'ops.receipt',
      'ops.payer_credit',
      'ops.refund',
      'ops.payment_settlement_file',
    ]) {
      expect(await count(other.tenantId, table)).toBe(table === 'ops.payment_settlement_file' ? 1 : 0);
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
    }
    // the callback log is platform-only: the application role sees none of it
    expect(await count(DEV.tenantId, 'ops.payment_webhook')).toBe(0);
  });
});
