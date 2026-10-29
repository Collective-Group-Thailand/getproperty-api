import { addCalendarDays, bangkokDate } from '@common/time/bangkok';

import { bankAccountIn } from './message-safety';

/**
 * Verified building reviews (G9, D-301) — pure rules: who may review a lease and when, what a review may say and how
 * tenure is shown. A review comes only from verified tenure: a lease that was activated, reviewed by a party who lived
 * under it, **after move-out** (within `review.window_after_end_days`) or **after `review.min_tenure_months`** of
 * tenure (LIFF GL4).
 */

export type LeaseStatusName =
  'draft' | 'pending_signature' | 'active' | 'notice_given' | 'ending' | 'ended' | 'terminated' | 'cancelled';

export interface TenureLease {
  status: LeaseStatusName;
  startDate: Date;
  endDate: Date;
  activatedAt: Date | null;
  moveInAt: Date | null;
  moveOutAt: Date | null;
  endedAt: Date | null;
  terminatedAt: Date | null;
}

export interface Tenure {
  /** Bangkok date the person started living there (move-in, else the lease start). */
  from: string;
  /** Bangkok date it ended (move-out, else the end / termination), null while living there. */
  to: string | null;
}

export type Eligibility =
  | { eligible: true; tenure: Tenure }
  | {
      eligible: false;
      reason: 'not_started' | 'too_early' | 'window_closed';
      eligibleFrom: string | null;
      tenure: Tenure | null;
    };

const LIVING = ['active', 'notice_given', 'ending'] as const;
const ENDED = ['ended', 'terminated'] as const;

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

/** `YYYY-MM-DD` + n calendar months (end-of-month clamped). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The tenure of a lease as the reviewer lived it; null when the lease never started. */
export function tenureOf(lease: TenureLease): Tenure | null {
  if (!lease.activatedAt || !([...LIVING, ...ENDED] as string[]).includes(lease.status)) return null;
  const from = lease.moveInAt ? bangkokDate(lease.moveInAt) : dateOf(lease.startDate);
  if ((LIVING as readonly string[]).includes(lease.status)) return { from, to: null };
  const end = lease.moveOutAt ?? lease.terminatedAt ?? lease.endedAt;
  const to = end ? bangkokDate(end) : dateOf(lease.endDate);
  return { from, to: to < from ? from : to };
}

/** Whether the lease may be reviewed today (Bangkok date `today`). */
export function reviewEligibility(
  lease: TenureLease,
  today: string,
  rules: { minTenureMonths: number; windowAfterEndDays: number },
): Eligibility {
  const tenure = tenureOf(lease);
  if (!tenure) return { eligible: false, reason: 'not_started', eligibleFrom: null, tenure: null };
  if (tenure.to) {
    const closes = addCalendarDays(tenure.to, rules.windowAfterEndDays);
    return today <= closes
      ? { eligible: true, tenure }
      : { eligible: false, reason: 'window_closed', eligibleFrom: null, tenure };
  }
  const from = addMonths(tenure.from, rules.minTenureMonths);
  return today >= from
    ? { eligible: true, tenure }
    : { eligible: false, reason: 'too_early', eligibleFrom: from, tenure };
}

/** Tenure as shown publicly: months only (`YYYY-MM`), never exact dates (re-identification, D-025). */
export function tenureMonths(tenure: { from: string; to: string | null }): {
  from: string;
  to: string | null;
} {
  return { from: tenure.from.slice(0, 7), to: tenure.to ? tenure.to.slice(0, 7) : null };
}

// ------------------------------------------------------------------------------------------- screening

export type PersonalDataKind = 'bank_account' | 'phone' | 'email' | 'line_id' | 'link' | 'national_id';

const THAI_DIGITS = /[๐-๙]/g;
const normalise = (text: string) =>
  text.normalize('NFKC').replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50));

const PHONE = /(?<!\d)(?:\+?66[- ]?|0)[1-9](?:[- ]?\d){7,8}(?!\d)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LINE_ID =
  /\bline\s*id\s*[:：]?\s*@?[A-Za-z0-9._-]{3,}|\bline\s*[:：]\s*@?[A-Za-z0-9._-]{3,}|(?:ไอดีไลน์|ไลน์)\s*[:：]?\s*@?[A-Za-z0-9._-]{3,}|(?<![A-Za-z0-9])@[A-Za-z0-9._-]{4,}/i;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|co\.th|in\.th|net|org|me|ly|io|th)\b/i;
const NATIONAL_ID = /(?<!\d)\d(?:[- ]?\d){12}(?!\d)/;

/**
 * What personal or contact data a review / reply carries (refused, `review.personal_data`): bank accounts (D-267
 * message safety), phone numbers, e-mail addresses, LINE ids, links and 13-digit ID numbers — protects the reviewer,
 * the owner and other residents (D-025) and keeps reviews from becoming ads.
 */
export function personalDataIn(text: string): PersonalDataKind[] {
  const t = normalise(text);
  const found: PersonalDataKind[] = [];
  if (NATIONAL_ID.test(t)) found.push('national_id');
  if (bankAccountIn(text) && !found.includes('national_id')) found.push('bank_account');
  if (PHONE.test(t)) found.push('phone');
  if (EMAIL.test(t)) found.push('email');
  else if (LINE_ID.test(t)) found.push('line_id');
  if (LINK.test(t.replace(new RegExp(EMAIL.source, 'g'), ' '))) found.push('link');
  return found;
}

/** Collapses whitespace runs and trims; null for an empty text. */
export function cleanText(text: string | null | undefined): string | null {
  const t = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length ? t : null;
}

export interface RatingSummary {
  count: number;
  /** Decimal string with one decimal, null without reviews. */
  average: string | null;
  /** Count per star, index 0 = 1 star. */
  distribution: [number, number, number, number, number];
}

/** Count, average (half-up to one decimal) and distribution of published ratings. */
export function summarise(ratings: number[]): RatingSummary {
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const r of ratings) if (r >= 1 && r <= 5) distribution[(r - 1) as 0 | 1 | 2 | 3 | 4] += 1;
  const count = distribution.reduce((a, b) => a + b, 0);
  const sum = distribution.reduce((a, n, i) => a + n * (i + 1), 0);
  return {
    count,
    average: count ? (Math.round((sum * 10) / count) / 10).toFixed(1) : null,
    distribution,
  };
}
