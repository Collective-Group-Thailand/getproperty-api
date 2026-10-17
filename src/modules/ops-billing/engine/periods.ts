import Decimal from 'decimal.js';

/**
 * Billing-period arithmetic on Bangkok calendar dates (`YYYY-MM-DD`, D-031, D-041). Pure; the services convert
 * instants with `bangkokDate`.
 */
const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => iso(t(d) + n * DAY);
/** Inclusive number of days from `from` to `to`. */
export const daysInclusive = (from: string, to: string): number => Math.round((t(to) - t(from)) / DAY) + 1;
export const maxDate = (a: string, b: string): string => (a >= b ? a : b);
export const minDate = (a: string, b: string): string => (a <= b ? a : b);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export interface ProRata {
  /** Days billed (inclusive). */
  days: number;
  /** Calendar days of the billing period (inclusive). */
  daysInPeriod: number;
  /** days / daysInPeriod, 6 decimals (documentation; amounts use the exact fraction). */
  factor: string;
  from: string;
  to: string;
}

/**
 * The share of a period a lease covers (D-041: pro-rata by calendar days for partial first/last months): the
 * intersection of the billing period and the occupancy; null when they do not overlap.
 */
export function proRata(
  period: { start: string; end: string },
  occupancy: { from: string; to: string },
): ProRata | null {
  const from = maxDate(period.start, occupancy.from);
  const to = minDate(period.end, occupancy.to);
  if (from > to) return null;
  const days = daysInclusive(from, to);
  const daysInPeriod = daysInclusive(period.start, period.end);
  return {
    days,
    daysInPeriod,
    factor: new Decimal(days).div(daysInPeriod).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6),
    from,
    to,
  };
}

/** `amount × days / daysInPeriod`, half-up to satang; the full amount for a full period (D-046). */
export function proRataAmount(amount: Decimal.Value, p: ProRata): string {
  if (p.days === p.daysInPeriod) return new Decimal(amount).toFixed(2);
  return new Decimal(amount)
    .times(p.days)
    .div(p.daysInPeriod)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/**
 * Due date of an invoice (D-191): the first date after the period end whose day of the month is the lease's rent
 * due day (`lease.billing_day`, the contract's "ภายในวันที่ … ของทุกเดือน"; 5 when the lease has none — the
 * standard contract's default), but never earlier than issue + `invoice.min_lead_days` (ข้อ 4 (8)).
 */
export function dueDateFor(input: {
  periodEnd: string;
  issuedOn: string;
  dueDay: number;
  minLeadDays: number;
}): string {
  const [y, m, d] = input.periodEnd.split('-').map(Number) as [number, number, number];
  const day = Math.min(Math.max(1, input.dueDay), 31);
  let year = y;
  let month = m;
  let candidate: string;
  const sameMonth = Math.min(day, daysInMonth(y, m));
  if (sameMonth > d) {
    candidate = `${y}-${String(m).padStart(2, '0')}-${String(sameMonth).padStart(2, '0')}`;
  } else {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, daysInMonth(year, month))).padStart(2, '0')}`;
  }
  return maxDate(candidate, addDays(input.issuedOn, input.minLeadDays));
}

/** Rent in force on a date: the lease rent, replaced by recorded changes from their effective date (D-176). */
export function rentOn(
  base: string,
  changes: { effectiveFrom: string; rent: string }[],
  day: string,
): string {
  let rent = base;
  for (const c of [...changes].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)))
    if (c.effectiveFrom <= day) rent = c.rent;
  return rent;
}

/** Sub-ranges of `[from, to]` with a constant rent (a recorded change inside the range splits it). */
export function rentSegments(
  base: string,
  changes: { effectiveFrom: string; rent: string }[],
  from: string,
  to: string,
): { from: string; to: string; rent: string }[] {
  const cuts = changes
    .map((c) => c.effectiveFrom)
    .filter((d) => d > from && d <= to)
    .sort();
  const out: { from: string; to: string; rent: string }[] = [];
  let start = from;
  for (const cut of [...new Set(cuts)]) {
    out.push({ from: start, to: addDays(cut, -1), rent: rentOn(base, changes, start) });
    start = cut;
  }
  out.push({ from: start, to, rent: rentOn(base, changes, start) });
  return out;
}
