import Decimal from 'decimal.js';

/** A published fee price-plan version as the accrual needs it (D-287, D-291; values from the price plan). */
export interface FeePrice {
  billingUnit: string;
  /** `percent_of_amount`: the percentage; `per_deal`: the flat fee. null = not on sale. */
  unitPrice: string | null;
  /** `basis`: `commission` (default) or `monthly_rent`; `capAmount`: a ceiling per deal (decimal string). */
  terms: { basis?: unknown; capAmount?: unknown };
}

export interface FeeBase {
  /** The commission recorded on the deal (or the co-broke share for the co-broke fee); null = not recorded. */
  commission: string | null;
  monthlyRent: string;
}

export interface FeeAmount {
  billingUnit: 'percent_of_amount' | 'per_deal';
  rate: string;
  baseAmount: string | null;
  amount: string;
  capped: boolean;
}

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const DECIMAL = /^\d{1,12}(\.\d{1,4})?$/;

/**
 * The fee of one deal (G2, D-293): `per_deal` = the flat price; `percent_of_amount` = price % of the base — the
 * recorded commission (`terms.basis = commission`, the default; a deal without a recorded commission falls back to
 * one month's rent) or the monthly rent (`terms.basis = monthly_rent`); `terms.capAmount` caps it. Answers null
 * when the version has no price or an unknown unit (not on sale — nothing is accrued, D-287).
 */
export function feeFor(price: FeePrice, base: FeeBase): FeeAmount | null {
  if (price.unitPrice === null || !DECIMAL.test(price.unitPrice)) return null;
  const rate = new Decimal(price.unitPrice);
  let amount: Decimal;
  let baseAmount: Decimal | null = null;
  let billingUnit: FeeAmount['billingUnit'];
  if (price.billingUnit === 'per_deal') {
    billingUnit = 'per_deal';
    amount = money(rate);
  } else if (price.billingUnit === 'percent_of_amount') {
    billingUnit = 'percent_of_amount';
    baseAmount =
      price.terms.basis === 'monthly_rent' || base.commission === null
        ? new Decimal(base.monthlyRent)
        : new Decimal(base.commission);
    amount = money(baseAmount.times(rate).dividedBy(100));
  } else return null;
  let capped = false;
  const cap = price.terms.capAmount;
  if (typeof cap === 'string' && DECIMAL.test(cap) && amount.gt(cap)) {
    amount = money(new Decimal(cap));
    capped = true;
  }
  return {
    billingUnit,
    rate: rate.toFixed(4),
    baseAmount: baseAmount ? money(baseAmount).toFixed(2) : null,
    amount: amount.toFixed(2),
    capped,
  };
}

/**
 * The commission recorded for a deal from the mandate's terms (ADR-0008: recorded, paid outside the platform): the
 * fixed amount when set, else the percentage of one month's rent; null when the mandate states neither. The co-broke
 * share is that commission × the agreement's split %.
 */
export function recordedCommission(
  terms: { amount: string | null; percent: string | null },
  monthlyRent: string,
): string | null {
  if (terms.amount !== null) return money(new Decimal(terms.amount)).toFixed(2);
  if (terms.percent !== null)
    return money(new Decimal(monthlyRent).times(terms.percent).dividedBy(100)).toFixed(2);
  return null;
}

export function coBrokeShare(commission: string | null, splitPercent: string): string | null {
  return commission === null
    ? null
    : money(new Decimal(commission).times(splitPercent).dividedBy(100)).toFixed(2);
}
