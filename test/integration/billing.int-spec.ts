import 'reflect-metadata';

import { ComplianceScoreService } from '@core/compliance/compliance-score.service';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { BillingCyclesService } from '@modules/ops-billing/billing-cycles.service';
import type request from 'supertest';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000b4b201';

interface Line {
  id: string;
  lineKind: string;
  amount: string;
  units: string | null;
  unitPrice: string | null;
  aboveCap: boolean;
  complianceAcknowledgementId: string | null;
  registerFrom: string | null;
  registerTo: string | null;
  readingSource: string | null;
}

/**
 * B4.2 acceptance (billing cycles & invoices) on the development lease A-101 (rent 4,500, internet 300, billing day
 * 5): rate plans (tiered power below the cap at the representative 150 kWh; flat water above it → 409 → acknowledge),
 * the October cycle waiting for a staff water reading → computed → issued (the tiered power line is above the cap at
 * 300 kWh → cycle acknowledgement), immutability, the resident's view, credit/debit notes, void + reissue, one-off
 * charges and the prior balance on November (opened by the worker sweep), the final invoice at move-out applying the
 * advance rent and feeding the deposit settlement, the compliance score, cross-tenant 404s and RLS.
 */
describe('B4.2 billing cycles & invoices (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let other: { tenantId: string; token: string };
  const ids: Record<string, string> = {};
  const meters: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];

  /** A manual (staff round) reading of A-101, accepted. */
  const reading = (utility: 'electric' | 'water', register: string, readAt: string) =>
    db.admin.query(
      `INSERT INTO smart.meter_reading (tenant_id, building_id, asset_item_id, meter_assignment_id, unit_id, register, unit,
                                        read_at, source, confidence, review_state, submitted_via)
       SELECT m.tenant_id, m.building_id, m.asset_item_id, m.id, m.unit_id, $2, $3, $4, 'manual', 0.95, 'accepted', 'staff_pwa'
         FROM core.meter_assignment m WHERE m.asset_item_id = $1`,
      [meters[utility], register, utility === 'electric' ? 'kwh' : 'm3', readAt],
    );

  /** Time travel: the fake clock moves and the operators sign in again. */
  async function at(instant: string) {
    t.clock.set(new Date(instant));
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
  }

  /** 409 compliance.acknowledgement_required → the owner acknowledges what was shown → its id. */
  async function acknowledge(res: request.Response): Promise<string> {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compliance.acknowledgement_required');
    const ack = await t.http
      .post('/v1/owner/compliance-acknowledgements')
      .set(bearer(owner))
      .send({
        evaluationId: res.body.evaluationId,
        legalTextKey: res.body.legalTextKey,
        legalTextVersion: res.body.legalTextVersion,
        language: 'th',
      })
      .expect(201);
    return ack.body.id as string;
  }

  const invoiceOf = async (id: string | undefined) =>
    (await t.http.get(`/v1/owner/invoices/${id}`).set(bearer(owner)).expect(200)).body as {
      id: string;
      number: string | null;
      status: string;
      total: string;
      balance: string;
      priorBalance: string;
      amountDue: string;
      dueDate: string | null;
      lines: Line[];
      reviewFlags: string[];
      nextActions: string[];
      replacedByInvoiceId: string | null;
      replacesInvoiceId: string | null;
      snapshotSha256: string | null;
    };
  const line = (lines: Line[], kind: string) => lines.find((l) => l.lineKind === kind)!;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_billing' });
    // the seeded settings start at the seeding instant; this suite travels back to September
    // (test setup only: the append-only trigger is bypassed with replication role for this one statement)
    await db.admin.query('SET session_replication_role = replica');
    await db.admin.query(
      `UPDATE platform.setting_version SET effective_from = '2026-01-01T00:00:00+07:00', created_at = '2026-01-01T00:00:00+07:00'`,
    );
    await db.admin.query('SET session_replication_role = origin');
    // the MEA residential and MWA tariffs are published (two-person rule done by the platform, D-021a)
    await db.admin.query(
      `UPDATE platform.utility_tariff_version v
          SET state = 'published', published_at = now(), verified_by = $1, verified_at = now(), needs_check = false
         FROM platform.utility_tariff t
        WHERE t.id = v.utility_tariff_id AND ((t.provider = 'mea' AND t.tariff_code LIKE '1.1%') OR t.provider = 'mwa')`,
      [DEV.users.support],
    );
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    for (const r of await q<{ category: string; id: string }>(
      `SELECT a.category::text, a.id FROM core.asset_item a JOIN core.unit u ON u.id = a.unit_id
        WHERE u.building_id = $1 AND u.unit_no = 'A-101'`,
      [DEV.buildingId],
    ))
      meters[r.category === 'meter_electric' ? 'electric' : 'water'] = r.id;
    ids.unitA101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    await at('2026-09-20T03:00:00Z');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b42',
      phone: '+660000000142',
      type: 'apartment',
    });
  }, 180_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('rate plans: tiered power below the cap at 150 kWh; flat water above it → acknowledge; never backdated', async () => {
    const O = bearer(owner);
    for (const [utility, provider, customerNo] of [
      ['electric', 'mea', '000011110001'],
      ['water', 'mwa', '000022220001'],
    ])
      await t.http
        .post(`/v1/owner/buildings/${DEV.buildingId}/utility-accounts`)
        .set(O)
        .send({ utility, provider, customerNo, label: `${provider} main` })
        .expect(201);
    const power = await t.http
      .post('/v1/owner/rate-plans')
      .set(O)
      .send({ buildingId: DEV.buildingId, kind: 'power', name: 'ค่าไฟห้องพัก', isDefault: true })
      .expect(201);
    ids.powerPlan = power.body.id;
    const tiers = {
      kind: 'tiered',
      unit: 'kwh',
      tiers: [
        { fromUnits: '0', toUnits: '150', pricePerUnit: '3.0000' },
        { fromUnits: '150', toUnits: null, pricePerUnit: '9.0000' },
      ],
    };
    await t.http
      .post(`/v1/owner/rate-plans/${ids.powerPlan}/versions`)
      .set(O)
      .send({ effectiveFrom: '2026-09-19', basis: 'per_unit', tiers })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('rate_plan.backdated'));
    const saved = await t.http
      .post(`/v1/owner/rate-plans/${ids.powerPlan}/versions`)
      .set(O)
      .send({ effectiveFrom: '2026-09-20', basis: 'per_unit', tiers })
      .expect(201);
    expect(saved.body.versions[0]).toMatchObject({
      aboveCap: false,
      inForce: true,
      effectiveFrom: '2026-09-20',
    });
    // compared at the representative 150 kWh with the lowest MEA residential average rate in force
    expect(saved.body.versions[0].capCheck).toMatchObject({
      provider: 'mea',
      representativeUnits: '150.000',
      tenantRate: '3.0000',
      aboveCap: false,
    });
    // a bad shape is a validation problem, not a crash
    await t.http
      .post(`/v1/owner/rate-plans/${ids.powerPlan}/versions`)
      .set(O)
      .send({ basis: 'per_unit', tiers: { kind: 'budget', amount: '10' } })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('validation.failed'));

    const water = await t.http
      .post('/v1/owner/rate-plans')
      .set(O)
      .send({ buildingId: DEV.buildingId, kind: 'water', name: 'ค่าน้ำ', isDefault: true })
      .expect(201);
    ids.waterPlan = water.body.id;
    const body = {
      effectiveFrom: '2026-09-20',
      basis: 'per_unit',
      tiers: { kind: 'flat', unit: 'm3', pricePerUnit: '18.0000' },
    };
    const warn = await t.http.post(`/v1/owner/rate-plans/${ids.waterPlan}/versions`).set(O).send(body);
    expect(warn.body.shown).toMatchObject({ tenantRate: '18.0000', utility: 'water' });
    const ackId = await acknowledge(warn);
    const ok = await t.http
      .post(`/v1/owner/rate-plans/${ids.waterPlan}/versions`)
      .set(O)
      .send({ ...body, acknowledgementIds: [ackId] })
      .expect(201);
    expect(ok.body.versions[0]).toMatchObject({ aboveCap: true, complianceAcknowledgementId: ackId });
    // a version in force is immutable
    await t.http
      .post(`/v1/owner/rate-plans/${ids.waterPlan}/versions`)
      .set(O)
      .send({ ...body, tiers: { kind: 'flat', unit: 'm3', pricePerUnit: '8.0000' } })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('rate_plan.version_in_force'));
    const list = await t.http.get(`/v1/owner/rate-plans?buildingId=${DEV.buildingId}`).set(O).expect(200);
    expect((list.body as { kind: string }[]).map((p) => p.kind).sort()).toEqual(['power', 'water']);
  });

  it('October: readings pending → staff reading within grace → computed (per-unit table)', async () => {
    await reading('electric', '300.000', '2026-10-31T20:00:00+07:00');
    await at('2026-11-01T03:00:00Z');
    const opened = await t.http
      .post('/v1/owner/billing-cycles')
      .set(bearer(owner))
      .send({ propertyId: DEV.propertyId, periodKey: '2026-10' })
      .expect(200);
    ids.cycleOct = opened.body.id;
    expect(opened.body).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'open' });
    const pending = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/compute`)
      .set(bearer(owner))
      .expect(200);
    expect(pending.body.status).toBe('readings_pending');
    expect(pending.body.invoices).toHaveLength(1);
    const flags = (pending.body.invoices as { reviewFlags: string[] }[])[0]!.reviewFlags;
    expect(flags.some((f) => f.startsWith('missing_reading:'))).toBe(true);
    const asked = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'billing_cycle.readings_requested' AND aggregate_id = $1`,
      [ids.cycleOct],
    );
    expect(asked[0]!.n).toBe(1);
    // issuing now skips the unit (not ready)
    const early = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({})
      .expect(200);
    expect(early.body.skipped[0].reason).toContain('missing_reading');

    const photo = await uploadFile(t, db, staff, {
      kind: 'meter_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'meter.jpg',
      mimeType: 'image/jpeg',
      body: Buffer.from('fake-jpeg-meter-photo'),
      surface: 'staff',
    });
    await t.http
      .post('/v1/staff/meter-readings')
      .set(bearer(staff))
      .set(idem())
      .send({
        assetItemId: meters.water,
        photoDocumentId: photo,
        typedValue: '12.000',
        readAt: '2026-11-01T09:00:00+07:00',
      })
      .expect(201)
      .expect((r) => expect(r.body.reviewState).toBe('accepted'));
    const computed = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/compute`)
      .set(bearer(owner))
      .expect(200);
    expect(computed.body.status).toBe('computed');
    expect(computed.body.nextActions).toEqual(['compute', 'issue']);
    ids.invOctDraft = computed.body.invoices[0].id;
    const draft = await invoiceOf(ids.invOctDraft);
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      total: '6816.00',
      nextActions: ['issue', 'recompute'],
    });
    expect(line(draft.lines, 'rent').amount).toBe('4500.00');
    expect(line(draft.lines, 'internet').amount).toBe('300.00');
    // 150 × 3 + 150 × 9 = 1,800 → 6.0000/kWh, above the MEA rate at 300 kWh: no acknowledgement yet
    expect(line(draft.lines, 'electricity')).toMatchObject({
      units: '300.000',
      unitPrice: '6.0000',
      amount: '1800.00',
      registerFrom: '0.000',
      registerTo: '300.000',
      readingSource: 'manual',
      aboveCap: true,
      complianceAcknowledgementId: null,
    });
    // water above the cap carries the rate version's acknowledgement
    expect(line(draft.lines, 'water')).toMatchObject({ units: '12.000', amount: '216.00', aboveCap: true });
    expect(line(draft.lines, 'water').complianceAcknowledgementId).not.toBeNull();
  });

  it('issue: the above-cap power line needs the cycle acknowledgement; issued invoices are immutable', async () => {
    const first = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({});
    expect(first.body.shown).toMatchObject({ count: 1 });
    const ackId = await acknowledge(first);
    const issued = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({ acknowledgementIds: [ackId] })
      .expect(200);
    expect(issued.body).toMatchObject({ status: 'issued', skipped: [], nextActions: ['close'] });
    const inv = await invoiceOf(ids.invOctDraft);
    ids.invOct = inv.id;
    expect(inv).toMatchObject({
      number: 'INV-2026-00001',
      status: 'issued',
      total: '6816.00',
      balance: '6816.00',
    });
    expect(inv.dueDate! >= '2026-11-05').toBe(true);
    expect(inv.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(line(inv.lines, 'electricity').complianceAcknowledgementId).toBe(ackId);
    const snap = await q<{
      snapshot: { totals: { total: string }; meters: unknown[]; settings: Record<string, unknown> };
    }>('SELECT snapshot FROM ops.invoice WHERE id = $1', [ids.invOct]);
    expect(snap[0]!.snapshot.totals.total).toBe('6816.00');
    expect(Object.keys(snap[0]!.snapshot.settings)).toContain('billing.cutoff');
    // D-040: no edit, no delete — enforced by the database
    await expect(
      db.admin.query('UPDATE ops.invoice SET total = 1 WHERE id = $1', [ids.invOct]),
    ).rejects.toThrow(/compliance.invoice_immutable/);
    await expect(
      db.admin.query('UPDATE ops.invoice_line SET amount = 1 WHERE invoice_id = $1', [ids.invOct]),
    ).rejects.toThrow(/compliance.invoice_immutable/);
    await expect(db.admin.query('DELETE FROM ops.invoice WHERE id = $1', [ids.invOct])).rejects.toThrow(
      /compliance.invoice_immutable/,
    );
    const events = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'invoice.issued' AND aggregate_id = $1`,
      [ids.invOct],
    );
    expect(events[0]!.n).toBe(1);
    const search = await t.http.get('/v1/owner/search?q=INV-2026').set(bearer(owner)).expect(200);
    expect(search.body.data).toContainEqual(expect.objectContaining({ type: 'invoice', id: ids.invOct }));
  });

  it('the resident sees the issued invoice (registers, sources, amount due); others get 404', async () => {
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(owner))
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
    const resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)
    ).body.accessToken as string;
    ids.resident = resident;
    const R = bearer(resident);
    const mine = await t.http.get('/v1/resident/invoices').set(R).expect(200);
    expect((mine.body.data as { id: string }[]).map((i) => i.id)).toEqual([ids.invOct]);
    const one = await t.http.get(`/v1/resident/invoices/${ids.invOct}`).set(R).expect(200);
    expect(one.body).toMatchObject({
      number: 'INV-2026-00001',
      total: '6816.00',
      amountDue: '6816.00',
      balance: '6816.00',
    });
    const elec = (
      one.body.lines as {
        lineKind: string;
        registerFrom: string;
        registerTo: string;
        readingSource: string;
      }[]
    ).find((l) => l.lineKind === 'electricity')!;
    expect(elec).toMatchObject({ registerFrom: '0.000', registerTo: '300.000', readingSource: 'manual' });
    await t.http.get('/v1/resident/invoices/by-number/INV-2026-00001').set(R).expect(200);
    await t.http.get('/v1/resident/invoices/by-number/INV-2026-99999').set(R).expect(404);
    // a resident without a link sees nothing; a draft is never visible
    const stranger = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b4b2ff', name: 'คนอื่น' }) })
      .expect(200);
    await t.http
      .get(`/v1/resident/invoices/${ids.invOct}`)
      .set(bearer(stranger.body.accessToken))
      .expect(404);
  });

  it('void before payment and reissue: a replacement draft for the same period, issued with a new number', async () => {
    const r = await t.http
      .post(`/v1/owner/invoices/${ids.invOct}/actions/void`)
      .set(bearer(owner))
      .set(idem())
      .send({ reason: 'คำนวณจากเลขมิเตอร์ที่อ่านผิด', reissue: true })
      .expect(200);
    expect(r.body.voided).toMatchObject({ status: 'void', number: 'INV-2026-00001', nextActions: [] });
    expect(r.body.replacement).toMatchObject({ status: 'draft', replacesInvoiceId: ids.invOct });
    ids.invOct2Draft = r.body.replacement.id;
    expect(r.body.voided.replacedByInvoiceId).toBe(ids.invOct2Draft);
    // the void is audited
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'invoice.voided' AND subject_id = $1`,
      [ids.invOct],
    );
    expect(audit[0]!.n).toBe(1);
    const warn = await t.http
      .post(`/v1/owner/invoices/${ids.invOct2Draft}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({});
    const ackId = await acknowledge(warn);
    const issued = await t.http
      .post(`/v1/owner/invoices/${ids.invOct2Draft}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({ acknowledgementIds: [ackId] })
      .expect(200);
    expect(issued.body).toMatchObject({
      number: 'INV-2026-00002',
      status: 'issued',
      total: '6816.00',
      priorBalance: '0.00',
    });
    ids.invOct2 = issued.body.id;
    // voiding a void invoice changes nothing
    const again = await t.http
      .post(`/v1/owner/invoices/${ids.invOct}/actions/void`)
      .set(bearer(owner))
      .set(idem())
      .send({ reason: 'อีกครั้ง' })
      .expect(200);
    expect(again.body.voided.status).toBe('void');
  });

  it('credit and debit notes move the balance; a credit above the line is refused', async () => {
    const inv = await invoiceOf(ids.invOct2);
    const elec = line(inv.lines, 'electricity');
    await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/credit-notes`)
      .set(bearer(owner))
      .set(idem())
      .send({
        reason: 'reading_correction',
        reasonText: 'อ่านมิเตอร์เกิน',
        lines: [{ refInvoiceLineId: elec.id, description: 'แก้ไขค่าไฟ', amount: '1900.00' }],
      })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('invoice.credit_exceeds'));
    const credited = await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/credit-notes`)
      .set(bearer(owner))
      .set(idem())
      .send({
        reason: 'reading_correction',
        reasonText: 'อ่านมิเตอร์เกิน 10 หน่วย',
        lines: [{ refInvoiceLineId: elec.id, description: 'แก้ไขค่าไฟ 10 หน่วย', amount: '90.00' }],
      })
      .expect(201);
    expect(credited.body).toMatchObject({
      creditedTotal: '90.00',
      balance: '6726.00',
      status: 'partially_paid',
    });
    expect(credited.body.creditNotes[0]).toMatchObject({ number: 'CRN-2026-00001', total: '90.00' });
    const debited = await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/debit-notes`)
      .set(bearer(owner))
      .set(idem())
      .send({
        reason: 'other',
        reasonText: 'ค่าทำกุญแจที่ตกลงไว้',
        lines: [{ lineKind: 'one_off', description: 'ค่าทำกุญแจสำรอง', amount: '10.00' }],
      })
      .expect(201);
    expect(debited.body).toMatchObject({ debitedTotal: '10.00', balance: '6736.00' });
    expect(debited.body.debitNotes[0].number).toBe('DBN-2026-00001');
    // notes are final too, and an invoice with notes is corrected by notes, never voided (D-040)
    await expect(
      db.admin.query(`UPDATE ops.credit_note SET total = 1 WHERE invoice_id = $1`, [ids.invOct2]),
    ).rejects.toThrow(/compliance.invoice_immutable/);
    await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/actions/void`)
      .set(bearer(owner))
      .set(idem())
      .send({ reason: 'ยกเลิก' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('invoice.has_payments'));
  });

  it('November by the worker: a queued one-off, the unpaid October as prior balance (renewal fee refused)', async () => {
    await t.http
      .post('/v1/owner/invoice-charges')
      .set(bearer(owner))
      .set(idem())
      .send({ unitId: ids.unitA101, lineKind: 'one_off', description: 'ค่าต่อสัญญา', unitPrice: '500.00' })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('compliance.no_renewal_fee'));
    const charge = await t.http
      .post('/v1/owner/invoice-charges')
      .set(bearer(owner))
      .set(idem())
      .send({
        unitId: ids.unitA101,
        lineKind: 'one_off',
        description: 'ค่าทำกุญแจสำรอง',
        unitPrice: '150.00',
      })
      .expect(201);
    expect(charge.body).toMatchObject({ status: 'pending', amount: '150.00', partyId: DEV.residentPartyId });
    ids.charge = charge.body.id;

    await reading('electric', '450.000', '2026-11-30T20:00:00+07:00');
    await reading('water', '20.000', '2026-11-30T20:00:00+07:00');
    await at('2026-12-01T03:00:00Z');
    await t.app.get(BillingCyclesService).sweep();
    const cycles = await t.http
      .get('/v1/owner/billing-cycles?status=computed')
      .set(bearer(owner))
      .expect(200);
    const nov = (cycles.body.data as { id: string; periodKey: string }[]).find(
      (c) => c.periodKey === '2026-11',
    )!;
    expect(nov).toBeDefined();
    const cycle = await t.http.get(`/v1/owner/billing-cycles/${nov.id}`).set(bearer(owner)).expect(200);
    const draft = await invoiceOf(cycle.body.invoices[0].id);
    // 150 kWh × 3 = 450 (below the cap), 8 m³ × 18 = 144, the key 150
    expect(line(draft.lines, 'electricity')).toMatchObject({
      amount: '450.00',
      aboveCap: false,
      registerFrom: '300.000',
    });
    expect(line(draft.lines, 'water')).toMatchObject({ amount: '144.00', registerFrom: '12.000' });
    expect(line(draft.lines, 'one_off')).toMatchObject({ amount: '150.00' });
    expect(draft.total).toBe('5544.00');
    const issued = await t.http
      .post(`/v1/owner/billing-cycles/${nov.id}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({})
      .expect(200);
    expect(issued.body.skipped).toEqual([]);
    const inv = await invoiceOf(draft.id);
    ids.invNov = inv.id;
    expect(inv).toMatchObject({
      number: 'INV-2026-00003',
      total: '5544.00',
      priorBalance: '6736.00', // INV-2026-00002 after its notes (the void one never counts)
      amountDue: '12280.00',
    });
    const charges = await t.http
      .get(`/v1/owner/invoice-charges?unitId=${ids.unitA101}`)
      .set(bearer(owner))
      .expect(200);
    expect(charges.body[0]).toMatchObject({ id: ids.charge, status: 'applied' });
  });

  it('move-out: the final invoice applies the advance rent and feeds the deposit settlement', async () => {
    await at('2026-12-10T03:00:00Z');
    await reading('electric', '480.000', '2026-12-10T09:00:00+07:00');
    await reading('water', '22.000', '2026-12-10T09:00:00+07:00');
    await t.http
      .post(`/v1/owner/leases/${DEV.leaseId}/actions/begin-move-out`)
      .set(bearer(owner))
      .expect(200);
    await t.http
      .post(`/v1/owner/leases/${DEV.leaseId}/actions/complete-move-out`)
      .set(bearer(owner))
      .set(idem())
      .send({})
      .expect(200);
    const finals = await t.http
      .get(`/v1/owner/invoices?leaseId=${DEV.leaseId}&status=draft`)
      .set(bearer(owner))
      .expect(200);
    expect(finals.body.data).toHaveLength(1);
    const draft = await invoiceOf(finals.body.data[0].id);
    expect(draft).toMatchObject({ isFinal: true, periodStart: '2026-12-01', periodEnd: '2026-12-10' });
    // rent 4,500 × 10/31, internet 300 × 10/31, 30 kWh × 3, 2 m³ × 18 → 1,674.38, all covered by the advance rent
    expect(line(draft.lines, 'rent').amount).toBe('1451.61');
    expect(line(draft.lines, 'internet').amount).toBe('96.77');
    expect(line(draft.lines, 'electricity').amount).toBe('90.00');
    expect(line(draft.lines, 'water').amount).toBe('36.00');
    expect(line(draft.lines, 'deposit_offset').amount).toBe('-1674.38');
    expect(draft.total).toBe('0.00');
    const issued = await t.http
      .post(`/v1/owner/invoices/${draft.id}/actions/issue`)
      .set(bearer(owner))
      .set(idem())
      .send({})
      .expect(200);
    expect(issued.body.number).toBe('INV-2026-00004');
    const deposit = (
      await t.http.get(`/v1/owner/deposits?leaseId=${DEV.leaseId}`).set(bearer(owner)).expect(200)
    ).body.data[0];
    expect(deposit.settlement).toMatchObject({ advanceRentUnused: '2825.62', utilitiesFinal: '0.00' });
    const link = await q<{ final_invoice_id: string }>(
      'SELECT final_invoice_id FROM ops.deposit_settlement WHERE id = $1',
      [deposit.settlement.id],
    );
    expect(link[0]!.final_invoice_id).toBe(draft.id);
  });

  it('compliance score counts invoices within the rate and acknowledged above-cap lines', async () => {
    const score = await t.app.get(ComplianceScoreService).compute(DEV.tenantId, '2026-11');
    const parts = Object.fromEntries(
      (
        score.details as { components: { key: string; numerator: number; denominator: number }[] }
      ).components.map((c) => [c.key, c]),
    );
    // November issued INV-1 (void), INV-2 (both above the cap, acknowledged) — none within the rate
    expect(parts.invoices_within_rate).toMatchObject({ numerator: 0, denominator: 2 });
    expect(parts.above_cap_acknowledged).toMatchObject({ numerator: 4, denominator: 4 });
  });

  it('another tenant gets 404 on my plans, cycles, invoices and charges; RLS hides the rows', async () => {
    const B = bearer(await operatorToken(t, '+660000000142'));
    await t.http.get(`/v1/owner/rate-plans/${ids.powerPlan}`).set(B).expect(404);
    await t.http
      .post(`/v1/owner/rate-plans/${ids.powerPlan}/versions`)
      .set(B)
      .send({
        basis: 'per_unit',
        tiers: { kind: 'flat', pricePerUnit: '1.0000' },
      })
      .expect(404);
    await t.http.get(`/v1/owner/billing-cycles/${ids.cycleOct}`).set(B).expect(404);
    await t.http.post(`/v1/owner/billing-cycles/${ids.cycleOct}/actions/compute`).set(B).expect(404);
    await t.http.get(`/v1/owner/invoices/${ids.invOct2}`).set(B).expect(404);
    await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/credit-notes`)
      .set(B)
      .set(idem())
      .send({ reason: 'other', reasonText: 'xxx', lines: [{ description: 'x', amount: '1.00' }] })
      .expect(404);
    await t.http
      .post(`/v1/owner/invoices/${ids.invOct2}/actions/void`)
      .set(B)
      .set(idem())
      .send({ reason: 'xxx' })
      .expect(404);
    await t.http
      .post(`/v1/owner/invoice-charges/${ids.charge}/actions/cancel`)
      .set(B)
      .send({ reason: 'xxx' })
      .expect(404);
    expect((await t.http.get('/v1/owner/invoices').set(B).expect(200)).body.data).toEqual([]);
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of [
      'ops.invoice',
      'ops.invoice_line',
      'ops.billing_cycle',
      'ops.rate_plan',
      'ops.rate_plan_version',
      'ops.credit_note',
      'ops.debit_note',
      'ops.invoice_charge',
    ]) {
      expect(await count(other.tenantId, table)).toBe(0);
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
    }
  });
});
