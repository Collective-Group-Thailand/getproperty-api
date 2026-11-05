import 'reflect-metadata';

import { SettingsService } from '@core/settings/settings.service';
import { CollectionsService } from '@modules/ops-juristic/collections.service';
import { PaymentPlansService } from '@modules/ops-juristic/payment-plans.service';
import { ReceivablesService } from '@modules/ops-receivables/receivables.service';

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

const PHONE_J = '+660000000261';
const PHONE_P = '+66810002611';
const PHONE_LANDLORD = '+66810002621';
const PHONE_LANDLORD_2 = '+66810002622';
const PHONE_OFFICE = '+66810002623';
const PROJECT = 'เดอะ ทดสอบ คอนโด J12B';
const ADDRESS = { line1: 'ถนนสุขุมวิท', district: 'วัฒนา', province: 'กรุงเทพมหานคร', postcode: '10110' };
const at = (d: string) => new Date(`${d}T09:00:00+07:00`);

/**
 * J1.2b acceptance (D-270, D-305, D-307, D-326) on a juristic condominium (condo_act) and the DEV apartment: cases open
 * on overdue invoices of the juristic tenant only (apartments keep their per-invoice dunning); the ladder runs each step
 * on its day exactly once; a payment plan and a dispute pause it, a plan default and the dispute's closing resume it
 * (the pause moves the rest back); the surcharge is off by default (skipped) and exact when switched on with the
 * seeded rule; an approval-required step waits, approved runs, refused moves on; a statement across two units is paid
 * by one payment over both invoices and the cases resolve; letters for an owner without channels; aging and KPI from
 * the fixture; the D-270 workspace sees only linked units and bills the landlord, who pays in LIFF; cross-tenant 404.
 */
