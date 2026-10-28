import Decimal from 'decimal.js';

import { type ChargeLine, type Charges } from './pricing';

/**
 * Pure rules of G5 (D-287, D-291, D-297): what a boost / media-service product is (the `terms` of a price-plan version),
 * a boost's window, the sponsored slots of a public results page, the monthly fee invoice and a dispute's credit.
 * Every price comes from a price-plan version — nothing here is a commercial value.
 */

export const BOOST_PRODUCT = 'boost';
export const MEDIA_PRODUCT = 'media_service';
/** `snapshot.product` of the monthly success / co-broke fee invoice. */
export const FEES_PRODUCT = 'growth_fees';

export type BoostTarget = 'listing' | 'building';
export type MediaService = 'verified_photo' | 'tour_360';

export interface BoostTerms {
  product: typeof BOOST_PRODUCT;
  target: BoostTarget;
  days: number | null;
  months: number | null;
}

export interface MediaTerms {
  product: typeof MEDIA_PRODUCT;
  service: MediaService;
}

const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The boost terms of a version (`{product: boost, target, days | months}`), or null when it is not a boost. */
export function boostTermsOf(terms: unknown): BoostTerms | null {
  if (!terms || typeof terms !== 'object') return null;
  const t = terms as Record<string, unknown>;
  if (t.product !== BOOST_PRODUCT || (t.target !== 'listing' && t.target !== 'building')) return null;
  const days = intIn(t.days, 1, 366) ? t.days : null;
  const months = intIn(t.months, 1, 12) ? t.months : null;
  if ((days === null) === (months === null)) return null;
  return { product: BOOST_PRODUCT, target: t.target, days, months };
}

/** The media-service terms of a version (`{product: media_service, service}`), or null. */
export function mediaTermsOf(terms: unknown): MediaTerms | null {
  if (!terms || typeof terms !== 'object') return null;
  const t = terms as Record<string, unknown>;
  if (t.product !== MEDIA_PRODUCT || (t.service !== 'verified_photo' && t.service !== 'tour_360'))
    return null;
  return { product: MEDIA_PRODUCT, service: t.service };
}

