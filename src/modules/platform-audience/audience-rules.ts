import { type QuietHours, quietUntil } from '@core/notifications/quiet-hours';
import Decimal from 'decimal.js';

import { type Charges } from '../platform-subscriptions/pricing';

/**
 * Pure rules of G6 (D-287, D-291, D-300): the closed segment schema, matching a person's preferences against a
 * campaign, the weekly frequency window, quiet hours and the per-recipient charges. Every commercial value (price,
 * minimum, cap, window) comes from a price-plan version or a setting — nothing here is one.
 */

export const RECOMMENDATIONS_PURPOSE = 'platform.recommendations';
export const SPONSORED_PRODUCT = 'sponsored_broadcast';
/** Default campaign minimum when a priced version does not say (G-growth-api G6: "default 500"). */
export const DEFAULT_MINIMUM_RECIPIENTS = 500;
/** LINE Messaging API: at most 500 user ids per multicast request (provider limit, not a business value). */
export const MULTICAST_LIMIT = 500;
export const AUDIENCE_LANGUAGES = ['th', 'en', 'my', 'km', 'lo', 'zh'] as const;
export type AudienceLanguage = (typeof AUDIENCE_LANGUAGES)[number];
export const UNIT_KINDS = ['condo_unit', 'house', 'townhouse', 'room'] as const;
export type AudienceUnitKind = (typeof UNIT_KINDS)[number];

/**
 * A campaign's segment — a closed whitelist (D-300): areas, budget, unit kinds, move-in window, languages. Nothing
 * else can be targeted; in particular no special-category data (PDPA s.26) and nothing the person did not type.
 */
export interface Segment {
  areas: string[];
  budgetMin: string | null;
  budgetMax: string | null;
  unitKinds: AudienceUnitKind[];
  moveInFrom: string | null;
  moveInTo: string | null;
  languages: AudienceLanguage[];
}

export const EMPTY_SEGMENT: Segment = {
  areas: [],
  budgetMin: null,
  budgetMax: null,
  unitKinds: [],
  moveInFrom: null,
  moveInTo: null,
  languages: [],
};

const SEGMENT_KEYS = new Set(Object.keys(EMPTY_SEGMENT));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const SLUG = /^[a-z0-9-]{1,100}$/;

export interface SegmentProblem {
  path: string;
  message: string;
}

/** Validates and normalises a stored or submitted segment; problems name the path. */
export function parseSegment(raw: unknown): { segment: Segment; problems: SegmentProblem[] } {
  const problems: SegmentProblem[] = [];
  const s: Segment = { ...EMPTY_SEGMENT, areas: [], unitKinds: [], languages: [] };
  if (raw === null || raw === undefined) return { segment: s, problems };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { segment: s, problems: [{ path: 'segment', message: 'an object' }] };
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r))
    if (!SEGMENT_KEYS.has(key)) problems.push({ path: `segment.${key}`, message: 'not a segment field' });
  const list = (key: 'areas' | 'unitKinds' | 'languages', ok: (v: string) => boolean, max: number) => {
    const v = r[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && ok(x))) {
      problems.push({ path: `segment.${key}`, message: `up to ${max} allowed values` });
      return [];
    }
    return [...new Set(v as string[])];
  };
  s.areas = list('areas', (x) => SLUG.test(x), 10);
  s.unitKinds = list(
    'unitKinds',
    (x) => (UNIT_KINDS as readonly string[]).includes(x),
    4,
  ) as AudienceUnitKind[];
  s.languages = list(
    'languages',
    (x) => (AUDIENCE_LANGUAGES as readonly string[]).includes(x),
    6,
  ) as AudienceLanguage[];
  const money = (key: 'budgetMin' | 'budgetMax') => {
    const v = r[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !MONEY.test(v)) {
      problems.push({ path: `segment.${key}`, message: 'a decimal string' });
      return null;
    }
    return new Decimal(v).toFixed(2);
  };
  s.budgetMin = money('budgetMin');
  s.budgetMax = money('budgetMax');
  if (s.budgetMin && s.budgetMax && new Decimal(s.budgetMin).gt(s.budgetMax))
    problems.push({ path: 'segment.budgetMax', message: 'not below budgetMin' });
  const day = (key: 'moveInFrom' | 'moveInTo') => {
    const v = r[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !DAY.test(v)) {
      problems.push({ path: `segment.${key}`, message: 'a date YYYY-MM-DD' });
      return null;
    }
    return v;
  };
  s.moveInFrom = day('moveInFrom');
  s.moveInTo = day('moveInTo');
  if (s.moveInFrom && s.moveInTo && s.moveInFrom > s.moveInTo)
    problems.push({ path: 'segment.moveInTo', message: 'not before moveInFrom' });
  return { segment: s, problems };
}