describe('J1.2b collections ladder, statements, D-270 workspace, reports (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let dev: string;
  let jur: { tenantId: string; token: string };
  let coOwner: string;
  const ids: Record<string, string> = {};
  const inv: Record<string, string> = {};
  let invSeq = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const collections = () => t.app.get(CollectionsService);
  /** Moves the clock and signs in again (access tokens are short-lived). */
  const relogin = async () => {
    jur = { ...jur, token: await operatorToken(t, PHONE_J) };
    dev = await ownerToken(t);
    admin = await adminToken(t);
  };
  const goTo = async (d: string) => {
    t.clock.set(at(d));
    await relogin();
  };
  const caseOf = (unitId: string) =>
    one<{ id: string; state: string; paused_days: number; plan_id: string | null; next_seq: number }>(
      `SELECT id, state::text, paused_days, plan_id, next_seq FROM juristic.collection_case
        WHERE unit_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [unitId],
    );
  const steps = (caseId: string) =>
    q<{ seq: number; action: string; outcome: string; reason: string | null; amount: string | null }>(
      `SELECT seq, action::text, outcome::text, reason, amount::text FROM juristic.collection_event
        WHERE case_id = $1 AND kind = 'step' ORDER BY occurred_at, id`,
      [caseId],
    );
  const doc = async (tenantId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [tenantId],
      )
    ).id;

  /** An issued invoice of the juristic tenant (one common-fee line). */
  async function invoice(
    unitId: string,
    partyId: string,
    amount: string,
    opts: { issuedAt: string; dueDate: string; cycleId?: string; kind?: string; chargeId?: string },
  ): Promise<string> {
    invSeq += 1;
    const id = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, billing_cycle_id, period_start, period_end,
                                  subtotal, total, balance)
         VALUES ($1, $2, $3, $4, $5, '2026-12-01', '2026-12-31', $6, $6, $6) RETURNING id`,
        [jur.tenantId, ids.building, unitId, partyId, opts.cycleId ?? null, amount],
      )
    ).id;
    const kind = opts.kind ?? 'common_fee';
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount, source_id)
       VALUES ($1, $2, 1, $3::ops.invoice_line_source_type, $4::ops.invoice_line_kind, $4, 1, 'month', $5, $5, $6)`,
      [
        jur.tenantId,
        id,
        kind === 'plan_instalment' ? 'adjustment' : 'common_fee',
        kind,
        amount,
        opts.chargeId ?? null,
      ],
    );
    await q(
      `UPDATE ops.invoice SET status = 'issued', number = $2, issued_at = $3, due_date = $4, snapshot = '{}' WHERE id = $1`,
      [id, `INV-2026-8${String(invSeq).padStart(4, '0')}`, opts.issuedAt, opts.dueDate],
    );
    return id;
  }
  const balance = (id: string) =>
    one<{ status: string; balance: string }>(
      'SELECT status::text, balance::text FROM ops.invoice WHERE id = $1',
      [id],
    );
  const setOwner = (key: string, value: unknown) =>
    t.http
      .put(`/v1/owner/settings/${key}`)
      .set(J())
      .send({ value, reason: 'J1.2b test' })
      .expect(200)
      .then(() => t.app.get(SettingsService).invalidate(key));
  const setPlatform = (key: string, value: unknown) =>
    t.http
      .put(`/v1/admin/settings/${key}`)
      .set(bearer(admin))
      .send({ value, reason: 'J1.2b test (counsel confirmed in the fixture)' })
      .expect(200)
      .then(() => t.app.get(SettingsService).invalidate(key));

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_collections' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2027-01-10'));
    admin = await adminToken(t);
    dev = await ownerToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j12b-juristic', phone: PHONE_J, type: 'juristic' });
    const property = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโด J1.2b', kind: 'condo' })
      .expect(201);
    ids.property = property.body.id;
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
    for (const n of [1, 2, 3, 4, 5])
      ids[`u${n}`] = (
        await t.http
          .post('/v1/owner/units')
          .set(J())
          .send({ buildingId: ids.building, unitNo: `A-20${n}`, type: 'condo_unit', areaSqm: '40.00' })
          .expect(201)
      ).body.id;
    // P owns A-201 and A-202 (phone, co-owner login); Q owns A-203 (no LINE, e-mail or phone); R A-204; S A-205
    const add = async (unit: string, body: Record<string, unknown>) =>
      (
        await t.http
          .post(`/v1/owner/juristic/register/units/${unit}/owners`)
          .set(J())
          .send({ sharePct: '100', validFrom: '2020-01-01', ...body })
          .expect(201)
      ).body.owners[0].party.id as string;
    ids.P = await add(ids.u1!, { party: { type: 'person', displayName: 'สมชาย สองห้อง', phone: PHONE_P } });
    await add(ids.u2!, { partyId: ids.P });
    ids.Q = await add(ids.u3!, { party: { type: 'person', displayName: 'สมหญิง ไม่มีช่องทาง' } });
    ids.R = await add(ids.u4!, { party: { type: 'person', displayName: 'สมศักดิ์ ผ่อนชำระ' } });
    ids.S = await add(ids.u5!, { party: { type: 'person', displayName: 'สมใจ โต้แย้ง' } });
    coOwner = (await otpSignIn(t, 'resident', PHONE_P, jur.token)).accessToken;
    ids.evidence = await doc(jur.tenantId);
    await setOwner('payments.allow_partial', true);
    // one monthly cycle of December 2026 for the KPI fixture
    ids.cycle = (
      await one<{ id: string }>(
        `INSERT INTO ops.billing_cycle (tenant_id, property_id, period_key, period_start, period_end, cut_off_at, status,
                                        readings_window_minutes, grace_deadline_at, estimate_policy, frequency, computed_at, issued_at)
         VALUES ($1, $2, '2026-12', '2026-12-01', '2026-12-31', '2026-12-28T00:00:00+07:00', 'issued', 0,
                 '2026-12-28T00:00:00+07:00', (enum_range(NULL::ops.estimate_policy))[1], 'monthly',
                 '2026-12-28T00:00:00+07:00', '2026-12-28T09:00:00+07:00') RETURNING id`,
        [jur.tenantId, ids.property],
      )
    ).id;
    const issued = '2026-12-28T09:00:00+07:00';
    inv.A = await invoice(ids.u1!, ids.P, '4500.00', {
      issuedAt: issued,
      dueDate: '2027-01-05',
      cycleId: ids.cycle,
    });
    inv.B = await invoice(ids.u2!, ids.P, '4500.00', {
      issuedAt: issued,
      dueDate: '2027-01-05',
      cycleId: ids.cycle,
    });
    inv.C = await invoice(ids.u3!, ids.Q, '4500.00', {
      issuedAt: issued,
      dueDate: '2027-01-08',
      cycleId: ids.cycle,
    });
    inv.D = await invoice(ids.u4!, ids.R, '10000.00', { issuedAt: issued, dueDate: '2027-01-05' });
    inv.E = await invoice(ids.u5!, ids.S, '4500.00', { issuedAt: issued, dueDate: '2027-01-05' });
    // DEV apartment: one overdue rent invoice (per-invoice dunning must stay as it is)
    const devUnit = (
      await one<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    ).id;
    inv.DEV = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, period_start, period_end,
                                  issued_at, due_date, status, subtotal, total, balance, snapshot)
         VALUES ($1, $2, $3, $4, $5, 'INV-2026-88888', '2026-12-01', '2026-12-31', $6, '2027-01-05', 'issued', 1000, 1000, 1000, '{}')
         RETURNING id`,
        [DEV.tenantId, DEV.buildingId, devUnit, DEV.residentPartyId, DEV.leaseId, issued],
      )
    ).id;
  }, 600_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  // --------------------------------------------------------------------------------------- cases & ladder

  it('opens a case per party × unit of a juristic tenant on overdue; the apartment keeps its dunning (D-326)', async () => {
    await t.app.get(ReceivablesService).sweep();
    await settle();
    for (const id of [inv.A, inv.B, inv.C, inv.D, inv.E, inv.DEV])
      expect((await balance(id!)).status).toBe('overdue');
    const cases = await q<{ unit_id: string; state: string; anchor_on: string; legal_form: string }>(
      `SELECT unit_id, state::text, anchor_on::text, legal_form::text FROM juristic.collection_case WHERE tenant_id = $1 ORDER BY anchor_on, unit_id`,
      [jur.tenantId],
    );
    expect(cases).toHaveLength(5);
    expect(cases.every((c) => c.state === 'open' && c.legal_form === 'condo_act')).toBe(true);
    expect(cases.find((c) => c.unit_id === ids.u3)?.anchor_on).toBe('2027-01-08');
    // juristic invoices: no per-invoice reminders and no late_fee.* assessment; the DEV invoice: dunning as before
    expect(
      await one(`SELECT count(*)::int AS n FROM ops.dunning_reminder WHERE invoice_id = ANY($1::uuid[])`, [
        [inv.A, inv.B, inv.C, inv.D, inv.E],
      ]),
    ).toEqual({ n: 0 });
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM ops.dunning_reminder WHERE invoice_id = $1`,
          [inv.DEV],
        )
      ).n,
    ).toBeGreaterThan(0);
    expect(
      await one(`SELECT count(*)::int AS n FROM juristic.collection_case WHERE tenant_id = $1`, [
        DEV.tenantId,
      ]),
    ).toEqual({ n: 0 });
    // each case runs on the workflow engine
    expect(
      await one(
        `SELECT count(*)::int AS n FROM ops.workflow_instance w JOIN ops.workflow_definition d ON d.id = w.definition_id
          WHERE d.key = 'collection_case' AND w.tenant_id = $1 AND w.state = 'open'`,
        [jur.tenantId],
      ),
    ).toEqual({ n: 5 });

    const ladders = await t.http.get('/v1/owner/juristic/collection-ladders').set(J()).expect(200);
    expect(ladders.body.items).toHaveLength(1);
    const ladder = ladders.body.items[0];
    ids.ladder = ladder.id;
    for (const s of ladder.steps as { seq: number; id: string }[]) ids[`step${s.seq}`] = s.id;
    expect(
      (
        ladder.steps as {
          action: string;
          enabled: boolean;
          legalReviewRequired: boolean;
          requiresApproval: boolean;
        }[]
      ).map((s) => [s.action, s.enabled, s.legalReviewRequired, s.requiresApproval]),
    ).toEqual([
      ['remind', true, false, false],
      ['remind', true, false, false],
      ['surcharge', false, true, false],
      ['notice_letter', false, true, false],
      ['remind', true, false, false],
      ['lawyer_letter', false, true, true],
      ['suspend_services', false, true, true],
      ['legal_action', false, true, true],
    ]);
    expect(ladder.steps[2].gateClosedReason).toBe('surcharge_disabled');
    expect(ladder.steps[3].gateClosedReason).toBe('letter_wording_unverified');
    // apartments have no ladder
    expect(
      (await t.http.get('/v1/owner/juristic/collection-ladders').set(bearer(dev)).expect(200)).body,
    ).toEqual({
      items: [],
    });
  });

  it('runs each due step exactly once (job twice → one reminder per case)', async () => {
    expect((await collections().run()).steps).toBe(4); // A, B, D, E (anchor 5 Jan, +3); C (8 Jan) not yet
    expect((await collections().run()).steps).toBe(0);
    for (const u of [ids.u1, ids.u2, ids.u4, ids.u5])
      expect(await steps((await caseOf(u!)).id)).toEqual([
        { seq: 1, action: 'remind', outcome: 'sent', reason: null, amount: null },
      ]);
    expect(await steps((await caseOf(ids.u3!)).id)).toEqual([]);
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'juristic.collection.reminder' AND tenant_id = $1`,
        [jur.tenantId],
      ),
    ).toEqual({ n: 4 });
    await settle();
    // the resident notice is routed (LINE / e-mail templates exist; the co-owner has neither → nothing breaks)
    const rem = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'juristic.collection.reminder' AND payload->>'unitId' = $1`,
      [ids.u1],
    );
    expect(rem.payload).toMatchObject({
      unitNo: 'A-201',
      amountDue: '4500.00',
      oldestDueOn: '2027-01-05',
      daysOverdue: 5,
    });
  });

  it('a payment plan and a dispute pause the case (D-305)', async () => {
    await goTo('2027-01-11');
    expect((await collections().run()).steps).toBe(1); // C's first reminder (8 Jan + 3)
    // R: staff proposes a plan, the owner approves it → the case pauses
    const plan = await t.http
      .post('/v1/owner/juristic/payment-plans')
      .set(J())
      .set(idem())
      .send({ unitId: ids.u4, partyId: ids.R, instalments: 2, firstDueOn: '2027-02-01' })
      .expect(201);
    ids.plan = plan.body.id;
    await t.http
      .post(`/v1/owner/juristic/payment-plans/${ids.plan}/actions/approve`)
      .set(J())
      .set(idem())
      .expect(200);
    await settle();
    expect(await caseOf(ids.u4!)).toMatchObject({ state: 'paused', plan_id: ids.plan });
    // S disputes → paused; the resident is told; a second dispute is refused
    const caseE = (await caseOf(ids.u5!)).id;
    const opened = await t.http
      .post(`/v1/owner/juristic/collection-cases/${caseE}/actions/open-dispute`)
      .set(J())
      .set(idem())
      .send({ reason: 'เจ้าของห้องโต้แย้งยอดเดือนธันวาคม' })
      .expect(200);
    expect(opened.body).toMatchObject({
      state: 'paused',
      disputeReason: 'เจ้าของห้องโต้แย้งยอดเดือนธันวาคม',
    });
    expect(opened.body.nextActions).toEqual(['close_dispute']);
    expect(
      (
        await t.http
          .post(`/v1/owner/juristic/collection-cases/${caseE}/actions/open-dispute`)
          .set(J())
          .set(idem())
          .send({ reason: 'อีกครั้ง' })
          .expect(409)
      ).body.code,
    ).toBe('collections.invalid_state');
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'juristic.collection.dispute_opened' AND aggregate_id = $1`,
        [caseE],
      ),
    ).toEqual({ n: 1 });

    await goTo('2027-01-21');
    expect((await collections().run()).steps).toBe(2); // A and B (+15 = 20 Jan); D and E paused
    expect(await steps((await caseOf(ids.u4!)).id)).toHaveLength(1);
    expect(await steps(caseE)).toHaveLength(1);
    // the dispute closes after 10 days: the ladder resumes, moved back by the pause
    const closed = await t.http
      .post(`/v1/owner/juristic/collection-cases/${caseE}/actions/close-dispute`)
      .set(J())
      .set(idem())
      .send({ reason: 'ตรวจสอบแล้ว ยอดถูกต้องตามมติ' })
      .expect(200);
    expect(closed.body).toMatchObject({ state: 'open', pausedDays: 10, disputeOpenedAt: null });
    expect(closed.body.nextStep).toMatchObject({ seq: 2, action: 'remind', dueOn: '2027-01-30' });
    expect((await collections().run()).steps).toBe(0);
    await goTo('2027-01-30');
    // E's second reminder on 30 Jan (20 Jan + 10); C's second (23 Jan) catches up
    expect((await collections().run()).steps).toBe(2);
    const kinds = (
      (await t.http.get(`/v1/owner/juristic/collection-cases/${caseE}`).set(J()).expect(200)).body
        .timeline as { kind: string }[]
    ).map((e) => e.kind);
    expect(kinds).toEqual([
      'opened',
      'step',
      'dispute_opened',
      'paused',
      'dispute_closed',
      'resumed',
      'step',
    ]);
  });

  it('the surcharge is off by default and exact when switched on with the seeded rule (⚖ O-038)', async () => {
    await goTo('2027-02-05');
    await collections().run();
    // A and B reached step 3 (5 Jan + 30): skipped while surcharges are off
    expect((await steps((await caseOf(ids.u1!)).id)).at(-1)).toEqual({
      seq: 3,
      action: 'surcharge',
      outcome: 'skipped',
      reason: 'disabled',
      amount: null,
    });
    const enable = () =>
      t.http
        .patch(`/v1/owner/juristic/collection-ladders/${ids.ladder}/steps/${ids.step3}`)
        .set(J())
        .send({ enabled: true });
    const refused = await enable().expect(422);
    expect(refused.body).toMatchObject({ code: 'collections.legal_review_required' });
    // the legal measures stay guarded: no lawyer letter without counsel's wording, approval cannot be dropped
    expect(
      (
        await t.http
          .patch(`/v1/owner/juristic/collection-ladders/${ids.ladder}/steps/${ids.step6}`)
          .set(J())
          .send({ enabled: true })
          .expect(422)
      ).body.code,
    ).toBe('collections.legal_review_required');
    expect(
      (
        await t.http
          .patch(`/v1/owner/juristic/collection-ladders/${ids.ladder}/steps/${ids.step7}`)
          .set(J())
          .send({ requiresApproval: false })
          .expect(422)
      ).body.code,
    ).toBe('collections.approval_required');
    // the platform switches surcharges on with a cap (as if counsel confirmed it), the juristic person sets its rate
    await setPlatform('juristic.surcharge.enabled', true);
    await setPlatform('juristic.surcharge.condo_act.rate_cap', '12');
    await setOwner('juristic.surcharge.rate_pct_per_year', '12');
    const enabled = await enable().expect(200);
    expect(enabled.body.steps[2]).toMatchObject({
      enabled: true,
      gateClosedReason: null,
      legalReviewRequired: true,
    });

    await goTo('2027-02-07');
    await collections().run();
    // C: 4,500.00 × 12 % × 30 days (8 Jan → 7 Feb) ÷ 365 = 44.383… → 44.38
    const caseC = (await caseOf(ids.u3!)).id;
    expect((await steps(caseC)).at(-1)).toMatchObject({
      seq: 3,
      action: 'surcharge',
      outcome: 'sent',
      amount: '44.38',
    });
    expect(
      await one(
        `SELECT amount::text, line_kind::text, source_type::text, status::text FROM ops.invoice_charge
          WHERE source_id = $1 AND line_kind = 'late_fee'`,
        [caseC],
      ),
    ).toEqual({ amount: '44.38', line_kind: 'late_fee', source_type: 'penalty', status: 'pending' });
    await collections().run();
    expect(
      await one(`SELECT count(*)::int AS n FROM ops.invoice_charge WHERE source_id = $1`, [caseC]),
    ).toEqual({ n: 1 });
    // C pays within 30 days of its due date (KPI fixture) → the case resolves at once
    await t.http
      .post('/v1/owner/payments')
      .set(J())
      .set(idem())
      .send({
        invoiceId: inv.C,
        amount: '4500.00',
        method: 'bank_transfer_manual',
        paidAt: t.clock.now().toISOString(),
        evidenceDocumentId: ids.evidence,
        notes: 'โอนผ่านธนาคาร KBank',
      })
      .expect(201);
    await settle();
    expect(await caseOf(ids.u3!)).toMatchObject({ state: 'resolved' });
  });

  it('a step that needs approval waits; approved it runs, refused the ladder moves on (D-305)', async () => {
    await t.http
      .patch(`/v1/owner/juristic/collection-ladders/${ids.ladder}/steps/${ids.step5}`)
      .set(J())
      .send({ requiresApproval: true })
      .expect(200);
    await goTo('2027-03-06');
    await collections().run(); // A, B: step 4 (letter off) skipped, step 5 waits
    const caseA = (await caseOf(ids.u1!)).id;
    const caseB = (await caseOf(ids.u2!)).id;
    for (const c of [caseA, caseB])
      expect((await steps(c)).slice(-2)).toEqual([
        { seq: 4, action: 'notice_letter', outcome: 'skipped', reason: 'disabled', amount: null },
        { seq: 5, action: 'remind', outcome: 'awaiting_approval', reason: null, amount: null },
      ]);
    expect((await collections().run()).steps).toBe(0); // still waiting: nothing new, the later steps held back
    expect((await steps(caseA)).length).toBe(5);
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'juristic.collection.approval_required' AND aggregate_id = $1`,
        [caseA],
      ),
    ).toEqual({ n: 1 });
    const waiting = (await t.http.get(`/v1/owner/juristic/collection-cases/${caseA}`).set(J()).expect(200))
      .body;
    expect(waiting.nextStep).toMatchObject({ seq: 5, awaitingApproval: true });
    expect(waiting.nextActions).toEqual(['open_dispute', 'approve_step', 'refuse_step']);
    const approved = await t.http
      .post(`/v1/owner/juristic/collection-cases/${caseA}/actions/approve-step`)
      .set(J())
      .set(idem())
      .send({ reason: 'ผู้จัดการอนุมัติ' })
      .expect(200);
    expect((approved.body.timeline as { outcome: string }[]).slice(-2).map((e) => e.outcome)).toEqual([
      'approved',
      'sent',
    ]);
    const refused = await t.http
      .post(`/v1/owner/juristic/collection-cases/${caseB}/actions/refuse-step`)
      .set(J())
      .set(idem())
      .send({ reason: 'ให้เวลาเพิ่มอีก 30 วัน' })
      .expect(200);
    expect((refused.body.timeline as Record<string, unknown>[]).at(-1)).toMatchObject({
      seq: 5,
      outcome: 'refused',
    });
    expect(refused.body.nextStep).toBeNull(); // the rest of the ladder is disabled
    expect(
      (
        await t.http
          .post(`/v1/owner/juristic/collection-cases/${caseB}/actions/approve-step`)
          .set(J())
          .set(idem())
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('collections.no_pending_approval');
    // the timeline is append-only in the database
    await expect(
      db.admin.query(`UPDATE juristic.collection_event SET reason = 'x' WHERE case_id = $1`, [caseA]),
    ).rejects.toThrow(/append-only/);
  });

  it('a plan default resumes the paused case, moved back by the pause (D-305, D-325)', async () => {
    const plans = t.app.get(PaymentPlansService);
    t.clock.set(at('2027-02-01'));
    expect((await plans.maintain()).queued).toBe(1);
    const charge = await one<{ id: string }>(
      `SELECT c.id FROM ops.invoice_charge c JOIN juristic.payment_plan_instalment i ON i.invoice_charge_id = c.id
        WHERE i.plan_id = $1 AND i.seq = 1`,
      [ids.plan],
    );
    const billed = await invoice(ids.u4!, ids.R!, '5000.00', {
      issuedAt: '2027-02-01T09:00:00+07:00',
      dueDate: '2027-02-05',
      kind: 'plan_instalment',
      chargeId: charge.id,
    });
    const line = await one<{ id: string }>(`SELECT id FROM ops.invoice_line WHERE invoice_id = $1`, [billed]);
    await q(`UPDATE ops.invoice_charge SET status = 'applied', applied_invoice_line_id = $2 WHERE id = $1`, [
      charge.id,
      line.id,
    ]);
    t.clock.set(at('2027-03-08'));
    expect((await plans.maintain()).defaulted).toBe(1);
    await settle();
    // paused 11 Jan → resumed 8 Mar = 56 days; the next reminder moves from 20 Jan to 17 Mar
    expect(await caseOf(ids.u4!)).toMatchObject({ state: 'open', plan_id: null, paused_days: 56 });
    await goTo('2027-03-08');
    const c = (
      await t.http
        .get(`/v1/owner/juristic/collection-cases/${(await caseOf(ids.u4!)).id}`)
        .set(J())
        .expect(200)
    ).body;
    expect(c.nextStep).toMatchObject({ seq: 2, dueOn: '2027-03-17' });
    expect((c.timeline as { kind: string }[]).map((e: { kind: string }) => e.kind)).toEqual([
      'opened',
      'step',
      'paused',
      'resumed',
    ]);
    expect(
      await one(
        `SELECT w.state FROM ops.workflow_instance w JOIN juristic.collection_case c ON c.workflow_instance_id = w.id WHERE c.id = $1`,
        [c.id],
      ),
    ).toEqual({ state: 'open' });
  });

  // --------------------------------------------------------------------------------------- reports

  it('aging buckets and the collection-rate KPI from the fixture (D-326)', async () => {
    const aging = (await t.http.get('/v1/owner/juristic/reports/aging').set(J()).expect(200)).body;
    // 8 Mar: A, B, E (5 Jan, 62 days) 13,500 in 31–90; R's instalment invoice (5 Feb, 31 days) 5,000 in 31–90
    expect(aging.bounds).toEqual([30, 90, 365]);
    expect(
      (aging.overall.buckets as { key: string; invoices: number; amount: string }[]).map(
        (b: { key: string; invoices: number; amount: string }) => [b.key, b.invoices, b.amount],
      ),
    ).toEqual([
      ['0-30', 0, '0.00'],
      ['31-90', 4, '18500.00'],
      ['91-365', 0, '0.00'],
      ['>365', 0, '0.00'],
    ]);
    expect(aging.overall.overdue).toEqual({ invoices: 4, accounts: 4, amount: '18500.00' });
    expect(aging.buildings).toHaveLength(1);
    const kpi = (
      await t.http
        .get('/v1/owner/juristic/reports/collection-rate?from=2026-12-01&to=2026-12-31')
        .set(J())
        .expect(200)
    ).body;
    expect(kpi.cycles).toHaveLength(1);
    expect(kpi.cycles[0]).toMatchObject({
      periodKey: '2026-12',
      invoices: 3,
      billed: '13500.00',
      collected: '4500.00',
      collectedWithinDays: '4500.00',
      collectionRatePct: '33.33',
      withinDaysRatePct: '33.33',
    });
    const rec = (await t.http.get('/v1/owner/juristic/receivables?sort=amount').set(J()).expect(200)).body;
    const a = (rec.data as { unitId: string }[]).find((r: { unitId: string }) => r.unitId === ids.u1);
    expect(a).toMatchObject({
      unitNo: 'A-201',
      ownerName: 'สมชาย สองห้อง',
      context: { ownsUnits: 2, nonResident: true, agent: false },
      outstanding: '4500.00',
      oldestOverdueOn: '2027-01-05',
      oldestOverdueMonths: 2,
      caseState: 'open',
      channels: ['sms'],
    });
    const r = (rec.data as { unitId: string }[]).find((x: { unitId: string }) => x.unitId === ids.u4);
    // R: the instalment invoice 5,000 + the accelerated rest 5,000 queued
    expect(r).toMatchObject({ outstanding: '10000.00', nextStep: { kind: 'remind', date: '2027-03-17' } });
    expect(
      (await t.http.get('/v1/owner/juristic/receivables?tab=dispute').set(J()).expect(200)).body.meta.total,
    ).toBe(0);
    expect(
      (
        (await t.http.get('/v1/owner/juristic/receivables?q=A-202').set(J()).expect(200)).body.data as {
          unitNo: string;
        }[]
      ).map((x) => x.unitNo),
    ).toEqual(['A-202']);
    const exp = await t.http
      .post('/v1/owner/juristic/receivables/exports')
      .set(J())
      .set(idem())
      .send({ tab: 'all' })
      .expect(202);
    await settle();
    expect(
      await one(`SELECT status::text, row_count FROM ops.export_job WHERE id = $1`, [exp.body.id]),
    ).toEqual({
      status: 'done',
      row_count: rec.meta.total,
    });
  });

  // --------------------------------------------------------------------------------------- statements

  it('a statement across two units is paid by one payment over both invoices; the cases resolve (D-307)', async () => {
    const issued = await t.http
      .post('/v1/owner/juristic/statements/actions/issue')
      .set(J())
      .set(idem())
      .send({ period: '2027-02' })
      .expect(200);
    type Stmt = { id: string; partyId: string; units: { unitNo: string }[]; openInvoices: { id: string }[] };
    const mine = (issued.body.issued as Stmt[]).find((s) => s.partyId === ids.P)!;
    expect(mine).toMatchObject({
      number: 'STM-2027-00001',
      period: '2027-02',
      opening: '9000.00',
      charges: '0.00',
      credits: '0.00',
      payments: '0.00',
      closing: '9000.00',
      amountDue: '9000.00',
      deliveredVia: ['sms'],
    });
    expect(mine.units.map((u) => u.unitNo)).toEqual(['A-201', 'A-202']);
    expect(mine.openInvoices.map((i) => i.id).sort()).toEqual([inv.A, inv.B].sort());
    const q3 = (issued.body.issued as Stmt[]).find((s) => s.partyId === ids.Q)!;
    expect(q3).toMatchObject({ deliveredVia: ['letter'], amountDue: '0.00', payments: '4500.00' });
    // the same month again: nobody is stated twice
    const again = await t.http
      .post('/v1/owner/juristic/statements/actions/issue')
      .set(J())
      .set(idem())
      .send({ period: '2027-02' })
      .expect(200);
    expect(again.body.issued).toHaveLength(0);
    await settle();
    const ready = await one<{ document_id: string | null }>(
      `SELECT document_id FROM juristic.statement WHERE id = $1`,
      [mine.id],
    );
    expect(ready.document_id).not.toBeNull();
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'juristic.statement.ready' AND aggregate_id = $1`,
        [mine.id],
      ),
    ).toEqual({ n: 1 });
    await t.http.get(`/v1/owner/juristic/statements/${mine.id}/document`).set(J()).expect(200);
    // the co-owner sees it in LIFF
    coOwner = (await otpSignIn(t, 'resident', PHONE_P, jur.token)).accessToken;
    const mineInLiff = await t.http.get('/v1/resident/statements').set(bearer(coOwner)).expect(200);
    expect((mineInLiff.body.data as { id: string }[]).map((s: { id: string }) => s.id)).toEqual([mine.id]);
    await t.http.get(`/v1/resident/statements/${mine.id}/document`).set(bearer(coOwner)).expect(200);
    await t.http.get(`/v1/resident/statements/${q3.id}/document`).set(bearer(coOwner)).expect(404);

    const paid = await t.http
      .post(`/v1/owner/juristic/statements/${mine.id}/payments`)
      .set(J())
      .set(idem())
      .send({
        amount: '9000.00',
        method: 'bank_transfer_manual',
        paidAt: t.clock.now().toISOString(),
        evidenceDocumentId: ids.evidence,
        notes: 'โอนครั้งเดียวสองห้อง',
      })
      .expect(201);
    expect(paid.body.payments).toHaveLength(2);
    expect((paid.body.payments as { amount: string }[]).map((p: { amount: string }) => p.amount)).toEqual([
      '4500.00',
      '4500.00',
    ]);
    expect(await balance(inv.A!)).toEqual({ status: 'paid', balance: '0.00' });
    expect(await balance(inv.B!)).toEqual({ status: 'paid', balance: '0.00' });
    await settle();
    expect(await caseOf(ids.u1!)).toMatchObject({ state: 'resolved' });
    expect(await caseOf(ids.u2!)).toMatchObject({ state: 'resolved' });
    expect(
      (
        await t.http
          .post(`/v1/owner/juristic/statements/${mine.id}/payments`)
          .set(J())
          .set(idem())
          .send({
            amount: '1.00',
            method: 'cash',
            paidAt: t.clock.now().toISOString(),
            evidenceDocumentId: ids.evidence,
            notes: 'ซ้ำอีกครั้ง',
          })
          .expect(409)
      ).body.code,
    ).toBe('statement.nothing_due');

    // printed letters for the owner without LINE, e-mail or phone
    const letters = await t.http
      .post('/v1/owner/juristic/letter-batches')
      .set(J())
      .set(idem())
      .send({ period: '2027-02' })
      .expect(202);
    // Q, R and S have no LINE, e-mail or phone; P has a phone
    expect(letters.body.statementIds).toContain(q3.id);
    expect(letters.body.statementIds).not.toContain(mine.id);
    await settle();
    const batch = (
      await t.http.get(`/v1/owner/juristic/letter-batches/${letters.body.id}`).set(J()).expect(200)
    ).body;
    expect(batch).toMatchObject({ state: 'ready' });
    await t.http.get(`/v1/owner/juristic/letter-batches/${letters.body.id}/document`).set(J()).expect(200);
    ids.statement = mine.id;
    ids.letters = letters.body.id;
  });

  it('budget vs actual — income side (D-304)', async () => {
    const b = await one<{ id: string }>(
      `INSERT INTO juristic.budget (tenant_id, building_id, fiscal_year, name, period_start, period_end, state, total)
       VALUES ($1, $2, 2026, 'งบ 2569', '2026-01-01', '2026-12-31', 'draft', 0) RETURNING id`,
      [jur.tenantId, ids.building],
    );
    await q(
      `INSERT INTO juristic.budget_line (tenant_id, budget_id, kind, label, amount, sort) VALUES ($1, $2, 'income', 'ค่าส่วนกลาง', 54000, 1)`,
      [jur.tenantId, b.id],
    );
    ids.budget = b.id;
    const r = (await t.http.get(`/v1/owner/juristic/budgets/${b.id}/actual-income`).set(J()).expect(200))
      .body;
    // A–E issued 28 Dec 2026: 4,500 × 4 + 10,000 billed; the payments came in 2027 (outside the 2026 period)
    expect(r).toMatchObject({
      budgetedIncome: '54000.00',
      billed: '28000.00',
      collected: '0.00',
      billedVsBudgetPct: '51.85',
      expenseSideAvailable: false,
    });
    expect(r.billedByKind[0]).toEqual({ kind: 'common_fee', amount: '28000.00' });
    // residents see the approved budget of their building for the current year (income side)
    const res = await one<{ id: string }>(
      `INSERT INTO juristic.resolution (tenant_id, building_id, meeting_kind, meeting_date, number, title, text, state, adopted_at)
       VALUES ($1, $2, 'agm', '2026-12-15', '1/2569', 'งบประมาณ 2570', 'อนุมัติงบประมาณประจำปี 2570', 'adopted', now()) RETURNING id`,
      [jur.tenantId, ids.building],
    );
    const b27 = await one<{ id: string }>(
      `INSERT INTO juristic.budget (tenant_id, building_id, fiscal_year, name, period_start, period_end, state, resolution_id, total, approved_at)
       VALUES ($1, $2, 2027, 'งบ 2570', '2027-01-01', '2027-12-31', 'approved', $3, 0, now()) RETURNING id`,
      [jur.tenantId, ids.building, res.id],
    );
    await q(
      `INSERT INTO juristic.budget_line (tenant_id, budget_id, kind, label, amount, sort) VALUES ($1, $2, 'income', 'ค่าส่วนกลาง', 60000, 1)`,
      [jur.tenantId, b27.id],
    );
    const mineBudget = (
      await t.http.get(`/v1/resident/units/${ids.u1}/budget-vs-actual`).set(bearer(coOwner)).expect(200)
    ).body;
    // 2027 so far: R's instalment invoice (5,000, issued 1 Feb, unpaid)
    expect(mineBudget).toMatchObject({
      budgetId: b27.id,
      budgetedIncome: '60000.00',
      billed: '5000.00',
      collected: '0.00',
    });
    await t.http.get(`/v1/resident/units/${ids.u3}/budget-vs-actual`).set(bearer(coOwner)).expect(404);
  });

  // --------------------------------------------------------------------------------------- D-270

  it('D-270: a landlord invites its juristic office; the workspace sees only linked units and bills the landlord', async () => {
    const phoneSignup = async (phone: string, displayName: string) => {
      t.clock.advance(61_000);
      const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
      const res = await t.http
        .post('/v1/public/signup/landlord')
        .send({
          provider: 'phone_otp',
          challengeId: challenge.body.challengeId,
          code: t.sms.lastCodeTo(phone),
          displayName,
        })
        .expect(201);
      return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
    };
    const landlord = await phoneSignup(PHONE_LANDLORD, 'สมชาย เจ้าของห้อง');
    const other = await phoneSignup(PHONE_LANDLORD_2, 'มาลี เจ้าของอีกห้อง');
    const L = () => bearer(landlord.token);
    const addUnit = (token: string, unitNo: string) =>
      t.http
        .post('/v1/owner/portfolio/units')
        .set(bearer(token))
        .send({ kind: 'condo_unit', projectName: PROJECT, unitNo, address: ADDRESS, areaSqm: '35.00' })
        .expect(201)
        .then((r) => r.body as { unitId: string; buildingId: string });
    const l1 = await addUnit(landlord.token, '12/1');
    const l2 = await addUnit(landlord.token, '12/2');
    const m1 = await addUnit(other.token, '12/3');
    expect(l1.buildingId).toBe(m1.buildingId); // one stub, two landlords
    // the landlord's own rent invoice on 12/1 (must stay invisible to the office)
    const lessee = await one<{ id: string }>(
      `INSERT INTO core.party (tenant_id, type, display_name) VALUES ($1, 'person', 'ผู้เช่า ของเจ้าของ') RETURNING id`,
      [landlord.tenantId],
    );
    const rent = await one<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, number, period_start, period_end, issued_at, due_date,
                                status, subtotal, total, balance, snapshot)
       VALUES ($1, $2, $3, $4, 'INV-2027-77777', '2027-03-01', '2027-03-31', now(), '2027-03-05', 'issued', 12000, 12000, 12000, '{}')
       RETURNING id`,
      [landlord.tenantId, l1.buildingId, l1.unitId, lessee.id],
    );

    // a building that is not a stub, another landlord's unit: refused
    await t.http
      .post('/v1/owner/juristic-workspace-invitations')
      .set(L())
      .set(idem())
      .send({ buildingId: l1.buildingId, unitIds: [m1.unitId], officeName: 'นิติบุคคลอาคารชุด ทดสอบ' })
      .expect(404);
    await t.http
      .post('/v1/owner/juristic-workspace-invitations')
      .set(L())
      .set(idem())
      .send({ buildingId: ids.building, unitIds: [l1.unitId], officeName: 'นิติบุคคลอาคารชุด ทดสอบ' })
      .expect(404);
    const invited = await t.http
      .post('/v1/owner/juristic-workspace-invitations')
      .set(L())
      .set(idem())
      .send({ buildingId: l1.buildingId, unitIds: [l1.unitId], officeName: 'นิติบุคคลอาคารชุด ทดสอบ' })
      .expect(201);
    expect(invited.body).toMatchObject({ state: 'invited', unitIds: [l1.unitId] });
    const code = invited.body.code as string;
    expect(code).toHaveLength(10);
    // nothing of it is visible to a juristic tenant (another tenant's invitation)
    await t.http
      .post(`/v1/owner/juristic-workspace-invitations/${invited.body.id}/actions/revoke`)
      .set(J())
      .set(idem())
      .send({ reason: 'ไม่ใช่ของเรา' })
      .expect(404);

    const preview = await t.http.get(`/v1/public/juristic-workspaces/${code}`).expect(200);
    expect(preview.body).toMatchObject({
      officeName: 'นิติบุคคลอาคารชุด ทดสอบ',
      buildingName: PROJECT,
      units: 1,
    });
    t.clock.advance(61_000);
    const challenge = await t.http
      .post('/v1/public/juristic-workspaces/otp')
      .send({ phone: PHONE_OFFICE })
      .expect(200);
    const accepted = await t.http
      .post('/v1/public/juristic-workspaces/accept')
      .send({
        code,
        provider: 'phone_otp',
        challengeId: challenge.body.challengeId,
        code6: t.sms.lastCodeTo(PHONE_OFFICE),
        displayName: 'นิติบุคคลอาคารชุด เดอะ ทดสอบ',
      })
      .expect(201);
    expect(accepted.body).toMatchObject({ created: true, tenantName: 'นิติบุคคลอาคารชุด เดอะ ทดสอบ' });
    const office = {
      tenantId: accepted.body.tenantId as string,
      token: accepted.body.tokens.accessToken as string,
    };
    const O = () => bearer(office.token);
    expect(await one(`SELECT type::text FROM core.tenant WHERE id = $1`, [office.tenantId])).toEqual({
      type: 'juristic',
    });
    expect(
      await q(
        `SELECT unit_id, modules, scope::text, reason::text FROM core.asset_access_grant WHERE grantee_tenant_id = $1`,
        [office.tenantId],
      ),
    ).toEqual([{ unit_id: l1.unitId, modules: ['juristic'], scope: 'unit', reason: 'landlord_unit' }]);
    // used code: refused
    await t.http.get(`/v1/public/juristic-workspaces/${code}`).expect(404);

    const units = (await t.http.get('/v1/owner/juristic/workspace/units').set(O()).expect(200)).body.items;
    expect(
      (units as { unitId: string; landlordName: string }[]).map(
        (u: { unitId: string; landlordName: string }) => [u.unitId, u.landlordName],
      ),
    ).toEqual([[l1.unitId, 'สมชาย เจ้าของห้อง']]);
    // isolation: the landlord's rent invoice, the landlord's other unit and the other landlord's unit are not the office's
    await t.http.get(`/v1/owner/invoices/${rent.id}`).set(O()).expect(404);
    expect((await t.http.get('/v1/owner/invoices').set(O()).expect(200)).body.data).toEqual([]);
    for (const unitId of [l2.unitId, m1.unitId, ids.u1])
      await t.http
        .post(`/v1/owner/juristic/workspace/units/${unitId}/invoices`)
        .set(O())
        .set(idem())
        .send({ periodStart: '2027-01-01', periodEnd: '2027-03-31', amount: '4500.00' })
        .expect(404);
    // the other juristic tenant has no linked unit
    expect((await t.http.get('/v1/owner/juristic/workspace/units').set(J()).expect(200)).body.items).toEqual(
      [],
    );
    await t.http
      .post(`/v1/owner/juristic/workspace/units/${l1.unitId}/invoices`)
      .set(J())
      .set(idem())
      .send({ periodStart: '2027-01-01', periodEnd: '2027-03-31', amount: '4500.00' })
      .expect(404);

    const bill = await t.http
      .post(`/v1/owner/juristic/workspace/units/${l1.unitId}/invoices`)
      .set(O())
      .set(idem())
      .send({
        periodStart: '2027-04-01',
        periodEnd: '2027-06-30',
        amount: '4500.00',
        description: 'ค่าส่วนกลาง ไตรมาส 2/2570',
      })
      .expect(201);
    expect(bill.body).toMatchObject({ status: 'issued', total: '4500.00' });
    expect(bill.body.number).toMatch(/^INV-2027-/);
    const ws = (await t.http.get('/v1/owner/juristic/workspace/invoices').set(O()).expect(200)).body;
    expect((ws.data as { id: string }[]).map((i: { id: string }) => i.id)).toEqual([bill.body.id]);
    // the landlord's own console does not list the office's invoice; the landlord pays it in LIFF like any bill
    expect((await t.http.get(`/v1/owner/invoices/${bill.body.id}`).set(L()).expect(404)).body.code).toBe(
      'http.not_found',
    );
    t.clock.advance(61_000);
    const ch = await t.http.post('/v1/auth/resident/otp/request').send({ phone: PHONE_LANDLORD }).expect(200);
    const resident = await t.http
      .post('/v1/auth/resident/otp/verify')
      .send({ challengeId: ch.body.challengeId, code: t.sms.lastCodeTo(PHONE_LANDLORD) })
      .expect(200);
    const bills = await t.http
      .get('/v1/resident/invoices')
      .set(bearer(resident.body.accessToken as string))
      .expect(200);
    expect((bills.body.data as { id: string }[]).map((i: { id: string }) => i.id)).toContain(bill.body.id);

    // the landlord revokes: the grants go, the office gets 404
    const list = (await t.http.get('/v1/owner/juristic-workspace-invitations').set(L()).expect(200)).body
      .items;
    expect((list as { state: string }[]).map((x: { state: string }) => x.state)).toEqual(['active']);
    await t.http
      .post(`/v1/owner/juristic-workspace-invitations/${invited.body.id}/actions/revoke`)
      .set(L())
      .set(idem())
      .send({ reason: 'ขายห้องแล้ว' })
      .expect(200);
    expect((await t.http.get('/v1/owner/juristic/workspace/units').set(O()).expect(200)).body.items).toEqual(
      [],
    );
    await t.http
      .post(`/v1/owner/juristic/workspace/units/${l1.unitId}/invoices`)
      .set(O())
      .set(idem())
      .send({ periodStart: '2027-07-01', periodEnd: '2027-09-30', amount: '4500.00' })
      .expect(404);
    expect(
      await one(
        `SELECT count(*)::int AS n FROM core.asset_access_grant WHERE grantee_tenant_id = $1 AND revoked_at IS NULL`,
        [office.tenantId],
      ),
    ).toEqual({ n: 0 });
  });

  // --------------------------------------------------------------------------------------- tenancy

  it('every new endpoint answers 404 across tenants (contract §8)', async () => {
    await relogin();
    const D = () => bearer(dev);
    const caseId = (await caseOf(ids.u4!)).id;
    const r = (await t.http.get('/v1/owner/juristic/collection-ladders').set(J()).expect(200)).body;
    const stepId = r.items[0].steps[0].id;
    const checks: [string, string, Record<string, unknown>?][] = [
      ['patch', `/v1/owner/juristic/collection-ladders/${ids.ladder}/steps/${stepId}`, { offsetDays: 4 }],
      ['get', `/v1/owner/juristic/collection-cases/${caseId}`],
      [
        'post',
        `/v1/owner/juristic/collection-cases/${caseId}/actions/open-dispute`,
        { reason: 'ทดสอบข้ามผู้เช่า' },
      ],
      [
        'post',
        `/v1/owner/juristic/collection-cases/${caseId}/actions/close-dispute`,
        { reason: 'ทดสอบข้ามผู้เช่า' },
      ],
      ['post', `/v1/owner/juristic/collection-cases/${caseId}/actions/approve-step`, {}],
      [
        'post',
        `/v1/owner/juristic/collection-cases/${caseId}/actions/refuse-step`,
        { reason: 'ทดสอบข้ามผู้เช่า' },
      ],
      ['get', `/v1/owner/juristic/receivables?buildingId=${ids.building}`],
      ['post', '/v1/owner/juristic/receivables/exports', { buildingId: ids.building }],
      ['get', `/v1/owner/juristic/reports/aging?buildingId=${ids.building}`],
      ['get', `/v1/owner/juristic/reports/collection-rate?buildingId=${ids.building}`],
      ['get', `/v1/owner/juristic/budgets/${ids.budget}/actual-income`],
      [
        'post',
        '/v1/owner/juristic/statements/actions/issue',
        { period: '2027-02', buildingId: ids.building },
      ],
      ['post', '/v1/owner/juristic/statements/actions/issue', { period: '2027-02', partyIds: [ids.P] }],
      ['get', `/v1/owner/juristic/statements/${ids.statement}`],
      ['get', `/v1/owner/juristic/statements/${ids.statement}/document`],
      [
        'post',
        `/v1/owner/juristic/statements/${ids.statement}/payments`,
        { amount: '1.00', method: 'cash', paidAt: t.clock.now().toISOString(), notes: 'ทดสอบข้ามผู้เช่า' },
      ],
      ['get', `/v1/owner/juristic/letter-batches/${ids.letters}`],
      ['get', `/v1/owner/juristic/letter-batches/${ids.letters}/document`],
      [
        'post',
        `/v1/owner/juristic/workspace/units/${ids.u1}/invoices`,
        { periodStart: '2027-01-01', periodEnd: '2027-01-31', amount: '1.00' },
      ],
    ];
    for (const [method, url, body] of checks) {
      const req = (t.http as unknown as Record<string, (u: string) => import('supertest').Test>)[method]!(url)
        .set(D())
        .set(idem());
      const res = await (body ? req.send(body) : req);
      expect([url, res.status]).toEqual([url, 404]);
    }
    // lists of another tenant are simply empty
    expect((await t.http.get('/v1/owner/juristic/statements').set(D()).expect(200)).body.meta.total).toBe(0);
    expect(
      (await t.http.get('/v1/owner/juristic/collection-cases').set(D()).expect(200)).body.meta.total,
    ).toBe(0);
    expect((await t.http.get('/v1/owner/juristic/letter-batches').set(D()).expect(200)).body.meta.total).toBe(
      0,
    );
    // the apartment sees its own overdue rent invoice only — nothing of the juristic tenant
    const own = (await t.http.get('/v1/owner/juristic/receivables').set(D()).expect(200)).body.data as {
      buildingId: string;
    }[];
    expect(own.every((r) => r.buildingId === DEV.buildingId)).toBe(true);
  });
});
