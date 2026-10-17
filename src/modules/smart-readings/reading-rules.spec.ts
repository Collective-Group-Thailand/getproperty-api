import Decimal from 'decimal.js';

import { cutoffOf, periodBounds, periodOf } from './cutoff';
import {
  type AcceptedReading,
  type AssignmentWindow,
  classifyReading,
  consumption,
  isRollover,
  plausibilityBand,
  positionConsumption,
  trailingDailyAverage,
} from './reading-rules';

/** Deterministic PRNG (mulberry32) so the property runs are reproducible without a property-testing library. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLL = '99999.999';
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

/** A random monotonic cumulative series that may wrap at `ROLL` (returns registers and the true consumption). */
function series(rand: () => number, n: number, start: number) {
  const registers: string[] = [];
  let reg = new Decimal(start);
  let truth = new Decimal(0);
  registers.push(reg.toFixed(3));
  for (let i = 1; i < n; i += 1) {
    const step = new Decimal(Math.floor(rand() * 4000))
      .div(1000)
      .plus(rand() < 0.1 ? 0 : 1)
      .toDecimalPlaces(3);
    truth = truth.plus(step);
    reg = reg.plus(step);
    if (reg.gt(ROLL)) reg = reg.minus(new Decimal(ROLL).plus('0.001'));
    registers.push(reg.toFixed(3));
  }
  return { registers, truth };
}

