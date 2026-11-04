import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';

/** `billing.cutoff` (D-031): `day` = `end_of_month` or 1–28, `time` = HH:mm Asia/Bangkok. */
export interface CutoffSetting {
  day: 'end_of_month' | number;
  time: string;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The cut-off instant of the Bangkok month `year`-`month` (1-based). */
export function cutoffOf(setting: CutoffSetting, year: number, month: number): Date {
  const day =
    setting.day === 'end_of_month' ? daysIn(year, month) : Math.min(setting.day, daysIn(year, month));
  const [h, m] = (/^\d{2}:\d{2}$/.test(setting.time) ? setting.time : '23:59').split(':').map(Number);
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(startOfBangkokDay(date).getTime() + (h! * 60 + m!) * 60_000);
}

/**
 * The billing period an instant belongs to (D-031): the next cut-off at or after `at` closes it; the period key is
 * the Bangkok month of that cut-off (`2026-11`), the period starts right after the previous cut-off.
 */
export function periodOf(setting: CutoffSetting, at: Date): { key: string; start: Date; cutoff: Date } {
  const [y, mo] = bangkokDate(at).split('-').map(Number) as [number, number];
  let year = y;
  let month = mo;
  let cutoff = cutoffOf(setting, year, month);
  if (cutoff.getTime() < at.getTime()) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cutoff = cutoffOf(setting, year, month);
  }
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return {
    key: `${year}-${String(month).padStart(2, '0')}`,
    start: new Date(cutoffOf(setting, prevYear, prevMonth).getTime() + 1),
    cutoff,
  };
}

/** Period bounds of a period key `YYYY-MM`. */
export function periodBounds(setting: CutoffSetting, key: string): { start: Date; end: Date } {
  const [year, month] = key.split('-').map(Number) as [number, number];
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return {
    start: new Date(cutoffOf(setting, prevYear, prevMonth).getTime() + 1),
    end: cutoffOf(setting, year, month),
  };
}

// ------------------------------------------------------------------------------------------- frequencies (J1.1a)

/** `ops.billing_frequency` (D-303 = D-J02). */
export type BillingFrequencyName = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** Months a period of each frequency stands for (rate amounts are per month). */
export const MONTHS_OF: Record<BillingFrequencyName, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

const KEY_PATTERNS: [BillingFrequencyName, RegExp][] = [
  ['monthly', /^(\d{4})-(0[1-9]|1[0-2])$/],
  ['quarterly', /^(\d{4})-Q([1-4])$/],
  ['semiannual', /^(\d{4})-H([12])$/],
  ['annual', /^(\d{4})$/],
];

/** The period key pattern of every frequency (`YYYY-MM`, `YYYY-Qn`, `YYYY-Hn`, `YYYY`) — DTO validation. */
export const PERIOD_KEY_PATTERN = /^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4]|-H[12])?$/;

/** The frequency a period key belongs to, or null when the key is malformed. */
export function frequencyOfKey(key: string): BillingFrequencyName | null {
  for (const [frequency, re] of KEY_PATTERNS) if (re.test(key)) return frequency;
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => `${year}-${pad(month)}-${pad(daysIn(year, month))}`;

/**
 * Calendar bounds (Bangkok dates, inclusive) of a non-monthly key: quarters, halves and years are calendar-aligned
 * (1 Jan / 1 Apr / 1 Jul / 1 Oct) and billed in advance — they do not follow the meter cut-off of `billing.cutoff`.
 */
export function calendarPeriod(key: string): { start: string; end: string; frequency: BillingFrequencyName } {
  const frequency = frequencyOfKey(key);
  if (!frequency || frequency === 'monthly') throw new Error(`not a calendar period key: ${key}`);
  const year = Number(key.slice(0, 4));
  const index = frequency === 'annual' ? 1 : Number(key.slice(6));
  const months = MONTHS_OF[frequency];
  const firstMonth = (index - 1) * months + 1;
  const endMonth = firstMonth + months - 1;
  return { start: `${year}-${pad(firstMonth)}-01`, end: lastDay(year, endMonth), frequency };
}

/** The key of the non-monthly period of `frequency` that contains the Bangkok date `day` (`YYYY-MM-DD`). */
export function periodKeyFor(frequency: Exclude<BillingFrequencyName, 'monthly'>, day: string): string {
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  if (frequency === 'annual') return year;
  if (frequency === 'semiannual') return `${year}-H${month <= 6 ? 1 : 2}`;
  return `${year}-Q${Math.ceil(month / 3)}`;
}
