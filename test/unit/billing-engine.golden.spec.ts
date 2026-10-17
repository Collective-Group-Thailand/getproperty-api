import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { effectiveAverageRate } from '@core/utility-tariffs/tariff-math';
import {
  type CapCandidate,
  capFor,
  computeInvoiceDraft,
  type DraftInput,
  type DraftResult,
  type MeterInput,
} from '@modules/ops-billing/engine/invoice-draft';
import { dueDateFor, proRata, proRataAmount } from '@modules/ops-billing/engine/periods';
import { chargeFor, type RateVersionLike, validateRateVersion } from '@modules/ops-billing/engine/rate-tiers';
import {
  type CandidateReading,
  estimateRegister,
  type MeterSegment,
  selectClosingReading,
} from '@modules/ops-billing/engine/readings';
import Decimal from 'decimal.js';

import { UTILITY_TARIFFS } from '../../prisma/seed/data/utility-tariffs';

/**
 * B4.2 golden tests of the billing engine (D-011, D-021a, D-022, D-031, D-040, D-041, D-046, D-140, D-141). Every
 * case is a fixture whose output is kept in `test/golden/billing/<case>.json` (UPDATE_GOLDEN=1 rewrites them after a
 * reviewed change) **and** hand-computed assertions on the numbers that matter, so a golden file never just agrees
 * with itself. The engine is pure: the same input always gives the same output.
 */
const DIR = join(__dirname, '..', 'golden', 'billing');

function golden(name: string, result: DraftResult): void {
  const file = join(DIR, `${name}.json`);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
  }
  // compared as data: the formatting of the committed file does not matter
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

function tariff(provider: string, code: string, effectiveFrom: string): CapCandidate {
  const t = UTILITY_TARIFFS.find((x) => x.provider === provider && x.tariffCode === code)!;
  const v = t.versions.find((x) => x.effectiveFrom === effectiveFrom)!;
  return {
    id: `utv-${provider}-${code}`,
    provider,
    tariffCode: code,
    effectiveFrom,
    structure: v.structure,
  };
}

const MEA_2026_09 = [tariff('mea', '1.1.1', '2026-09-01'), tariff('mea', '1.1.2', '2026-09-01')];
const MWA = [tariff('mwa', 'residential', '2025-01-01')];

const flat = (id: string, price: string, minimumCharge: string | null = null): RateVersionLike => ({
  id,
  effectiveFrom: '2026-06-01',
  tiers: { kind: 'flat', unit: 'kwh', pricePerUnit: price },
  basis: 'per_unit',
  minimumCharge,
});

const reading = (
  id: string,
  register: string,
  readAt: string,
  source: 'iot' | 'manual' | 'ocr' | 'estimated' = 'iot',
) => ({
  readingId: id,
  register,
  readAt,
  source,
  confidence: source === 'iot' ? '1.000' : '0.950',
  isEstimated: source === 'estimated',
  evidenceDocumentId: null,
});

const segment = (
  assignmentId: string,
  from: MeterSegment['from'],
  to: MeterSegment['to'],
  multiplier = '1',
): MeterSegment => ({
  assignmentId,
  assetItemId: `${assignmentId}-meter`,
  code: `A-201${assignmentId.slice(-1)}`,
  multiplier,
  rolloverAt: '99999.999',
  from,
  to,
});

const ELECTRIC = (
  segments: MeterSegment[],
  rate: RateVersionLike | null,
  extra: Partial<MeterInput> = {},
) => ({
  utility: 'electric' as const,
  segments,
  ratePlanVersion: rate,
  capCandidates: MEA_2026_09,
  ...extra,
});
const WATER = (segments: MeterSegment[], rate: RateVersionLike | null, extra: Partial<MeterInput> = {}) => ({
  utility: 'water' as const,
  segments,
  ratePlanVersion: rate
    ? { ...rate, tiers: { ...rate.tiers, unit: 'm3' } as RateVersionLike['tiers'] }
    : null,
  capCandidates: MWA,
  ...extra,
});

