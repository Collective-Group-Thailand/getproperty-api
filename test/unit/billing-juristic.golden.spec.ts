import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeInvoiceDraft,
  type DraftInput,
  type DraftResult,
} from '@modules/ops-billing/engine/invoice-draft';
import { allocateByOwnership, type OwnershipRow } from '@modules/ops-billing/engine/ownership-shares';
import { chargeFor, type RateVersionLike, validateRateVersion } from '@modules/ops-billing/engine/rate-tiers';
import { monthlySchedule } from '@modules/ops-billing/engine/revenue-schedule';
import {
  calendarPeriod,
  frequencyOfKey,
  MONTHS_OF,
  PERIOD_KEY_PATTERN,
  periodKeyFor,
} from '@modules/smart-readings/cutoff';
import Decimal from 'decimal.js';

/**
 * J1.1a golden cases (D-303 = D-J02, D-307 = D-J06, D-323): co-owners billed by their share with the satang remainder on
 * the largest share, an ownership transfer inside an annual cycle prorated by calendar days between seller and buyer,
 * a condominium billed semiannually by ownership ratio of an annual budget, and a quarterly common fee beside the
 * monthly rent of the same property. Each case keeps its output in `test/golden/billing/<case>.json` (UPDATE_GOLDEN=1
 * rewrites after a reviewed change) **and** hand-computed assertions, so a golden file never just agrees with itself.
 */
const DIR = join(__dirname, '..', 'golden', 'billing');

