import 'reflect-metadata';

import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { fakeWebhookSecret, signFakeWebhook } from '@integrations/payments/fake-payment-providers';
import { SubscriptionsService } from '@modules/platform-subscriptions/subscriptions.service';
import Decimal from 'decimal.js';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import {
  adminToken,
  bearer,
  idem,
  onboardTenant,
  operatorToken,
  ownerToken,
  supportToken,
} from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

interface Invoice {
  id: string;
  number: string;
  kind: string;
  state: string;
  total: string;
  subtotal: string;
  discount: string;
  vatAmount: string;
  openAmount: string;
  periodStart: string;
  periodEnd: string;
  qr: { payload: string; reference: string } | null;
  documentId: string | null;
  lines: { kind: string; quantity: string; amount: string }[];
  payments: { receiptNumber: string | null }[];
  nextActions: string[];
}

/** 10:00 Asia/Bangkok on a Bangkok date. */
const at = (day: string) => new Date(`${day}T10:00:00+07:00`);
const firstOfNextMonth = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const daysIn = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * B6.1 platform business (D-081–D-083, D-091, D-156, D-204) on the development tenant (12 units, Starter):
 * price plans, subscribe (trial), pilot discount, trial end → pro-rata first invoice with the platform's Thai QR and
 * PDF, paid by a signed platform callback → active; the 1st of the month → usage snapshot + monthly invoice; unpaid →
 * past_due → suspended (owner/staff writes 403 `tenant.read_only`, reads and exports allowed) → a transfer recorded by
 * Finance reinstates; maker-checker credit note; upgrade survey → install order seen by staff; HaaS register;
 * landlord free tier; AI usage records from meter OCR; pilot KPIs; tenant health; cancellation → read-only +
 * de-install order. Other tenants get 404.
 */