const LEASE: NonNullable<DraftInput['lease']> = {
  id: 'lease-1',
  number: 'CTR-2026-00042',
  startDate: '2026-06-01',
  endDate: '2027-05-31',
  rent: '4500.00',
  rentChanges: [],
  utilityBillingMode: 'metered',
  lines: [
    {
      id: 'line-net',
      kind: 'internet',
      description: 'อินเทอร์เน็ต',
      amount: '300.00',
      recurrence: 'monthly',
      effectiveFrom: '2026-06-01',
      effectiveTo: null,
    },
  ],
};

const NOV = { start: '2026-11-01', end: '2026-11-30' };
const BASE: DraftInput = {
  period: NOV,
  mode: 'cycle',
  unit: { id: 'unit-1', unitNo: 'A-201', type: 'room', areaSqm: '24.00', ownershipRatio: null },
  occupancy: { from: NOV.start, to: NOV.end },
  lease: LEASE,
  meters: [],
  unitRatePlans: [],
  charges: [],
  estimateSettlements: [],
  advanceRent: null,
  vat: { registered: false, rate: '0.07', applicableKinds: [] },
};

const amounts = (r: DraftResult) =>
  Object.fromEntries(r.lines.map((l) => [`${l.lineNo}:${l.lineKind}`, l.amount]));