function golden(name: string, result: unknown): void {
  const file = join(DIR, `${name}.json`);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

const sqm = (id: string, price: string): RateVersionLike => ({
  id,
  effectiveFrom: '2026-01-01',
  tiers: { kind: 'flat', pricePerUnit: price },
  basis: 'per_sqm',
  minimumCharge: null,
});

const VAT_NONE = { registered: false, rate: '0.07', applicableKinds: [] };

/** An owner's draft: no lease, no meters, the unit's common-fee plans, all ownership rows of the unit. */
function ownerDraft(input: {
  period: { start: string; end: string };
  months: number;
  unit: Partial<DraftInput['unit']>;
  plans: DraftInput['unitRatePlans'];
  partyId: string;
  rows: OwnershipRow[];
}): DraftResult {
  return computeInvoiceDraft({
    period: input.period,
    mode: 'cycle',
    unit: {
      id: 'unit-1',
      unitNo: 'A-1204',
      type: 'condo_unit',
      areaSqm: null,
      ownershipRatio: null,
      ...input.unit,
    },
    occupancy: { from: input.period.start, to: input.period.end },
    lease: null,
    meters: [],
    unitRatePlans: input.plans,
    charges: [],
    estimateSettlements: [],
    advanceRent: null,
    vat: VAT_NONE,
    ownership: { partyId: input.partyId, rows: input.rows },
    cycleMonths: input.months,
  });
}

const NOV = { start: '2026-11-01', end: '2026-11-30' };
const total = (...drafts: DraftResult[]) =>
  drafts.reduce((s, d) => s.plus(d.total), new Decimal(0)).toFixed(2);

describe('billing engine — juristic golden cases (J1.1a)', () => {
  it('two co-owners 60/40: each billed their share, Σ = the unit amount (1,234.34)', () => {
    const rows: OwnershipRow[] = [
      { partyId: 'party-a', sharePct: '60.0000', from: '2024-01-01', to: null },
      { partyId: 'party-b', sharePct: '40.0000', from: '2024-01-01', to: null },
    ];
    const common = {
      period: NOV,
      months: 1,
      unit: { areaSqm: '34.77' },
      plans: [{ kind: 'common_fee' as const, name: 'ค่าส่วนกลาง', version: sqm('rpv-cf', '35.50') }],
      rows,
    };
    const a = ownerDraft({ ...common, partyId: 'party-a' });
    const b = ownerDraft({ ...common, partyId: 'party-b' });
    // 34.77 m² × 35.50 = 1,234.335 → 1,234.34; 60 % = 740.604 → 740.60; 40 % = 493.736 → 493.74
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]!.amount).toBe('740.60');
    expect(b.lines[0]!.amount).toBe('493.74');
    expect(total(a, b)).toBe('1234.34');
    expect(a.lines[0]!.description).toBe('ค่าส่วนกลาง (ส่วนกรรมสิทธิ์ 60%)');
    expect(a.lines[0]!.tierBreakdown!.at(-1)).toEqual({
      label: 'ownership_share',
      units: '60.0000',
      pricePerUnit: null,
      amount: '740.60',
    });
    expect(a.reviewFlags).toEqual([]);
    golden('co-owners-60-40', { a, b });
  });

  it('three co-owners 33.3333/33.3333/33.3334: the satang remainder goes to the largest share', () => {
    const rows: OwnershipRow[] = [
      { partyId: 'party-c', sharePct: '33.3334', from: '2024-01-01', to: null },
      { partyId: 'party-a', sharePct: '33.3333', from: '2024-01-01', to: null },
      { partyId: 'party-b', sharePct: '33.3333', from: '2024-01-01', to: null },
    ];
    const common = {
      period: NOV,
      months: 1,
      unit: { areaSqm: '34.77' },
      plans: [{ kind: 'common_fee' as const, name: 'ค่าส่วนกลาง', version: sqm('rpv-cf', '35.50') }],
      rows,
    };
    const [a, b, c] = ['party-a', 'party-b', 'party-c'].map((partyId) => ownerDraft({ ...common, partyId }));
    // half-up: 411.4462 → 411.45, 411.4475 → 411.45 → Σ 1,234.35 = 1 satang too much → off the largest share (c)
    expect(a!.total).toBe('411.45');
    expect(b!.total).toBe('411.45');
    expect(c!.total).toBe('411.44');
    expect(total(a!, b!, c!)).toBe('1234.34');
    golden('co-owners-three-way-remainder', { a, b, c });
  });

  it('transfer on 15 March inside an annual cycle: seller 73/365, buyer 292/365, never both full', () => {
    const YEAR = { start: '2027-01-01', end: '2027-12-31' };
    const rows: OwnershipRow[] = [
      { partyId: 'party-seller', sharePct: '100.0000', from: '2020-05-01', to: '2027-03-15' },
      { partyId: 'party-buyer', sharePct: '100.0000', from: '2027-03-15', to: null },
    ];
    const common = {
      period: YEAR,
      months: 12,
      unit: { areaSqm: '45.50' },
      plans: [{ kind: 'common_fee' as const, name: 'ค่าส่วนกลาง', version: sqm('rpv-cf', '30.00') }],
      rows,
    };
    const seller = ownerDraft({ ...common, partyId: 'party-seller' });
    const buyer = ownerDraft({ ...common, partyId: 'party-buyer' });
    // 45.50 m² × 30.00 = 1,365.00 a month → 16,380.00 a year; 1 Jan – 14 Mar = 73 days, 15 Mar – 31 Dec = 292 days
    expect(seller.lines[0]).toMatchObject({
      amount: '3276.00',
      periodFrom: '2027-01-01',
      periodTo: '2027-03-14',
      description: 'ค่าส่วนกลาง (73/365 วัน)',
    });
    expect(seller.lines[0]!.proRata).toMatchObject({ days: 73, daysInPeriod: 365 });
    expect(buyer.lines[0]).toMatchObject({
      amount: '13104.00',
      periodFrom: '2027-03-15',
      periodTo: '2027-12-31',
    });
    expect(total(seller, buyer)).toBe('16380.00');
    golden('transfer-15-march-annual', { seller, buyer });
  });

  it('condominium by ownership ratio of an annual budget, billed semiannually (2027-H1, 6 months)', () => {
    const H1 = { start: '2027-01-01', end: '2027-06-30' };
    const budget: RateVersionLike = {
      id: 'rpv-cf-2027',
      effectiveFrom: '2027-01-01',
      tiers: { kind: 'budget', amount: '12000000.00', period: 'year' },
      basis: 'per_ownership_ratio',
      minimumCharge: null,
    };
    const register = [
      ['A-1204', '0.003215'],
      ['A-1205', '0.003215'],
      ['B-0101', '0.250000'],
      ['B-0102', '0.250000'],
      ['C-0001', '0.243570'],
      ['C-0002', '0.250000'],
    ] as const;
    const drafts = register.map(([unitNo, ratio]) =>
      ownerDraft({
        period: H1,
        months: 6,
        unit: { unitNo, ownershipRatio: ratio },
        plans: [{ kind: 'common_fee', name: 'ค่าส่วนกลาง', version: budget }],
        partyId: `owner-${unitNo}`,
        rows: [{ partyId: `owner-${unitNo}`, sharePct: '100.0000', from: '2020-01-01', to: null }],
      }),
    );
    // 0.003215 × 12,000,000 ÷ 12 × 6 = 19,290.00; the register sums to 1 → the half-year budget 6,000,000.00
    expect(drafts[0]!.lines[0]).toMatchObject({
      amount: '19290.00',
      quantity: '0.003',
      periodFrom: '2027-01-01',
      periodTo: '2027-06-30',
      description: 'ค่าส่วนกลาง',
    });
    expect(total(...drafts)).toBe('6000000.00');
    golden('condo-ratio-semiannual', drafts[0]);
  });

  it('mixed property: a quarterly common fee of the owner beside the unchanged monthly rent of the lessee', () => {
    const Q1 = { start: '2027-01-01', end: '2027-03-31' };
    const owner = ownerDraft({
      period: Q1,
      months: 3,
      unit: { unitNo: 'S-01', type: 'shop', ownershipRatio: '0.012345' },
      plans: [
        {
          kind: 'common_fee',
          name: 'ค่าส่วนกลาง',
          version: {
            id: 'rpv-cf',
            effectiveFrom: '2026-01-01',
            tiers: { kind: 'budget', amount: '100000.00' },
            basis: 'per_ownership_ratio',
            minimumCharge: null,
          },
        },
      ],
      partyId: 'owner-s01',
      rows: [{ partyId: 'owner-s01', sharePct: '100.0000', from: '2020-01-01', to: null }],
    });
    const JAN = { start: '2027-01-01', end: '2027-01-31' };
    const rent = computeInvoiceDraft({
      period: JAN,
      mode: 'cycle',
      unit: { id: 'unit-r1', unitNo: 'R-101', type: 'room', areaSqm: '24.00', ownershipRatio: null },
      occupancy: { from: JAN.start, to: JAN.end },
      lease: {
        id: 'lease-r1',
        number: 'CTR-2027-00001',
        startDate: '2026-06-01',
        endDate: '2027-05-31',
        rent: '4500.00',
        rentChanges: [],
        utilityBillingMode: 'included',
        lines: [],
      },
      meters: [],
      unitRatePlans: [],
      charges: [],
      estimateSettlements: [],
      advanceRent: null,
      vat: VAT_NONE,
    });
    // 0.012345 × 100,000.00 a month × 3 months = 3,703.50 for the quarter (90 days)
    expect(owner.lines[0]).toMatchObject({
      amount: '3703.50',
      periodFrom: '2027-01-01',
      periodTo: '2027-03-31',
    });
    expect(owner.lines[0]!.proRata).toMatchObject({ days: 90, daysInPeriod: 90 });
    expect(rent.total).toBe('4500.00');
    golden('mixed-quarterly-common-fee', { owner, rent });
  });
});

