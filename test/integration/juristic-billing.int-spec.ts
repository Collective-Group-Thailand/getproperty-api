import 'reflect-metadata';

import { BillingCyclesService } from '@modules/ops-billing/billing-cycles.service';
import Decimal from 'decimal.js';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

interface Cycle {
  id: string;
  periodKey: string;
  frequency: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  invoices: { id: string; billedPartyId: string; unitId: string; total: string; status: string }[];
}
interface Invoice {
  id: string;
  total: string;
  status: string;
  dueDate: string | null;
  periodStart: string;
  periodEnd: string;
  reviewFlags: string[];
  lines: {
    id: string;
    lineKind: string;
    amount: string;
    description: string;
    periodFrom: string | null;
    periodTo: string | null;
  }[];
}

/**
 * J1.1a (D-303 = D-J02, D-307, D-323) on a juristic tenant's mixed property: a condominium building whose owners pay
 * an **annual** common fee and a **quarterly** sinking fund (two co-owners 60/40; a transfer on 15 March), and a rental
 * building of the same property with a **monthly** lease. The worker opens the three cycles side by side, the co-owners
 * share the fee to the satang, seller and buyer are prorated by calendar days, the advance invoices fall due at the
 * start of their period and their revenue is scheduled month by month; the DEV apartment keeps its monthly cycles.
 */