describe('B6.1 platform business (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let other: { tenantId: string; token: string };
  let subscriptionId = '';
  let firstInvoice: Invoice;
  let start = '';

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const sweep = () => t.app.get(SubscriptionsService).sweep();
  async function travel(day: string) {
    t.clock.set(at(day));
    admin = await adminToken(t);
    owner = await ownerToken(t);
    if (other) other.token = await operatorToken(t, '+660000000261');
  }
  const ownerInvoices = async () =>
    (await t.http.get('/v1/owner/subscription/invoices').set(bearer(owner)).expect(200)).body as Invoice[];

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_plat' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    // the support user also holds the Finance role: the second person of the credit-note maker-checker (D-091)
    await q(
      `INSERT INTO platform.platform_role_assignment (user_id, role_id)
       SELECT $1, r.id FROM platform.role r WHERE r.key = 'finance'`,
      [DEV.users.support],
    );
    start = firstOfNextMonth(bangkokDate(t.clock.now()));
    start = `${start.slice(0, 8)}10`; // the 10th of next month
    await travel(start);
    other = await onboardTenant(t, admin, { slug: 'other-b61', phone: '+660000000261', type: 'apartment' });
  }, 180_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('price plans: D-156 catalogue; a new version is a draft, published from a future date, never backdated', async () => {
    const plans = await t.http.get('/v1/admin/price-plans').set(bearer(admin)).expect(200);
    const starter = (
      plans.body as {
        id: string;
        key: string;
        isActive: boolean;
        versions: {
          id: string;
          state: string;
          unitPrice: string;
          minUnits: number;
          effectiveTo: string | null;
        }[];
      }[]
    ).find((p) => p.key === 'apartment_starter')!;
    expect(starter).toMatchObject({ isActive: true });
    expect(starter.versions[0]).toMatchObject({ state: 'published', unitPrice: '25.0000', minUnits: 20 });
    expect(
      (plans.body as { key: string; isActive: boolean }[]).find((p) => p.key === 'condo_juristic'),
    ).toMatchObject({ isActive: false });

    const backdated = await t.http
      .post(`/v1/admin/price-plans/${starter.id}/versions`)
      .set(bearer(admin))
      .set(idem())
      .send({
        effectiveFrom: addCalendarDays(start, -1),
        billingUnit: 'per_unit',
        unitPrice: '29',
        minUnits: 20,
      })
      .expect(201);
    await t.http
      .post(`/v1/admin/price-plans/versions/${backdated.body.id}/actions/publish`)
      .set(bearer(admin))
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('settings.backdated'));
    // the owner cannot touch the catalogue
    await t.http.get('/v1/admin/price-plans').set(bearer(owner)).expect(403);
  });

  it('subscribe → trial; one open subscription per tenant; the owner sees the plan, units counted and the estimate', async () => {
    const created = await t.http
      .post('/v1/admin/subscriptions')
      .set(bearer(admin))
      .set(idem())
      .send({ tenantId: DEV.tenantId, planKey: 'apartment_starter' })
      .expect(201);
    subscriptionId = created.body.id;
    expect(created.body).toMatchObject({
      state: 'trial',
      plan: { key: 'apartment_starter', version: 1 },
      readOnly: false,
    });
    await t.http
      .post('/v1/admin/subscriptions')
      .set(bearer(admin))
      .set(idem())
      .send({ tenantId: DEV.tenantId, planKey: 'apartment_smart' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('subscription.exists'));
    await t.http
      .post('/v1/admin/subscriptions')
      .set(bearer(admin))
      .set(idem())
      .send({ tenantId: other.tenantId, planKey: 'landlord' })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('subscription.plan_mismatch'));

    const mine = await t.http.get('/v1/owner/subscription').set(bearer(owner)).expect(200);
    expect(mine.body).toMatchObject({
      subscription: { state: 'trial', plan: { key: 'apartment_starter' } },
      usageToday: { units: 12, buildings: 1, meterPoints: 0 },
      // 12 units → the 20-unit minimum × THB 25 = 500.00 + VAT 7 % = 535.00
      estimate: { subtotal: '500.00', discount: '0.00', vatAmount: '35.00', total: '535.00' },
      nextActions: ['upgrade'],
    });
    // another tenant has no subscription; it never sees ours
    const theirs = await t.http.get('/v1/owner/subscription').set(bearer(other.token)).expect(200);
    expect(theirs.body.subscription).toBeNull();
  });

  it('pilot agreement: a paid pilot (never 100 %) applies its discount to the subscription (D-083)', async () => {
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/pilot-agreement`)
      .set(bearer(admin))
      .send({ signedOn: start, discountPct: '100', termMonths: 6 })
      .expect(422);
    const saved = await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/pilot-agreement`)
      .set(bearer(admin))
      .send({
        signedOn: start,
        discountPct: '30',
        termMonths: 6,
        baseline: { timeToBillHours: '72', onTimePaymentPct: '60', autoReconciledPct: '0' },
      })
      .expect(200);
    expect(saved.body).toMatchObject({ discountPct: '30.0000', kpiReviewOn: addCalendarDays(start, 90) });
    const sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body).toMatchObject({
      discountPct: '30.0000',
      discountReason: 'pilot',
      pilotAgreementId: saved.body.id,
    });
  });

  it('trial end → pro-rata first invoice (PIV series) with the platform Thai QR and PDF; a signed callback pays it → active', async () => {
    const trialEnd = addCalendarDays(start, 30);
    await travel(trialEnd); // the trial ends at 10:00 + 30 days; the tokens moved the clock a little further
    expect((await sweep()).invoices).toBe(1);
    await t.worker.tick();
    const days = daysIn(trialEnd) - Number(trialEnd.slice(8, 10)) + 1;
    const subtotal = new Decimal(500)
      .times(days)
      .div(daysIn(trialEnd))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const discount = subtotal.times('0.3').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const vat = subtotal.minus(discount).times('0.07').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const list = await ownerInvoices();
    expect(list).toHaveLength(1);
    firstInvoice = list[0]!;
    expect(firstInvoice).toMatchObject({
      number: `PIV-${trialEnd.slice(0, 4)}-00001`,
      kind: 'first',
      state: 'issued',
      periodStart: trialEnd,
      subtotal: subtotal.toFixed(2),
      discount: discount.toFixed(2),
      vatAmount: vat.toFixed(2),
      total: subtotal.minus(discount).plus(vat).toFixed(2),
      nextActions: ['pay-qr'],
    });
    expect(firstInvoice.lines.map((l) => l.kind)).toEqual(['subscription', 'discount']);
    expect(firstInvoice.qr?.payload).toMatch(/^000201/);
    expect(firstInvoice.qr?.reference).toBe(`PIV${trialEnd.slice(0, 4)}00001`);
    expect(firstInvoice.documentId).toEqual(expect.any(String));
    const pdf = await t.http
      .get(`/v1/owner/subscription/invoices/${firstInvoice.id}/pdf`)
      .set(bearer(owner))
      .expect(200);
    expect(pdf.body.number).toBe(firstInvoice.number);
    // another tenant: 404 on our invoice and its PDF
    await t.http
      .get(`/v1/owner/subscription/invoices/${firstInvoice.id}`)
      .set(bearer(other.token))
      .expect(404);
    await t.http
      .get(`/v1/owner/subscription/invoices/${firstInvoice.id}/pdf`)
      .set(bearer(other.token))
      .expect(404);
    // the job is idempotent
    expect((await sweep()).invoices).toBe(0);

    const callback = (providerRef: string) =>
      JSON.stringify({
        eventId: `evt_${providerRef}`,
        merchantRef: 'GP-PLATFORM',
        payments: [
          {
            providerRef,
            reference: firstInvoice.qr!.reference,
            amount: firstInvoice.total,
            paidAt: t.clock.now().toISOString(),
            status: 'paid',
          },
        ],
      });
    const body = callback('KBP0001');
    await t.http
      .post('/webhooks/platform-payments/kbank')
      .set('Content-Type', 'application/json')
      .set('x-provider-signature', signFakeWebhook(body, 'wrong'))
      .send(body)
      .expect(401);
    const paid = await t.http
      .post('/webhooks/platform-payments/kbank')
      .set('Content-Type', 'application/json')
      .set('x-provider-signature', signFakeWebhook(body, fakeWebhookSecret('kbank', 'GP-PLATFORM')))
      .send(body)
      .expect(200);
    expect(paid.body.results).toEqual([{ reference: firstInvoice.qr!.reference, outcome: 'applied' }]);
    const again = await t.http
      .post('/webhooks/platform-payments/kbank')
      .set('Content-Type', 'application/json')
      .set('x-provider-signature', signFakeWebhook(body, fakeWebhookSecret('kbank', 'GP-PLATFORM')))
      .send(body)
      .expect(200);
    expect(again.body.results[0].outcome).toBe('duplicate');
    await t.worker.tick();
    const after = (await ownerInvoices())[0]!;
    expect(after).toMatchObject({ state: 'paid', openAmount: '0.00', qr: null });
    expect(after.payments[0]!.receiptNumber).toBe(`PRC-${trialEnd.slice(0, 4)}-00001`);
    const sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body.state).toBe('active');
  });

  it('the 1st: usage snapshot + monthly invoice; unpaid → past_due → suspended (read-only) → a transfer reinstates', async () => {
    const first = firstOfNextMonth(addCalendarDays(start, 30));
    await travel(first);
    expect((await sweep()).invoices).toBe(1);
    await t.worker.tick();
    const usage = await t.http.get('/v1/owner/subscription/usage').set(bearer(owner)).expect(200);
    expect(usage.body[0]).toMatchObject({
      month: first,
      unitsCounted: 12,
      unitsByBuilding: { [DEV.buildingId]: 12 },
      // 500.00 − 30 % = 350.00 + VAT 24.50
      amountComputed: '374.50',
    });
    const monthly = (await ownerInvoices()).find((i) => i.kind === 'monthly')!;
    expect(monthly).toMatchObject({ total: '374.50', periodStart: first, state: 'issued' });

    // due (15 days) + grace (7 days) passed → overdue, subscription past due
    await travel(addCalendarDays(first, 23));
    await sweep();
    let sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body.state).toBe('past_due');
    // 30 more days past due → suspended: the tenant is read-only (D-082)
    await travel(addCalendarDays(first, 54));
    await sweep();
    sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body).toMatchObject({ state: 'suspended', readOnly: true });
    const health = await t.http
      .get(`/v1/admin/tenants/${DEV.tenantId}/health`)
      .set(bearer(admin))
      .expect(200);
    expect(health.body).toMatchObject({
      status: 'read_only',
      subscriptionState: 'suspended',
      signals: expect.arrayContaining(['suspended']),
    });

    await t.http
      .post('/v1/owner/subscription/upgrade')
      .set(bearer(owner))
      .set(idem())
      .send({ buildingId: DEV.buildingId })
      .expect(403)
      .expect((r) => expect(r.body.code).toBe('tenant.read_only'));
    // reads, the plan page and own-data exports keep working; nothing is deleted
    await t.http.get('/v1/owner/subscription').set(bearer(owner)).expect(200);
    await t.http.get('/v1/owner/units').set(bearer(owner)).expect(200);
    await t.http
      .post('/v1/owner/exports')
      .set(bearer(owner))
      .set(idem())
      .send({ kind: 'invoices_xlsx', params: { period: first.slice(0, 7) } })
      .expect(202);

    // Finance records the transfer of every overdue invoice → reinstated, writes allowed again
    for (const inv of (await ownerInvoices()).filter((i) => i.state === 'overdue')) {
      const recorded = await t.http
        .post(`/v1/admin/platform-invoices/${inv.id}/payments`)
        .set(bearer(admin))
        .set(idem())
        .send({
          amount: inv.openAmount,
          method: 'bank_transfer',
          paidAt: t.clock.now().toISOString(),
          reference: `KTB-${inv.number}`,
        })
        .expect(201);
      expect(recorded.body.state).toBe('paid');
    }
    sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body).toMatchObject({ state: 'active', readOnly: false });
    owner = await ownerToken(t);
    const survey = await t.http
      .post('/v1/owner/subscription/upgrade')
      .set(bearer(owner))
      .set(idem())
      .send({ buildingId: DEV.buildingId, notes: 'สะดวกวันเสาร์' })
      .expect(201);
    expect(survey.body).toMatchObject({ state: 'requested', targetPlanKey: 'apartment_smart' });
  });

  it('credit notes are maker-checker: the requester cannot approve; a second platform user issues PCN', async () => {
    const open = (await ownerInvoices()).find((i) => ['issued', 'overdue'].includes(i.state))!;
    expect(open).toBeDefined();
    const requested = await t.http
      .post(`/v1/admin/platform-invoices/${open.id}/credit-notes`)
      .set(bearer(admin))
      .set(idem())
      .send({ amount: '50.00', reason: 'คิดหน่วยเกินจากห้องที่ปิดปรับปรุง' })
      .expect(201);
    expect(requested.body).toMatchObject({ state: 'requested', number: null });
    await t.http
      .post(`/v1/admin/platform-invoices/credit-notes/${requested.body.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('platform_credit_note.same_approver'));
    const finance = await supportToken(t);
    const issued = await t.http
      .post(`/v1/admin/platform-invoices/credit-notes/${requested.body.id}/actions/approve`)
      .set(bearer(finance))
      .set(idem())
      .expect(200);
    expect(issued.body).toMatchObject({
      state: 'issued',
      number: expect.stringMatching(/^PCN-\d{4}-00001$/),
    });
    const inv = await t.http.get(`/v1/admin/platform-invoices/${open.id}`).set(bearer(admin)).expect(200);
    expect(inv.body).toMatchObject({ creditedTotal: '50.00' });
    expect(new Decimal(inv.body.openAmount as string).toFixed(2)).toBe(
      new Decimal(open.openAmount).minus(50).toFixed(2),
    );
  });

  it('upgrade survey → install order (gateway + a meter device per unit and utility) visible read-only to staff', async () => {
    const surveys = await t.http
      .get(`/v1/admin/site-surveys?tenantId=${DEV.tenantId}`)
      .set(bearer(admin))
      .expect(200);
    const survey = (surveys.body as { id: string; state: string }[])[0]!;
    const done = await t.http
      .post(`/v1/admin/site-surveys/${survey.id}/actions/complete`)
      .set(bearer(admin))
      .send({ findings: { rs485: 'ok' } })
      .expect(200);
    expect(done.body).toMatchObject({ state: 'done', installOrderId: expect.any(String) });
    const order = await t.http
      .get(`/v1/admin/install-orders/${done.body.installOrderId}`)
      .set(bearer(admin))
      .expect(200);
    expect(order.body.items).toHaveLength(1 + 12 * 2);
    const staff = await operatorToken(t, '+660000000003');
    const mine = await t.http.get('/v1/staff/install-orders').set(bearer(staff)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].units).toHaveLength(13);
    expect(mine.body.data[0].units[0]).toMatchObject({
      unitId: null,
      items: [{ kind: 'gateway', state: 'open' }],
    });
    const theirs = await t.http.get('/v1/staff/install-orders').set(bearer(other.token)).expect(200);
    expect(theirs.body.data).toEqual([]);
    // completing needs every item done
    await t.http
      .post(`/v1/admin/install-orders/${done.body.installOrderId}/actions/complete`)
      .set(bearer(admin))
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('install_order.items_open'));
  });

  it('HaaS register: a platform device allocated, installed (term, straight-line book value); others cannot see it', async () => {
    const device = await t.http
      .post('/v1/admin/devices')
      .set(bearer(admin))
      .set(idem())
      .send({
        serial: 'GP-GW-B6-0001',
        kind: 'gateway',
        model: 'rpi-cm4',
        vendor: 'Collective',
        ownership: 'platform_haas',
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
      })
      .expect(201);
    const asset = await t.http
      .post('/v1/admin/haas-assets')
      .set(bearer(admin))
      .set(idem())
      .send({
        deviceId: device.body.id,
        tenantId: DEV.tenantId,
        termMonths: 36,
        monthlyValue: '60.00',
        acquisitionCost: '1800.00',
      })
      .expect(201);
    expect(asset.body).toMatchObject({
      state: 'allocated',
      bookValue: '1800.00',
      nextActions: ['install', 'write-off'],
    });
    const today = bangkokDate(t.clock.now());
    const installed = await t.http
      .post(`/v1/admin/haas-assets/${asset.body.id}/actions/install`)
      .set(bearer(admin))
      .send({ date: today })
      .expect(200);
    expect(installed.body).toMatchObject({ state: 'installed', installedOn: today, bookValue: '1800.00' });
    await t.http
      .post(`/v1/admin/haas-assets/${asset.body.id}/actions/install`)
      .set(bearer(admin))
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('haas.invalid_transition'));
    const mine = await t.http.get('/v1/owner/subscription/hardware').set(bearer(owner)).expect(200);
    expect(mine.body).toHaveLength(1);
    const theirs = await t.http.get('/v1/owner/subscription/hardware').set(bearer(other.token)).expect(200);
    expect(theirs.body).toEqual([]);
  });

  it('meter OCR writes AI usage records per tenant (D-161); the admin sees them with the plan allowance', async () => {
    const staff = await operatorToken(t, '+660000000003');
    const meter = (
      await q<{ asset_item_id: string }>(
        `SELECT a.asset_item_id FROM core.meter_assignment a JOIN core.unit u ON u.id = a.unit_id
          WHERE u.building_id = $1 AND u.unit_no = 'A-102' AND a.utility = 'water' AND a.valid_to IS NULL`,
        [DEV.buildingId],
      )
    )[0]!.asset_item_id;
    const photo = await uploadFile(t, db, staff, {
      kind: 'meter_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'meter.jpg',
      mimeType: 'image/jpeg',
      body: Buffer.from('fake-jpeg-meter-photo-b6'),
      surface: 'staff',
    });
    await t.http
      .post('/v1/staff/meter-readings')
      .set(bearer(staff))
      .set(idem())
      .send({
        assetItemId: meter,
        photoDocumentId: photo,
        typedValue: '12.000',
        readAt: t.clock.now().toISOString(),
      })
      .expect(201);
    const rows = await q<{ feature: string; input_units: number; outcome: string }>(
      `SELECT feature::text, input_units, outcome FROM platform.ai_usage_record WHERE tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(rows).toEqual([{ feature: 'meter_ocr', input_units: 1, outcome: 'ok' }]);
    const usage = await t.http
      .get(`/v1/admin/tenants/${DEV.tenantId}/ai-usage`)
      .set(bearer(admin))
      .expect(200);
    expect(usage.body.months[0]).toMatchObject({
      feature: 'meter_ocr',
      calls: 1,
      units: 1,
      allowance: 500,
      overage: 0,
    });
  });

  it('pilot KPIs: the seven D-083 KPIs from real data, compared with the baseline, snapshotted', async () => {
    const kpis = await t.http
      .get(`/v1/admin/tenants/${DEV.tenantId}/pilot-kpis?window=90d`)
      .set(bearer(admin))
      .expect(200);
    expect((kpis.body.kpis as { kpi: string }[]).map((k) => k.kpi)).toEqual([
      'time_to_bill',
      'invoice_correction_rate',
      'on_time_payment',
      'auto_reconciled',
      'loss_identified',
      'meter_uptime',
      'csat',
    ]);
    expect(kpis.body).toMatchObject({
      window: '90d',
      kpiReviewOn: addCalendarDays(start, 90),
      current: { csat: null },
    });
    expect(kpis.body.kpis[0]).toMatchObject({ baseline: '72', target: '-80%' });
    const snapshots = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.kpi_snapshot WHERE tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(snapshots[0]!.n).toBe(1);
    await t.http.get(`/v1/admin/tenants/${DEV.tenantId}/pilot-kpis`).set(bearer(owner)).expect(403);
  });

  it('landlord free tier: ≤ 3 units → nothing to pay at trial end → active without an invoice', async () => {
    const landlord = await onboardTenant(t, admin, {
      slug: 'landlord-b61',
      phone: '+660000000262',
      type: 'landlord',
    });
    const sub = await t.http
      .post('/v1/admin/subscriptions')
      .set(bearer(admin))
      .set(idem())
      .send({ tenantId: landlord.tenantId, planKey: 'landlord' })
      .expect(201);
    await travel(addCalendarDays(bangkokDate(t.clock.now()), 31));
    await sweep();
    const after = await t.http.get(`/v1/admin/subscriptions/${sub.body.id}`).set(bearer(admin)).expect(200);
    expect(after.body.state).toBe('active');
    const invoices = await t.http
      .get(`/v1/admin/platform-invoices?tenantId=${landlord.tenantId}`)
      .set(bearer(admin))
      .expect(200);
    expect(invoices.body.meta.total).toBe(0);
  });

  it('change-plan, suspend and reinstate require an Idempotency-Key (contract §3, review #13)', async () => {
    for (const [action, body] of [
      ['change-plan', { planKey: 'apartment_smart' }],
      ['suspend', { reason: 'ทดสอบ idempotency' }],
      ['reinstate', { reason: 'ทดสอบ idempotency' }],
    ] as const) {
      const res = await t.http
        .post(`/v1/admin/subscriptions/${subscriptionId}/actions/${action}`)
        .set(bearer(admin))
        .send(body)
        .expect(400);
      expect({ action, code: res.body.code }).toEqual({ action, code: 'idempotency.key_required' });
    }
  });

  it('cancellation takes effect after the month end: tenant read-only, de-install order for platform hardware', async () => {
    const cancel = await t.http
      .post(`/v1/admin/subscriptions/${subscriptionId}/actions/cancel`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'ทดสอบการยกเลิก' })
      .expect(200);
    const effective = cancel.body.cancelEffectiveDate as string;
    expect(effective.slice(8)).toBe(String(daysIn(effective)).padStart(2, '0'));
    await travel(addCalendarDays(effective, 1));
    await sweep();
    const sub = await t.http.get(`/v1/admin/subscriptions/${subscriptionId}`).set(bearer(admin)).expect(200);
    expect(sub.body).toMatchObject({ state: 'cancelled', readOnly: true, nextActions: [] });
    const orders = await t.http
      .get(`/v1/admin/install-orders?tenantId=${DEV.tenantId}&kind=deinstall`)
      .set(bearer(admin))
      .expect(200);
    expect(orders.body.data).toHaveLength(1);
    expect(orders.body.data[0].items[0]).toMatchObject({ deviceKind: 'gateway' });
    const events = await t.http
      .get(`/v1/admin/subscriptions/${subscriptionId}/events`)
      .set(bearer(admin))
      .expect(200);
    expect((events.body as { type: string }[]).map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'created',
        'state.active',
        'state.past_due',
        'state.suspended',
        'cancellation_requested',
        'state.cancelled',
      ]),
    );
    await t.http
      .post('/v1/owner/subscription/upgrade')
      .set(bearer(owner))
      .set(idem())
      .send({ buildingId: DEV.buildingId })
      .expect(403);
  });
});