/** Adds calendar months to an instant (UTC fields; a day the target month lacks becomes its last day). */
export function addMonths(instant: Date, months: number): Date {
  const d = new Date(instant.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * The window of a boost activated at `now`: it starts now, or right after the target's last boost still in force
 * (`queuedAfter`, a paid boost never overlaps an earlier one), and lasts `days` × 24 h or `months` calendar months.
 */
export function boostWindow(
  now: Date,
  duration: { days: number | null; months: number | null },
  queuedAfter: Date | null,
): { startsAt: Date; endsAt: Date } {
  const startsAt = queuedAfter && queuedAfter > now ? queuedAfter : now;
  const endsAt = duration.days
    ? new Date(startsAt.getTime() + duration.days * 86_400_000)
    : addMonths(startsAt, duration.months ?? 1);
  return { startsAt, endsAt };
}

export interface SponsoredCandidate {
  id: string;
  verifiedVacant: boolean;
  publishedAt: Date;
}

/**
 * The sponsored listings of one results page (D-297): candidates (boosted listings matching the query) ranked by
 * verified vacancy (D-296), then freshness, then id; page k shows ranks k·N … k·N+N−1, so each boosted listing appears
 * once across pages; N = `boost.search.max_per_page` (0 = no sponsored slots).
 */
export function sponsoredSlots<T extends SponsoredCandidate>(
  candidates: readonly T[],
  pageIndex: number,
  perPage: number,
): T[] {
  if (perPage <= 0 || pageIndex < 0) return [];
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.verifiedVacant) - Number(a.verifiedVacant) ||
      b.publishedAt.getTime() - a.publishedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ranked.slice(pageIndex * perPage, pageIndex * perPage + perPage);
}

const money = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** One purchase line (boost / media service) at a version's price and VAT rate. */
export function purchaseCharges(
  kind: 'boost' | 'media_service',
  description: string,
  unitPrice: string,
  vatRate: string,
): Charges {
  const amount = money(unitPrice);
  const vat = money(amount.times(vatRate));
  return {
    lines: [
      {
        kind,
        description,
        quantity: '1.000',
        unitPrice: new Decimal(unitPrice).toFixed(4),
        amount: amount.toFixed(2),
      },
    ],
    subtotal: amount.toFixed(2),
    discount: '0.00',
    vatAmount: vat.toFixed(2),
    total: amount.plus(vat).toFixed(2),
  };
}

export interface FeeAccrualInput {
  id: string;
  kind: 'success_fee' | 'co_broke_fee';
  /** `YYYY-MM` of `accrued_on` (Bangkok). */
  month: string;
  amount: string;
  vatRate: string;
  description: string;
}

export interface FeeCap {
  kind: 'success_fee' | 'co_broke_fee';
  month: string;
  /** `terms.monthlyCapAmount` of the fee version in force on the month's last day; null = no cap. */
  capAmount: string | null;
}

export interface FeeInvoiceDraft {
  charges: Charges;
  /** The net charged per accrual after a monthly cap (pro rata), with its VAT rate — what a dispute credits. */
  charged: { id: string; lineIndex: number; net: string; vatRate: string }[];
  capped: { kind: string; month: string; total: string; cap: string; discount: string }[];
}

/**
 * The monthly fee invoice of one agency (D-297): one line per accrual (kind success_fee / co_broke_fee); per month and
 * kind a cap (`monthlyCapAmount`) above the sum becomes a negative `discount` line; VAT at each accrual's version rate
 * on its net (the cap is shared pro rata, the rounding remainder on the last accrual of the group).
 */
export function feeInvoice(accruals: readonly FeeAccrualInput[], caps: readonly FeeCap[]): FeeInvoiceDraft {
  const lines: ChargeLine[] = accruals.map((a) => ({
    kind: a.kind,
    description: a.description,
    quantity: '1.000',
    unitPrice: new Decimal(a.amount).toFixed(4),
    amount: money(a.amount).toFixed(2),
  }));
  const charged: FeeInvoiceDraft['charged'] = accruals.map((a, i) => ({
    id: a.id,
    lineIndex: i,
    net: money(a.amount).toFixed(2),
    vatRate: a.vatRate,
  }));
  const capped: FeeInvoiceDraft['capped'] = [];
  let discount = new Decimal(0);
  const groups = new Map<string, number[]>();
  accruals.forEach((a, i) => {
    const key = `${a.month}|${a.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const [key, idx] of groups) {
    const [month, kind] = key.split('|') as [string, FeeAccrualInput['kind']];
    const cap = caps.find((c) => c.kind === kind && c.month === month)?.capAmount ?? null;
    if (cap === null || !/^\d{1,12}(\.\d{1,2})?$/.test(cap)) continue;
    const total = idx.reduce((s, i) => s.plus(money(accruals[i]!.amount)), new Decimal(0));
    if (total.lte(cap)) continue;
    const off = total.minus(cap);
    discount = discount.plus(off);
    capped.push({
      kind,
      month,
      total: total.toFixed(2),
      cap: money(cap).toFixed(2),
      discount: off.toFixed(2),
    });
    let left = money(cap);
    idx.forEach((i, n) => {
      const share =
        n === idx.length - 1 ? left : money(money(accruals[i]!.amount).times(cap).dividedBy(total));
      left = left.minus(share);
      charged[i]!.net = share.toFixed(2);
    });
    lines.push({
      kind: 'discount',
      description: `เพดานค่าธรรมเนียมรายเดือน ${month} (${kind === 'success_fee' ? 'success fee' : 'co-broke fee'})`,
      quantity: '1.000',
      unitPrice: off.negated().toFixed(4),
      amount: off.negated().toFixed(2),
    });
  }
  const subtotal = accruals.reduce((s, a) => s.plus(money(a.amount)), new Decimal(0));
  const vat = charged.reduce((s, c) => s.plus(money(new Decimal(c.net).times(c.vatRate))), new Decimal(0));
  return {
    charges: {
      lines,
      subtotal: subtotal.toFixed(2),
      discount: discount.toFixed(2),
      vatAmount: vat.toFixed(2),
      total: subtotal.minus(discount).plus(vat).toFixed(2),
    },
    charged,
    capped,
  };
}

/** What a dispute credits for one accrual: its charged net plus its VAT (D-297), never more than the open room. */
export function disputeCredit(net: string, vatRate: string, room: string): string {
  const gross = money(net).plus(money(new Decimal(net).times(vatRate)));
  return Decimal.min(gross, new Decimal(room)).toFixed(2);
}
