import { bangkokDate, bangkokDayOfWeek, bangkokMinuteOfDay } from '@common/time/bangkok';

/**
 * Pure rules of B5.3 community (D-073, blueprint A1.6) — no I/O, unit-tested.
 */

/** Languages residents read (D-014 R2: six languages; Thai is the body, the others translations). */
export const TRANSLATION_LANGUAGES = ['en', 'my', 'km', 'lo', 'zh'] as const;
export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

export interface Translation {
  title?: string;
  body: string;
}
export type Translations = Partial<Record<TranslationLanguage, Translation>>;

/** Keeps the known languages with a non-empty body (unknown keys and empties are dropped). */
export function cleanTranslations(input: unknown): Translations {
  const out: Translations = {};
  if (!input || typeof input !== 'object') return out;
  for (const lang of TRANSLATION_LANGUAGES) {
    const t = (input as Record<string, unknown>)[lang] as { title?: unknown; body?: unknown } | undefined;
    if (t && typeof t.body === 'string' && t.body.trim())
      out[lang] = {
        body: t.body.trim().slice(0, 10_000),
        ...(typeof t.title === 'string' && t.title.trim() ? { title: t.title.trim().slice(0, 200) } : {}),
      };
  }
  return out;
}

/** The text in the reader's language, falling back to Thai. */
export function localized(
  base: { title: string; bodyTh: string },
  translations: unknown,
  language: string | null | undefined,
): { language: string; title: string; body: string } {
  const t = cleanTranslations(translations)[language as TranslationLanguage];
  if (language && language !== 'th' && t) return { language, title: t.title ?? base.title, body: t.body };
  return { language: 'th', title: base.title, body: base.bodyTh };
}

/** Who an announcement is for: everyone of its building(s), or the listed floors / units only. */
export interface AudienceFilter {
  floorIds?: string[];
  unitIds?: string[];
}

export function cleanAudience(input: unknown): AudienceFilter {
  const out: AudienceFilter = {};
  if (!input || typeof input !== 'object') return out;
  const f = input as Record<string, unknown>;
  const ids = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, 500) : [];
  if (ids(f.floorIds).length) out.floorIds = ids(f.floorIds);
  if (ids(f.unitIds).length) out.unitIds = ids(f.unitIds);
  return out;
}

export function inAudience(filter: AudienceFilter, unit: { id: string; floorId: string | null }): boolean {
  if (!filter.floorIds?.length && !filter.unitIds?.length) return true;
  return (
    (filter.unitIds?.includes(unit.id) ?? false) ||
    (!!unit.floorId && (filter.floorIds?.includes(unit.floorId) ?? false))
  );
}

// ------------------------------------------------------------------------------------------------- bookings

export interface BookingPolicy {
  slotMinutes: number;
  /** Local opening hours `HH:MM` (Asia/Bangkok). */
  openFrom: string;
  openTo: string;
  maxDurationMinutes: number;
  maxAdvanceDays: number;
  /** Live bookings of one unit for this facility in one week (Monday–Sunday, Asia/Bangkok). */
  maxPerUnitPerWeek: number;
  requiresApproval: boolean;
}

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  slotMinutes: 60,
  openFrom: '08:00',
  openTo: '22:00',
  maxDurationMinutes: 120,
  maxAdvanceDays: 14,
  maxPerUnitPerWeek: 2,
  requiresApproval: false,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** A policy from stored / sent JSON, every field defaulted and bounded. */
export function bookingPolicy(input: unknown): BookingPolicy {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<
    Record<keyof BookingPolicy, unknown>
  >;
  const int = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d;
  const time = (v: unknown, d: string) => (typeof v === 'string' && HHMM.test(v) ? v : d);
  const policy: BookingPolicy = {
    slotMinutes: int(p.slotMinutes, DEFAULT_BOOKING_POLICY.slotMinutes, 15, 720),
    openFrom: time(p.openFrom, DEFAULT_BOOKING_POLICY.openFrom),
    openTo: time(p.openTo, DEFAULT_BOOKING_POLICY.openTo),
    maxDurationMinutes: int(p.maxDurationMinutes, DEFAULT_BOOKING_POLICY.maxDurationMinutes, 15, 1440),
    maxAdvanceDays: int(p.maxAdvanceDays, DEFAULT_BOOKING_POLICY.maxAdvanceDays, 0, 365),
    maxPerUnitPerWeek: int(p.maxPerUnitPerWeek, DEFAULT_BOOKING_POLICY.maxPerUnitPerWeek, 1, 50),
    requiresApproval: typeof p.requiresApproval === 'boolean' ? p.requiresApproval : false,
  };
  if (minutesOf(policy.openTo) <= minutesOf(policy.openFrom)) {
    policy.openFrom = DEFAULT_BOOKING_POLICY.openFrom;
    policy.openTo = DEFAULT_BOOKING_POLICY.openTo;
  }
  return policy;
}

/** Problems of a requested booking against the policy (empty = fine). Quota and overlaps are checked against data. */
export function bookingProblems(policy: BookingPolicy, startsAt: Date, endsAt: Date, now: Date): string[] {
  const problems: string[] = [];
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes <= 0) problems.push('the booking must end after it starts');
  if (minutes % policy.slotMinutes !== 0) problems.push(`book whole slots of ${policy.slotMinutes} minutes`);
  if (minutes > policy.maxDurationMinutes) problems.push(`at most ${policy.maxDurationMinutes} minutes`);
  if (startsAt.getTime() < now.getTime()) problems.push('the booking starts in the past');
  if (startsAt.getTime() - now.getTime() > policy.maxAdvanceDays * 86_400_000)
    problems.push(`at most ${policy.maxAdvanceDays} days ahead`);
  if (bangkokDate(startsAt) !== bangkokDate(new Date(endsAt.getTime() - 1)))
    problems.push('a booking stays within one day');
  const from = bangkokMinuteOfDay(startsAt);
  const to = from + minutes;
  if (from < minutesOf(policy.openFrom) || to > minutesOf(policy.openTo))
    problems.push(`open ${policy.openFrom}–${policy.openTo}`);
  if ((from - minutesOf(policy.openFrom)) % policy.slotMinutes !== 0)
    problems.push(`start on a slot boundary from ${policy.openFrom}`);
  return problems;
}

/** Monday 00:00 and the next Monday 00:00 (Asia/Bangkok) of the week containing `at`, as instants. */
export function bangkokWeek(at: Date): { from: Date; to: Date } {
  const day = bangkokDate(at);
  const dow = bangkokDayOfWeek(at); // 0 = Sunday
  const back = (dow + 6) % 7;
  const monday = new Date(Date.parse(`${day}T00:00:00+07:00`) - back * 86_400_000);
  return { from: monday, to: new Date(monday.getTime() + 7 * 86_400_000) };
}

/** A 6-digit pick-up PIN (no leading zero). */
export { generatePin as parcelPin } from '../smart-access/access-rules';
