import { NOTIFICATION_TEMPLATES } from '../../../../prisma/seed/data/notifications';
import { closingOf, monthBounds } from '../statements.service';
import { agingBounds, juristicAging, monthsBetween, ratePct } from './juristic-aging';
import {
  approvalForced,
  gateClosedReason,
  type GateSettings,
  LADDER_TEMPLATES,
  legalFormOf,
  legalReviewRequired,
  stepDueOn,
} from './ladder-templates';
import { computeSurcharge } from './surcharge';

const CLOSED: GateSettings = {
  surchargeEnabled: false,
  surchargeRateCap: null,
  lettersTemplateVersion: null,
  suspendEnabled: false,
  suspendMinOverdueDays: null,
  legalActionEnabled: false,
};

describe('collections ladder templates (D-305, D-326)', () => {
  it('statutory forms carry every step; voluntary / lease forms only reminders and a letter', () => {
    expect(LADDER_TEMPLATES.condo_act.steps.map((s) => [s.offsetDays, s.action])).toEqual([
      [3, 'remind'],
      [15, 'remind'],
      [30, 'surcharge'],
      [45, 'notice_letter'],
      [60, 'remind'],
      [90, 'lawyer_letter'],
      [180, 'suspend_services'],
      [365, 'legal_action'],
    ]);
    expect(LADDER_TEMPLATES.voluntary.steps.map((s) => s.action)).toEqual([
      'remind',
      'remind',
      'notice_letter',
      'remind',
    ]);
  });

  it('only reminders start enabled; legal measures are flagged and suspension / lawyer / legal action need approval', () => {
    for (const t of Object.values(LADDER_TEMPLATES))
      for (const s of t.steps) {
        expect(s.enabled).toBe(s.action === 'remind');
        expect(legalReviewRequired(s.action)).toBe(s.action !== 'remind');
        expect(s.requiresApproval).toBe(approvalForced(s.action));
        expect(s.seq).toBe(t.steps.indexOf(s) + 1);
      }
    expect(
      approvalForced('suspend_services') && approvalForced('lawyer_letter') && approvalForced('legal_action'),
    ).toBe(true);
    expect(approvalForced('surcharge')).toBe(false);
  });

  it('every gate is closed by default (O-038) and opens only with its settings', () => {
    expect(gateClosedReason('remind', CLOSED)).toBeNull();
    expect(gateClosedReason('surcharge', CLOSED)).toBe('surcharge_disabled');
    expect(gateClosedReason('surcharge', { ...CLOSED, surchargeEnabled: true })).toBe('surcharge_cap_unset');
    expect(
      gateClosedReason('surcharge', { ...CLOSED, surchargeEnabled: true, surchargeRateCap: '12' }),
    ).toBeNull();
    expect(gateClosedReason('notice_letter', CLOSED)).toBe('letter_wording_unverified');
    expect(gateClosedReason('lawyer_letter', { ...CLOSED, lettersTemplateVersion: 'v1' })).toBeNull();
    expect(gateClosedReason('suspend_services', { ...CLOSED, suspendEnabled: true })).toBe(
      'suspend_services_min_days_unset',
    );
    expect(gateClosedReason('legal_action', CLOSED)).toBe('legal_action_disabled');
  });

  it('a step falls due at anchor + offset + days paused; a stub condo reads as condo_act', () => {
    expect(stepDueOn('2027-01-05', 3, 0)).toBe('2027-01-08');
    expect(stepDueOn('2027-01-05', 30, 10)).toBe('2027-02-14');
    expect(stepDueOn('2027-12-31', 1, 0)).toBe('2028-01-01');
    expect(legalFormOf({ legalForm: null, type: 'condo' })).toBe('condo_act');
    expect(legalFormOf({ legalForm: null, type: 'house_cluster' })).toBe('voluntary');
    expect(legalFormOf({ legalForm: 'land_allocation_act', type: 'house_cluster' })).toBe(
      'land_allocation_act',
    );
  });
});

