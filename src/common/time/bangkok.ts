/**
 * Time is stored in UTC (`timestamptz`); business rules are evaluated in Asia/Bangkok
 * (CLAUDE.md hard rules). Thailand has used UTC+07:00 without daylight saving since 1920, so a
 * fixed offset is exact for every date getproperty handles.
 */
export const BANGKOK_TZ = 'Asia/Bangkok';
const OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of the Bangkok calendar day containing `instant`. */
export function bangkokDate(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Day of week in Bangkok, 0 = Sunday (same numbering as `business_calendars.weekend_days`). */
export function bangkokDayOfWeek(instant: Date): number {
  return new Date(instant.getTime() + OFFSET_MS).getUTCDay();
}

/** The UTC instant of 00:00 Bangkok on `day` (`YYYY-MM-DD`). */
export function startOfBangkokDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`Not a date: ${day}`);
  return new Date(Date.parse(`${day}T00:00:00Z`) - OFFSET_MS);
}

/** `day` shifted by `days` calendar days (`YYYY-MM-DD` in, out). */
/** Midnight in Bangkok on the first day of the instant's Bangkok month. */
export function startOfBangkokMonth(instant: Date): Date {
  return startOfBangkokDay(`${bangkokDate(instant).slice(0, 8)}01`);
}

export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO 8601 with the Bangkok offset, the wire format for date-times (contract §3). */
export function toBangkokIso(instant: Date): string {
  return `${new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 19)}+07:00`;
}

/** Minutes since 00:00 Bangkok. */
export function bangkokMinuteOfDay(instant: Date): number {
  const local = new Date(instant.getTime() + OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

export const MS_PER_DAY = DAY_MS;