describe('billing engine — golden cases (B4.2)', () => {
  it('full month: rent + lease line + electricity and water within the utility rate', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-e',
              reading('r-e0', '1000.000', '2026-10-31T16:59:00Z'),
              reading('r-e1', '1150.000', '2026-11-30T16:58:00Z'),
            ),
          ],
          flat('rpv-e', '3.2000'),
        ),
        WATER(
          [
            segment(
              'asg-w',
              reading('r-w0', '250.000', '2026-10-31T16:30:00Z', 'manual'),
              reading('r-w1', '258.000', '2026-11-30T09:00:00Z', 'manual'),
            ),
          ],
          flat('rpv-w', '8.0000'),
        ),
      ],
    });
    // 4500 + 300 + 150 × 3.20 + 8 × 8.00
    expect(amounts(r)).toEqual({
      '1:rent': '4500.00',
      '2:internet': '300.00',
      '3:electricity': '480.00',
      '4:water': '64.00',
    });
    expect(r.total).toBe('5344.00');
    expect(r.hasAboveCapLine).toBe(false);
    expect(r.reviewFlags).toEqual([]);
    const e = r.lines[2]!;
    // cap = the lower effective average of MEA 1.1.1 / 1.1.2 (Sep 2026) at 150 kWh; 1.1.2 = 3.3264 (tariff-math golden)
    expect(e.capPerUnit).toBe(
      Decimal.min(
        effectiveAverageRate(MEA_2026_09[0]!.structure, { units: '150' })!,
        effectiveAverageRate(MEA_2026_09[1]!.structure, { units: '150' })!,
      ).toFixed(4),
    );
    expect(e.meter).toMatchObject({
      registerFrom: '1000.000',
      registerTo: '1150.000',
      units: '150.000',
      readingSource: 'iot',
    });
    golden('full-month', r);
  });

  it('move-in mid-month: rent and monthly lines pro-rata by calendar days (12–30 Nov = 19/30)', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      lease: { ...LEASE, startDate: '2026-11-12' },
      occupancy: { from: '2026-11-12', to: '2026-11-30' },
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-e',
              reading('r-e-in', '2000.000', '2026-11-12T03:00:00Z', 'manual'),
              reading('r-e1', '2061.500', '2026-11-30T16:58:00Z'),
            ),
          ],
          flat('rpv-e', '3.0000'),
        ),
      ],
    });
    // 4500 × 19 / 30 = 2850.00; 300 × 19 / 30 = 190.00; 61.5 × 3 = 184.50
    expect(amounts(r)).toEqual({ '1:rent': '2850.00', '2:internet': '190.00', '3:electricity': '184.50' });
    expect(r.lines[0]!.proRata).toMatchObject({
      days: 19,
      daysInPeriod: 30,
      from: '2026-11-12',
      to: '2026-11-30',
    });
    expect(r.total).toBe('3224.50');
    golden('move-in-mid-month', r);
  });

  it('move-out mid-month (final invoice): pro-rata to the move-out day, advance rent applied, the rest unused', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      mode: 'final',
      occupancy: { from: '2026-11-01', to: '2026-11-10' },
      advanceRent: '4500.00',
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-e',
              reading('r-e0', '1000.000', '2026-10-31T16:59:00Z'),
              reading('r-e-out', '1040.250', '2026-11-10T04:00:00Z', 'manual'),
            ),
          ],
          flat('rpv-e', '3.0000'),
        ),
      ],
    });
    // 4500 × 10 / 30 = 1500.00; 300 × 10/30 = 100.00; 40.25 × 3 = 120.75; advance applied −1720.75
    expect(amounts(r)).toEqual({
      '1:rent': '1500.00',
      '2:internet': '100.00',
      '3:electricity': '120.75',
      '4:deposit_offset': '-1720.75',
    });
    expect(r.total).toBe('0.00');
    expect(r.advanceRent).toEqual({ received: '4500.00', applied: '1720.75', unused: '2779.25' });
    golden('move-out-mid-month', r);
  });

  it('MEA tiered utility tariff vs a flat tenant rate: 400 kWh at 4.0000 is above the 3.76 cap (warned)', () => {
    const units = '400';
    const cap = capFor(MEA_2026_09, units)!;
    // MEA Sep 2026 at 400 kWh: 1.1.2 = (600 + 200 × 4.1584 + 400 × 0.1623 + 24.62) / 400 = 3.8031 (tariff-math golden);
    // 1.1.1 has the same blocks with the 8.19 service charge: 1504.79 / 400 = 3.761975 → the lower one is the cap
    expect(effectiveAverageRate(MEA_2026_09[1]!.structure, { units })).toBe('3.8031');
    expect(cap).toMatchObject({ capPerUnit: '3.7620', tariffCode: '1.1.1' });
    const meter = (ack: string | null) =>
      ELECTRIC(
        [
          segment(
            'asg-e',
            reading('r-e0', '5000.000', '2026-10-31T16:59:00Z'),
            reading('r-e1', '5400.000', '2026-11-30T16:59:00Z'),
          ),
        ],
        flat('rpv-e', '4.0000'),
        { acknowledgementId: ack },
      );
    const warned = computeInvoiceDraft({ ...BASE, lease: { ...LEASE, lines: [] }, meters: [meter(null)] });
    expect(warned.lines[1]).toMatchObject({
      amount: '1600.00',
      unitPrice: '4.0000',
      capPerUnit: '3.7620',
      aboveCap: true,
    });
    expect(warned.reviewFlags).toEqual(['acknowledgement_required:electric']);
    expect(warned.complianceFlags).toEqual(['above_cap:electric']);
    const acknowledged = computeInvoiceDraft({
      ...BASE,
      lease: { ...LEASE, lines: [] },
      meters: [meter('ack-1')],
    });
    expect(acknowledged.lines[1]).toMatchObject({ aboveCap: true, acknowledgementId: 'ack-1' });
    expect(acknowledged.reviewFlags).toEqual([]);
    expect(acknowledged.hasAboveCapLine).toBe(true);
    golden('mea-tiered-vs-flat-above-cap', acknowledged);
  });

  it('a tiered tenant rate: the effective price per unit is the average of the blocks', () => {
    const tiered: RateVersionLike = {
      id: 'rpv-t',
      effectiveFrom: '2026-06-01',
      basis: 'per_unit',
      minimumCharge: null,
      tiers: {
        kind: 'tiered',
        unit: 'kwh',
        tiers: [
          { fromUnits: '0', toUnits: '150', pricePerUnit: '3.0000' },
          { fromUnits: '150', toUnits: null, pricePerUnit: '4.0000' },
        ],
      },
    };
    const c = chargeFor(tiered, { units: '200' });
    // 150 × 3 + 50 × 4 = 650.00 → 3.2500 / unit
    expect(c).toMatchObject({ amount: '650.00', unitPrice: '3.2500', quantity: '200.000' });
    expect(c.tierBreakdown.map((t) => t.amount)).toEqual(['450', '200']);
  });

  it('water minimum charge (D-141): a top-up line to the lease minimum', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      lease: {
        ...LEASE,
        lines: [
          ...LEASE.lines,
          {
            id: 'line-wmin',
            kind: 'water_minimum',
            description: 'ค่าน้ำขั้นต่ำ',
            amount: '100.00',
            recurrence: 'monthly',
            effectiveFrom: '2026-06-01',
            effectiveTo: null,
          },
        ],
      },
      meters: [
        WATER(
          [
            segment(
              'asg-w',
              reading('r-w0', '250.000', '2026-10-31T16:30:00Z', 'manual'),
              reading('r-w1', '252.000', '2026-11-30T09:00:00Z', 'manual'),
            ),
          ],
          flat('rpv-w', '8.5000'),
        ),
      ],
    });
    // 2 m³ × 8.50 = 17.00 → top-up 83.00 to the 100.00 minimum
    expect(amounts(r)).toEqual({
      '1:rent': '4500.00',
      '2:internet': '300.00',
      '3:water': '17.00',
      '4:water_minimum': '83.00',
    });
    expect(r.lines[3]!.sourceType).toBe('adjustment');
    expect(r.lines[3]!.leaseLineId).toBe('line-wmin');
    golden('water-minimum', r);
  });

  it('estimate then settlement: an estimated line, then Δ units × the estimated price on the next invoice', () => {
    const estimated = computeInvoiceDraft({
      ...BASE,
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-e',
              reading('r-e0', '1000.000', '2026-10-31T16:59:00Z'),
              reading('r-est', '1100.000', '2026-11-30T16:59:00Z', 'estimated'),
            ),
          ],
          flat('rpv-e', '3.2000'),
        ),
      ],
    });
    expect(estimated.hasEstimate).toBe(true);
    expect(estimated.lines[2]).toMatchObject({
      amount: '320.00',
      description: 'ค่าไฟฟ้า 100.000 หน่วย (ประมาณการ)',
    });
    const settled = computeInvoiceDraft({
      ...BASE,
      period: { start: '2026-12-01', end: '2026-12-31' },
      occupancy: { from: '2026-12-01', to: '2026-12-31' },
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-e',
              reading('r-act', '1120.000', '2026-12-01T02:00:00Z', 'manual'),
              reading('r-e2', '1250.000', '2026-12-31T16:59:00Z'),
            ),
          ],
          flat('rpv-e', '3.2000'),
        ),
      ],
      estimateSettlements: [
        {
          id: 'es-1',
          utility: 'electric',
          estimatedUnits: '100.000',
          actualUnits: '120.000',
          unitPrice: '3.2000',
          capPerUnit: estimated.lines[2]!.capPerUnit!,
          utilityTariffVersionId: estimated.lines[2]!.utilityTariffVersionId!,
          ratePlanVersionId: 'rpv-e',
          acknowledgementId: null,
          meterAssignmentId: 'asg-e',
          assetItemId: 'asg-e-meter',
          actualReadingId: 'r-act',
        },
      ],
    });
    // December: 130 × 3.20 = 416.00; settlement (120 − 100) × 3.20 = 64.00
    expect(amounts(settled)).toEqual({
      '1:rent': '4500.00',
      '2:internet': '300.00',
      '3:electricity': '416.00',
      '4:estimate_settlement': '64.00',
    });
    expect(settled.hasEstimate).toBe(false);
    golden('estimate-then-settlement', settled);
  });

  it('a swap within the period (two assignments): units summed over both meters', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      lease: { ...LEASE, lines: [] },
      meters: [
        ELECTRIC(
          [
            segment(
              'asg-old',
              reading('r-o0', '1000.000', '2026-10-31T16:59:00Z'),
              reading('r-o-final', '1060.000', '2026-11-15T02:59:59.999Z', 'manual'),
            ),
            segment(
              'asg-new',
              reading('r-n-install', '0.000', '2026-11-15T03:00:00Z', 'manual'),
              reading('r-n1', '40.000', '2026-11-30T16:59:00Z'),
            ),
          ],
          flat('rpv-e', '3.0000'),
        ),
      ],
    });
    // (1060 − 1000) + (40 − 0) = 100 kWh × 3 = 300.00
    expect(r.lines[1]).toMatchObject({ amount: '300.00', quantity: '100.000' });
    expect(r.lines[1]!.meter).toMatchObject({
      registerFrom: null,
      registerTo: null,
      meterAssignmentId: 'asg-new',
    });
    expect(r.lines[1]!.meter!.segments).toHaveLength(2);
    golden('swap-within-period', r);
  });

  it('missing readings, rate plans and cap references block the draft (review flags)', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      meters: [
        ELECTRIC(
          [segment('asg-e', reading('r-e0', '1000.000', '2026-10-31T16:59:00Z'), null)],
          flat('rpv', '3'),
        ),
        WATER(
          [
            segment(
              'asg-w',
              reading('r-w0', '250.000', '2026-10-31T16:30:00Z', 'manual'),
              reading('r-w1', '252.000', '2026-11-30T09:00:00Z', 'manual'),
            ),
          ],
          null,
        ),
      ],
    });
    expect(r.reviewFlags).toEqual(['missing_reading:electric', 'missing_rate_plan:water']);
    const noCap = computeInvoiceDraft({
      ...BASE,
      meters: [
        {
          ...ELECTRIC(
            [
              segment(
                'asg-e',
                reading('r-e0', '1000.000', '2026-10-31T16:59:00Z'),
                reading('r-e1', '1100.000', '2026-11-30T16:59:00Z'),
              ),
            ],
            flat('rpv', '3'),
          ),
          capCandidates: [],
        },
      ],
    });
    expect(noCap.reviewFlags).toEqual(['no_cap_reference:electric']);
  });

  it('condo common fee by ownership ratio and by m² (one engine, D-151)', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      unit: {
        id: 'unit-c',
        unitNo: 'C-1203',
        type: 'condo_unit',
        areaSqm: '24.00',
        ownershipRatio: '0.012345',
      },
      lease: null,
      unitRatePlans: [
        {
          kind: 'common_fee',
          name: 'ค่าส่วนกลาง',
          version: {
            id: 'rpv-cf',
            effectiveFrom: '2026-01-01',
            basis: 'per_ownership_ratio',
            minimumCharge: null,
            tiers: { kind: 'budget', amount: '100000.00', period: 'month' },
          },
        },
        {
          kind: 'fund',
          name: 'เงินกองทุน',
          version: {
            id: 'rpv-fund',
            effectiveFrom: '2026-01-01',
            basis: 'per_sqm',
            minimumCharge: null,
            tiers: { kind: 'flat', pricePerUnit: '35.0000' },
          },
        },
      ],
    });
    // 100000 × 0.012345 = 1234.50; 24 m² × 35 = 840.00
    expect(amounts(r)).toEqual({ '1:common_fee': '1234.50', '2:fund': '840.00' });
    expect(r.total).toBe('2074.50');
    golden('condo-common-fee-by-ratio', r);
  });

  it('VAT only for VAT-registered tenants and the kinds their setting lists (O-004)', () => {
    const r = computeInvoiceDraft({
      ...BASE,
      vat: { registered: true, rate: '0.07', applicableKinds: ['internet'] },
    });
    // 300 × 7 % = 21.00
    expect(r).toMatchObject({ subtotal: '4800.00', vatAmount: '21.00', total: '4821.00' });
    expect(r.lines.map((l) => l.vatApplicable)).toEqual([false, true]);
  });
});

