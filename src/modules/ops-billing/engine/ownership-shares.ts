import Decimal from 'decimal.js';

import { addDays, daysInclusive, maxDate, minDate } from './periods';

/**
 * Co-owner shares and ownership changes inside a billing period (J1.1a, D-303 = D-J02, D-307 = D-J06, D-323). Pure.
 *
 * - The period is cut at every ownership start and end (`core.unit_ownership.valid_to` is **exclusive**,
 *   `daterange(valid_from, valid_to)`), so a seller is billed from the period start to the day before the transfer and
 *   the buyer from the transfer date — never both in full.
 * - Each segment gets `round(P × cumEnd / N) − round(P × cumStart / N)` (half-up, cumulative by calendar days), so the
 *   segments of a fully owned period sum to the period amount P exactly.
 * - Inside a segment every owner gets `round(segment × share / 100)` half-up; the satang remainder against the target
 *   goes to the largest share (ties: the first by party id). The target is the segment amount when the shares sum to
 *   100 %, else `round(segment × Σ shares / 100)` and the result is flagged `incomplete` — an owner is never billed
 *   more than their share because the register lacks a co-owner.
 * - Consecutive slices of one party with the same share merge into one.
 */
export interface OwnershipRow {
  partyId: string;
  /** `share_pct`, 0 < x ≤ 100. */
  sharePct: string;
  /** First owned day (Bangkok date). */
  from: string;
  /** First day **not** owned any more (exclusive); null = open. */
  to: string | null;
}

export interface ShareSlice {
  partyId: string;
  sharePct: string;
  /** Inclusive Bangkok dates inside the period. */
  from: string;
  to: string;
  days: number;
  daysInPeriod: number;
  amount: string;
}

const D = (v: Decimal.Value) => new Decimal(v);
const m2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function allocateByOwnership(
  periodAmount: Decimal.Value,
  period: { start: string; end: string },
  rows: OwnershipRow[],
): { slices: ShareSlice[]; incomplete: boolean } {
  const total = D(periodAmount);
  const n = daysInclusive(period.start, period.end);
  const clipped = rows
    .map((r) => ({
      ...r,
      cFrom: maxDate(r.from, period.start),
      cTo: r.to === null ? period.end : minDate(addDays(r.to, -1), period.end),
    }))
    .filter((r) => r.cFrom <= r.cTo);
  const cuts = new Set<string>([period.start, addDays(period.end, 1)]);
  for (const r of clipped) {
    cuts.add(r.cFrom);
    cuts.add(addDays(r.cTo, 1));
  }
  const bounds = [...cuts].sort();
  const cumAt = (d: string) => m2(total.times(daysInclusive(period.start, d) - 1).div(n));
  const slices: ShareSlice[] = [];
  let incomplete = false;
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i]!;
    const next = bounds[i + 1]!;
    const to = addDays(next, -1);
    const owners = clipped.filter((r) => r.cFrom <= from && r.cTo >= to);
    if (!owners.length) continue;
    const segment = cumAt(next).minus(cumAt(from));
    const sumShares = owners.reduce((s, r) => s.plus(r.sharePct), D(0));
    if (sumShares.lt(100)) incomplete = true;
    const target = sumShares.gte(100) ? segment : m2(segment.times(sumShares).div(100));
    const parts = owners.map((r) => ({ r, amount: m2(segment.times(r.sharePct).div(100)) }));
    const diff = target.minus(parts.reduce((s, p) => s.plus(p.amount), D(0)));
    if (!diff.isZero()) {
      const largest = [...parts].sort(
        (a, b) => D(b.r.sharePct).cmp(a.r.sharePct) || a.r.partyId.localeCompare(b.r.partyId),
      )[0]!;
      largest.amount = largest.amount.plus(diff);
    }
    for (const p of parts) {
      const prev = slices.findLast((s) => s.partyId === p.r.partyId);
      if (prev && prev.to === addDays(from, -1) && D(prev.sharePct).eq(p.r.sharePct)) {
        prev.to = to;
        prev.days = daysInclusive(prev.from, to);
        prev.amount = D(prev.amount).plus(p.amount).toFixed(2);
        continue;
      }
      slices.push({
        partyId: p.r.partyId,
        sharePct: D(p.r.sharePct).toFixed(4),
        from,
        to,
        days: daysInclusive(from, to),
        daysInPeriod: n,
        amount: p.amount.toFixed(2),
      });
    }
  }
  slices.sort((a, b) => a.from.localeCompare(b.from) || a.partyId.localeCompare(b.partyId));
  return { slices, incomplete };
}
