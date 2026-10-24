import 'reflect-metadata';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeLineIdToken } from '@collective/integrations/line';
import { AnalyticsService } from '@modules/platform-analytics/analytics.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const GOLDEN = join(__dirname, '..', 'golden', 'analytics');
function golden(name: string, value: unknown): void {
  const file = join(GOLDEN, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(value).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

const DAY = 86_400_000;

/**
 * B6.3 acceptance (docs/prompts/B6-platform-launch.md 6.3, D-083, D-217): facts derived from real billing flows and
 * from fixtures roll up per Bangkok day / week / month and per building; the pilot KPI endpoint reads the rollups
 * (golden); the owner insights; the resident survey; anonymised benchmarks only for buckets of k ≥ 5 opted-in tenants.
 */
describe('B6.3 analytics, KPIs, insights, benchmarks (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let unitA101: string;
  const others: { tenantId: string; token: string; ownerUserId: string }[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const analytics = () => t.app.get(AnalyticsService);
  /** Inserts a fact as the subscriber / derivation would (partition first). */
  async function fact(
    tenantId: string,
    f: string,
    value: string,
    at: Date,
    buildingId: string | null = null,
  ) {
    await q('SELECT platform.ensure_analytics_partition($1::timestamptz)', [at]);
    await q(
      `INSERT INTO platform.analytics_fact (time, tenant_id, building_id, fact, subject_type, subject_id, value)
       VALUES ($1, $2, $3, $4, 'test.fixture', uuidv7(), $5)`,
      [at, tenantId, buildingId, f, value],
    );
  }
  let period = 0;
  /** A draft invoice for A-101 issued through the API (its due date follows the lease billing day). */
  async function issuedInvoice(total: string): Promise<string> {
    period += 1;
    const start = `2024-${String(period).padStart(2, '0')}-01`;
    const [inv] = await q<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                subtotal, total, balance)
       VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, $7, $7, $7)
       RETURNING id`,
      [DEV.tenantId, DEV.buildingId, unitA101, DEV.residentPartyId, DEV.leaseId, start, total],
    );
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
       VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่า', 1, 'month', $3, $3)`,
      [DEV.tenantId, inv!.id, total],
    );
    await t.http
      .post(`/v1/owner/invoices/${inv!.id}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({})
      .expect(200);
    await settle();
    return inv!.id;
  }
  const balance = async (invoiceId: string) =>
    (await q<{ b: string }>('SELECT balance::text AS b FROM ops.invoice WHERE id = $1', [invoiceId]))[0]!.b;
  const cash = async (invoiceId: string, _total: string) =>
    t.http
      .post('/v1/owner/payments')
      .set(bearer(owner))
      .set(idem())
      .send({
        invoiceId,
        amount: await balance(invoiceId),
        method: 'cash',
        paidAt: t.clock.now().toISOString(),
        reference: 'เงินสด',
      });

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b63' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    owner = await ownerToken(t);
    unitA101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    for (let i = 1; i <= 5; i += 1) {
      const o = await onboardTenant(t, admin, {
        slug: `bench-${i}`,
        phone: `+66000000029${i}`,
        type: 'apartment',
      });
      const [m] = await q<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`,
        [o.tenantId],
      );
      others.push({ ...o, ownerUserId: m!.user_id });
    }
  }, 300_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('facts from real flows: invoices issued, corrected, paid on time or late; payments by method', async () => {
    // one open invoice at a time (no partial payments): pay, void, then leave one open
    const early = await issuedInvoice('3000.00');
    const paidEarly = await cash(early, '3000.00');
    if (paidEarly.status >= 300) throw new Error(JSON.stringify(paidEarly.body));
    await settle();
    const voided = await issuedInvoice('3200.00');
    await t.http
      .post(`/v1/owner/invoices/${voided}/actions/void`)
      .set(bearer(owner))
      .set(idem())
      .send({ reason: 'ออกผิดงวด' })
      .expect(200);
    await settle();
    const late = await issuedInvoice('3100.00');
    // two days after the due date the late one is paid
    const [{ due }] = (await q<{ due: string }>(
      'SELECT due_date::text AS due FROM ops.invoice WHERE id = $1',
      [late],
    )) as [{ due: string }];
    t.clock.set(new Date(new Date(`${due}T12:00:00+07:00`).getTime() + 2 * DAY));
    owner = await ownerToken(t);
    admin = await adminToken(t);
    expect((await cash(late, '3100.00')).status).toBeLessThan(300);
    await settle();
    await analytics().sweep();
    const facts = await q<{ fact: string; subject_id: string; value: string }>(
      `SELECT fact, subject_id, value::numeric(18,2)::text AS value FROM platform.analytics_fact
        WHERE tenant_id = $1 ORDER BY fact, value`,
      [DEV.tenantId],
    );
    const of = (f: string) => facts.filter((x) => x.fact === f);
    expect(of('invoice.issued')).toHaveLength(3);
    expect(of('invoice.corrected')).toEqual([expect.objectContaining({ subject_id: voided, value: '1.00' })]);
    expect(of('payment.on_time').map((x) => [x.subject_id, x.value])).toEqual([
      [late, '0.00'],
      [early, '1.00'],
    ]);
    expect(of('payment.auto_reconciled').map((x) => x.value)).toEqual(['0.00', '0.00']);
    expect(of('payment.by_qr').map((x) => x.value)).toEqual(['0.00', '0.00']);
    // idempotent: deriving again writes nothing new
    const before = facts.length;
    await analytics().sweep();
    expect(
      (await q('SELECT 1 FROM platform.analytics_fact WHERE tenant_id = $1', [DEV.tenantId])).length,
    ).toBe(before);
  });

  it('rollups per Bangkok day / week / month and per building; the pilot KPIs read them (golden)', async () => {
    const now = t.clock.now();
    const yesterday = new Date(now.getTime() - DAY);
    await fact(DEV.tenantId, 'loss.pct', '4.5', new Date(now.getTime() - 10 * DAY), DEV.buildingId);
    await fact(DEV.tenantId, 'loss.pct', '3.0', yesterday, DEV.buildingId);
    await fact(DEV.tenantId, 'meter.uptime_pct', '99', yesterday, DEV.buildingId);
    await fact(DEV.tenantId, 'meter.uptime_pct', '100', new Date(yesterday.getTime() - DAY), DEV.buildingId);
    await fact(DEV.tenantId, 'csat.rating', '5', yesterday, DEV.buildingId);
    await fact(DEV.tenantId, 'csat.rating', '4', yesterday, DEV.buildingId);
    await fact(DEV.tenantId, 'cycle.time_to_issue_s', '1800', yesterday);
    await fact(DEV.tenantId, 'cycle.time_to_issue_s', '5400', new Date(yesterday.getTime() - 2 * DAY));
    await fact(DEV.tenantId, 'reminder.effective', '1', yesterday, DEV.buildingId);
    await fact(DEV.tenantId, 'reminder.effective', '0', yesterday, DEV.buildingId);
    await t.app.get(AnalyticsService).sweep();
    await db
      .prisma()
      .withTx((tx) =>
        analytics().rollup(tx, { tenantId: DEV.tenantId, from: new Date(now.getTime() - 30 * DAY), to: now }),
      );

    const day = await q<{ building_id: string | null; value: string; count: number }>(
      `SELECT building_id, value::numeric(18,2)::text AS value, count FROM platform.analytics_rollup
        WHERE tenant_id = $1 AND fact = 'csat.rating' AND bucket = 'day' ORDER BY building_id NULLS FIRST`,
      [DEV.tenantId],
    );
    expect(day).toEqual([
      { building_id: null, value: '9.00', count: 2 },
      { building_id: DEV.buildingId, value: '9.00', count: 2 },
    ]);
    const month = await q<{ n: number; v: string }>(
      `SELECT sum(count)::int AS n, sum(value)::numeric(18,2)::text AS v FROM platform.analytics_rollup
        WHERE tenant_id = $1 AND fact = 'loss.pct' AND bucket = 'month' AND building_id IS NULL`,
      [DEV.tenantId],
    );
    expect(month[0]).toEqual({ n: 2, v: '7.50' });
    const weeks = await q<{ d: string }>(
      `SELECT bucket_start::text AS d FROM platform.analytics_rollup
        WHERE tenant_id = $1 AND fact = 'loss.pct' AND bucket = 'week' AND building_id IS NULL`,
      [DEV.tenantId],
    );
    for (const w of weeks) expect(new Date(`${w.d}T00:00:00Z`).getUTCDay()).toBe(1); // ISO weeks start on Monday

    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/pilot-agreement`)
      .set(bearer(admin))
      .send({
        signedOn: new Date(now.getTime() - 5 * DAY).toISOString().slice(0, 10),
        discountPct: '30',
        termMonths: 6,
        baseline: { timeToBillHours: '72', onTimePaymentPct: '40', autoReconciledPct: '0', csat: '3.5' },
      })
      .expect(200);
    const kpis = await t.http
      .get(`/v1/admin/tenants/${DEV.tenantId}/pilot-kpis?window=90d`)
      .set(bearer(admin))
      .expect(200);
    golden('pilot-kpis-90d.json', {
      kpis: kpis.body.kpis,
      current: kpis.body.current,
      acceptance: kpis.body.acceptance,
    });
    expect(kpis.body.current).toMatchObject({
      timeToBillHours: '1.00',
      invoiceCorrectionRatePct: '33.33',
      onTimePaymentPct: '50.00',
      autoReconciledPct: '0.00',
      lossIdentified: true,
      latestLossPct: '3.0000',
      meterUptimePct: '99.50',
      csat: '4.50',
    });
    const mine = await t.http.get('/v1/owner/pilot-kpis?window=90d').set(bearer(owner)).expect(200);
    expect(mine.body.current).toEqual(kpis.body.current);
  });

  it('the resident survey: due, answered once per interval, counted in CSAT', async () => {
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b63b01', name: 'ผู้เช่า' }) })
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
    const R = bearer(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)).body
        .accessToken as string,
    );
    const due = await t.http.get(`/v1/resident/surveys/csat?unitId=${unitA101}`).set(R).expect(200);
    expect(due.body).toMatchObject({
      unitId: unitA101,
      due: true,
      questionKey: 'csat.overall_v1',
      lastAnsweredAt: null,
    });
    await t.http.post('/v1/resident/surveys/csat').set(R).send({ unitId: unitA101, rating: 6 }).expect(422);
    const answered = await t.http
      .post('/v1/resident/surveys/csat')
      .set(R)
      .send({ unitId: unitA101, rating: 3, comment: 'ลิฟต์เสียบ่อย' })
      .expect(200);
    expect(answered.body).toMatchObject({ due: false });
    const again = await t.http
      .post('/v1/resident/surveys/csat')
      .set(R)
      .send({ unitId: unitA101, rating: 5 })
      .expect(409);
    expect(again.body.code).toBe('csat.not_due');
    const [a102] = await q<{ id: string }>(
      `SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`,
      [DEV.buildingId],
    );
    await t.http.get(`/v1/resident/surveys/csat?unitId=${a102!.id}`).set(R).expect(404);
    await settle();
    const facts = await q<{ value: string; dims: { source: string } }>(
      `SELECT value::int::text AS value, dims FROM platform.analytics_fact WHERE tenant_id = $1 AND fact = 'csat.rating'
          AND subject_type = 'platform.csat_response'`,
      [DEV.tenantId],
    );
    expect(facts).toEqual([{ value: '3', dims: { source: 'survey', question: 'csat.overall_v1' } }]);
  });

  it('owner insights: 90-day KPIs, month series of every metric, building filter', async () => {
    // the clock travelled: fresh tokens for the benchmark tenants
    for (const [i, o] of others.entries()) o.token = await operatorToken(t, `+66000000029${i + 1}`);
    const res = await t.http.get('/v1/owner/insights?months=3').set(bearer(owner)).expect(200);
    expect(res.body).toMatchObject({
      tenantId: DEV.tenantId,
      buildingId: null,
      benchmarks: { optedIn: false, items: [] },
    });
    expect(res.body.series).toHaveLength(12);
    for (const s of res.body.series as { points: unknown[] }[]) expect(s.points).toHaveLength(3);
    const csat = (
      res.body.series as { metric: string; points: { value: string | null; count: number }[] }[]
    ).find((s) => s.metric === 'csat')!;
    expect(csat.points.reduce((n, p) => n + p.count, 0)).toBe(3);
    const correction = (res.body.series as { metric: string; points: { value: string | null }[] }[]).find(
      (s) => s.metric === 'invoice_correction_rate_pct',
    )!;
    expect(correction.points.some((p) => p.value === '33.33')).toBe(true);
    const building = await t.http
      .get(`/v1/owner/insights?months=3&building=${DEV.buildingId}`)
      .set(bearer(owner))
      .expect(200);
    expect(building.body.buildingId).toBe(DEV.buildingId);
    await t.http
      .get(`/v1/owner/insights?building=${DEV.buildingId}`)
      .set(bearer(others[0]!.token))
      .expect(404);
    await t.http.get('/v1/owner/insights?months=1').set(bearer(owner)).expect(422);
  });

  it('benchmarks: k-anonymity — nothing below 5 opted-in tenants, percentiles from 5', async () => {
    const yesterday = new Date(t.clock.now().getTime() - DAY);
    const [purpose] = await q<{ id: string }>(
      `SELECT v.id FROM platform.consent_purpose_version v JOIN platform.consent_purpose p ON p.id = v.purpose_id
        WHERE p.key = 'analytics.anonymised' ORDER BY v.version DESC LIMIT 1`,
    );
    const optIn = (userId: string) =>
      q(
        `INSERT INTO platform.consent (tenant_id, subject_type, subject_id, purpose_version_id, granted, channel)
         VALUES (NULL, 'user', $1, $2, true, 'web')`,
        [userId, purpose!.id],
      );
    for (const [i, o] of others.entries()) {
      await fact(o.tenantId, 'loss.pct', String(2 + i), yesterday);
      await fact(o.tenantId, 'payment.on_time', '1', yesterday);
      await fact(o.tenantId, 'payment.on_time', i % 2 ? '0' : '1', yesterday);
    }
    for (const o of others.slice(0, 4)) await optIn(o.ownerUserId);
    expect(await analytics().benchmarks()).toBe(0);
    expect(await q('SELECT 1 FROM platform.benchmark_bucket')).toHaveLength(0);
    const four = await t.http.get('/v1/owner/insights?months=3').set(bearer(others[0]!.token)).expect(200);
    expect(four.body.benchmarks).toEqual({ optedIn: true, items: [] });

    await optIn(others[4]!.ownerUserId);
    expect(await analytics().benchmarks()).toBe(4); // loss & on-time × (type, type × size)
    const rows = await q<{
      metric: string;
      bucket_key: string;
      k: number;
      p25: string;
      p50: string;
      p75: string;
    }>(
      `SELECT metric, bucket_key, k, p25::numeric(18,2)::text AS p25, p50::numeric(18,2)::text AS p50,
              p75::numeric(18,2)::text AS p75 FROM platform.benchmark_bucket ORDER BY metric, bucket_key`,
    );
    expect(rows).toEqual([
      { metric: 'loss_pct', bucket_key: 'type:apartment', k: 5, p25: '3.00', p50: '4.00', p75: '5.00' },
      {
        metric: 'loss_pct',
        bucket_key: 'type:apartment|size:lt20',
        k: 5,
        p25: '3.00',
        p50: '4.00',
        p75: '5.00',
      },
      {
        metric: 'on_time_payment_pct',
        bucket_key: 'type:apartment',
        k: 5,
        p25: '50.00',
        p50: '100.00',
        p75: '100.00',
      },
      {
        metric: 'on_time_payment_pct',
        bucket_key: 'type:apartment|size:lt20',
        k: 5,
        p25: '50.00',
        p50: '100.00',
        p75: '100.00',
      },
    ]);
    // the table never stores tenant ids, and refuses a bucket below k = 5
    const columns = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'benchmark_bucket'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('tenant_id');
    await expect(
      q(
        `INSERT INTO platform.benchmark_bucket (metric, bucket_key, k, p25, p50, p75, as_of, computed_at)
         VALUES ('loss_pct', 'type:x', 4, 1, 2, 3, current_date, now())`,
      ),
    ).rejects.toThrow(/benchmark_bucket_k_check/);
    const opted = await t.http.get('/v1/owner/insights?months=3').set(bearer(others[1]!.token)).expect(200);
    expect(opted.body.benchmarks.optedIn).toBe(true);
    expect(opted.body.benchmarks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'loss_pct',
          bucketKey: 'type:apartment',
          k: 5,
          p50: '4.0000',
          mine: '3.0000',
        }),
      ]),
    );
    // the dev tenant did not opt in: no benchmarks (give to get)
    const dev = await t.http.get('/v1/owner/insights?months=3').set(bearer(owner)).expect(200);
    expect(dev.body.benchmarks).toEqual({ optedIn: false, items: [] });
  });

  it('RLS: facts and rollups stay within their tenant', async () => {
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of ['platform.analytics_fact', 'platform.analytics_rollup', 'platform.csat_response']) {
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
    }
    const devFacts = await count(DEV.tenantId, 'platform.analytics_fact');
    const all = (await q<{ n: number }>('SELECT count(*)::int AS n FROM platform.analytics_fact'))[0]!.n;
    expect(devFacts).toBeLessThan(all);
    expect(await count(others[0]!.tenantId, 'platform.csat_response')).toBe(0);
  });
});
