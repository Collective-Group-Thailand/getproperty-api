import { addCalendarDays, bangkokDate, bangkokDayOfWeek, startOfBangkokDay } from '@common/time/bangkok';

import { type AvailabilityException, type WeeklySlot } from './listings.service';

export interface Availability {
  weekly: WeeklySlot[];
  exceptions: AvailabilityException[];
  slotMinutes: number;
}

export interface SlotRules {
  now: Date;
  minNoticeHours: number;
  horizonDays: number;
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

const MINUTE = 60_000;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The viewing windows of one Bangkok day (minutes of the day): the day's exception wins over the weekly windows. */
export function windowsOn(day: string, availability: Availability): { from: number; to: number }[] {
  const exception = availability.exceptions.find((e) => e.date === day);
  if (exception) {
    if (exception.closed || !exception.from || !exception.to) return [];
    return [{ from: minutes(exception.from), to: minutes(exception.to) }];
  }
  const weekday = bangkokDayOfWeek(startOfBangkokDay(day));
  return availability.weekly
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ from: minutes(w.from), to: minutes(w.to) }));
}

/** Every slot of one Bangkok day, in order: each window cut into `slotMinutes` pieces from its start. */
export function slotsOn(day: string, availability: Availability): Slot[] {
  const step = availability.slotMinutes;
  const midnight = startOfBangkokDay(day).getTime();
  const starts = new Set<number>();
  for (const window of windowsOn(day, availability))
    for (let m = window.from; m + step <= window.to; m += step) starts.add(m);
  return [...starts]
    .sort((a, b) => a - b)
    .map((m) => ({
      startsAt: new Date(midnight + m * MINUTE),
      endsAt: new Date(midnight + (m + step) * MINUTE),
    }));
}

/** Whether a slot may be booked now: not earlier than the notice, not later than the horizon. */
export function withinRules(startsAt: Date, rules: SlotRules): boolean {
  const t = startsAt.getTime();
  const earliest = rules.now.getTime() + rules.minNoticeHours * 60 * MINUTE;
  const latest = rules.now.getTime() + rules.horizonDays * 24 * 60 * MINUTE;
  return t >= earliest && t <= latest;
}

/** The slot that starts exactly at `startsAt` (a slot of the availability within the rules), or null. */
export function slotAt(startsAt: Date, availability: Availability, rules: SlotRules): Slot | null {
  if (!withinRules(startsAt, rules)) return null;
  return (
    slotsOn(bangkokDate(startsAt), availability).find((s) => s.startsAt.getTime() === startsAt.getTime()) ??
    null
  );
}

/** Free slots from `fromDay` for `days` days (within the rules), leaving out the ranges already taken. */
export function freeSlots(
  availability: Availability,
  rules: SlotRules,
  fromDay: string,
  days: number,
  taken: Slot[],
): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < days; i += 1) {
    for (const slot of slotsOn(addCalendarDays(fromDay, i), availability)) {
      if (!withinRules(slot.startsAt, rules)) continue;
      const clash = taken.some(
        (t) => t.startsAt.getTime() < slot.endsAt.getTime() && slot.startsAt.getTime() < t.endsAt.getTime(),
      );
      if (!clash) out.push(slot);
    }
  }
  return out;
}
