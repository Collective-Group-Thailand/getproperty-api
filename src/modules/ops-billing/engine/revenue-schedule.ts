import Decimal from 'decimal.js';

import { addDays, daysInclusive, minDate } from './periods';

/**
 * Unearned revenue recognised monthly (J1.1a, D-303 = D-J02): an invoice line billed in advance for more than one
 * month is spread over the calendar months it covers by calendar days, with cumulative half-up rounding so the rows
 * sum to the line amount exactly. Pure; persisted as `juristic.revenue_schedule` when the invoice is issued.
 */
export interface ScheduleRow {
  /** First day of the calendar month (`YYYY-MM-01`). */
  month: string;
  amount: string;
}

const monthEnd = (d: string): string => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export function monthlySchedule(amount: Decimal.Value, from: string, to: string): ScheduleRow[] {
  const total = new Decimal(amount);
  const n = daysInclusive(from, to);
  if (n <= 0) return [];
  const cum = (days: number) => total.times(days).div(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const rows: ScheduleRow[] = [];
  let start = from;
  let done = 0;
  while (start <= to) {
    const end = minDate(monthEnd(start), to);
    const days = daysInclusive(start, end);
    rows.push({
      month: `${start.slice(0, 7)}-01`,
      amount: cum(done + days)
        .minus(cum(done))
        .toFixed(2),
    });
    done += days;
    start = addDays(end, 1);
  }
  return rows;
}