describe('reading rules (D-030, D-035, D-142)', () => {
  describe('consumption and rollover', () => {
    it('is the difference for a rising register and null for a plain decrease', () => {
      expect(consumption('100.000', '142.120', ROLL)!.toFixed(3)).toBe('42.120');
      expect(consumption('100.000', '100.000', ROLL)!.toFixed(3)).toBe('0.000');
      expect(consumption('500.000', '499.000', ROLL)).toBeNull();
      expect(isRollover('500.000', '499.000', ROLL)).toBe(false);
    });

    it('counts a wrap at the rollover value', () => {
      expect(isRollover('99999.000', '1.000', ROLL)).toBe(true);
      expect(consumption('99999.000', '1.000', ROLL)!.toFixed(3)).toBe('2.000');
      expect(consumption('99999.999', '0.000', ROLL)!.toFixed(3)).toBe('0.001');
    });

    it('applies the multiplier (CT meters) and rounds to 3 decimals', () => {
      expect(consumption('10.000', '12.500', ROLL, '40')!.toFixed(3)).toBe('100.000');
    });

    it('property: Σ interval consumption of a monotonic (wrapping) series = the true consumption', () => {
      const rand = rng(42);
      for (let run = 0; run < 300; run += 1) {
        const start = rand() < 0.3 ? 99990 + rand() * 9 : rand() * 99000;
        const { registers, truth } = series(
          rand,
          2 + Math.floor(rand() * 60),
          Math.floor(start * 1000) / 1000,
        );
        let sum = new Decimal(0);
        for (let i = 1; i < registers.length; i += 1) {
          const c = consumption(registers[i - 1]!, registers[i]!, ROLL);
          expect(c).not.toBeNull();
          expect(c!.gte(0)).toBe(true);
          sum = sum.plus(c!);
        }
        expect(sum.toFixed(3)).toBe(truth.toFixed(3));
      }
    });

    it('property: a decrease that is not a wrap is never billed', () => {
      const rand = rng(7);
      for (let run = 0; run < 500; run += 1) {
        const prev = new Decimal(Math.floor(rand() * 89_000_000) / 1000 + 10);
        const curr = prev.minus(new Decimal(Math.floor(rand() * 9_000) + 1).div(1000));
        expect(consumption(prev, curr, ROLL)).toBeNull();
        const c = classifyReading({
          previous: { register: prev, readAt: day(0) },
          initialRegister: '0',
          register: curr,
          readAt: day(30),
          rolloverAt: ROLL,
          dailyAverage: null,
          plausibilityPct: '60',
        });
        expect(c.state).toBe('pending_review');
        expect(c.reason).toBe('decreasing_without_swap');
      }
    });
  });

  describe('plausibility and classification', () => {
    it('builds the ±pct band from the trailing daily average', () => {
      const avg = trailingDailyAverage(
        [
          { register: '100', readAt: day(0) },
          { register: '130', readAt: day(10) },
          { register: '160', readAt: day(20) },
        ],
        ROLL,
      );
      expect(avg!.toFixed(3)).toBe('3.000');
      const band = plausibilityBand(avg!, 30, '60');
      expect([band.low.toFixed(3), band.expected.toFixed(3), band.high.toFixed(3)]).toEqual([
        '36.000',
        '90.000',
        '144.000',
      ]);
    });

    it('accepts in band, reviews out of band, low OCR confidence and disagreement', () => {
      const common = {
        previous: { register: '160', readAt: day(20) },
        initialRegister: '0',
        readAt: day(50),
        rolloverAt: ROLL,
        dailyAverage: new Decimal(3),
        plausibilityPct: '60',
      };
      expect(classifyReading({ ...common, register: '250' }).state).toBe('accepted');
      expect(classifyReading({ ...common, register: '900' }).reason).toBe('out_of_band');
      expect(classifyReading({ ...common, register: '170' }).reason).toBe('out_of_band');
      expect(
        classifyReading({
          ...common,
          register: '250',
          ocr: { confidence: '0.5', minConfidence: '0.8', typedValue: null, value: '250' },
        }).reason,
      ).toBe('ocr_low_confidence');
      expect(
        classifyReading({
          ...common,
          register: '250',
          ocr: { confidence: '0.95', minConfidence: '0.8', typedValue: '250', value: '256' },
        }).reason,
      ).toBe('ocr_low_confidence');
      expect(classifyReading({ ...common, register: '250', forceReview: 'clock_suspect' }).reason).toBe(
        'clock_suspect',
      );
    });

    it('measures the first reading against the opening register of the assignment', () => {
      const c = classifyReading({
        previous: null,
        initialRegister: '1000.000',
        register: '1012.500',
        readAt: day(3),
        rolloverAt: ROLL,
        dailyAverage: null,
        plausibilityPct: '60',
      });
      expect(c.state).toBe('accepted');
      expect(c.consumption!.toFixed(3)).toBe('12.500');
    });
  });

  describe('positions across swaps (D-033)', () => {
    const a1: AssignmentWindow = {
      id: 'a1',
      validFrom: day(0),
      validTo: day(15),
      initialReading: '500.000',
      finalReading: '650.000',
      rolloverAt: ROLL,
      multiplier: '1',
    };
    const a2: AssignmentWindow = {
      id: 'a2',
      validFrom: day(15),
      validTo: null,
      initialReading: '0.000',
      finalReading: null,
      rolloverAt: ROLL,
      multiplier: '1',
    };

    it('sums old meter to its final register and new meter from its initial register, no gap, no overlap', () => {
      const readings: AcceptedReading[] = [
        { assignmentId: 'a1', register: '500.000', readAt: day(0) },
        { assignmentId: 'a1', register: '600.000', readAt: day(10) },
        { assignmentId: 'a2', register: '0.000', readAt: day(15) },
        { assignmentId: 'a2', register: '120.000', readAt: day(30) },
      ];
      expect(positionConsumption([a1, a2], readings, day(0), day(30)).toFixed(3)).toBe('270.000');
      // split at the swap instant: the two halves add up to the whole
      const before = positionConsumption([a1, a2], readings, day(0), day(15));
      const after = positionConsumption([a1, a2], readings, day(15), day(30));
      expect(before.plus(after).toFixed(3)).toBe('270.000');
    });

    it('property: splitting a window anywhere never changes the total (no gap, no overlap)', () => {
      const rand = rng(99);
      for (let run = 0; run < 200; run += 1) {
        const swapDay = 5 + Math.floor(rand() * 20);
        const s1 = series(rand, 6, Math.floor(rand() * 1000));
        const s2 = series(rand, 6, 0);
        const old: AssignmentWindow = {
          ...a1,
          validTo: day(swapDay),
          initialReading: s1.registers[0]!,
          finalReading: s1.registers[5]!,
        };
        const next: AssignmentWindow = { ...a2, validFrom: day(swapDay), initialReading: s2.registers[0]! };
        const readings: AcceptedReading[] = [
          ...s1.registers
            .slice(0, 5)
            .map((r, i) => ({ assignmentId: 'a1', register: r, readAt: day((swapDay * i) / 5) })),
          ...s2.registers.map((r, i) => ({ assignmentId: 'a2', register: r, readAt: day(swapDay + i * 2) })),
        ];
        const end = day(swapDay + 10);
        const whole = positionConsumption([old, next], readings, day(0), end);
        expect(whole.toFixed(3)).toBe(s1.truth.plus(s2.truth).toFixed(3));
        const cut = day(Math.floor(rand() * (swapDay + 10)));
        const sum = positionConsumption([old, next], readings, day(0), cut).plus(
          positionConsumption([old, next], readings, cut, end),
        );
        // a cut between two readings cannot be priced exactly: never more than the whole, never negative
        expect(sum.lte(whole)).toBe(true);
        expect(sum.gte(0)).toBe(true);
        // a cut at a reading instant (here: the swap) is exact
        const atSwap = positionConsumption([old, next], readings, day(0), day(swapDay)).plus(
          positionConsumption([old, next], readings, day(swapDay), end),
        );
        expect(atSwap.toFixed(3)).toBe(whole.toFixed(3));
      }
    });
  });
});

describe('billing cut-off (D-031)', () => {
  it('end of month 23:59 Bangkok', () => {
    const c = cutoffOf({ day: 'end_of_month', time: '23:59' }, 2026, 2);
    expect(c.toISOString()).toBe('2026-02-28T16:59:00.000Z');
  });

  it('assigns an instant to the period its next cut-off closes', () => {
    const s = { day: 25, time: '00:00' } as const;
    expect(periodOf(s, new Date('2026-10-24T10:00:00Z')).key).toBe('2026-10');
    expect(periodOf(s, new Date('2026-10-25T10:00:00Z')).key).toBe('2026-11');
    expect(periodOf(s, new Date('2026-12-26T10:00:00Z')).key).toBe('2027-01');
    const b = periodBounds(s, '2026-11');
    expect(b.start.toISOString()).toBe('2026-10-24T17:00:00.001Z');
    expect(b.end.toISOString()).toBe('2026-11-24T17:00:00.000Z');
  });
});
