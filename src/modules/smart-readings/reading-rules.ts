import Decimal from 'decimal.js';

/**
 * Pure meter-reading rules (D-030, D-035, D-142): consumption between two cumulative registers with rollover,
 * the plausibility band from the trailing consumption, the review decision, and the consumption of a unit over a
 * period across several meter assignments (swaps). No I/O — the services and the property tests use them.
 */

export const REGISTER_STEP = new Decimal('0.001');
/** A decrease counts as a rollover only from the top 10 % of the register range to its bottom 10 %. */
export const ROLLOVER_FRACTION = new Decimal('0.1');

export type Dec = Decimal | string | number;
const d = (v: Dec) => new Decimal(v);

/** True when `current` < `previous` is the register wrapping at `rolloverAt` (99999.999 → 0.000), not a fault. */
export function isRollover(previous: Dec, current: Dec, rolloverAt: Dec): boolean {
  const prev = d(previous);
  const curr = d(current);
  const top = d(rolloverAt);
  if (curr.gte(prev)) return false;
  return prev.gte(top.mul(d(1).minus(ROLLOVER_FRACTION))) && curr.lte(top.mul(ROLLOVER_FRACTION));
}

/**
 * Units consumed from `previous` to `current` (× multiplier, 3 decimals): the difference, or across a rollover the
 * rest of the range plus the new register. A decrease that is not a rollover has no consumption (null): it is a
 * fault for the review queue, never a negative bill.
 */
