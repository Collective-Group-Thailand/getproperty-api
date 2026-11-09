import Decimal from 'decimal.js';

/**
 * Pure rules of J3.3 management contracts (D-334): calendar billing periods of the fee, proration by days of service,
 * due dates in arrears. Dates are `YYYY-MM-DD` business dates (Asia/Bangkok); ranges are inclusive.
 */

export type FeePeriod = 'monthly' | 'quarterly' | 'annual';

export interface FeePeriodSlice {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  /** First and last day of service inside the period. */
  serviceStart: string;
  serviceEnd: string;
  serviceDays: number;
  periodDays: number;
}

const DAY = 86_400_000;
const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, '0');
export const daysInclusive = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY) + 1;
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);

/** Months per period. */
const SPAN: Record<FeePeriod, number> = { monthly: 1, quarterly: 3, annual: 12 };

/** The calendar period of `period` that contains `day`. */
export function periodOf(period: FeePeriod, day: string): { key: string; start: string; end: string } {
  const y = +day.slice(0, 4);
  const m = +day.slice(5, 7);
  const span = SPAN[period];
  const firstMonth = Math.floor((m - 1) / span) * span + 1;
  const start = `${y}-${pad(firstMonth)}-01`;
  const end = iso(Date.UTC(y, firstMonth - 1 + span, 1) - DAY);
  const key =
    period === 'monthly'
      ? `${y}-${pad(m)}`
      : period === 'quarterly'
        ? `${y}-Q${Math.floor((m - 1) / 3) + 1}`
        : `${y}`;
  return { key, start, end };
}

/** Every calendar period overlapping the service days [from, to], with the days of service in each. */
export function feePeriods(period: FeePeriod, from: string, to: string): FeePeriodSlice[] {
  if (to < from) return [];
  const out: FeePeriodSlice[] = [];
  let cursor = from;
  for (let guard = 0; guard < 1200 && cursor <= to; guard += 1) {
    const p = periodOf(period, cursor);
    const serviceEnd = p.end < to ? p.end : to;
    out.push({
      periodKey: p.key,
      periodStart: p.start,
      periodEnd: p.end,
      serviceStart: cursor,
      serviceEnd,
      serviceDays: daysInclusive(cursor, serviceEnd),
      periodDays: daysInclusive(p.start, p.end),
    });
    cursor = addDays(p.end, 1);
  }
  return out;
}

/** The fee of a slice: a whole period pays the fee, a part pays fee × days / days of the period, half-up. */
export function proratedFee(
  fee: Decimal.Value,
  vat: Decimal.Value,
  slice: Pick<FeePeriodSlice, 'serviceDays' | 'periodDays'>,
): { amount: string; vatAmount: string } {
  if (slice.serviceDays >= slice.periodDays)
    return { amount: new Decimal(fee).toFixed(2), vatAmount: new Decimal(vat).toFixed(2) };
  const part = (v: Decimal.Value) =>
    new Decimal(v)
      .times(slice.serviceDays)
      .div(slice.periodDays)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
  return { amount: part(fee), vatAmount: part(vat) };
}

/** In arrears: the `dueDay` of the month after the period ends. */
export function dueOnAfter(periodEnd: string, dueDay: number): string {
  const y = +periodEnd.slice(0, 4);
  const m = +periodEnd.slice(5, 7);
  return iso(Date.UTC(y, m, dueDay));
}

/** Last day of service: the day before a termination takes effect, else the end of the term. */
export function lastServiceDay(c: { endsOn: string; terminatedOn: string | null }): string {
  if (c.terminatedOn) {
    const before = addDays(c.terminatedOn, -1);
    return before < c.endsOn ? before : c.endsOn;
  }
  return c.endsOn;
}

/**
 * Slices whose fee may be requested on `today`: service in the slice has ended (its last service day is before
 * today) — the fee is never requested for days not yet served.
 */
export function chargeableSlices(
  c: { feePeriod: FeePeriod; startsOn: string; endsOn: string; terminatedOn: string | null },
  today: string,
): FeePeriodSlice[] {
  return feePeriods(c.feePeriod, c.startsOn, lastServiceDay(c)).filter(
    (s) => s.serviceDays > 0 && s.serviceEnd < today,
  );
}

/** Problems with the terms of a contract (empty = valid). */
export function termsProblems(t: {
  fee: string;
  vatAmount: string;
  dueDay: number;
  startsOn: string;
  endsOn: string;
}): { path: string; code: string; message: string }[] {
  const out: { path: string; code: string; message: string }[] = [];
  const money = /^\d{1,12}(\.\d{1,2})?$/;
  if (!money.test(t.fee) || new Decimal(t.fee).lte(0))
    out.push({ path: 'fee', code: 'money', message: 'a positive decimal string, 2 places' });
  if (!money.test(t.vatAmount))
    out.push({ path: 'vatAmount', code: 'money', message: 'a decimal string, 2 places' });
  else if (money.test(t.fee) && new Decimal(t.vatAmount).gt(t.fee))
    out.push({ path: 'vatAmount', code: 'range', message: 'not above the fee' });
  if (!Number.isInteger(t.dueDay) || t.dueDay < 1 || t.dueDay > 28)
    out.push({ path: 'dueDay', code: 'range', message: '1–28' });
  if (t.endsOn < t.startsOn) out.push({ path: 'endsOn', code: 'range', message: 'on or after startsOn' });
  else if (daysInclusive(t.startsOn, t.endsOn) > 366 * 10)
    out.push({ path: 'endsOn', code: 'range', message: 'a term of at most 10 years' });
  return out;
}