describe('ownership shares, budget periods and the revenue schedule (J1.1a)', () => {
  it('Σ of the slices is the period amount whatever the shares and dates; gaps are not billed', () => {
    const period = { start: '2027-01-01', end: '2027-12-31' };
    const r = allocateByOwnership('16380.01', period, [
      { partyId: 'x', sharePct: '50.0000', from: '2020-01-01', to: '2027-02-10' },
      { partyId: 'y', sharePct: '50.0000', from: '2020-01-01', to: null },
      { partyId: 'z', sharePct: '50.0000', from: '2027-02-10', to: null },
    ]);
    expect(r.incomplete).toBe(false);
    const sum = r.slices.reduce((s, x) => s.plus(x.amount), new Decimal(0));
    expect(sum.toFixed(2)).toBe('16380.01');
    // y owns half all year in one merged slice
    expect(r.slices.filter((s) => s.partyId === 'y')).toHaveLength(1);
    const gap = allocateByOwnership('100.00', { start: '2027-01-01', end: '2027-01-31' }, [
      { partyId: 'x', sharePct: '100.0000', from: '2027-01-11', to: null },
    ]);
    expect(gap.slices).toEqual([
      expect.objectContaining({
        partyId: 'x',
        from: '2027-01-11',
        to: '2027-01-31',
        days: 21,
        amount: '67.74',
      }),
    ]);
  });

  it('ties on the largest share go to the first party id; shares below 100 % are flagged, never scaled up', () => {
    const tie = allocateByOwnership('0.01', { start: '2027-01-01', end: '2027-01-31' }, [
      { partyId: 'b', sharePct: '50.0000', from: '2020-01-01', to: null },
      { partyId: 'a', sharePct: '50.0000', from: '2020-01-01', to: null },
    ]);
    // half-up: 0.005 → 0.01 each = 0.02 → −0.01 off the first of the tied largest shares (a)
    expect(Object.fromEntries(tie.slices.map((s) => [s.partyId, s.amount]))).toEqual({
      a: '0.00',
      b: '0.01',
    });
    const partial = allocateByOwnership('1000.00', { start: '2027-01-01', end: '2027-01-31' }, [
      { partyId: 'a', sharePct: '60.0000', from: '2020-01-01', to: null },
    ]);
    expect(partial.incomplete).toBe(true);
    expect(partial.slices[0]!.amount).toBe('600.00');
  });

  it('an ownership that ended on the first day of the period (valid_to exclusive) bills nothing', () => {
    const r = allocateByOwnership('100.00', { start: '2027-01-01', end: '2027-01-31' }, [
      { partyId: 'old', sharePct: '100.0000', from: '2020-01-01', to: '2027-01-01' },
      { partyId: 'new', sharePct: '100.0000', from: '2027-01-01', to: null },
    ]);
    expect(r.slices.map((s) => [s.partyId, s.amount])).toEqual([['new', '100.00']]);
  });

  it('budget tiers: period year = amount ÷ 12 a month; month (default) unchanged', () => {
    const v = (period?: 'month' | 'year') => ({
      tiers: { kind: 'budget' as const, amount: '1200000.00', ...(period ? { period } : {}) },
      basis: 'per_ownership_ratio' as const,
      minimumCharge: null,
    });
    expect(chargeFor(v('year'), { ownershipRatio: '0.010000' }).amount).toBe('1000.00');
    expect(chargeFor(v(), { ownershipRatio: '0.010000' }).amount).toBe('12000.00');
    expect(validateRateVersion('common_fee', 'per_ownership_ratio', v('year').tiers, null)).toEqual([]);
    expect(
      validateRateVersion(
        'common_fee',
        'per_ownership_ratio',
        { kind: 'budget', amount: '1.00', period: 'week' },
        null,
      ),
    ).toEqual([{ path: 'tiers.period', message: 'month | year' }]);
  });

  it('revenue schedule: one row per calendar month by days, Σ = the line amount', () => {
    const rows = monthlySchedule('13104.00', '2027-03-15', '2027-12-31');
    expect(rows[0]).toEqual({ month: '2027-03-01', amount: '762.90' });
    expect(rows).toHaveLength(10);
    expect(rows.reduce((s, r) => s.plus(r.amount), new Decimal(0)).toFixed(2)).toBe('13104.00');
    const year = monthlySchedule('16380.00', '2027-01-01', '2027-12-31');
    expect(year.map((r) => r.month)).toEqual([
      '2027-01-01',
      '2027-02-01',
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
    expect(year.reduce((s, r) => s.plus(r.amount), new Decimal(0)).toFixed(2)).toBe('16380.00');
    expect(monthlySchedule('-5.00', '2027-01-01', '2027-03-31').at(-1)!.amount).toBe('-1.72');
  });
});

describe('period keys per frequency (J1.1a, D-303)', () => {
  it('parses the four formats and refuses others', () => {
    expect(
      ['2027-01', '2027-Q1', '2027-H2', '2027', '2027-13', '2027-Q5', '2027-H3', '27'].map(frequencyOfKey),
    ).toEqual(['monthly', 'quarterly', 'semiannual', 'annual', null, null, null, null]);
    expect(['2027-12', '2027-Q4', '2027-H1', '2027'].every((k) => PERIOD_KEY_PATTERN.test(k))).toBe(true);
    expect(['2027-00', '2027-Q0', '2027-H0', '2027-'].some((k) => PERIOD_KEY_PATTERN.test(k))).toBe(false);
  });

  it('calendar-aligned bounds and the key of a date', () => {
    expect(calendarPeriod('2027-Q1')).toEqual({
      start: '2027-01-01',
      end: '2027-03-31',
      frequency: 'quarterly',
    });
    expect(calendarPeriod('2028-Q1').end).toBe('2028-03-31');
    expect(calendarPeriod('2027-Q4')).toMatchObject({ start: '2027-10-01', end: '2027-12-31' });
    expect(calendarPeriod('2027-H1')).toMatchObject({ start: '2027-01-01', end: '2027-06-30' });
    expect(calendarPeriod('2027-H2')).toMatchObject({ start: '2027-07-01', end: '2027-12-31' });
    expect(calendarPeriod('2028')).toMatchObject({ start: '2028-01-01', end: '2028-12-31' });
    expect(periodKeyFor('quarterly', '2027-05-15')).toBe('2027-Q2');
    expect(periodKeyFor('semiannual', '2027-07-01')).toBe('2027-H2');
    expect(periodKeyFor('annual', '2027-03-15')).toBe('2027');
    expect(MONTHS_OF.semiannual).toBe(6);
    expect(() => calendarPeriod('2027-01')).toThrow();
  });
});
