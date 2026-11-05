import 'reflect-metadata';

import { residentUnitRoles } from '@core/identity/resident-units';
import { AccessService } from '@core/tenancy/access.service';
import { TenantTx } from '@database/tenant-tx';
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
  invoices: { id: string; billedPartyId: string; unitId: string; total: string; status: string }[];
}

/**
 * J1.1b (D-302, D-303, D-304, D-307, D-320, D-324) on a juristic tenant: onboarding with property kind and building
 * legal form (a condominium and a housing estate), the co-owner register (shares ≤ 100, incomplete), resolutions and
 * budgets (adopt, approve, supersede), the resolution requirement on common-fee rates, the budget → rate preview and
 * draft (`budget_split`, exact sum), an ownership transfer after an issued annual invoice (`carry_to_buyer` and
 * `refund_seller`), bill-to billing and the payer role, committee / auditor roles (time-boxed), and cross-tenant 404s.
 */
describe('J1.1b juristic register, bill-to, budgets and resolutions (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let jur: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const J = () => bearer(jur.token);
  const at = async (instant: string) => {
    t.clock.set(new Date(instant));
    jur = { ...jur, token: await operatorToken(t, '+660000000241') };
  };
  const cycles = async () =>
    (
      await t.http
        .get(`/v1/owner/billing-cycles?propertyId=${ids.condoProperty}&perPage=50`)
        .set(J())
        .expect(200)
    ).body.data as Cycle[];
  const cycle = async (id: string) =>
    (await t.http.get(`/v1/owner/billing-cycles/${id}`).set(J()).expect(200)).body as Cycle;
  const doc = async (tenantId: string, key: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'b', $2, 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [tenantId, key],
      )
    ).id;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_register' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db);
    t.clock.set(new Date('2026-12-20T09:00:00+07:00'));
    jur = await onboardTenant(t, await adminToken(t), {
      slug: 'j11b-juristic',
      phone: '+660000000241',
      type: 'juristic',
    });
  }, 600_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('onboarding: a juristic tenant names the property kind and each building’s legal form (422 otherwise)', async () => {
    const noKind = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโดทดสอบ' })
      .expect(422);
    expect(noKind.body.errors).toEqual([expect.objectContaining({ path: 'kind' })]);
    const condo = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโดทดสอบ', kind: 'condo' })
      .expect(201);
    expect(condo.body.kind).toBe('condo');
    ids.condoProperty = condo.body.id;
    const village = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'V1', name: 'หมู่บ้านทดสอบ', kind: 'village' })
      .expect(201);
    ids.villageProperty = village.body.id;
    const noForm = await t.http
      .post('/v1/owner/buildings')
      .set(J())
      .send({ propertyId: ids.condoProperty, code: 'A', name: 'อาคาร A', type: 'condo' })
      .expect(422);
    expect(noForm.body.errors).toEqual([expect.objectContaining({ path: 'legalForm' })]);
    const a = await t.http
      .post('/v1/owner/buildings')
      .set(J())
      .send({
        propertyId: ids.condoProperty,
        code: 'A',
        name: 'อาคาร A',
        type: 'condo',
        legalForm: 'condo_act',
      })
      .expect(201);
    expect(a.body.legalForm).toBe('condo_act');
    ids.condo = a.body.id;
    const v = await t.http
      .post('/v1/owner/buildings')
      .set(J())
      .send({
        propertyId: ids.villageProperty,
        code: 'V',
        name: 'โครงการ',
        type: 'house_cluster',
        legalForm: 'land_allocation_act',
      })
      .expect(201);
    ids.village = v.body.id;
    const plot = await t.http
      .post('/v1/owner/units')
      .set(J())
      .send({
        buildingId: ids.village,
        unitNo: '12/48',
        type: 'plot',
        landAreaSqwa: '52.50',
        plotNo: '12/48',
      })
      .expect(201);
    expect(plot.body).toMatchObject({ type: 'plot', landAreaSqwa: '52.50', plotNo: '12/48' });
    ids.plot = plot.body.id;
    // a juristic person does not own the units it manages: no ownership row for its legal party
    expect(
      await one(`SELECT count(*)::int AS n FROM core.unit_ownership WHERE unit_id = $1`, [ids.plot]),
    ).toEqual({
      n: 0,
    });
    for (const [key, unitNo, area] of [
      ['a1', 'A-101', '40.00', '0.400000'],
      ['a2', 'A-102', '60.00', '0.600000'],
    ] as const)
      ids[key] = (
        await t.http
          .post('/v1/owner/units')
          .set(J())
          .send({ buildingId: ids.condo, unitNo, type: 'condo_unit', areaSqm: area })
          .expect(201)
      ).body.id;
    await t.http
      .patch(`/v1/owner/juristic/register/units/${ids.a1}`)
      .set(J())
      .send({ ownershipRatio: '0.400000', titleDeedNo: 'อช.2 1/101' })
      .expect(200);
    const patched = await t.http
      .patch(`/v1/owner/juristic/register/units/${ids.a2}`)
      .set(J())
      .send({ ownershipRatio: '0.600000', version: 1 })
      .expect(200);
    expect(patched.body).toMatchObject({ ownershipRatio: '0.600000', version: 2 });
    await t.http
      .patch(`/v1/owner/juristic/register/units/${ids.a2}`)
      .set(J())
      .send({ ownershipRatio: '0.600000', version: 1 })
      .expect(412);
  });

  it('register: co-owners with shares ≤ 100 % (422 beyond), incomplete flag, contact channels', async () => {
    const add = (unit: string, body: Record<string, unknown>) =>
      t.http.post(`/v1/owner/juristic/register/units/${ids[unit]}/owners`).set(J()).send(body);
    const p60 = await add('a1', {
      party: { type: 'person', displayName: 'เจ้าของ 60', phone: '+66810000601' },
      sharePct: '60',
      validFrom: '2020-01-01',
    }).expect(201);
    expect(p60.body).toMatchObject({ sharesTotal: '60.0000', incomplete: true });
    ids.p60 = p60.body.owners[0].party.id;
    expect(p60.body.owners[0].party).toMatchObject({
      phoneMasked: expect.stringMatching(/•/),
      residentLinked: false,
    });
    const over = await add('a1', {
      party: { type: 'person', displayName: 'เกิน' },
      sharePct: '50',
      validFrom: '2020-01-01',
    }).expect(422);
    expect(over.body.code).toBe('register.shares_exceeded');
    const p40 = await add('a1', {
      party: { type: 'person', displayName: 'เจ้าของ 40', phone: '+66810000401' },
      sharePct: '40',
      validFrom: '2020-01-01',
    }).expect(201);
    expect(p40.body).toMatchObject({ sharesTotal: '100.0000', incomplete: false });
    ids.p40 = (p40.body.owners as { sharePct: string; party: { id: string } }[]).find(
      (o) => o.sharePct === '40.0000',
    )!.party.id;
    const s2 = await add('a2', {
      party: { type: 'company', displayName: 'บริษัท ผู้ขาย จำกัด' },
      sharePct: '100',
      validFrom: '2020-01-01',
    }).expect(201);
    ids.s2 = s2.body.owners[0].party.id;
    const incomplete = await t.http
      .get(`/v1/owner/juristic/register?buildingId=${ids.condo}&incomplete=true`)
      .set(J())
      .expect(200);
    expect(incomplete.body.data).toEqual([]);
    const all = await t.http.get(`/v1/owner/juristic/register?q=A-10`).set(J()).expect(200);
    expect((all.body.data as { unitNo: string }[]).map((u) => u.unitNo)).toEqual(['A-101', 'A-102']);
    const ev = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'unit_ownership.added' AND tenant_id = $1`,
      [jur.tenantId],
    );
    expect(ev.n).toBe(3);
  });

  it('resolutions and budgets: adopt (idempotent), approve with an adopted resolution, a new approval supersedes', async () => {
    const res = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.condo,
        meetingKind: 'agm',
        meetingDate: '2026-12-10',
        number: '1/2569',
        title: 'งบประมาณ 2570',
        text: 'ที่ประชุมอนุมัติงบประมาณและอัตราค่าส่วนกลาง',
      })
      .expect(201);
    expect(res.body).toMatchObject({ state: 'draft', nextActions: ['adopt', 'void'] });
    ids.res = res.body.id;
    const dup = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.condo,
        meetingKind: 'agm',
        meetingDate: '2026-12-10',
        number: '1/2569',
        title: 'x',
        text: 'x',
      })
      .expect(422);
    expect(dup.body.errors).toEqual([expect.objectContaining({ path: 'number' })]);
    const budget = await t.http
      .post('/v1/owner/juristic/budgets')
      .set(J())
      .send({
        buildingId: ids.condo,
        fiscalYear: 2027,
        name: 'งบประมาณ 2570',
        lines: [
          { kind: 'expense', label: 'รักษาความปลอดภัย', amount: '1000000.00' },
          { kind: 'expense', label: 'ทำความสะอาด', amount: '234567.89' },
          { kind: 'fund', label: 'กองทุนสำรอง', amount: '120000.00' },
          { kind: 'income', label: 'ค่าที่จอดรถ', amount: '10000.00' },
        ],
      })
      .expect(201);
    expect(budget.body).toMatchObject({ state: 'draft', total: '1354567.89', incomeTotal: '10000.00' });
    ids.budget = budget.body.id;
    // a draft resolution cannot approve a budget
    const notAdopted = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/actions/approve`)
      .set({ ...J(), ...idem() })
      .send({ resolutionId: ids.res })
      .expect(422);
    expect(notAdopted.body.errors).toEqual([expect.objectContaining({ path: 'resolutionId' })]);
    const key = idem();
    const adopted = await t.http
      .post(`/v1/owner/juristic/resolutions/${ids.res}/actions/adopt`)
      .set({ ...J(), ...key })
      .expect(200);
    expect(adopted.body.state).toBe('adopted');
    const replay = await t.http
      .post(`/v1/owner/juristic/resolutions/${ids.res}/actions/adopt`)
      .set({ ...J(), ...key })
      .expect(200);
    expect(replay.body.version).toBe(adopted.body.version);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${ids.res}/actions/adopt`)
      .set({ ...J(), ...idem() })
      .expect(409);
    await t.http.post(`/v1/owner/juristic/resolutions/${ids.res}/actions/adopt`).set(J()).expect(400);
    await t.http
      .patch(`/v1/owner/juristic/resolutions/${ids.res}`)
      .set(J())
      .send({ title: 'แก้' })
      .expect(409);
    const approved = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/actions/approve`)
      .set({ ...J(), ...idem() })
      .send({ resolutionId: ids.res })
      .expect(200);
    expect(approved.body).toMatchObject({
      state: 'approved',
      resolutionId: ids.res,
      nextActions: ['create-rate-plan-draft'],
    });
    await t.http.patch(`/v1/owner/juristic/budgets/${ids.budget}`).set(J()).send({ name: 'x' }).expect(409);
    // a revised budget of the same year supersedes the approved one
    const revised = await t.http
      .post('/v1/owner/juristic/budgets')
      .set(J())
      .send({
        buildingId: ids.condo,
        fiscalYear: 2027,
        name: 'ฉบับแก้ไข',
        lines: [{ kind: 'expense', label: 'x', amount: '1.00' }],
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/budgets/${revised.body.id}/actions/approve`)
      .set({ ...J(), ...idem() })
      .send({ resolutionId: ids.res })
      .expect(200);
    const states = await t.http.get(`/v1/owner/juristic/budgets?fiscalYear=2027`).set(J()).expect(200);
    expect((states.body.data as { state: string }[]).map((b) => b.state).sort()).toEqual([
      'approved',
      'superseded',
    ]);
    // the resolution is in use: it cannot be voided
    await t.http
      .post(`/v1/owner/juristic/resolutions/${ids.res}/actions/void`)
      .set(J())
      .send({ reason: 'ทดสอบ' })
      .expect(409);
    // re-approve the full budget for the rate draft below (supersedes the revision)
    const again = await t.http
      .post('/v1/owner/juristic/budgets')
      .set(J())
      .send({
        buildingId: ids.condo,
        fiscalYear: 2027,
        name: 'งบประมาณ 2570 (มติ)',
        lines: (budget.body.lines as Record<string, string>[]).map((l) => ({
          kind: l.kind,
          label: l.label,
          amount: l.amount,
        })),
      })
      .expect(201);
    ids.budget = again.body.id;
    await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/actions/approve`)
      .set({ ...J(), ...idem() })
      .send({ resolutionId: ids.res })
      .expect(200);
  });

  it('a juristic common-fee rate needs an adopted resolution of the building (422 rate_plan.resolution_required)', async () => {
    const plan = await t.http
      .post('/v1/owner/rate-plans')
      .set(J())
      .send({
        buildingId: ids.condo,
        kind: 'common_fee',
        name: 'ค่าส่วนกลาง',
        isDefault: true,
        frequency: 'annual',
      })
      .expect(201);
    ids.cfPlan = plan.body.id;
    const version = {
      effectiveFrom: '2027-01-01',
      basis: 'per_sqm',
      tiers: { kind: 'flat', pricePerUnit: '30.00' },
    };
    const missing = await t.http
      .post(`/v1/owner/rate-plans/${ids.cfPlan}/versions`)
      .set(J())
      .send(version)
      .expect(422);
    expect(missing.body.code).toBe('rate_plan.resolution_required');
    const other = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.condo,
        meetingKind: 'committee',
        meetingDate: '2026-12-11',
        number: 'C-1',
        title: 'ร่าง',
        text: 'ร่าง',
      })
      .expect(201);
    const draft = await t.http
      .post(`/v1/owner/rate-plans/${ids.cfPlan}/versions`)
      .set(J())
      .send({ ...version, resolutionId: other.body.id })
      .expect(422);
    expect(draft.body.code).toBe('rate_plan.resolution_invalid');
    const saved = await t.http
      .post(`/v1/owner/rate-plans/${ids.cfPlan}/versions`)
      .set(J())
      .send({ ...version, resolutionId: ids.res })
      .expect(201);
    expect(saved.body.versions[0]).toMatchObject({ basis: 'per_sqm', resolutionId: ids.res });
    // the drafted committee resolution: void with a reason (not in use)
    const voided = await t.http
      .post(`/v1/owner/juristic/resolutions/${other.body.id}/actions/void`)
      .set(J())
      .send({ reason: 'บันทึกซ้ำ' })
      .expect(200);
    expect(voided.body.state).toBe('void');
  });

  it('budget → rate preview (Σ exact, min / median / max) and a budget_split fund draft carrying the resolution', async () => {
    const preview = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/rate-preview`)
      .set(J())
      .send({ kind: 'common_fee', splitBy: 'ownership_ratio', frequency: 'annual' })
      .expect(200);
    // expense lines 1,234,567.89 split 0.4 / 0.6 → 493,827.16 + 740,740.73 (remainder on the larger ratio)
    expect(preview.body).toMatchObject({
      annualAmount: '1234567.89',
      cycleAmount: '1234567.89',
      min: '493827.16',
      max: '740740.73',
      sum: '1234567.89',
      sumMatches: true,
      unitsCount: 2,
      missingUnitIds: [],
    });
    const byLand = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/rate-preview`)
      .set(J())
      .send({ kind: 'fund', splitBy: 'land_area_sqwa', frequency: 'quarterly' })
      .expect(200);
    expect(byLand.body).toMatchObject({ annualAmount: '120000.00', cycleAmount: '30000.00', units: [] });
    expect(byLand.body.missingUnitIds).toHaveLength(2);
    const refused = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/actions/create-rate-plan-draft`)
      .set({ ...J(), ...idem() })
      .send({ kind: 'fund', splitBy: 'land_area_sqwa', frequency: 'quarterly', effectiveFrom: '2027-01-01' })
      .expect(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'splitBy' })]);
    const draft = await t.http
      .post(`/v1/owner/juristic/budgets/${ids.budget}/actions/create-rate-plan-draft`)
      .set({ ...J(), ...idem() })
      .send({ kind: 'fund', splitBy: 'ownership_ratio', frequency: 'quarterly', effectiveFrom: '2027-01-01' })
      .expect(200);
    expect(draft.body.plan).toMatchObject({ kind: 'fund', frequency: 'quarterly', isDefault: true });
    expect(draft.body.plan.versions[0]).toMatchObject({
      basis: 'budget_split',
      resolutionId: ids.res,
      tiers: { kind: 'budget', amount: '120000.00', period: 'year', splitBy: 'ownership_ratio' },
    });
    expect(draft.body.preview).toMatchObject({
      cycleAmount: '30000.00',
      min: '12000.00',
      max: '18000.00',
      sumMatches: true,
    });
  });

  it('cycles: annual common fee by share, quarterly budget_split fund Σ exact to the satang', async () => {
    await at('2027-01-01T01:00:00+07:00');
    await t.app.get(BillingCyclesService).sweep();
    const list = await cycles();
    for (const c of list) ids[`cycle:${c.frequency}`] = c.id;
    expect(list.map((c) => [c.frequency, c.periodKey]).sort()).toEqual([
      ['annual', '2027'],
      ['quarterly', '2027-Q1'],
    ]);
    const annual = await cycle(ids['cycle:annual']!);
    const of = (c: Cycle, unit: string, party: string) =>
      c.invoices.find((i) => i.unitId === ids[unit] && i.billedPartyId === ids[party])!;
    // A-101 40 m² × 30.00 × 12 = 14,400.00 → 60 % 8,640.00 + 40 % 5,760.00; A-102 60 m² → 21,600.00
    expect([
      of(annual, 'a1', 'p60').total,
      of(annual, 'a1', 'p40').total,
      of(annual, 'a2', 's2').total,
    ]).toEqual(['8640.00', '5760.00', '21600.00']);
    const quarter = await cycle(ids['cycle:quarterly']!);
    // 120,000.00 ÷ 12 × 3 = 30,000.00 split 0.4 / 0.6 → 12,000.00 / 18,000.00, then by share on A-101
    expect(quarter.invoices.reduce((s, i) => s.plus(i.total), new Decimal(0)).toFixed(2)).toBe('30000.00');
    expect(of(quarter, 'a1', 'p60').total).toBe('7200.00');
    await t.http
      .post(`/v1/owner/billing-cycles/${ids['cycle:annual']}/actions/issue`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(200);
    ids.invP60 = of(annual, 'a1', 'p60').id;
    ids.invP40 = of(annual, 'a1', 'p40').id;
    ids.invS2 = of(annual, 'a2', 's2').id;
  });

  it('transfer after the issued annual invoice: carry_to_buyer credits the sellers and charges the buyer (idempotent)', async () => {
    const key = idem();
    const body = {
      transferDate: '2027-03-15',
      buyers: [
        { party: { type: 'person', displayName: 'ผู้ซื้อ A-101', phone: '+66810000999' }, sharePct: '100' },
      ],
    };
    const r = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/transfers`)
      .set({ ...J(), ...key })
      .send(body)
      .expect(201);
    expect(r.body.transfer).toMatchObject({ transferDate: '2027-03-15', policy: 'carry_to_buyer' });
    expect(r.body.transfer.creditNoteIds).toHaveLength(2);
    expect(r.body.transfer.chargeIds).toHaveLength(2);
    ids.buyer = (
      r.body.register.history as { validFrom: string; validTo: string | null; party: { id: string } }[]
    ).find((o) => o.validFrom === '2027-03-15')!.party.id;
    expect(
      (
        r.body.register.history as { validFrom: string; validTo: string | null; party: { id: string } }[]
      ).filter((o) => o.validTo === '2027-03-15'),
    ).toHaveLength(2);
    const replay = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/transfers`)
      .set({ ...J(), ...key })
      .send(body)
      .expect(201);
    expect(replay.body.transfer.id).toBe(r.body.transfer.id);
    expect(
      await one(`SELECT count(*)::int AS n FROM juristic.ownership_transfer WHERE unit_id = $1`, [ids.a1]),
    ).toEqual({ n: 1 });
    // 8,640.00 − round(8,640 × 73 / 365 = 1,728.00) = 6,912.00; 5,760.00 − 1,152.00 = 4,608.00
    const notes = await q<{ invoice_id: string; total: string; reason: string }>(
      `SELECT invoice_id::text, total::text, reason::text FROM ops.credit_note WHERE tenant_id = $1 ORDER BY total DESC`,
      [jur.tenantId],
    );
    expect(notes).toEqual([
      { invoice_id: ids.invP60, total: '6912.00', reason: 'ownership_transfer' },
      { invoice_id: ids.invP40, total: '4608.00', reason: 'ownership_transfer' },
    ]);
    const charges = await q<{ party_id: string; amount: string; line_kind: string; status: string }>(
      `SELECT party_id::text, amount::text, line_kind::text, status::text FROM ops.invoice_charge WHERE unit_id = $1 ORDER BY amount DESC`,
      [ids.a1],
    );
    // one charge per credited line: the buyer (100 %) pays the days from 15 March of both former shares
    expect(charges).toEqual([
      { party_id: ids.buyer, amount: '6912.00', line_kind: 'common_fee', status: 'pending' },
      { party_id: ids.buyer, amount: '4608.00', line_kind: 'common_fee', status: 'pending' },
    ]);
    const event = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'unit_ownership.transferred' AND aggregate_id = $1`,
      [ids.a1],
    );
    expect(event.payload).toMatchObject({
      transferDate: '2027-03-15',
      policy: 'carry_to_buyer',
      credited: '11520.00',
    });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'unit_ownership.transferred' AND tenant_id = $1`,
        [jur.tenantId],
      ),
    ).toEqual({ n: 1 });
    // a transfer before the buyer's start (or with nobody owning) is refused
    await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/transfers`)
      .set({ ...J(), ...idem() })
      .send({ ...body, transferDate: '2027-02-01' })
      .expect(409);
  });

  it('refund_seller: the seller is credited for the days after the transfer, the buyer is not charged', async () => {
    const r = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a2}/transfers`)
      .set({ ...J(), ...idem() })
      .send({
        transferDate: '2027-07-01',
        policy: 'refund_seller',
        buyers: [{ party: { type: 'person', displayName: 'ผู้ซื้อ A-102' }, sharePct: '100' }],
      })
      .expect(201);
    expect(r.body.transfer).toMatchObject({ policy: 'refund_seller', chargeIds: [] });
    // 21,600.00 − round(21,600 × 181 / 365 = 10,711.23) = 10,888.77
    const note = await one<{ total: string }>(
      `SELECT total::text FROM ops.credit_note WHERE invoice_id = $1`,
      [ids.invS2],
    );
    expect(note.total).toBe('10888.77');
    expect(
      await one(`SELECT count(*)::int AS n FROM ops.invoice_charge WHERE unit_id = $1`, [ids.a2]),
    ).toEqual({ n: 0 });
  });

  it('bill-to: with written consent the buyer’s charges are invoiced to the agency; the agency login holds role payer', async () => {
    const consent = await doc(jur.tenantId, 'j11b/consent.pdf');
    const noOwner = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/bill-to`)
      .set(J())
      .send({
        ownerPartyId: ids.p60,
        payer: { party: { type: 'company', displayName: 'x' } },
        kind: 'agency',
        consentDocumentId: consent,
        validFrom: '2027-03-15',
      })
      .expect(422);
    expect(noOwner.body.errors).toEqual([expect.objectContaining({ path: 'ownerPartyId' })]);
    const set = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/bill-to`)
      .set(J())
      .send({
        ownerPartyId: ids.buyer,
        payer: {
          party: { type: 'company', displayName: 'บริษัท ตัวแทน จำกัด', email: 'agency@example.invalid' },
        },
        kind: 'agency',
        consentDocumentId: consent,
        validFrom: '2027-03-15',
      })
      .expect(201);
    const billTo = set.body.billTo[0];
    expect(billTo).toMatchObject({
      ownerPartyId: ids.buyer,
      kind: 'agency',
      validFrom: '2027-03-15',
      validTo: null,
    });
    ids.agency = billTo.billToParty.id;
    ids.billTo = billTo.id;
    // the March cycle bills the buyer's pending charge to the agency
    await at('2027-04-02T09:00:00+07:00');
    const march = await t.http
      .post('/v1/owner/billing-cycles')
      .set(J())
      .send({ propertyId: ids.condoProperty, periodKey: '2027-03' })
      .expect(200);
    await t.http
      .post(`/v1/owner/billing-cycles/${march.body.id}/actions/compute`)
      .set(J())
      .send({})
      .expect(200);
    const computed = await cycle(march.body.id);
    expect(computed.invoices.map((i) => [i.unitId, i.billedPartyId, i.total])).toEqual([
      [ids.a1, ids.agency, '11520.00'],
    ]);
    // JR: a login linked to the agency party holds role payer, source bill_to (invoices only, no unit scope)
    const user = await one<{ id: string }>(
      `INSERT INTO core.user_account (display_name, phone_e164) VALUES ('agency', '+66810000777') RETURNING id`,
    );
    await q(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via) VALUES ($1, $2, $3, 'admin')`,
      [jur.tenantId, ids.agency, user.id],
    );
    const roles = await t.app.get(TenantTx).platform((tx) => residentUnitRoles(tx, user.id, '2027-04-02'));
    expect(roles.map((x) => [x.unitId, x.role, x.source])).toEqual([[ids.a1, 'payer', 'bill_to']]);
    const ended = await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/bill-to/${ids.billTo}/actions/end`)
      .set(J())
      .send({ validTo: '2027-05-01' })
      .expect(200);
    expect(ended.body.billToHistory[0]).toMatchObject({ validTo: '2027-05-01', endedReason: 'ended' });
  });

  it('committee approves and adopts but never edits the register; auditor reads until accessUntil', async () => {
    // committee / auditor exist only in juristic tenants
    const devOwner = bearer(await ownerToken(t));
    const apartment = await t.http
      .post('/v1/owner/invitations')
      .set(devOwner)
      .send({ role: 'committee', phone: '+66810000881', channel: 'link' })
      .expect(422);
    expect(apartment.body.code).toBe('membership.role_not_allowed');
    const noUntil = await t.http
      .post('/v1/owner/invitations')
      .set(J())
      .send({ role: 'auditor', phone: '+66810000882', channel: 'link' })
      .expect(422);
    expect(noUntil.body.code).toBe('membership.access_until_required');
    const committeeInvite = await t.http
      .post('/v1/owner/invitations')
      .set(J())
      .send({ role: 'committee', phone: '+66810000883', channel: 'link' })
      .expect(201);
    const committee = bearer(await operatorToken(t, '+66810000883', committeeInvite.body.code));
    await t.http.get(`/v1/owner/juristic/register/units/${ids.a1}`).set(committee).expect(200);
    await t.http
      .post(`/v1/owner/juristic/register/units/${ids.a1}/owners`)
      .set(committee)
      .send({ partyId: ids.p60, sharePct: '1' })
      .expect(403);
    const r = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.condo,
        meetingKind: 'committee',
        meetingDate: '2027-04-01',
        number: 'C-2',
        title: 'ค่าซ่อม',
        text: 'อนุมัติ',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${r.body.id}/actions/adopt`)
      .set({ ...committee, ...idem() })
      .expect(200);
    const until = new Date(t.clock.now().getTime() + 30 * 86_400_000).toISOString();
    const auditorInvite = await t.http
      .post('/v1/owner/invitations')
      .set(J())
      .send({ role: 'auditor', phone: '+66810000884', channel: 'link', accessUntil: until })
      .expect(201);
    expect(auditorInvite.body.accessUntil).not.toBeNull();
    const auditor = bearer(await operatorToken(t, '+66810000884', auditorInvite.body.code));
    await t.http.get('/v1/owner/juristic/budgets').set(auditor).expect(200);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${r.body.id}/actions/void`)
      .set(auditor)
      .send({ reason: 'x' })
      .expect(403);
    // after accessUntil the membership grants nothing
    t.clock.set(new Date(new Date(until).getTime() + 60_000));
    t.app.get(AccessService).forget('*');
    const late = await t.http.get('/v1/owner/juristic/budgets').set(auditor);
    expect([401, 403]).toContain(late.status);
  });

  it('every new endpoint answers 404 to another tenant; lists stay empty', async () => {
    const D = bearer(await ownerToken(t));
    const u = ids.a1;
    const calls: [string, string, Record<string, unknown>?][] = [
      ['get', `/v1/owner/juristic/register/units/${u}`],
      ['patch', `/v1/owner/juristic/register/units/${u}`, { plotNo: 'x' }],
      ['post', `/v1/owner/juristic/register/units/${u}/owners`, { partyId: ids.p60, sharePct: '1' }],
      [
        'post',
        `/v1/owner/juristic/register/units/${u}/transfers`,
        { transferDate: '2027-09-01', buyers: [{ partyId: ids.p60, sharePct: '100' }] },
      ],
      ['get', `/v1/owner/juristic/register/units/${u}/transfers`],
      [
        'post',
        `/v1/owner/juristic/register/units/${u}/bill-to`,
        {
          ownerPartyId: ids.buyer,
          payer: { partyId: ids.agency },
          kind: 'agency',
          consentDocumentId: ids.agency,
        },
      ],
      ['post', `/v1/owner/juristic/register/units/${u}/bill-to/${ids.billTo}/actions/end`, {}],
      ['get', `/v1/owner/juristic/register?buildingId=${ids.condo}`],
      ['get', `/v1/owner/juristic/resolutions/${ids.res}`],
      ['patch', `/v1/owner/juristic/resolutions/${ids.res}`, { title: 'x' }],
      ['post', `/v1/owner/juristic/resolutions/${ids.res}/actions/adopt`, {}],
      ['post', `/v1/owner/juristic/resolutions/${ids.res}/actions/void`, { reason: 'x' }],
      [
        'post',
        `/v1/owner/juristic/resolutions/${ids.res}/documents`,
        { documentId: ids.res, kind: 'minutes' },
      ],
      ['delete', `/v1/owner/juristic/resolutions/${ids.res}/documents/${ids.res}`],
      [
        'post',
        '/v1/owner/juristic/resolutions',
        {
          buildingId: ids.condo,
          meetingKind: 'agm',
          meetingDate: '2027-01-01',
          number: 'x',
          title: 'x',
          text: 'x',
        },
      ],
      ['get', `/v1/owner/juristic/budgets/${ids.budget}`],
      ['patch', `/v1/owner/juristic/budgets/${ids.budget}`, { name: 'x' }],
      ['post', `/v1/owner/juristic/budgets/${ids.budget}/actions/approve`, { resolutionId: ids.res }],
      [
        'post',
        `/v1/owner/juristic/budgets/${ids.budget}/rate-preview`,
        { kind: 'common_fee', splitBy: 'per_unit' },
      ],
      [
        'post',
        `/v1/owner/juristic/budgets/${ids.budget}/actions/create-rate-plan-draft`,
        { kind: 'common_fee', splitBy: 'per_unit', effectiveFrom: '2027-12-01' },
      ],
      [
        'post',
        '/v1/owner/juristic/budgets',
        { buildingId: ids.condo, fiscalYear: 2028, name: 'x', lines: [] },
      ],
    ];
    for (const [method, path, body] of calls) {
      const req = t.http[method as 'get'](path).set({ ...D, ...idem() });
      const res = body ? await req.send(body) : await req;
      expect([path, res.status]).toEqual([path, 404]);
    }
    const lists = ['/v1/owner/juristic/resolutions', '/v1/owner/juristic/budgets'];
    for (const path of lists) expect((await t.http.get(path).set(D).expect(200)).body.data).toEqual([]);
    // the DEV apartment keeps its tenancy: its units have no ownership rows written by the juristic tenant
    expect(
      await one(
        `SELECT count(*)::int AS n FROM core.unit_ownership WHERE tenant_id = $1 AND building_id = $2`,
        [DEV.tenantId, ids.condo],
      ),
    ).toEqual({ n: 0 });
  });
});
