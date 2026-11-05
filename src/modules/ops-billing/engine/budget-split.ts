import Decimal from 'decimal.js';

import { type BudgetSplitBy } from './rate-tiers';

/**
 * Budget split (J1.1b, D-304 = D-J03, D-324). Pure. A budget amount is divided over units by a weight (ownership
 * ratio, m², ตารางวา or one per unit): each unit gets `round(total × weight / Σ weights)` half-up to satang and the
 * satang remainder against the total goes to the **largest weight (ties: first unit id)**, so the parts always sum to
 * the budget line exactly. Units without a weight are reported (`missing`) and are not part of the split.
 */
export interface SplitUnit {
  unitId: string;
  areaSqm: string | null;
  ownershipRatio: string | null;
  landAreaSqwa: string | null;
}

export interface SplitResult {
  amounts: Map<string, string>;
  weights: Map<string, string>;
  totalWeight: string;
  missing: string[];
}

const D = (v: Decimal.Value) => new Decimal(v);

/** The weight of a unit for a split basis; null = the unit lacks the value (or it is zero). */
export function weightOf(u: SplitUnit, by: BudgetSplitBy): string | null {
  const v =
    by === 'per_unit'
      ? '1'
      : by === 'area_sqm'
        ? u.areaSqm
        : by === 'land_area_sqwa'
          ? u.landAreaSqwa
          : u.ownershipRatio;
  return v !== null && D(v).gt(0) ? D(v).toString() : null;
}

export function splitBudget(total: Decimal.Value, units: SplitUnit[], by: BudgetSplitBy): SplitResult {
  const amount = D(total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const weights = new Map<string, string>();
  const missing: string[] = [];
  for (const u of [...units].sort((a, b) => a.unitId.localeCompare(b.unitId))) {
    const w = weightOf(u, by);
    if (w === null) missing.push(u.unitId);
    else weights.set(u.unitId, w);
  }
  const totalWeight = [...weights.values()].reduce((s, w) => s.plus(w), D(0));
  const amounts = new Map<string, string>();
  if (totalWeight.isZero()) return { amounts, weights, totalWeight: '0', missing };
  const parts = [...weights.entries()].map(([unitId, w]) => ({
    unitId,
    w: D(w),
    amount: amount.times(w).div(totalWeight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  }));
  const diff = amount.minus(parts.reduce((s, p) => s.plus(p.amount), D(0)));
  if (!diff.isZero()) {
    const largest = [...parts].sort((a, b) => b.w.cmp(a.w) || a.unitId.localeCompare(b.unitId))[0]!;
    largest.amount = largest.amount.plus(diff);
  }
  for (const p of parts) amounts.set(p.unitId, p.amount.toFixed(2));
  return { amounts, weights, totalWeight: totalWeight.toString(), missing };
}

/** The amount a budget tier bills for a cycle of `months` months (monthly exact × months, rounded once). */
export function periodBudget(tiers: { amount: string; period?: 'month' | 'year' }, months: number): string {
  const monthly = tiers.period === 'year' ? D(tiers.amount).div(12) : D(tiers.amount);
  return monthly.times(months).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** min / median / max / Σ of a list of money amounts (the rate-plan preview). */
export function moneyStats(values: string[]): { min: string; median: string; max: string; sum: string } {
  if (!values.length) return { min: '0.00', median: '0.00', max: '0.00', sum: '0.00' };
  const sorted = values.map(D).sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]!.plus(sorted[mid]!).div(2).toDecimalPlaces(2);
  return {
    min: sorted[0]!.toFixed(2),
    median: median.toFixed(2),
    max: sorted[sorted.length - 1]!.toFixed(2),
    sum: sorted.reduce((s, v) => s.plus(v), D(0)).toFixed(2),
  };
}

/**
 * Transfer proration of an issued line (J1.1b): the part of `amount` for the days from `transferDate` to the end of
 * the line's period, by calendar days with the same cumulative rounding as J1.1a (line − round(line × before / days)).
 */
export function amountFromDate(
  amount: Decimal.Value,
  period: { from: string; to: string },
  transferDate: string,
): string {
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const days = (day(period.to) - day(period.from)) / 86_400_000 + 1;
  if (transferDate <= period.from) return D(amount).toFixed(2);
  if (transferDate > period.to) return '0.00';
  const before = (day(transferDate) - day(period.from)) / 86_400_000;
  const kept = D(amount).times(before).div(days).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return D(amount).minus(kept).toFixed(2);
}

/** Splits an amount by shares (percent of 100): half-up each, remainder to the largest share (ties: first party id). */
export function splitByShares(
  amount: Decimal.Value,
  shares: { partyId: string; sharePct: string }[],
): Map<string, string> {
  const sum = shares.reduce((s, x) => s.plus(x.sharePct), D(0));
  // shares below 100 % bill only their own part (never scale a share up, D-323)
  const total = sum.gte(100)
    ? D(amount)
    : D(amount).times(sum).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const parts = shares.map((x) => ({
    ...x,
    amount: D(amount).times(x.sharePct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  }));
  const diff = total.minus(parts.reduce((s, p) => s.plus(p.amount), D(0)));
  if (!diff.isZero() && parts.length) {
    const largest = [...parts].sort(
      (a, b) => D(b.sharePct).cmp(a.sharePct) || a.partyId.localeCompare(b.partyId),
    )[0]!;
    largest.amount = largest.amount.plus(diff);
  }
  return new Map(parts.map((p) => [p.partyId, p.amount.toFixed(2)]));
}
