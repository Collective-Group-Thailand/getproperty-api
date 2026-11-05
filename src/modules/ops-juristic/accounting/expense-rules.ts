import {
  type ApprovalBand,
  approvalBandsProblems,
  BAND_ROLES,
  type BandRole,
  DEFAULT_APPROVAL_BANDS,
  DEFAULT_WHT_RATES,
  type WhtRate,
  whtRatesProblems,
} from '@core/settings/juristic-accounting-settings';
import Decimal from 'decimal.js';

export {
  type ApprovalBand,
  approvalBandsProblems,
  BAND_ROLES,
  type BandRole,
  DEFAULT_APPROVAL_BANDS,
  DEFAULT_WHT_RATES,
  type WhtRate,
  whtRatesProblems,
};

/**
 * Expense rules (D-311 = D-J10, D-091, D-329) — pure. Approval bands are the setting `juristic.approval_bands`
 * (amount → roles + approvals needed); withholding-tax rates are the setting `juristic.wht_rates` (data, ⚖ O-041).
 */

/** The band an amount falls into, with a stable key (`le:10000.00` · `gt:100000.00`). */
export function bandFor(
  bands: readonly ApprovalBand[],
  amount: Decimal.Value,
): ApprovalBand & { key: string } {
  const a = new Decimal(amount.toString());
  let previous: string | null = null;
  for (const b of bands) {
    if (b.upTo === null || a.lte(b.upTo))
      return { ...b, key: b.upTo === null ? `gt:${previous ?? '0.00'}` : `le:${b.upTo}` };
    previous = b.upTo;
  }
  const last = bands[bands.length - 1]!;
  return { ...last, key: `gt:${previous ?? '0.00'}` };
}

const halfUp = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** WHT of a line: (amount − VAT) × rate %, half-up to the satang. */
export function whtOf(amount: Decimal.Value, vat: Decimal.Value, ratePct: Decimal.Value): string {
  return halfUp(
    new Decimal(amount.toString()).minus(vat.toString()).times(ratePct.toString()).div(100),
  ).toFixed(2);
}

/** The 50 ทวิ form of a payee: a company → ภ.ง.ด.53, a person → ภ.ง.ด.3. */
export const whtFormOf = (partyType: string): 'pnd3' | 'pnd53' => (partyType === 'person' ? 'pnd3' : 'pnd53');
