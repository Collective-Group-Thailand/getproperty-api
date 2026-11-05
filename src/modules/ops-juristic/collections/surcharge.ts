import Decimal from 'decimal.js';

/**
 * Surcharge of a ladder `surcharge` step (D-305, D-326; compliance `compliance.<legal_form>.surcharge_cap`,
 * ⚖ O-038 — off by default). Pure:
 * - per overdue invoice, on the **principal** still open (late-fee lines excluded — never a surcharge on a surcharge),
 * - simple interest by calendar days: `principal × rate % ÷ 100 × days ÷ 365`, from max(due date, the day the case was
 *   last surcharged through) to the step day,
 * - rate = min(the tenant's rate, the legal form's cap); after `escalateAfterDays` past the due date the escalated
 *   rate = min(tenant's escalated rate (else its rate), escalated cap (else cap)),
 * - rounded half-up to the satang per invoice; Σ of the rounded parts is the charge.
 */
export interface SurchargeInvoice {
  invoiceId: string;
  /** `YYYY-MM-DD` due date (Asia/Bangkok). */
  dueOn: string;
  /** Principal still open (balance − open late fees), decimal string. */
  principal: string;
}

export interface SurchargeRates {
  ratePct: string;
  capPct: string;
  escalatedRatePct?: string | null;
  escalatedCapPct?: string | null;
  escalateAfterDays?: number | null;
}

export interface SurchargePart {
  invoiceId: string;
  from: string;
  to: string;
  days: number;
  escalatedDays: number;
  amount: string;
}

const DAY = 86_400_000;
const n = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
const iso = (x: number) => new Date(x * DAY).toISOString().slice(0, 10);
const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);

export function computeSurcharge(
  invoices: readonly SurchargeInvoice[],
  rates: SurchargeRates,
  through: string,
  since: string | null,
): { total: string; parts: SurchargePart[] } {
  const rate = min(new Decimal(rates.ratePct), new Decimal(rates.capPct));
  const escRate = min(
    new Decimal(rates.escalatedRatePct ?? rates.ratePct),
    new Decimal(rates.escalatedCapPct ?? rates.capPct),
  );
  const parts: SurchargePart[] = [];
  let total = new Decimal(0);
  for (const inv of invoices) {
    const principal = new Decimal(inv.principal);
    if (principal.lte(0)) continue;
    const start = Math.max(n(inv.dueOn), since ? n(since) : -Infinity);
    const end = n(through);
    const days = end - start;
    if (days <= 0) continue;
    const escFrom =
      rates.escalateAfterDays === null || rates.escalateAfterDays === undefined
        ? Infinity
        : n(inv.dueOn) + rates.escalateAfterDays;
    const escalatedDays = Math.max(0, end - Math.max(start, escFrom));
    const normalDays = days - escalatedDays;
    const amount = principal
      .times(rate.times(normalDays).plus(escRate.times(escalatedDays)))
      .div(100)
      .div(365)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (amount.lte(0)) continue;
    total = total.plus(amount);
    parts.push({
      invoiceId: inv.invoiceId,
      from: iso(start),
      to: iso(end),
      days,
      escalatedDays,
      amount: amount.toFixed(2),
    });
  }
  return { total: total.toFixed(2), parts };
}
