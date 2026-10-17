import Decimal from 'decimal.js';

/** Aging buckets of what is owed (D-045): not yet due, then days past the due date. */
export interface AgingBuckets {
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90p: string;
}

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90p'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface OpenInvoiceBalance {
  balance: Decimal.Value;
  /** `YYYY-MM-DD` (Asia/Bangkok); null = no due date (counted as current). */
  dueOn: string | null;
}

export interface ReceivablePosition {
  /** Σ open balances − credit (what the party owes net; negative = the party is in credit). */
  balance: string;
  openBalance: string;
  creditBalance: string;
  openInvoicesCount: number;
  /** Due date of the oldest open invoice with a balance. */
  oldestDueOn: string | null;
  /** Days the oldest open invoice is past due (0 when nothing is overdue). */
  daysOverdue: number;
  aging: AgingBuckets;
}

const DAY = 86_400_000;
const dayNumber = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;

/** Whole days from `dueOn` to `today` (both Bangkok dates); ≤ 0 = not yet overdue. */
export const daysPastDue = (dueOn: string, today: string): number => dayNumber(today) - dayNumber(dueOn);

export function bucketOf(daysPast: number): AgingBucket {
  if (daysPast <= 0) return 'current';
  if (daysPast <= 30) return 'd1_30';
  if (daysPast <= 60) return 'd31_60';
  if (daysPast <= 90) return 'd61_90';
  return 'd90p';
}

/**
 * The receivable position of a billed party × unit on a Bangkok day (pure): open balances by aging bucket (an
 * invoice is 1 day overdue the day after its due date), the oldest due date, days overdue and the net balance after
 * the party's credit. Credit is not spread over buckets — the buckets show what the invoices still owe.
 */
export function positionOf(
  invoices: readonly OpenInvoiceBalance[],
  credit: Decimal.Value,
  today: string,
): ReceivablePosition {
  const sums: Record<AgingBucket, Decimal> = {
    current: new Decimal(0),
    d1_30: new Decimal(0),
    d31_60: new Decimal(0),
    d61_90: new Decimal(0),
    d90p: new Decimal(0),
  };
  let open = new Decimal(0);
  let count = 0;
  let oldest: string | null = null;
  for (const inv of invoices) {
    const b = new Decimal(inv.balance);
    if (b.lte(0)) continue;
    count += 1;
    open = open.plus(b);
    const past = inv.dueOn ? daysPastDue(inv.dueOn, today) : 0;
    sums[bucketOf(past)] = sums[bucketOf(past)].plus(b);
    if (inv.dueOn && (oldest === null || inv.dueOn < oldest)) oldest = inv.dueOn;
  }
  const creditBalance = Decimal.max(0, new Decimal(credit));
  return {
    balance: open.minus(creditBalance).toFixed(2),
    openBalance: open.toFixed(2),
    creditBalance: creditBalance.toFixed(2),
    openInvoicesCount: count,
    oldestDueOn: oldest,
    daysOverdue: oldest ? Math.max(0, daysPastDue(oldest, today)) : 0,
    aging: {
      current: sums.current.toFixed(2),
      d1_30: sums.d1_30.toFixed(2),
      d31_60: sums.d31_60.toFixed(2),
      d61_90: sums.d61_90.toFixed(2),
      d90p: sums.d90p.toFixed(2),
    },
  };
}

/** Totals of many positions (arrears list footer). */
export function totalsOf(
  positions: readonly Pick<ReceivablePosition, 'balance' | 'creditBalance' | 'aging'>[],
) {
  const aging = Object.fromEntries(AGING_BUCKETS.map((k) => [k, new Decimal(0)])) as Record<
    AgingBucket,
    Decimal
  >;
  let balance = new Decimal(0);
  let credit = new Decimal(0);
  for (const p of positions) {
    balance = balance.plus(p.balance);
    credit = credit.plus(p.creditBalance);
    for (const k of AGING_BUCKETS) aging[k] = aging[k].plus(p.aging[k]);
  }
  return {
    balance: balance.toFixed(2),
    creditBalance: credit.toFixed(2),
    aging: Object.fromEntries(AGING_BUCKETS.map((k) => [k, aging[k].toFixed(2)])) as unknown as AgingBuckets,
  };
}
