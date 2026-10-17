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