describe('surcharge (D-305, ⚖ O-038)', () => {
  it('simple interest by days on the principal, rate capped, half-up per invoice', () => {
    // 10,000.00 × 12 % × 31 / 365 = 101.917… → 101.92
    const r = computeSurcharge(
      [{ invoiceId: 'a', dueOn: '2027-01-05', principal: '10000.00' }],
      { ratePct: '15', capPct: '12' },
      '2027-02-05',
      null,
    );
    expect(r.total).toBe('101.92');
    expect(r.parts[0]).toMatchObject({ days: 31, escalatedDays: 0, from: '2027-01-05', to: '2027-02-05' });
  });

  it('counts only the days since the case was last surcharged (never twice)', () => {
    const r = computeSurcharge(
      [{ invoiceId: 'a', dueOn: '2027-01-05', principal: '10000.00' }],
      { ratePct: '12', capPct: '12' },
      '2027-03-07',
      '2027-02-05',
    );
    // 30 days → 98.630… → 98.63
    expect(r.total).toBe('98.63');
    expect(
      computeSurcharge(
        [{ invoiceId: 'a', dueOn: '2027-01-05', principal: '1' }],
        { ratePct: '12', capPct: '12' },
        '2027-02-05',
        '2027-02-05',
      ).total,
    ).toBe('0.00');
  });

  it('escalates after the configured days, capped by the escalated cap', () => {
    const r = computeSurcharge(
      [{ invoiceId: 'a', dueOn: '2027-01-01', principal: '3650.00' }],
      { ratePct: '12', capPct: '12', escalatedRatePct: '24', escalatedCapPct: '20', escalateAfterDays: 10 },
      '2027-01-21',
      null,
    );
    // 10 days × 12 % + 10 days × 20 % on 3,650 = 3650 × (1.2 + 2.0) / 100 / 365 × ... = 12.00 + 20.00
    expect(r.parts[0]).toMatchObject({ days: 20, escalatedDays: 10 });
    expect(r.total).toBe('32.00');
  });

  it('sums the rounded parts of several invoices and skips paid or not yet due ones', () => {
    const r = computeSurcharge(
      [
        { invoiceId: 'a', dueOn: '2027-01-05', principal: '4500.00' },
        { invoiceId: 'b', dueOn: '2027-01-05', principal: '4500.00' },
        { invoiceId: 'c', dueOn: '2027-03-01', principal: '4500.00' },
        { invoiceId: 'd', dueOn: '2027-01-05', principal: '0.00' },
      ],
      { ratePct: '12', capPct: '12' },
      '2027-02-04',
      null,
    );
    // 4500 × 12 % × 30 / 365 = 44.383… → 44.38 each
    expect(r.parts.map((p) => p.amount)).toEqual(['44.38', '44.38']);
    expect(r.total).toBe('88.76');
  });
});

describe('juristic aging and KPI (D-326)', () => {
  it('buckets 0–30 · 31–90 · 91–365 · > 365 days past due, plus not yet due', () => {
    const r = juristicAging(
      [
        { balance: '100.00', dueOn: '2027-01-20', account: 'p1:u1' },
        { balance: '200.00', dueOn: '2027-01-09', account: 'p1:u1' },
        { balance: '300.00', dueOn: '2026-12-11', account: 'p2:u2' },
        { balance: '400.00', dueOn: '2026-12-10', account: 'p2:u2' },
        { balance: '500.00', dueOn: '2025-01-10', account: 'p3:u3' },
        { balance: '600.00', dueOn: '2026-01-09', account: 'p4:u4' },
        { balance: '0.00', dueOn: '2020-01-01', account: 'p5:u5' },
      ],
      agingBounds([30, 90, 365]),
      '2027-01-10',
    );
    expect(r.notDue).toEqual({ invoices: 1, accounts: 1, amount: '100.00' });
    expect(r.buckets.map((b) => [b.key, b.invoices, b.accounts, b.amount])).toEqual([
      ['0-30', 2, 2, '500.00'],
      ['31-90', 1, 1, '400.00'],
      ['91-365', 0, 0, '0.00'],
      ['>365', 2, 2, '1100.00'],
    ]);
    expect(r.overdue).toEqual({ invoices: 5, accounts: 4, amount: '2000.00' });
  });

  it('a bad bucket setting falls back to the default; rates are percent with 2 dp', () => {
    expect(agingBounds('x')).toEqual([30, 90, 365]);
    expect(agingBounds([90, 30])).toEqual([30, 90]);
    expect(ratePct('1100000.00', '1234567.89')).toBe('89.10');
    expect(ratePct('1', '0')).toBeNull();
    expect(monthsBetween('2026-11-05', '2027-02-04')).toBe(2);
    expect(monthsBetween('2026-11-05', '2027-02-05')).toBe(3);
  });
});

describe('owner statements (D-307, D-326)', () => {
  it('closing = opening + charges − credits − payments; month bounds', () => {
    expect(
      closingOf({ opening: '1000.00', charges: '9000.00', credits: '500.00', payments: '4500.00' }),
    ).toBe('5000.00');
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('resident templates of pack J never call the resident ลูกหนี้ (PDPA tone) and say ยอดที่ต้องชำระ', () => {
    const keys = [
      'juristic.statement.ready',
      'juristic.collection.reminder',
      'juristic.collection.surcharge_added',
      'juristic.collection.notice_letter',
      'juristic.collection.lawyer_letter',
      'juristic.collection.services_suspended',
      'juristic.collection.dispute_opened',
      'juristic.collection.dispute_closed',
    ];
    const resident = NOTIFICATION_TEMPLATES.filter((t) => t.audience === 'resident');
    for (const key of keys) {
      const ts = resident.filter((t) => t.key === key);
      expect(ts.map((t) => t.channel).sort()).toEqual(['email', 'line', 'sms']);
      for (const t of ts)
        for (const v of t.versions) expect(`${v.subject ?? ''} ${v.body}`).not.toContain('ลูกหนี้');
    }
    for (const t of resident) for (const v of t.versions) expect(v.body).not.toContain('ลูกหนี้');
    const reminder = resident.find((t) => t.key === 'juristic.collection.reminder' && t.channel === 'line')!;
    expect(reminder.versions.find((v) => v.language === 'th')!.body).toContain('ยอดที่ต้องชำระ');
  });
});
