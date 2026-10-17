import { consumption, trailingDailyAverage } from '@modules/smart-readings/reading-rules';
import Decimal from 'decimal.js';

/**
 * Which accepted reading closes a period for a meter assignment (D-031, D-012, D-030) and what an estimate is when
 * none arrives. Pure.
 */
export type ReadingSourceName = 'iot' | 'ocr' | 'manual' | 'estimated';

export interface CandidateReading {
  id: string;
  register: string;
  readAt: Date;
  source: ReadingSourceName;
  confidence: string;
  isFinal?: boolean;
  isInstall?: boolean;
  evidenceDocumentId?: string | null;
  quality?: string | null;
}

export interface SelectionWindows {
  /** `readings.iot_window_minutes` (±, D-031). */
  iotMinutes: number;
  /** `readings.round_window_days` before the cut-off for staff/OCR readings (D-187). */
  manualDaysBefore: number;
  /** Staff/OCR readings after the cut-off count until the grace deadline (`billing.reading_grace_hours`). */
  graceUntil: Date;
}

/** Whether a reading may close the period at `at` under the windows. */
export function inWindow(r: CandidateReading, at: Date, w: SelectionWindows): boolean {
  const dt = r.readAt.getTime() - at.getTime();
  if (r.source === 'estimated') return false;
  if (r.source === 'iot') return Math.abs(dt) <= w.iotMinutes * 60_000;
  return dt >= -w.manualDaysBefore * 86_400_000 && r.readAt.getTime() <= w.graceUntil.getTime();
}

/**
 * The reading that closes a period (D-031): among the accepted, non-estimated readings inside the window, the one
 * with the **highest confidence**; ties go to the one closest to the cut-off, then the later one. Readings marked
 * final (move-out / swap registers) win at a move-out instant.
 */
export function selectClosingReading(
  candidates: CandidateReading[],
  at: Date,
  w: SelectionWindows,
  preferFinal = false,
): CandidateReading | null {
  const eligible = candidates.filter((r) => inWindow(r, at, w));
  if (!eligible.length) return null;
  const score = (r: CandidateReading) => new Decimal(r.confidence);
  return [...eligible].sort((a, b) => {
    if (preferFinal && Boolean(a.isFinal) !== Boolean(b.isFinal)) return a.isFinal ? -1 : 1;
    const c = score(b).comparedTo(score(a));
    if (c !== 0) return c;
    const da = Math.abs(a.readAt.getTime() - at.getTime());
    const db = Math.abs(b.readAt.getTime() - at.getTime());
    if (da !== db) return da - db;
    return b.readAt.getTime() - a.readAt.getTime();
  })[0]!;
}

export interface EstimateResult {
  register: string;
  basis: {
    method: 'trailing_daily_average';
    fromReadingId: string;
    fromRegister: string;
    fromReadAt: string;
    dailyAverage: string;
    days: string;
    historyPoints: number;
  };
}

/**
 * An estimated register at `at` (D-031: the trailing average, flagged and settled on the next actual reading): the
 * last actual register + the trailing daily average × days since it (3 decimals, never below the last register);
 * null when the history cannot support an average (≥ 2 points over ≥ 1 day within 90 days).
 */
export function estimateRegister(
  history: CandidateReading[],
  at: Date,
  rolloverAt: Decimal | string | number,
): EstimateResult | null {
  const actual = history.filter((h) => h.source !== 'estimated' && h.readAt.getTime() <= at.getTime());
  if (!actual.length) return null;
  const last = [...actual].sort((a, b) => b.readAt.getTime() - a.readAt.getTime())[0]!;
  const avg = trailingDailyAverage(
    actual.map((h) => ({ register: h.register, readAt: h.readAt })),
    rolloverAt,
  );
  if (avg === null) return null;
  const days = new Decimal(at.getTime() - last.readAt.getTime()).div(86_400_000);
  const register = new Decimal(last.register).plus(avg.times(days)).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return {
    register: Decimal.max(register, new Decimal(last.register)).toFixed(3),
    basis: {
      method: 'trailing_daily_average',
      fromReadingId: last.id,
      fromRegister: new Decimal(last.register).toFixed(3),
      fromReadAt: last.readAt.toISOString(),
      dailyAverage: avg.toDecimalPlaces(3).toFixed(3),
      days: days.toDecimalPlaces(4).toFixed(4),
      historyPoints: actual.length,
    },
  };
}

export interface SegmentReading {
  readingId: string | null;
  register: string;
  readAt: string;
  source: ReadingSourceName | 'assignment';
  confidence: string | null;
  isEstimated: boolean;
  evidenceDocumentId: string | null;
}

export interface MeterSegment {
  assignmentId: string;
  assetItemId: string;
  code: string;
  multiplier: string;
  rolloverAt: string;
  from: SegmentReading;
  /** null = no closing reading yet. */
  to: SegmentReading | null;
}

/** Units of a segment (rollover-aware × multiplier); null when a reading is missing or the register went down. */
export function segmentUnits(s: MeterSegment): Decimal | null {
  if (!s.to) return null;
  return consumption(s.from.register, s.to.register, s.rolloverAt, s.multiplier);
}