/** A person's preferences as matching needs them (decimal strings, ISO days). */
export interface PreferenceFacts {
  areaSlugs: string[];
  budgetMin: string | null;
  budgetMax: string | null;
  unitKinds: string[];
  moveInFrom: string | null;
  moveInTo: string | null;
  language: string;
}

/** What the campaign offers: its listings' rent and unit kind. */
export interface OfferedListing {
  rent: string;
  unitKind: string | null;
}

const overlaps = <T>(a: readonly T[], b: readonly T[]) =>
  !a.length || !b.length || a.some((x) => b.includes(x));

function rangesOverlap(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
  cmp: (x: string, y: string) => number,
): boolean {
  if (aFrom && bTo && cmp(aFrom, bTo) > 0) return false;
  if (bFrom && aTo && cmp(bFrom, aTo) > 0) return false;
  return true;
}

const money = (x: string, y: string) => new Decimal(x).comparedTo(y);
const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Whether a consenting person's preferences fit a campaign (D-300). A dimension the person or the segment left empty
 * does not restrict; when both set it, they must overlap. On top, at least one listing must fit the person's own
 * budget and unit kinds — nobody gets an ad for something they said they do not want.
 */
export function matchesSegment(
  p: PreferenceFacts,
  segment: Segment,
  listings: readonly OfferedListing[],
): boolean {
  if (!overlaps(p.areaSlugs, segment.areas)) return false;
  if (!overlaps(p.unitKinds, segment.unitKinds)) return false;
  if (segment.languages.length && !(segment.languages as string[]).includes(p.language)) return false;
  if (!rangesOverlap(p.budgetMin, p.budgetMax, segment.budgetMin, segment.budgetMax, money)) return false;
  if (!rangesOverlap(p.moveInFrom, p.moveInTo, segment.moveInFrom, segment.moveInTo, text)) return false;
  return listings.some(
    (l) =>
      (!p.budgetMin || new Decimal(l.rent).gte(p.budgetMin)) &&
      (!p.budgetMax || new Decimal(l.rent).lte(p.budgetMax)) &&
      (!p.unitKinds.length || (l.unitKind !== null && p.unitKinds.includes(l.unitKind))),
  );
}

/** Whether `at` is inside the person's quiet hours (their own, else the platform setting). */
export function inQuietHours(
  at: Date,
  own: { start: string; end: string } | null,
  fallback: QuietHours,
): boolean {
  return quietUntil(at, own ? { ...own, timezone: fallback.timezone } : fallback) !== null;
}

/** Start of the rolling frequency-cap window (7 × 24 h before `now`). */
export const capWindowStart = (now: Date): Date => new Date(now.getTime() - 7 * 86_400_000);

/** Campaign size an estimate may show: below the minimum the count is withheld (aggregate-only, D-300). */
export function shownEstimate(count: number, minimum: number, maxRecipients: number) {
  const capped = Math.min(count, maxRecipients);
  return capped >= minimum
    ? { estimated: capped, belowMinimum: false }
    : { estimated: null, belowMinimum: true };
}

