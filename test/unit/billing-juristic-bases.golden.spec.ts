import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  amountFromDate,
  moneyStats,
  periodBudget,
  splitBudget,
  splitByShares,
  type SplitUnit,
} from '@modules/ops-billing/engine/budget-split';
import { computeInvoiceDraft, type DraftResult } from '@modules/ops-billing/engine/invoice-draft';
import { chargeFor, type RateVersionLike, validateRateVersion } from '@modules/ops-billing/engine/rate-tiers';
import Decimal from 'decimal.js';

/**
 * J1.1b golden cases (D-302, D-304, D-324): the charge bases `per_sqwa` (land area of a housing-estate plot) and
 * `budget_split` (a budget divided over the units by ratio / m² / ตร.วา / per unit with an exact sum, the satang
 * remainder on the largest weight, ties on the first unit id), and the transfer proration of an issued line. Outputs
 * are kept in `test/golden/billing/<case>.json` (UPDATE_GOLDEN=1 rewrites after review) next to hand-computed
 * assertions.
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

const VAT_NONE = { registered: false, rate: '0.07', applicableKinds: [] };
const YEAR = { start: '2027-01-01', end: '2027-12-31' };
const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).toFixed(2);

/** 248 plots of a housing estate (หมู่บ้านจัดสรร): land 50.00–110.99 ตร.วา, deterministic. */
const PLOTS = Array.from({ length: 248 }, (_, i) => {
  const n = i + 1;
  return {
    unitId: `plot-${String(n).padStart(3, '0')}`,
    unitNo: `${n}/248`,
    landAreaSqwa: new Decimal(50 + ((n * 37) % 61)).plus(((n * 13) % 100) / 100).toFixed(2),
  };
});

const sqwa = (price: string): RateVersionLike => ({
  id: 'rpv-village-2027',
  effectiveFrom: '2027-01-01',
  tiers: { kind: 'flat', pricePerUnit: price },
  basis: 'per_sqwa',
  minimumCharge: null,
});

function plotDraft(plot: (typeof PLOTS)[number]): DraftResult {
  return computeInvoiceDraft({
    period: YEAR,
    mode: 'cycle',
    unit: {
      id: plot.unitId,
      unitNo: plot.unitNo,
      type: 'plot',
      areaSqm: null,
      ownershipRatio: null,
      landAreaSqwa: plot.landAreaSqwa,
    },
    occupancy: { from: YEAR.start, to: YEAR.end },
    lease: null,
    meters: [],
    unitRatePlans: [{ kind: 'common_fee', name: 'ค่าส่วนกลางหมู่บ้าน', version: sqwa('30.00') }],
    charges: [],
    estimateSettlements: [],
    advanceRent: null,
    vat: VAT_NONE,
    ownership: {
      partyId: `owner-${plot.unitId}`,
      rows: [{ partyId: `owner-${plot.unitId}`, sharePct: '100.0000', from: '2020-01-01', to: null }],
    },
    cycleMonths: 12,
  });
}

/** 312 condominium units with 6-decimal ownership ratios (0.002500–0.004199), deterministic. */
const CONDO: SplitUnit[] = Array.from({ length: 312 }, (_, i) => ({
  unitId: `unit-${String(i + 1).padStart(3, '0')}`,
  areaSqm: null,
  landAreaSqwa: null,
  ownershipRatio: new Decimal(2500 + (((i + 1) * 7919) % 1700)).div(1_000_000).toFixed(6),
}));

