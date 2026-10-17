import { type SlaCalendar, type SlaPolicy } from './definition';

/** Which days count for `business` SLAs: weekends and holidays (host supplies the holiday list). */
export interface BusinessCalendar {
  /** Local date `YYYY-MM-DD` in the calendar's time zone. */
  isHoliday(localDate: string): boolean;
  readonly timeZone: string;
}

export interface Duration {
  days: number;
  hours: number;
  minutes: number;
}

export function parseDuration(iso: string): Duration {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m || iso === 'P' || iso.endsWith('T')) throw new Error(`invalid ISO 8601 duration "${iso}"`);
  return { days: Number(m[1] ?? 0), hours: Number(m[2] ?? 0), minutes: Number(m[3] ?? 0) };
}

const localDate = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    at,
  );

const weekday = (at: Date, timeZone: string): number =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at),
  );

/** True on Saturday/Sunday or a holiday of the calendar (in its time zone). */
export function isNonBusinessDay(at: Date, calendar: BusinessCalendar): boolean {
  const wd = weekday(at, calendar.timeZone);
  return wd === 0 || wd === 6 || calendar.isHoliday(localDate(at, calendar.timeZone));
}

/**
 * `start + duration`. Calendar SLAs add exact time. Business SLAs add whole days one at a time, skipping
 * non-business days (the time of day is kept; a start on a non-business day counts from the next business day),
 * then add the hours/minutes as calendar time.
 */
export function addDuration(
  start: Date,
  duration: Duration,
  mode: SlaCalendar,
  calendar: BusinessCalendar,
): Date {
  const DAY = 86_400_000;
  let at = new Date(start.getTime());
  if (mode === 'business') {
    let remaining = duration.days;
    while (remaining > 0) {
      at = new Date(at.getTime() + DAY);
      if (!isNonBusinessDay(at, calendar)) remaining -= 1;
    }
  } else {
    at = new Date(at.getTime() + duration.days * DAY);
  }
  return new Date(at.getTime() + duration.hours * 3_600_000 + duration.minutes * 60_000);
}

/** Resolves a policy to a duration; `settingValue` is the number read from `settingKey` by the host. */
export function policyDuration(policy: SlaPolicy, settingValue?: number): Duration {
  if (policy.duration) return parseDuration(policy.duration);
  if (settingValue === undefined || !Number.isFinite(settingValue) || settingValue <= 0)
    throw new Error(`SLA setting ${policy.settingKey} has no positive value`);
  return policy.settingUnit === 'hours'
    ? { days: 0, hours: settingValue, minutes: 0 }
    : { days: settingValue, hours: 0, minutes: 0 };
}

export interface SlaTimes {
  dueAt: Date;
  warnAt: Date | null;
  /** Reminder times (`remindBefore`) still in the future of the clock start, earliest first. */
  remindAt: Date[];
}

const ms = (d: Duration) => d.days * 86_400_000 + d.hours * 3_600_000 + d.minutes * 60_000;

export function slaTimes(
  policy: SlaPolicy,
  clockStart: Date,
  calendar: BusinessCalendar,
  settingValue?: number,
): SlaTimes {
  const dueAt = addDuration(clockStart, policyDuration(policy, settingValue), policy.calendar, calendar);
  const remindAt = (policy.remindBefore ?? [])
    .map((r) => new Date(dueAt.getTime() - ms(parseDuration(r))))
    .filter((at) => at.getTime() > clockStart.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  if (!policy.warnBefore) return { dueAt, warnAt: null, remindAt };
  const warnAt = new Date(dueAt.getTime() - ms(parseDuration(policy.warnBefore)));
  return { dueAt, warnAt: warnAt.getTime() > clockStart.getTime() ? warnAt : null, remindAt };
}