const round2 = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** The charges of a sponsored campaign: delivered recipients × price per recipient (+ VAT at the version's rate). */
export function sponsoredCharges(
  description: string,
  delivered: number,
  pricePerRecipient: string,
  vatRate: string,
): Charges {
  const amount = round2(new Decimal(pricePerRecipient).times(delivered));
  const vat = round2(amount.times(vatRate));
  return {
    lines: [
      {
        kind: 'sponsored_broadcast',
        description,
        quantity: new Decimal(delivered).toFixed(3),
        unitPrice: new Decimal(pricePerRecipient).toFixed(4),
        amount: amount.toFixed(2),
      },
    ],
    subtotal: amount.toFixed(2),
    discount: '0.00',
    vatAmount: vat.toFixed(2),
    total: amount.plus(vat).toFixed(2),
  };
}

/** A price preview for `recipients` (null when the product has no price). */
export function costPreview(recipients: number, pricePerRecipient: string | null, vatRate: string) {
  if (pricePerRecipient === null) return null;
  const c = sponsoredCharges('', recipients, pricePerRecipient, vatRate);
  return { recipients, subtotal: c.subtotal, vatAmount: c.vatAmount, total: c.total };
}

/** The minimum recipients of a priced version's terms (`minimumRecipients`), else the default. */
export function minimumOf(terms: unknown): number {
  const v = (terms as Record<string, unknown> | null)?.minimumRecipients;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_MINIMUM_RECIPIENTS;
}

/** Whether a version is the sponsored-broadcast product (`terms.product`). */
export const isSponsoredProduct = (terms: unknown): boolean =>
  (terms as Record<string, unknown> | null)?.product === SPONSORED_PRODUCT;

/** The message language of a person: th, else en (the message templates are Thai and English). */
export const messageLanguage = (language: string): 'th' | 'en' => (language === 'th' ? 'th' : 'en');

export interface MessageListing {
  title: string;
  rent: string;
  place: string | null;
  imageUrl: string;
  url: string;
}

const TEXT = {
  th: {
    label: 'โฆษณา · ส่งจาก getproperty',
    perMonth: '/เดือน',
    view: 'ดูห้องนี้',
    whyTitle: 'ทำไมฉันได้รับข้อความนี้',
    why: 'คุณเลือกรับห้องแนะนำจาก getproperty ตามพื้นที่และงบที่คุณตั้งไว้ ข้อความนี้เป็นโฆษณาที่เจ้าของประกาศซื้อ เจ้าของไม่เห็นชื่อหรือข้อมูลของคุณ',
    stop: 'ตั้งค่า / เลิกรับ',
    alt: 'ห้องแนะนำ (โฆษณา) จาก getproperty',
  },
  en: {
    label: 'Sponsored · from getproperty',
    perMonth: '/month',
    view: 'View this place',
    whyTitle: 'Why did I get this?',
    why: 'You chose to receive recommended places from getproperty for the areas and budget you set. This is an ad the listing owner paid for; the owner never sees your name or details.',
    stop: 'Settings / stop',
    alt: 'Recommended places (sponsored) from getproperty',
  },
} as const;

const baht = (rent: string) =>
  `฿${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(rent))}`;

/**
 * The LINE message of a campaign in one language (D-300): a Flex carousel, every bubble labelled as an ad, the
 * listing's OG card, title, rent, place and the campaign's short link; a last bubble says why the person got it and
 * links to the settings page where withdrawing is one tap.
 */
export function sponsoredMessage(
  lang: 'th' | 'en',
  listings: readonly MessageListing[],
  settingsUrl: string,
) {
  const t = TEXT[lang];
  const bubbles: Record<string, unknown>[] = listings.map((l) => ({
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: t.label, size: 'xs', color: '#6B7280' }],
    },
    hero: { type: 'image', url: l.imageUrl, size: 'full', aspectRatio: '1.91:1', aspectMode: 'cover' },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: l.title.slice(0, 80), weight: 'bold', wrap: true },
        { type: 'text', text: `${baht(l.rent)}${t.perMonth}`, size: 'sm' },
        ...(l.place ? [{ type: 'text', text: l.place.slice(0, 60), size: 'xs', color: '#6B7280' }] : []),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: t.view, uri: l.url } }],
    },
  }));
  bubbles.push({
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: t.whyTitle, weight: 'bold', wrap: true },
        { type: 'text', text: t.why, size: 'sm', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'button', style: 'secondary', action: { type: 'uri', label: t.stop, uri: settingsUrl } },
      ],
    },
  });
  return [{ type: 'flex' as const, altText: t.alt, contents: { type: 'carousel', contents: bubbles } }];
}