describe('billing engine — juristic charge bases (J1.1b)', () => {
  it('village of 248 plots, per ตร.วา, annual: 30.00 a ตร.วา a month × 12 months; Σ = Σ land × 360', () => {
    const drafts = PLOTS.map(plotDraft);
    // plot 1: 50 + 37 + 0.13 = 87.13 ตร.วา × 30.00 = 2,613.90 a month → 31,366.80 a year
    expect(PLOTS[0]!.landAreaSqwa).toBe('87.13');
    expect(drafts[0]!.total).toBe('31366.80');
    expect(drafts[0]!.lines[0]).toMatchObject({ unit: 'sqwa', quantity: '87.130', periodTo: '2027-12-31' });
    const land = PLOTS.reduce((s, p) => s.plus(p.landAreaSqwa), new Decimal(0));
    expect(sum(drafts.map((d) => d.total))).toBe(land.times(360).toFixed(2));
    expect(drafts.every((d) => d.reviewFlags.length === 0)).toBe(true);
    golden('village-per-sqwa-annual', {
      plots: PLOTS.length,
      landTotalSqwa: land.toFixed(2),
      yearTotal: sum(drafts.map((d) => d.total)),
      samples: [0, 1, 61, 123, 247].map((i) => ({
        unitNo: PLOTS[i]!.unitNo,
        landAreaSqwa: PLOTS[i]!.landAreaSqwa,
        lines: drafts[i]!.lines,
        total: drafts[i]!.total,
      })),
    });
  });

  it('a plot without land area is not billed: review flag land_area_missing', () => {
    const d = plotDraft({ unitId: 'plot-x', unitNo: 'X', landAreaSqwa: null as unknown as string });
    expect(d.lines).toHaveLength(0);
    expect(d.reviewFlags).toEqual(['land_area_missing']);
  });

  it('budget_split of 1,234,567.89 over 312 ratios sums exactly; the remainder goes to the largest ratio', () => {
    const r = splitBudget('1234567.89', CONDO, 'ownership_ratio');
    const amounts = [...r.amounts.values()];
    expect(amounts).toHaveLength(312);
    expect(sum(amounts)).toBe('1234567.89');
    expect(r.missing).toEqual([]);
    // unit-001: 2500 + 7919 mod 1700 (= 1119) = 3619 → ratio 0.003619
    expect(CONDO[0]!.ownershipRatio).toBe('0.003619');
    const total = new Decimal(r.totalWeight);
    const naive = (w: string) =>
      new Decimal('1234567.89').times(w).div(total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    const diff = new Decimal('1234567.89').minus(sum(CONDO.map((u) => naive(u.ownershipRatio!))));
    const largest = [...CONDO].sort(
      (a, b) => new Decimal(b.ownershipRatio!).cmp(a.ownershipRatio!) || a.unitId.localeCompare(b.unitId),
    )[0]!;
    for (const u of CONDO)
      expect(r.amounts.get(u.unitId)).toBe(
        u.unitId === largest.unitId
          ? new Decimal(naive(u.ownershipRatio!)).plus(diff).toFixed(2)
          : naive(u.ownershipRatio!),
      );
    golden('budget-split-1234567-89', {
      budget: '1234567.89',
      units: CONDO.length,
      totalWeight: r.totalWeight,
      remainder: diff.toFixed(2),
      remainderUnit: largest.unitId,
      stats: moneyStats(amounts),
      first10: CONDO.slice(0, 10).map((u) => ({
        unitId: u.unitId,
        ratio: u.ownershipRatio,
        amount: r.amounts.get(u.unitId),
      })),
    });
  });

  it('budget_split through the engine: the unit draft bills its exact part of the cycle amount', () => {
    const version: RateVersionLike = {
      id: 'rpv-split',
      effectiveFrom: '2027-01-01',
      tiers: { kind: 'budget', amount: '1234567.89', period: 'year', splitBy: 'ownership_ratio' },
      basis: 'budget_split',
      minimumCharge: null,
    };
    const cycle = periodBudget({ amount: '1234567.89', period: 'year' }, 12);
    expect(cycle).toBe('1234567.89');
    const r = splitBudget(cycle, CONDO, 'ownership_ratio');
    const u = CONDO[0]!;
    const d = computeInvoiceDraft({
      period: YEAR,
      mode: 'cycle',
      unit: {
        id: u.unitId,
        unitNo: 'A-0001',
        type: 'condo_unit',
        areaSqm: null,
        ownershipRatio: u.ownershipRatio,
      },
      occupancy: { from: YEAR.start, to: YEAR.end },
      lease: null,
      meters: [],
      unitRatePlans: [
        {
          kind: 'common_fee',
          name: 'ค่าส่วนกลาง',
          version,
          split: {
            periodAmount: r.amounts.get(u.unitId)!,
            weight: u.ownershipRatio!,
            totalWeight: r.totalWeight,
          },
        },
      ],
      charges: [],
      estimateSettlements: [],
      advanceRent: null,
      vat: VAT_NONE,
      ownership: {
        partyId: 'p60',
        rows: [
          { partyId: 'p60', sharePct: '60.0000', from: '2020-01-01', to: null },
          { partyId: 'p40', sharePct: '40.0000', from: '2020-01-01', to: null },
        ],
        partyIds: ['p60', 'p40'],
      },
      cycleMonths: 12,
    });
    // a bill-to party paying for both owners gets both shares on one invoice: Σ = the unit's part
    expect(d.lines).toHaveLength(2);
    expect(d.total).toBe(r.amounts.get(u.unitId));
    expect(d.lines[0]!.tierBreakdown![0]!.label).toBe('budget_split:ownership_ratio');
    // without the split (a unit of the building lacks its weight) nothing is billed and the draft is flagged
    const missing = computeInvoiceDraft({
      ...{
        period: YEAR,
        mode: 'cycle' as const,
        unit: { id: 'u', unitNo: 'U', type: 'condo_unit', areaSqm: null, ownershipRatio: null },
        occupancy: { from: YEAR.start, to: YEAR.end },
        lease: null,
        meters: [],
        charges: [],
        estimateSettlements: [],
        advanceRent: null,
        vat: VAT_NONE,
      },
      unitRatePlans: [{ kind: 'common_fee', name: 'ค่าส่วนกลาง', version, split: null }],
    });
    expect(missing.lines).toHaveLength(0);
    expect(missing.reviewFlags).toEqual(['budget_split_weight_missing']);
  });

  it('per unit ties: 100.00 over three equal units → 33.34 to the first unit id, 33.33 to the others', () => {
    const units = ['u-c', 'u-a', 'u-b'].map((unitId) => ({
      unitId,
      areaSqm: null,
      ownershipRatio: null,
      landAreaSqwa: null,
    }));
    const r = splitBudget('100.00', units, 'per_unit');
    expect(Object.fromEntries(r.amounts)).toEqual({ 'u-a': '33.34', 'u-b': '33.33', 'u-c': '33.33' });
  });

  it('by m² and by ตร.วา; a unit without the weight is reported missing', () => {
    const units: SplitUnit[] = [
      { unitId: 'a', areaSqm: '30.00', ownershipRatio: null, landAreaSqwa: '50.00' },
      { unitId: 'b', areaSqm: '60.00', ownershipRatio: null, landAreaSqwa: null },
    ];
    expect(Object.fromEntries(splitBudget('900.00', units, 'area_sqm').amounts)).toEqual({
      a: '300.00',
      b: '600.00',
    });
    const land = splitBudget('900.00', units, 'land_area_sqwa');
    expect(land.missing).toEqual(['b']);
  });

  it('chargeFor budget_split (preview of a single unit) and validation of the new bases', () => {
    const c = chargeFor(
      {
        tiers: { kind: 'budget', amount: '120000.00', period: 'year', splitBy: 'area_sqm' },
        basis: 'budget_split',
        minimumCharge: null,
      },
      { splitWeight: '30', splitTotal: '1200' },
    );
    // 120,000 ÷ 12 = 10,000 a month × 30 / 1,200 = 250.00
    expect(c.amount).toBe('250.00');
    expect(
      validateRateVersion('common_fee', 'budget_split', { kind: 'budget', amount: '1.00' }, null),
    ).toEqual([{ path: 'tiers.splitBy', message: 'ownership_ratio | area_sqm | land_area_sqwa | per_unit' }]);
    expect(validateRateVersion('fund', 'per_sqwa', { kind: 'flat', pricePerUnit: '5.00' }, null)).toEqual([]);
    expect(
      validateRateVersion(
        'common_fee',
        'per_ownership_ratio',
        { kind: 'budget', amount: '1.00', splitBy: 'per_unit' },
        null,
      ),
    ).toEqual([{ path: 'tiers.splitBy', message: 'only for basis budget_split' }]);
    expect(validateRateVersion('power', 'per_sqwa', { kind: 'flat', pricePerUnit: '5.00' }, null)).toEqual([
      { path: 'basis', message: 'power plans bill per_unit' },
    ]);
  });

  it('transfer after an issued annual invoice: the days from 15 March are credited (13,104.00 of 16,380.00)', () => {
    const credit = amountFromDate('16380.00', { from: '2027-01-01', to: '2027-12-31' }, '2027-03-15');
    // 16,380.00 − round(16,380.00 × 73 / 365 = 3,276.00) = 13,104.00 — the J1.1a buyer amount
    expect(credit).toBe('13104.00');
    expect(amountFromDate('16380.00', { from: '2027-03-15', to: '2027-12-31' }, '2027-03-15')).toBe(
      '16380.00',
    );
    expect(amountFromDate('16380.00', { from: '2027-01-01', to: '2027-03-14' }, '2027-03-15')).toBe('0.00');
    // carried to two buyers 60 / 40
    expect(
      Object.fromEntries(
        splitByShares(credit, [
          { partyId: 'b1', sharePct: '60' },
          { partyId: 'b2', sharePct: '40' },
        ]),
      ),
    ).toEqual({ b1: '7862.40', b2: '5241.60' });
    // three buyers 33.3333 / 33.3333 / 33.3334: remainder on the largest share
    expect(
      Object.fromEntries(
        splitByShares('100.00', [
          { partyId: 'x', sharePct: '33.3333' },
          { partyId: 'y', sharePct: '33.3333' },
          { partyId: 'z', sharePct: '33.3334' },
        ]),
      ),
    ).toEqual({ x: '33.33', y: '33.33', z: '33.34' });
    // buyers below 100 % are charged only their own share
    expect(Object.fromEntries(splitByShares('100.00', [{ partyId: 'x', sharePct: '50' }]))).toEqual({
      x: '50.00',
    });
  });
});
