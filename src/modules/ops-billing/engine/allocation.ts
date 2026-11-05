import Decimal from 'decimal.js';

/** How a payment is spread over a payer's open invoices (`payments.allocation_policy`, D-308 / D-325). */
export type AllocationPolicy = 'oldest_first' | 'surcharge_first';
export const ALLOCATION_POLICIES: readonly AllocationPolicy[] = ['oldest_first', 'surcharge_first'];

export interface AllocationTarget {
  invoiceId: string;
  /** Ordering key: the issue instant (oldest first); ties by invoice id. */
  issuedAt: Date;
  /** What is still owed on the invoice (decimal string, > 0 to be paid). */
  balance: string;
  /** The open late-fee (surcharge) part of the balance (≤ balance). */
  surchargeOpen: string;
}

export interface AllocationSlice {
  invoiceId: string;
  /** Total paid to the invoice (decimal string, 2 dp). */
  amount: string;
  /** Of which the surcharge part. */
  surcharge: string;
}

export interface AllocationPlan {
  slices: AllocationSlice[];
  /** What is left after every target is paid: the payer's credit. */
  remainder: string;
}

const D = (v: Decimal.Value) => new Decimal(v);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);

/**
 * D-325 (J1.2a): spreads `amount` over any set of open invoices — one unit today, the units of one owner when a J1.2b
 * statement is paid. `oldest_first` (default, D-044): invoice by invoice by issue date, each one's surcharge before
 * its principal. `surcharge_first` (D-308): first the open surcharge of every invoice (oldest first), then the
 * principal (oldest first). Amounts are exact satang; what exceeds the targets is the remainder (payer credit).
 */
export function planAllocation(
  amount: Decimal.Value,
  targets: readonly AllocationTarget[],
  policy: AllocationPolicy,
): AllocationPlan {
  const ordered = [...targets]
    .filter((t) => D(t.balance).gt(0))
    .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime() || a.invoiceId.localeCompare(b.invoiceId));
  const state = new Map(
    ordered.map((t) => {
      const balance = D(t.balance);
      const surcharge = Decimal.max(0, Decimal.min(D(t.surchargeOpen), balance));
      return [
        t.invoiceId,
        { surcharge, principal: balance.minus(surcharge), paid: D(0), paidSurcharge: D(0) },
      ];
    }),
  );
  let remaining = Decimal.max(0, D(amount).toDecimalPlaces(2, Decimal.ROUND_DOWN));
  const take = (id: string, part: 'surcharge' | 'principal') => {
    if (remaining.lte(0)) return;
    const s = state.get(id)!;
    const open = part === 'surcharge' ? s.surcharge : s.principal;
    const x = Decimal.min(open, remaining);
    if (x.lte(0)) return;
    if (part === 'surcharge') {
      s.surcharge = s.surcharge.minus(x);
      s.paidSurcharge = s.paidSurcharge.plus(x);
    } else s.principal = s.principal.minus(x);
    s.paid = s.paid.plus(x);
    remaining = remaining.minus(x);
  };
  if (policy === 'surcharge_first') {
    for (const t of ordered) take(t.invoiceId, 'surcharge');
    for (const t of ordered) take(t.invoiceId, 'principal');
  } else
    for (const t of ordered) {
      take(t.invoiceId, 'surcharge');
      take(t.invoiceId, 'principal');
    }
  return {
    slices: ordered
      .map((t) => ({ id: t.invoiceId, s: state.get(t.invoiceId)! }))
      .filter((x) => x.s.paid.gt(0))
      .map((x) => ({ invoiceId: x.id, amount: money(x.s.paid), surcharge: money(x.s.paidSurcharge) })),
    remainder: money(remaining),
  };
}

/**
 * D-325: `n` instalments of `principal` — each half-up of principal ÷ n, the satang remainder on the last one so the
 * instalments sum to the principal exactly.
 */
export function splitInstalments(principal: Decimal.Value, n: number): string[] {
  const total = D(principal);
  const each = total.div(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const out = Array.from({ length: n - 1 }, () => each);
  out.push(total.minus(each.times(n - 1)));
  return out.map((x) => x.toFixed(2));
}