describe('billing engine — readings, periods, rate plans', () => {
  const at = new Date('2026-11-30T16:59:00Z');
  const w = { iotMinutes: 120, manualDaysBefore: 7, graceUntil: new Date('2026-12-01T16:59:00Z') };
  const r = (
    id: string,
    iso: string,
    source: CandidateReading['source'],
    confidence: string,
    register = '1.000',
  ) => ({
    id,
    register,
    readAt: new Date(iso),
    source,
    confidence,
  });

  it('the closing reading: highest confidence inside the window, then the closest to the cut-off (D-031)', () => {
    const picked = selectClosingReading(
      [
        r('iot-far', '2026-11-30T13:00:00Z', 'iot', '1.000'), // 4 h before: outside ±2 h
        r('iot-near', '2026-11-30T16:00:00Z', 'iot', '0.700'),
        r('manual', '2026-12-01T03:00:00Z', 'manual', '0.950'),
        r('estimate', '2026-11-30T16:59:00Z', 'estimated', '0.500'),
      ],
      at,
      w,
    );
    expect(picked?.id).toBe('manual');
    expect(selectClosingReading([r('late', '2026-12-02T03:00:00Z', 'manual', '0.950')], at, w)).toBeNull();
  });

  it('an estimate continues the trailing daily average from the last actual register', () => {
    const est = estimateRegister(
      [
        r('a', '2026-09-30T16:59:00Z', 'iot', '1.000', '1000.000'),
        r('b', '2026-10-31T16:59:00Z', 'iot', '1.000', '1310.000'),
      ],
      new Date('2026-11-30T16:59:00Z'),
      '99999.999',
    );
    // 310 kWh in 31 days = 10 / day → 30 days → 1610.000
    expect(est).toMatchObject({
      register: '1610.000',
      basis: { dailyAverage: '10.000', fromReadingId: 'b' },
    });
    expect(
      estimateRegister([r('a', '2026-10-31T16:59:00Z', 'iot', '1.000', '5')], at, '99999.999'),
    ).toBeNull();
  });

  it('due date: the lease due day after the period, never inside the 3-day lead time (ข้อ 4 (8))', () => {
    expect(dueDateFor({ periodEnd: '2026-11-30', issuedOn: '2026-12-01', dueDay: 5, minLeadDays: 3 })).toBe(
      '2026-12-05',
    );
    expect(dueDateFor({ periodEnd: '2026-11-30', issuedOn: '2026-12-04', dueDay: 5, minLeadDays: 3 })).toBe(
      '2026-12-07',
    );
    expect(dueDateFor({ periodEnd: '2026-11-25', issuedOn: '2026-11-26', dueDay: 31, minLeadDays: 3 })).toBe(
      '2026-11-30',
    );
    expect(dueDateFor({ periodEnd: '2027-01-31', issuedOn: '2027-02-01', dueDay: 31, minLeadDays: 3 })).toBe(
      '2027-02-28',
    );
  });

  it('pro-rata is exact for a full period and half-up otherwise', () => {
    const p = proRata({ start: '2026-02-01', end: '2026-02-28' }, { from: '2026-02-15', to: '2026-02-28' })!;
    expect(p).toMatchObject({ days: 14, daysInPeriod: 28, factor: '0.500000' });
    expect(proRataAmount('3333.33', p)).toBe('1666.67');
    expect(
      proRata({ start: '2026-02-01', end: '2026-02-28' }, { from: '2026-03-01', to: '2026-03-31' }),
    ).toBeNull();
  });

  it('rate plan versions are validated per plan kind and basis', () => {
    expect(validateRateVersion('power', 'per_unit', { kind: 'flat', pricePerUnit: '7.0000' }, null)).toEqual(
      [],
    );
    expect(
      validateRateVersion('power', 'fixed', { kind: 'fixed', amount: '500.00' }, null).length,
    ).toBeGreaterThan(0);
    expect(
      validateRateVersion(
        'water',
        'per_unit',
        { kind: 'tiered', tiers: [{ fromUnits: '0', toUnits: '10', pricePerUnit: '18' }] },
        null,
      ).map((p) => p.path),
    ).toContain('tiers.tiers[0].toUnits');
    expect(
      validateRateVersion('common_fee', 'per_ownership_ratio', { kind: 'budget', amount: '100000.00' }, null),
    ).toEqual([]);
  });
});

