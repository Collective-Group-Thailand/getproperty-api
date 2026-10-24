import 'reflect-metadata';

import { fakeLineIdToken } from '@collective/integrations/line';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { DocumentsService } from '@core/documents/documents.service';
import { readXlsx } from '@modules/ops-receivables/exports/sheets';
import { ReceivablesService } from '@modules/ops-receivables/receivables.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const LINE_SUB = 'U00000000000000000000000000b4b501';
const HOUR = 3_600_000;

/**
 * B4.5 acceptance (receivables): the ledger and position of a billed party × unit with aging; an overdue invoice
 * gets its reminders on the days of `reminders.schedule` (workflow step timers, quiet hours respected) and they stop
 * once it is paid; the owner's "send now"; the late fee only when enabled and allowed by the contract (⚖ O-002) and
 * on the next invoice only; the owner dashboard; finance exports; cross-tenant 404s and RLS.
 */
describe('B4.5 receivables, dunning, penalties, dashboard, exports (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  let unitId = '';
  let month = 0;
  const ids: Record<string, string> = {};
  const due: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  /** Bangkok `day` at `hour`:00. */
  const at = (day: string, hour: number) => new Date(startOfBangkokDay(day).getTime() + hour * HOUR);
  /** Moves the clock (tokens expire meanwhile: both operators sign in again). */
  const travel = async (to: Date) => {
    t.clock.set(to);
    owner = await ownerToken(t);
    other.token = await operatorToken(t, '+660000000145');
  };

  async function issue(
    total: string,
    lines?: { kind: string; source: string; sourceId?: string; amount: string }[],
  ) {
    month += 1;
    const start = `2024-${String(month).padStart(2, '0')}-01`;
    const id = (
      await q<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                  subtotal, total, balance)
         VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, $7, $7, $7)
         RETURNING id`,
        [DEV.tenantId, DEV.buildingId, unitId, DEV.residentPartyId, DEV.leaseId, start, total],
      )
    )[0]!.id;
    const spec = lines ?? [{ kind: 'rent', source: 'rent', amount: total }];
    for (const [i, l] of spec.entries())
      await q(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, source_id, description, quantity, unit, unit_price, amount)
         VALUES ($1, $2, $3, $4::ops.invoice_line_source_type, $5::ops.invoice_line_kind, $6, $7, 1, 'month', $8, $8)`,
        [DEV.tenantId, id, i + 1, l.source, l.kind, l.sourceId ?? null, `${l.kind} A-101`, l.amount],
      );
    const res = await t.http.post(`/v1/owner/invoices/${id}/actions/issue`).set(O()).set(idem()).send({});
    if (res.status !== 200) throw new Error(`issue ${res.status}: ${JSON.stringify(res.body)}`);
    await settle();
    const row = await q<{ due_date: string; number: string }>(
      'SELECT due_date::text, number FROM ops.invoice WHERE id = $1',
      [id],
    );
    due[id] = row[0]!.due_date;
    return { id, number: row[0]!.number };
  }

  const reminders = async (invoiceId: string) =>
    q<{ step: number; status: string; triggered_by: string; sent_at: Date | null }>(
      `SELECT step, status::text, triggered_by::text, sent_at FROM ops.dunning_reminder WHERE invoice_id = $1 ORDER BY step, created_at`,
      [invoiceId],
    );
  const status = async (id: string) =>
    (await q<{ status: string }>('SELECT status::text FROM ops.invoice WHERE id = $1', [id]))[0]!.status;
  const balance = async () =>
    (
      await q<{
        balance: string;
        credit_balance: string;
        open_invoices_count: number;
        days_overdue: number;
        aging: Record<string, string>;
      }>(
        `SELECT balance::text, credit_balance::text, open_invoices_count, days_overdue, aging FROM ops.receivable_balance
          WHERE party_id = $1 AND unit_id = $2`,
        [DEV.residentPartyId, unitId],
      )
    )[0];
  const ledgerSum = async () =>
    (
      await q<{ s: string | null }>(
        `SELECT sum(amount)::text AS s FROM ops.receivable_entry WHERE party_id = $1 AND unit_id = $2`,
        [DEV.residentPartyId, unitId],
      )
    )[0]!.s;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_recv' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    const admin = await adminToken(t);
    other = await onboardTenant(t, admin, { slug: 'other-b45', phone: '+660000000145', type: 'apartment' });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    // the resident consents (LINE) so the reminders are planned for delivery
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
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('an issued invoice is posted to the ledger; the position is materialised with aging', async () => {
    const inv = await issue('1000.00');
    ids.inv1 = inv.id;
    const entries = await q<{ entry_type: string; ref_type: string; amount: string }>(
      `SELECT entry_type::text, ref_type, amount::text FROM ops.receivable_entry WHERE ref_id = $1`,
      [inv.id],
    );
    expect(entries).toEqual([{ entry_type: 'invoice', ref_type: 'invoice', amount: '1000.00' }]);
    expect(await balance()).toEqual({
      balance: '1000.00',
      credit_balance: '0.00',
      open_invoices_count: 1,
      days_overdue: 0,
      aging: { current: '1000.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90p: '0.00' },
    });
    expect(await ledgerSum()).toBe('1000.00');
    const changed = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'receivable.changed' AND payload->>'partyId' = $1`,
      [DEV.residentPartyId],
    );
    expect(changed[0]!.n).toBe(1);
  });

  it('overdue → reminder on day 1 (held through quiet hours) and day 3 → paid → the rest stops', async () => {
    const d = due[ids.inv1!]!;
    // 00:30 the day after the due date: the hourly sweep marks it overdue and dunning starts
    await travel(at(addCalendarDays(d, 1), 0.5));
    const swept = await t.app.get(ReceivablesService).sweep();
    expect(swept.overdue).toBe(1);
    expect(await status(ids.inv1!)).toBe('overdue');
    await settle();
    const instance = await q<{ state: string; id: string }>(
      `SELECT i.id, i.state FROM ops.workflow_instance i JOIN ops.workflow_definition d ON d.id = i.definition_id
        WHERE d.key = 'dunning' AND i.subject_id = $1`,
      [ids.inv1],
    );
    expect(instance).toEqual([{ id: expect.any(String), state: 'overdue' }]);
    const r1 = await reminders(ids.inv1!);
    expect(r1.map((r) => [r.step, r.status, r.triggered_by])).toEqual([
      [1, 'deferred_quiet_hours', 'schedule'],
      [3, 'scheduled', 'schedule'],
      [7, 'scheduled', 'schedule'],
    ]);
    const timers = await q<{ kind: string; fire_at: Date; fired_at: Date | null }>(
      `SELECT kind::text, fire_at, fired_at FROM ops.workflow_timer WHERE instance_id = $1 ORDER BY fire_at`,
      [instance[0]!.id],
    );
    expect(timers.map((x) => x.kind)).toEqual(['step', 'step', 'step']);
    expect(timers[1]!.fire_at.toISOString()).toBe(startOfBangkokDay(addCalendarDays(d, 3)).toISOString());
    // the LINE Flex reminder is planned, held until quiet hours end (08:00)
    const note = await q<{
      state: string;
      rendered: { format: string; flex: { type: string }; text: string };
    }>(
      `SELECT n.state::text, n.rendered FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'invoice.reminder_sent' AND e.aggregate_id = $1`,
      [ids.inv1],
    );
    expect(note).toHaveLength(1);
    expect(note[0]!.rendered).toMatchObject({ format: 'line_flex_json', flex: { type: 'bubble' } });
    expect(note[0]!.rendered.text).toMatch(
      /^แจ้งเตือนการชำระเงิน INV-\d{4}-\d{5} ยอด 1,000\.00 บาท เลยกำหนด 1 วัน$/,
    );
    expect(['held_quiet_hours', 'queued', 'sent', 'delivered']).toContain(note[0]!.state);
    expect(await balance()).toMatchObject({
      days_overdue: 1,
      aging: expect.objectContaining({ d1_30: '1000.00' }),
    });

    // day 3 at 10:00: the second reminder goes out
    await travel(at(addCalendarDays(d, 3), 10));
    await settle();
    expect((await reminders(ids.inv1!)).map((r) => r.status)).toEqual([
      'deferred_quiet_hours',
      'sent',
      'scheduled',
    ]);

    // paid on day 4 → the instance closes, day 7 is skipped and never fires
    await travel(at(addCalendarDays(d, 4), 10));
    await t.http
      .post('/v1/owner/payments')
      .set(O())
      .set(idem())
      .send({ invoiceId: ids.inv1, amount: '1000.00', method: 'cash', paidAt: t.clock.now().toISOString() })
      .expect(201);
    await settle();
    expect(await status(ids.inv1!)).toBe('paid');
    expect((await reminders(ids.inv1!)).map((r) => r.status)).toEqual([
      'deferred_quiet_hours',
      'sent',
      'skipped_paid',
    ]);
    const closed = await q<{ state: string; closed_at: Date | null }>(
      'SELECT state, closed_at FROM ops.workflow_instance WHERE id = $1',
      [instance[0]!.id],
    );
    expect(closed[0]).toMatchObject({ state: 'paid', closed_at: expect.any(Date) });
    await travel(at(addCalendarDays(d, 8), 10));
    await settle();
    const sent = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'invoice.reminder_sent' AND aggregate_id = $1`,
      [ids.inv1],
    );
    expect(sent[0]!.n).toBe(2);
    // the ledger: invoice +, payment − → nothing owed
    expect(await ledgerSum()).toBe('0.00');
    expect(await balance()).toMatchObject({ balance: '0.00', open_invoices_count: 0, days_overdue: 0 });
  }, 120_000);

  it('the owner sends a reminder now; never for a paid invoice', async () => {
    const paid = await t.http
      .post(`/v1/owner/invoices/${ids.inv1}/actions/send-reminder`)
      .set(O())
      .set(idem())
      .expect(409);
    expect(paid.body.code).toBe('invoice.nothing_due');
    const inv = await issue('500.00');
    ids.inv2 = inv.id;
    const res = await t.http
      .post(`/v1/owner/invoices/${inv.id}/actions/send-reminder`)
      .set(O())
      .set(idem())
      .expect(200);
    expect(res.body).toMatchObject({
      step: 0,
      triggeredBy: 'owner',
      status: expect.stringMatching(/^(sent|deferred_quiet_hours)$/),
    });
    const list = await t.http.get(`/v1/owner/invoices/${inv.id}/reminders`).set(O()).expect(200);
    expect(list.body).toEqual({
      reminders: [expect.objectContaining({ step: 0, triggeredBy: 'owner' })],
      penalty: null,
    });
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'dunning.reminder_sent' AND subject_id = $1`,
      [inv.id],
    );
    expect(audit[0]!.n).toBe(1);
  });

  it('late fee (⚖ O-002): nothing while disabled; refused without the contract term; else on the next invoice only', async () => {
    // disabled (default): overdue without any assessment
    await travel(at(addCalendarDays(due[ids.inv2!]!, 2), 10));
    await t.app.get(ReceivablesService).sweep();
    await settle();
    expect(await status(ids.inv2!)).toBe('overdue');
    expect(await q('SELECT 1 FROM ops.penalty_assessment WHERE invoice_id = $1', [ids.inv2])).toHaveLength(0);

    // enabled with an amount, but the lease states no late fee → recorded as not allowed, nothing charged
    await t.http
      .put('/v1/owner/settings/late_fee.enabled')
      .set(O())
      .send({ value: true, reason: 'ทดสอบค่าปรับ' })
      .expect(200);
    await t.http
      .put('/v1/owner/settings/late_fee.amount')
      .set(O())
      .send({ value: '100.00', reason: 'ตามสัญญา' })
      .expect(200);
    const inv3 = await issue('800.00');
    await travel(at(addCalendarDays(due[inv3.id]!, 1), 10));
    await t.app.get(ReceivablesService).sweep();
    await settle();
    const refused = await q<{ allowed: boolean; status: string; invoice_charge_id: string | null }>(
      'SELECT allowed, status::text, invoice_charge_id FROM ops.penalty_assessment WHERE invoice_id = $1',
      [inv3.id],
    );
    expect(refused).toEqual([{ allowed: false, status: 'waived', invoice_charge_id: null }]);

    // the contract states the late fee → allowed: a pending charge for the next invoice, the overdue one unchanged
    await q(`UPDATE ops.lease SET addendum = $2::jsonb WHERE id = $1`, [
      DEV.leaseId,
      JSON.stringify([{ title: 'ค่าปรับชำระล่าช้า', text: 'ค่าปรับชำระค่าเช่าล่าช้า 100 บาทต่อใบแจ้งหนี้' }]),
    ]);
    const inv4 = await issue('900.00');
    await travel(at(addCalendarDays(due[inv4.id]!, 1), 10));
    await t.app.get(ReceivablesService).sweep();
    await settle();
    const allowed = await q<{
      id: string;
      allowed: boolean;
      status: string;
      amount: string;
      invoice_charge_id: string;
    }>(
      'SELECT id, allowed, status::text, amount::text, invoice_charge_id FROM ops.penalty_assessment WHERE invoice_id = $1',
      [inv4.id],
    );
    expect(allowed[0]).toMatchObject({ allowed: true, status: 'pending', amount: '100.00' });
    const charge = await q<{ source_type: string; line_kind: string; status: string; amount: string }>(
      'SELECT source_type::text, line_kind::text, status::text, amount::text FROM ops.invoice_charge WHERE id = $1',
      [allowed[0]!.invoice_charge_id],
    );
    expect(charge[0]).toEqual({
      source_type: 'penalty',
      line_kind: 'late_fee',
      status: 'pending',
      amount: '100.00',
    });
    const total4 = await q<{ total: string }>('SELECT total::text FROM ops.invoice WHERE id = $1', [inv4.id]);
    expect(total4[0]!.total).toBe('900.00'); // never added to the issued invoice (D-045)
    const listed = await t.http.get(`/v1/owner/invoices/${inv4.id}/reminders`).set(O()).expect(200);
    expect(listed.body.penalty).toMatchObject({
      amount: '100.00',
      allowed: true,
      status: 'pending',
      appliedInvoiceLineId: null,
    });

    // the next invoice carries it: issued → the assessment is applied to that line
    const next = await issue('4500.00', [
      { kind: 'rent', source: 'rent', amount: '4400.00' },
      { kind: 'late_fee', source: 'penalty', sourceId: allowed[0]!.invoice_charge_id, amount: '100.00' },
    ]);
    const applied = await q<{ status: string; applied_invoice_line_id: string | null }>(
      'SELECT status::text, applied_invoice_line_id FROM ops.penalty_assessment WHERE id = $1',
      [allowed[0]!.id],
    );
    expect(applied[0]).toMatchObject({ status: 'applied', applied_invoice_line_id: expect.any(String) });
    const line = await q<{ invoice_id: string }>('SELECT invoice_id FROM ops.invoice_line WHERE id = $1', [
      applied[0]!.applied_invoice_line_id,
    ]);
    expect(line[0]!.invoice_id).toBe(next.id);
    const assessed = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'penalty.assessed'`,
    );
    expect(assessed[0]!.n).toBe(2);
    ids.inv3 = inv3.id;
    ids.inv4 = inv4.id;
    ids.inv5 = next.id;
  }, 120_000);

  it('arrears list with filters and totals; the ledger with its running balance equals the position', async () => {
    await t.app.get(ReceivablesService).sweep();
    await settle();
    const all = await t.http.get('/v1/owner/receivables').set(O()).expect(200);
    expect(all.body.data).toHaveLength(1);
    const row = all.body.data[0];
    const open = await q<{ s: string; n: number }>(
      `SELECT sum(balance)::text AS s, count(*)::int AS n FROM ops.invoice
        WHERE billed_party_id = $1 AND unit_id = $2 AND status IN ('issued','partially_paid','overdue') AND balance > 0`,
      [DEV.residentPartyId, unitId],
    );
    expect(row).toMatchObject({
      partyId: DEV.residentPartyId,
      unitId,
      unitNo: 'A-101',
      balance: open[0]!.s,
      openInvoicesCount: open[0]!.n,
      creditBalance: '0.00',
    });
    expect(row.daysOverdue).toBeGreaterThan(0);
    const bucketSum = Object.values(row.aging as Record<string, string>).reduce((s, v) => s + Number(v), 0);
    expect(bucketSum.toFixed(2)).toBe(row.balance);
    expect(all.body.totals).toEqual({
      count: 1,
      balance: row.balance,
      creditBalance: '0.00',
      aging: row.aging,
    });
    // filters
    expect(
      (await t.http.get('/v1/owner/receivables?minDaysOverdue=400').set(O()).expect(200)).body.data,
    ).toEqual([]);
    expect((await t.http.get('/v1/owner/receivables?bucket=d90p').set(O()).expect(200)).body.data).toEqual(
      [],
    );
    expect(
      (await t.http.get(`/v1/owner/receivables?unitId=${unitId}&sortBy=days_overdue`).set(O()).expect(200))
        .body.data,
    ).toHaveLength(1);
    await t.http.get('/v1/owner/receivables?bucket=d999').set(O()).expect(422);
    // the ledger
    const entries = await t.http
      .get(`/v1/owner/receivables/entries?partyId=${DEV.residentPartyId}&unitId=${unitId}&perPage=100`)
      .set(O())
      .expect(200);
    const ledger = entries.body.data as { refType: string; runningBalance: string }[];
    expect(ledger.at(-1)!.runningBalance).toBe(row.balance);
    expect(await ledgerSum()).toBe(row.balance);
    expect(ledger.map((e) => e.refType)).toEqual(expect.arrayContaining(['invoice', 'payment']));
    // the ledger is append-only
    await expect(db.admin.query('UPDATE ops.receivable_entry SET amount = 1')).rejects.toThrow();
  });

  it('dashboard: income, billed vs collected, arrears, due today, cycles, compliance, loss', async () => {
    const monthKey = bangkokDate(t.clock.now()).slice(0, 7);
    const res = await t.http.get('/v1/owner/dashboard').set(O()).expect(200);
    expect(res.body).toMatchObject({
      month: monthKey,
      income: { received: expect.stringMatching(/^\d+\.\d{2}$/), byMethod: expect.any(Array) },
      billing: { billed: expect.any(String) },
      arrears: { invoices: expect.any(Number) },
      dueToday: { invoices: expect.any(Number) },
      attention: { slipsToReview: 0 },
      compliance: { score: expect.stringMatching(/^\d+\.\d{2}$/), linesAboveCap: expect.any(Number) },
      cycles: expect.any(Array),
      loss: expect.any(Array),
    });
    const overdue = await q<{ s: string | null; n: number }>(
      `SELECT sum(balance)::text AS s, count(*)::int AS n FROM ops.invoice WHERE tenant_id = $1 AND status = 'overdue' AND balance > 0`,
      [DEV.tenantId],
    );
    expect(res.body.arrears).toMatchObject({
      balance: overdue[0]!.s ?? '0.00',
      invoices: overdue[0]!.n,
      parties: 1,
    });
    const [y, m] = monthKey.split('-').map(Number) as [number, number];
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const cash = await q<{ s: string | null }>(
      `SELECT sum(amount)::text AS s FROM ops.payment WHERE tenant_id = $1 AND status = 'confirmed' AND method <> 'offset'
         AND paid_at >= $2 AND paid_at < $3`,
      [DEV.tenantId, startOfBangkokDay(`${monthKey}-01`), startOfBangkokDay(`${nextMonth}-01`)],
    );
    expect(res.body.income.received).toBe(cash[0]!.s ?? '0.00');
    // a month with nothing
    const empty = await t.http.get('/v1/owner/dashboard?month=2020-01').set(O()).expect(200);
    expect(empty.body).toMatchObject({
      income: { received: '0.00', payments: 0 },
      billing: { billed: '0.00', collectedPct: null },
    });
  });

  it('finance exports: Excel, FlowAccount, PEAK, income/expense; VAT figures only for a VAT-registered tenant', async () => {
    const period = bangkokDate(new Date(t.clock.now().getTime())).slice(0, 7);
    // invoices were issued on the first day of the test (the clock moved since): use that month
    const issuedMonth = (
      await q<{ m: string }>(
        `SELECT to_char(issued_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS m FROM ops.invoice WHERE id = $1`,
        [ids.inv1],
      )
    )[0]!.m;
    const receiptMonth = (
      await q<{ m: string }>(
        `SELECT to_char(min(issued_at) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS m FROM ops.receipt WHERE voided_at IS NULL`,
      )
    )[0]!.m;
    const request = async (kind: string, params: Record<string, unknown>) =>
      (await t.http.post('/v1/owner/exports').set(O()).set(idem()).send({ kind, params }).expect(202)).body
        .id as string;
    const jobs = {
      invoices: await request('invoices_xlsx', { period: issuedMonth }),
      payments: await request('payments_xlsx', { period }),
      arrears: await request('arrears_xlsx', {}),
      flow: await request('flowaccount_csv', { period: issuedMonth }),
      // receipts carry their own date: late in a month the first one falls in the next month (date-independent test)
      flowReceipts: await request('flowaccount_csv', { period: receiptMonth }),
      peak: await request('peak_csv', { period: issuedMonth }),
      vat: await request('vat_pp30', { period: issuedMonth }),
      income: await request('income_expense', { period: issuedMonth }),
    };
    await t.http
      .post('/v1/owner/exports')
      .set(O())
      .set(idem())
      .send({ kind: 'arrears_xlsx', params: { asOf: '2026-13-01' } })
      .expect(422);
    await settle();
    const file = async (id: string) => {
      const row = await q<{
        status: string;
        storage_key: string | null;
        error: string | null;
        row_count: number | null;
      }>(
        `SELECT j.status::text, d.storage_key, j.error, j.row_count FROM ops.export_job j LEFT JOIN core.document d ON d.id = j.file_document_id WHERE j.id = $1`,
        [id],
      );
      return row[0]!;
    };
    const bytes = async (id: string) =>
      t.app.get(DocumentsService).bytesOf({ storageKey: (await file(id)).storage_key! });
    const numbers = (
      await q<{ number: string }>(
        `SELECT number FROM ops.invoice WHERE tenant_id = $1 AND number IS NOT NULL
            AND to_char(issued_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = $2 ORDER BY number`,
        [DEV.tenantId, issuedMonth],
      )
    ).map((r) => r.number);

    expect(await file(jobs.invoices)).toMatchObject({ status: 'done', row_count: numbers.length });
    const inv = await readXlsx(await bytes(jobs.invoices));
    const listed = inv['ใบแจ้งหนี้']!.map((r) => r[0]).filter(
      (c) => typeof c === 'string' && c.startsWith('INV-'),
    );
    expect(listed).toEqual(numbers);

    expect(await file(jobs.payments)).toMatchObject({ status: 'done' });
    expect(await file(jobs.arrears)).toMatchObject({ status: 'done', row_count: 1 });
    const arrears = await readXlsx(await bytes(jobs.arrears));
    expect(arrears['ลูกหนี้ค้างชำระ']!.some((r) => r.includes('A-101'))).toBe(true);

    const flow = (await bytes(jobs.flow)).toString('utf8');
    expect(flow.startsWith('﻿ประเภทเอกสาร')).toBe(true);
    for (const n of numbers) expect(flow).toContain(n);
    expect((await bytes(jobs.flowReceipts)).toString('utf8')).toMatch(/ใบเสร็จรับเงิน,RCP-\d{4}-\d{5}/);
    const peak = (await bytes(jobs.peak)).toString('utf8');
    expect(peak.split('\r\n')[0]).toContain('เลขที่เอกสาร');

    expect(await file(jobs.vat)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not VAT-registered'),
    });
    expect(await file(jobs.income)).toMatchObject({ status: 'done', row_count: 1 });
    const income = await readXlsx(await bytes(jobs.income));
    expect(income['รายรับรายจ่าย']!.at(-1)![0]).toBe('รวม');
  }, 120_000);

  it('another tenant gets 404 on my receivables, reminders and ledger; RLS hides the rows', async () => {
    const B = bearer(other.token);
    await t.http.get(`/v1/owner/receivables/entries?partyId=${DEV.residentPartyId}`).set(B).expect(404);
    await t.http.get(`/v1/owner/invoices/${ids.inv2}/reminders`).set(B).expect(404);
    await t.http.post(`/v1/owner/invoices/${ids.inv2}/actions/send-reminder`).set(B).set(idem()).expect(404);
    expect((await t.http.get('/v1/owner/receivables').set(B).expect(200)).body).toMatchObject({
      data: [],
      totals: { count: 0, balance: '0.00' },
    });
    const dash = await t.http.get('/v1/owner/dashboard').set(B).expect(200);
    expect(dash.body).toMatchObject({
      income: { received: '0.00' },
      arrears: { balance: '0.00', invoices: 0 },
    });
    await t.http.get(`/v1/owner/dashboard?buildingId=${DEV.buildingId}`).set(B).expect(404);
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of [
      'ops.receivable_entry',
      'ops.receivable_balance',
      'ops.dunning_reminder',
      'ops.penalty_assessment',
    ]) {
      expect(await count(other.tenantId, table)).toBe(0);
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
    }
  });
});