export function consumption(
  previous: Dec,
  current: Dec,
  rolloverAt: Dec,
  multiplier: Dec = 1,
): Decimal | null {
  const prev = d(previous);
  const curr = d(current);
  let units: Decimal;
  if (curr.gte(prev)) units = curr.minus(prev);
  else if (isRollover(prev, curr, rolloverAt))
    units = d(rolloverAt).plus(REGISTER_STEP).minus(prev).plus(curr);
  else return null;
  return units.mul(d(multiplier)).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

export interface HistoryPoint {
  register: Dec;
  readAt: Date;
}

/**
 * Average consumption per day of the trailing history (at most `maxDays` back from the newest point), ignoring
 * intervals that are faults; null with fewer than two points or less than a day of history.
 */
export function trailingDailyAverage(history: HistoryPoint[], rolloverAt: Dec, maxDays = 90): Decimal | null {
  const sorted = [...history].sort((a, b) => a.readAt.getTime() - b.readAt.getTime());
  if (sorted.length < 2) return null;
  const newest = sorted[sorted.length - 1]!.readAt.getTime();
  const window = sorted.filter((p) => newest - p.readAt.getTime() <= maxDays * 86_400_000);
  if (window.length < 2) return null;
  let units = d(0);
  let ms = 0;
  for (let i = 1; i < window.length; i += 1) {
    const c = consumption(window[i - 1]!.register, window[i]!.register, rolloverAt);
    if (c === null) continue;
    units = units.plus(c);
    ms += window[i]!.readAt.getTime() - window[i - 1]!.readAt.getTime();
  }
  if (ms < 86_400_000) return null;
  return units.div(ms / 86_400_000);
}

export interface Band {
  expected: Decimal;
  low: Decimal;
  high: Decimal;
}

/** Expected consumption since the previous reading ± `pct` % (D-035 plausibility band, default ±60 %). */
export function plausibilityBand(dailyAverage: Decimal, days: number, pct: Dec): Band {
  const expected = dailyAverage.mul(Math.max(days, 0));
  const spread = expected.mul(d(pct)).div(100);
  return {
    expected: expected.toDecimalPlaces(3),
    low: Decimal.max(0, expected.minus(spread)).toDecimalPlaces(3),
    high: expected.plus(spread).toDecimalPlaces(3),
  };
}

export type ReviewReasonKey =
  | 'decreasing_without_swap'
  | 'out_of_band'
  | 'ocr_low_confidence'
  | 'clock_suspect'
  | 'missing_photo'
  | 'non_monotonic';

export interface Classification {
  state: 'accepted' | 'pending_review';
  reason: ReviewReasonKey | null;
  consumption: Decimal | null;
  isRollover: boolean;
  band: Band | null;
}

/**
 * The review decision of a new reading (D-035): a decrease that is not a rollover → review
 * (`decreasing_without_swap`); a register below the previous one is never accepted silently; a consumption outside
 * the band → `out_of_band`; an OCR value below the confidence threshold or disagreeing with the typed value →
 * `ocr_low_confidence`. Everything else is accepted.
 */
export function classifyReading(input: {
  previous: { register: Dec; readAt: Date } | null;
  /** The assignment's opening register when there is no previous reading. */
  initialRegister: Dec;
  register: Dec;
  readAt: Date;
  rolloverAt: Dec;
  multiplier?: Dec;
  dailyAverage: Decimal | null;
  plausibilityPct: Dec;
  /** OCR checks apply when the value came from OCR. */
  ocr?: { confidence: Dec; minConfidence: Dec; typedValue: Dec | null; value: Dec } | null;
  /** IoT readings flagged by the gateway go to review instead of being accepted. */
  forceReview?: ReviewReasonKey | null;
}): Classification {
  const base = input.previous ? d(input.previous.register) : d(input.initialRegister);
  const rollover = isRollover(base, input.register, input.rolloverAt);
  const units = consumption(base, input.register, input.rolloverAt, input.multiplier ?? 1);
  if (units === null)
    return {
      state: 'pending_review',
      reason: 'decreasing_without_swap',
      consumption: null,
      isRollover: false,
      band: null,
    };
  if (input.forceReview)
    return {
      state: 'pending_review',
      reason: input.forceReview,
      consumption: units,
      isRollover: rollover,
      band: null,
    };
  if (input.ocr) {
    const lowConfidence = d(input.ocr.confidence).lt(d(input.ocr.minConfidence));
    const disagrees = input.ocr.typedValue !== null && !d(input.ocr.typedValue).eq(d(input.ocr.value));
    if (lowConfidence || disagrees)
      return {
        state: 'pending_review',
        reason: 'ocr_low_confidence',
        consumption: units,
        isRollover: rollover,
        band: null,
      };
  }
  let band: Band | null = null;
  if (input.previous && input.dailyAverage !== null) {
    const days = (input.readAt.getTime() - input.previous.readAt.getTime()) / 86_400_000;
    if (days >= 1) {
      band = plausibilityBand(input.dailyAverage, days, input.plausibilityPct);
      if (units.lt(band.low) || units.gt(band.high))
        return {
          state: 'pending_review',
          reason: 'out_of_band',
          consumption: units,
          isRollover: rollover,
          band,
        };
    }
  }
  return { state: 'accepted', reason: null, consumption: units, isRollover: rollover, band };
}

export interface AssignmentWindow {
  id: string;
  validFrom: Date;
  validTo: Date | null;
  initialReading: Dec;
  finalReading: Dec | null;
  rolloverAt: Dec;
  multiplier: Dec;
}

export interface AcceptedReading {
  assignmentId: string;
  register: Dec;
  readAt: Date;
}

/**
 * Consumption of one position (a unit's meter for one utility, or a common-area meter) between two instants,
 * summed over every assignment active in the window (schema-design §4.3): per assignment, from the register at the
 * window start (the last accepted reading at or before it, else the opening register) to the register at the window
 * end (the last accepted reading at or before it, or the closing register when the assignment closed inside the
 * window), rollover-aware, × multiplier. Assignments without a reading inside the window contribute what their
 * opening/closing registers prove, or nothing.
 */
export function positionConsumption(
  assignments: AssignmentWindow[],
  readings: AcceptedReading[],
  from: Date,
  to: Date,
): Decimal {
  let total = d(0);
  for (const a of assignments) {
    const start = a.validFrom.getTime() > from.getTime() ? a.validFrom : from;
    const end = a.validTo && a.validTo.getTime() < to.getTime() ? a.validTo : to;
    if (start.getTime() >= end.getTime()) continue;
    const own = readings
      .filter((r) => r.assignmentId === a.id)
      .sort((x, y) => x.readAt.getTime() - y.readAt.getTime());
    const atOrBefore = (t: Date) => [...own].reverse().find((r) => r.readAt.getTime() <= t.getTime());
    const inside = own.filter(
      (r) => r.readAt.getTime() > start.getTime() && r.readAt.getTime() <= end.getTime(),
    );
    const startReading = atOrBefore(start);
    // the opening register at the assignment's start; otherwise the last reading before the window, or (unknown
    // start) the first reading inside it — never more than the readings prove
    const startRegister =
      start.getTime() === a.validFrom.getTime()
        ? a.initialReading
        : (startReading?.register ?? inside.shift()?.register ?? null);
    if (startRegister === null) continue;
    const closesInside = a.validTo !== null && a.validTo.getTime() <= to.getTime() && a.finalReading !== null;
    const endRegister = closesInside ? a.finalReading! : (atOrBefore(end)?.register ?? null);
    if (endRegister === null) continue;
    // sum interval by interval so several rollovers inside the window are counted
    const points = [startRegister, ...inside.map((r) => r.register)];
    if (closesInside) points.push(endRegister);
    for (let i = 1; i < points.length; i += 1) {
      const c = consumption(points[i - 1]!, points[i]!, a.rolloverAt, a.multiplier);
      if (c !== null) total = total.plus(c);
    }
  }
  return total.toDecimalPlaces(3);
}