/** A tiny deterministic generator (no new dependency): Park–Miller LCG. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

describe('billing engine — properties (D-046)', () => {
  it('Σ line amounts = subtotal, total = subtotal + VAT, every amount in satang, deterministic', () => {
    const next = rng(20261017);
    const pick = (n: number) => Math.floor(next() * n);
    for (let i = 0; i < 300; i += 1) {
      const rent = (1000 + pick(20000) + pick(100) / 100).toFixed(2);
      const startDay = 1 + pick(28);
      const endDay = startDay + pick(30 - startDay);
      const units = (pick(800) + pick(1000) / 1000).toFixed(3);
      const price = (1 + pick(900) / 100).toFixed(4);
      const input: DraftInput = {
        ...BASE,
        lease: {
          ...LEASE,
          rent,
          lines: [
            { ...LEASE.lines[0]!, amount: (pick(1000) + pick(100) / 100).toFixed(2) },
            {
              id: 'line-p',
              kind: 'parking',
              description: 'ที่จอดรถ',
              amount: (pick(2000) / 3).toFixed(2),
              recurrence: 'monthly',
              effectiveFrom: '2026-06-01',
              effectiveTo: null,
            },
          ],
        },
        occupancy: {
          from: `2026-11-${String(startDay).padStart(2, '0')}`,
          to: `2026-11-${String(endDay).padStart(2, '0')}`,
        },
        meters: [
          ELECTRIC(
            [
              segment(
                'asg-e',
                reading('r0', '1000.000', '2026-10-31T16:59:00Z'),
                reading('r1', new Decimal(1000).plus(units).toFixed(3), '2026-11-30T16:59:00Z'),
              ),
            ],
            flat('rpv', price),
            { acknowledgementId: 'ack' },
          ),
        ],
        charges: pick(2)
          ? [
              {
                id: 'c1',
                sourceType: 'service',
                lineKind: 'one_off',
                description: 'ค่ากุญแจสำรอง',
                quantity: '1',
                unitPrice: '150.0000',
                amount: '150.00',
              },
            ]
          : [],
        vat: { registered: pick(2) === 1, rate: '0.07', applicableKinds: ['internet', 'parking', 'one_off'] },
      };
      const a = computeInvoiceDraft(input);
      const b = computeInvoiceDraft(JSON.parse(JSON.stringify(input)) as DraftInput);
      expect(a).toEqual(b);
      const sum = a.lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
      expect(sum.toFixed(2)).toBe(a.subtotal);
      expect(new Decimal(a.subtotal).plus(a.vatAmount).toFixed(2)).toBe(a.total);
      for (const l of a.lines) expect(l.amount).toMatch(/^-?\d+\.\d{2}$/);
      expect(a.lines.map((l) => l.lineNo)).toEqual(a.lines.map((_, k) => k + 1));
    }
  });

  it('the cap is never above any candidate tariff for the same consumption', () => {
    const next = rng(7);
    for (let i = 0; i < 100; i += 1) {
      const units = (1 + Math.floor(next() * 900)).toString();
      const cap = capFor(MEA_2026_09, units)!;
      for (const c of MEA_2026_09)
        expect(new Decimal(cap.capPerUnit).lte(effectiveAverageRate(c.structure, { units })!)).toBe(true);
    }
  });
});
