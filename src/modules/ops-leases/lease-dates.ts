/** Calendar-date helpers for leases (`YYYY-MM-DD`, Bangkok business dates; CLAUDE.md "Time"). */
const DAY = 86_400_000;

export const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return isoDate(new Date(toDate(iso).getTime() + days * DAY));
}

/** `start` + n months − 1 day: a 12-month lease from 2026-11-01 ends 2027-10-31; month ends clamp (Jan 31 → Feb 28). */
export function endDateFor(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const targetMonth = m - 1 + months;
  const year = y + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(year, month, Math.min(d, lastDay)));
  return isoDate(new Date(end.getTime() - DAY));
}

/** Months of a term with an explicit end date: the smallest n whose `endDateFor(start, n)` reaches `end` (≤ 360). */
export function monthsBetween(start: string, end: string): number {
  for (let n = 1; n <= 360; n += 1) if (endDateFor(start, n) >= end) return n;
  return 360;
}