describe('J1.1a juristic owner billing and billing frequencies (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let jur: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const J = () => bearer(jur.token);
  /** Time travel: the fake clock moves and the juristic owner signs in again. */
  const at = async (instant: string) => {
    t.clock.set(new Date(instant));
    jur = { ...jur, token: await operatorToken(t, '+660000000231') };
  };
  const cycles = async () =>
    (await t.http.get(`/v1/owner/billing-cycles?propertyId=${ids.property}&perPage=50`).set(J()).expect(200))
      .body.data as Cycle[];
  const cycle = async (id: string) =>
    (await t.http.get(`/v1/owner/billing-cycles/${id}`).set(J()).expect(200)).body as Cycle;
  const invoice = async (id: string) =>
    (await t.http.get(`/v1/owner/invoices/${id}`).set(J()).expect(200)).body as Invoice;
  const invoiceOf = (c: Cycle, unit: string, party: string) =>
    c.invoices.find((i) => i.unitId === ids[unit] && i.billedPartyId === ids[party]);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_billing' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db);
    t.clock.set(new Date('2026-12-20T09:00:00+07:00'));
    jur = await onboardTenant(t, await adminToken(t), {
      slug: 'j11a-condo',
      phone: '+660000000231',
      type: 'juristic',
    });
    const T = jur.tenantId;
    ids.property = (
      await one<{ id: string }>(
        `INSERT INTO core.property (tenant_id, code, name) VALUES ($1, 'J11A', 'ศุภาลัย ทดสอบ') RETURNING id`,
        [T],
      )
    ).id;
    const building = async (code: string, type: string, legalForm: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO core.building (tenant_id, property_id, code, name, type, owner_tenant_id, operator_tenant_id, legal_form)
           VALUES ($1, $2, $3, $6, $4::core.building_type, $1, $1, $5::core.building_legal_form) RETURNING id`,
          [T, ids.property, code, type, legalForm, `อาคาร ${code}`],
        )
      ).id;
    ids.condo = await building('A', 'condo', 'condo_act');
    ids.rental = await building('R', 'apartment', 'lease_contract');
    const unit = async (
      key: string,
      buildingId: string,
      unitNo: string,
      type: string,
      area: string,
      ratio: string | null,
    ) => {
      ids[key] = (
        await one<{ id: string }>(
          `INSERT INTO core.unit (tenant_id, building_id, property_id, unit_no, type, area_sqm, ownership_ratio)
           VALUES ($1, $2, $3, $4, $5::core.unit_type, $6, $7) RETURNING id`,
          [T, buildingId, ids.property, unitNo, type, area, ratio],
        )
      ).id;
    };
    await unit('a1201', ids.condo, 'A-1201', 'condo_unit', '34.77', '0.012345');
    await unit('a1202', ids.condo, 'A-1202', 'condo_unit', '45.50', '0.010000');
    await unit('r101', ids.rental, 'R-101', 'room', '24.00', null);
    const party = async (key: string, name: string) => {
      ids[key] = (
        await one<{ id: string }>(
          `INSERT INTO core.party (tenant_id, type, display_name) VALUES ($1, 'person', $2) RETURNING id`,
          [T, name],
        )
      ).id;
    };
    for (const [k, n] of [
      ['p60', 'เจ้าของร่วม 60'],
      ['p40', 'เจ้าของร่วม 40'],
      ['seller', 'ผู้ขาย'],
      ['buyer', 'ผู้ซื้อ'],
      ['lessee', 'ผู้เช่า R-101'],
    ])
      await party(k!, n!);
    const own = (unitKey: string, partyKey: string, share: string, from: string, to: string | null) =>
      q(
        `INSERT INTO core.unit_ownership (tenant_id, building_id, unit_id, party_id, share_pct, valid_from, valid_to, source)
         SELECT u.tenant_id, u.building_id, u.id, $2, $3, $4, $5, 'manual' FROM core.unit u WHERE u.id = $1`,
        [ids[unitKey], ids[partyKey], share, from, to],
      );
    await own('a1201', 'p60', '60', '2020-01-01', null);
    await own('a1201', 'p40', '40', '2020-01-01', null);
    await own('a1202', 'seller', '100', '2020-01-01', '2027-03-15');
    await own('a1202', 'buyer', '100', '2027-03-15', null);
    // the rental building: one monthly lease (rent only, utilities included)
    const template = await one<{ id: string }>(`SELECT id FROM ops.lease_template_version LIMIT 1`);
    await q(
      `INSERT INTO ops.lease (tenant_id, building_id, unit_id, lessee_party_id, template_version_id, number, status, start_date,
                              end_date, months, rent, utility_billing_mode, activated_at)
       VALUES ($1, $2, $3, $4, $5, 'CTR-J11A-0001', 'active', '2026-12-01', '2027-11-30', 12, 4500, 'included', now())`,
      [T, ids.rental, ids.r101, ids.lessee, template.id],
    );
  }, 600_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('rate plans carry their frequency; only common-fee and fund plans may be non-monthly (422)', async () => {
    const bad = await t.http
      .post('/v1/owner/rate-plans')
      .set(J())
      .send({ buildingId: ids.condo, kind: 'power', name: 'ไฟ', isDefault: true, frequency: 'annual' })
      .expect(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ path: 'frequency' })]);
    const plan = async (kind: string, name: string, frequency: string, version: Record<string, unknown>) => {
      const p = await t.http
        .post('/v1/owner/rate-plans')
        .set(J())
        .send({ buildingId: ids.condo, kind, name, isDefault: true, frequency })
        .expect(201);
      expect(p.body.frequency).toBe(frequency);
      await t.http
        .post(`/v1/owner/rate-plans/${p.body.id}/versions`)
        .set(J())
        .send({ effectiveFrom: '2027-01-01', ...version })
        .expect(201);
      return p.body.id as string;
    };
    ids.cfPlan = await plan('common_fee', 'ค่าส่วนกลาง', 'annual', {
      basis: 'per_sqm',
      tiers: { kind: 'flat', pricePerUnit: '30.00' },
    });
    ids.fundPlan = await plan('fund', 'เงินกองทุน', 'quarterly', {
      basis: 'per_ownership_ratio',
      tiers: { kind: 'budget', amount: '100000.00', period: 'month' },
    });
    const yearly = await t.http
      .post(`/v1/owner/rate-plans/${ids.fundPlan}/versions`)
      .set(J())
      .send({
        effectiveFrom: '2027-06-01',
        basis: 'per_ownership_ratio',
        tiers: { kind: 'budget', amount: '1.00', period: 'week' },
      })
      .expect(422);
    expect(yearly.body.errors).toEqual([expect.objectContaining({ path: 'tiers.period' })]);
  });

  it('the sweep opens a monthly lease cycle, a quarterly fund cycle and an annual common-fee cycle side by side', async () => {
    await at('2027-01-01T01:00:00+07:00');
    await t.app.get(BillingCyclesService).sweep();
    const list = await cycles();
    expect(list.map((c) => [c.frequency, c.periodKey, c.periodStart, c.periodEnd]).sort()).toEqual([
      ['annual', '2027', '2027-01-01', '2027-12-31'],
      ['monthly', '2026-12', '2026-12-01', '2026-12-31'],
      ['quarterly', '2027-Q1', '2027-01-01', '2027-03-31'],
    ]);
    for (const c of list) ids[`cycle:${c.frequency}`] = c.id;
    // the monthly cycle bills the lease only (no monthly owner plan, no meters)
    const monthly = await cycle(ids['cycle:monthly']!);
    expect(monthly.invoices).toHaveLength(1);
    expect(monthly.invoices[0]).toMatchObject({
      unitId: ids.r101,
      billedPartyId: ids.lessee,
      total: '4500.00',
    });
    // a second sweep changes nothing
    await t.app.get(BillingCyclesService).sweep();
    expect((await cycles()).length).toBe(3);
    // the keys are per frequency, and the key format follows the frequency
    await expect(
      q(
        `INSERT INTO ops.billing_cycle (tenant_id, property_id, period_key, frequency, period_start, period_end, cut_off_at,
                                        readings_window_minutes, grace_deadline_at, estimate_policy)
         VALUES ($1, $2, '2027', 'annual', '2027-01-01', '2027-12-31', now(), 60, now(), 'block')`,
        [jur.tenantId, ids.property],
      ),
    ).rejects.toThrow(/billing_cycle_property_id_frequency_period/);
    await expect(
      q(
        `INSERT INTO ops.billing_cycle (tenant_id, property_id, period_key, frequency, period_start, period_end, cut_off_at,
                                        readings_window_minutes, grace_deadline_at, estimate_policy)
         VALUES ($1, $2, '2027-Q2', 'monthly', '2027-04-01', '2027-04-30', now(), 60, now(), 'block')`,
        [jur.tenantId, ids.property],
      ),
    ).rejects.toThrow(/billing_cycle_period_key_check/);
  });

  it('annual common fee: co-owners 60/40 share the unit amount; seller and buyer are prorated around 15 March', async () => {
    const annual = await cycle(ids['cycle:annual']!);
    expect(annual.invoices).toHaveLength(4);
    // A-1201: 34.77 m² × 30.00 = 1,043.10 a month → 12,517.20 a year → 60 % 7,510.32 + 40 % 5,006.88
    expect(invoiceOf(annual, 'a1201', 'p60')!.total).toBe('7510.32');
    expect(invoiceOf(annual, 'a1201', 'p40')!.total).toBe('5006.88');
    // A-1202: 45.50 m² × 30.00 × 12 = 16,380.00 → seller 73/365 = 3,276.00, buyer 292/365 = 13,104.00
    const seller = await invoice(invoiceOf(annual, 'a1202', 'seller')!.id);
    const buyer = await invoice(invoiceOf(annual, 'a1202', 'buyer')!.id);
    expect(seller).toMatchObject({ total: '3276.00', periodStart: '2027-01-01', periodEnd: '2027-03-14' });
    expect(seller.lines[0]).toMatchObject({
      description: 'ค่าส่วนกลาง (73/365 วัน)',
      periodTo: '2027-03-14',
    });
    expect(buyer).toMatchObject({ total: '13104.00', periodStart: '2027-03-15', periodEnd: '2027-12-31' });
    expect(new Decimal(seller.total).plus(buyer.total).toFixed(2)).toBe('16380.00');
    for (const i of annual.invoices) expect((await invoice(i.id)).reviewFlags).toEqual([]);
  });

  it('quarterly fund by ownership ratio: 3 months of the monthly budget, shared and prorated the same way', async () => {
    const quarter = await cycle(ids['cycle:quarterly']!);
    // A-1201: 0.012345 × 100,000.00 × 3 = 3,703.50 → 2,222.10 + 1,481.40; A-1202: 3,000.00 → 73/90 = 2,433.33 + 566.67
    expect(
      Object.fromEntries(
        ['p60', 'p40', 'seller', 'buyer'].map((p) => [
          p,
          invoiceOf(quarter, p === 'p60' || p === 'p40' ? 'a1201' : 'a1202', p)!.total,
        ]),
      ),
    ).toEqual({ p60: '2222.10', p40: '1481.40', seller: '2433.33', buyer: '566.67' });
  });

  it('issuing the annual cycle: due at the start of each invoice period; revenue scheduled per month (Σ = line)', async () => {
    await t.http
      .post(`/v1/owner/billing-cycles/${ids['cycle:annual']}/actions/issue`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(200);
    const annual = await cycle(ids['cycle:annual']!);
    expect(annual.invoices.every((i) => i.status === 'issued')).toBe(true);
    const seller = await invoice(invoiceOf(annual, 'a1202', 'seller')!.id);
    const buyer = await invoice(invoiceOf(annual, 'a1202', 'buyer')!.id);
    const p60 = await invoice(invoiceOf(annual, 'a1201', 'p60')!.id);
    expect([seller.dueDate, buyer.dueDate, p60.dueDate]).toEqual(['2027-01-05', '2027-04-05', '2027-01-05']);
    const schedule = await q<{ line: string; month: string; amount: string }>(
      `SELECT invoice_line_id::text AS line, to_char(month, 'YYYY-MM-DD') AS month, amount::text AS amount
         FROM juristic.revenue_schedule WHERE tenant_id = $1 ORDER BY month`,
      [jur.tenantId],
    );
    const ofLine = (lineId: string) => schedule.filter((r) => r.line === lineId);
    const buyerRows = ofLine(buyer.lines[0]!.id);
    expect(buyerRows.map((r) => r.month)).toEqual([
      '2027-03-01',
      '2027-04-01',
      '2027-05-01',
      '2027-06-01',
      '2027-07-01',
      '2027-08-01',
      '2027-09-01',
      '2027-10-01',
      '2027-11-01',
      '2027-12-01',
    ]);
    expect(buyerRows[0]!.amount).toBe('762.90');
    for (const inv of [seller, buyer, p60]) {
      const sum = ofLine(inv.lines[0]!.id).reduce((s, r) => s.plus(r.amount), new Decimal(0));
      expect(sum.toFixed(2)).toBe(inv.lines[0]!.amount);
    }
    expect(ofLine(p60.lines[0]!.id)).toHaveLength(12);
    // monthly invoices get no schedule
    expect(schedule).toHaveLength(12 + 12 + 3 + 10);
  });

  it('opening by key: semiannual / quarterly keys accepted, malformed keys refused (422); another tenant gets 404', async () => {
    const h2 = await t.http
      .post('/v1/owner/billing-cycles')
      .set(J())
      .send({ propertyId: ids.property, periodKey: '2027-H2' })
      .expect(200);
    expect(h2.body).toMatchObject({
      frequency: 'semiannual',
      periodStart: '2027-07-01',
      periodEnd: '2027-12-31',
    });
    for (const periodKey of ['2027-Q5', '2027-H3', '2027-13', '27'])
      await t.http
        .post('/v1/owner/billing-cycles')
        .set(J())
        .send({ propertyId: ids.property, periodKey })
        .expect(422);
    const filtered = await t.http
      .get(`/v1/owner/billing-cycles?propertyId=${ids.property}&frequency=quarterly`)
      .set(J())
      .expect(200);
    expect((filtered.body.data as Cycle[]).map((c) => c.periodKey)).toEqual(['2027-Q1']);
    const dev = bearer(await ownerToken(t));
    await t.http.get(`/v1/owner/billing-cycles/${ids['cycle:annual']}`).set(dev).expect(404);
    await t.http.get(`/v1/owner/rate-plans/${ids.cfPlan}`).set(dev).expect(404);
  });

  it('apartments are unchanged: the DEV property keeps monthly cycles only', async () => {
    const rows = await q<{ frequency: string }>(
      `SELECT DISTINCT c.frequency::text AS frequency FROM ops.billing_cycle c JOIN core.property p ON p.id = c.property_id
        WHERE p.tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(rows.every((r) => r.frequency === 'monthly')).toBe(true);
    const plans = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.rate_plan WHERE tenant_id = $1 AND frequency <> 'monthly'`,
      [DEV.tenantId],
    );
    expect(plans[0]!.n).toBe(0);
  });
});
