import Decimal from 'decimal.js';

/**
 * Juristic aging (D-326, docs/juristic-gap.md §1 J1.2): a second bucket set next to D-045's — days past the due date
 * cut by the setting `juristic.aging_buckets` (default [30, 90, 365] → 0–30 · 31–90 · 91–365 · > 365), plus what is
 * not yet due. Counts are invoices and accounts (distinct party × unit); amounts are open balances. Pure.
 */
export interface AgingInvoice {
  balance: Decimal.Value;
  /** `YYYY-MM-DD` (Bangkok); null = no due date (not yet due). */
  dueOn: string | null;
  account: string;
}

export interface AgingBucketRow {
  key: string;
  fromDays: number;
  toDays: number | null;
  invoices: number;
  accounts: number;
  amount: string;
}

export interface AgingReport {
  notDue: { invoices: number; accounts: number; amount: string };
  buckets: AgingBucketRow[];
  overdue: { invoices: number; accounts: number; amount: string };
}

const DAY = 86_400_000;
const n = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;

/** Upper bounds of the buckets: positive whole days, unique, ascending (a bad setting falls back to the default). */
export function agingBounds(value: unknown): number[] {
  const ok =
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every((v) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 3650);
  const bounds = ok ? [...new Set(value as number[])].sort((a, b) => a - b) : [30, 90, 365];
  return bounds;
}

export function juristicAging(
  invoices: readonly AgingInvoice[],
  bounds: number[],
  today: string,
): AgingReport {
  const ranges = bounds.map((to, i) => ({ from: i === 0 ? 0 : bounds[i - 1]! + 1, to }));
  const last = bounds[bounds.length - 1]!;
  const rows = [
    ...ranges.map((r) => ({ key: `${r.from}-${r.to}`, fromDays: r.from, toDays: r.to })),
    { key: `>${last}`, fromDays: last + 1, toDays: null },
  ].map((r) => ({ ...r, invoices: 0, accounts: new Set<string>(), amount: new Decimal(0) }));
  const notDue = { invoices: 0, accounts: new Set<string>(), amount: new Decimal(0) };
  const overdue = { invoices: 0, accounts: new Set<string>(), amount: new Decimal(0) };
  for (const inv of invoices) {
    const b = new Decimal(inv.balance);
    if (b.lte(0)) continue;
    const past = inv.dueOn ? n(today) - n(inv.dueOn) : 0;
    const target =
      past <= 0
        ? notDue
        : (rows.find((r) => r.toDays === null || past <= r.toDays) ?? rows[rows.length - 1]!);
    target.invoices += 1;
    target.accounts.add(inv.account);
    target.amount = target.amount.plus(b);
    if (past > 0) {
      overdue.invoices += 1;
      overdue.accounts.add(inv.account);
      overdue.amount = overdue.amount.plus(b);
    }
  }
  const out = (x: { invoices: number; accounts: Set<string>; amount: Decimal }) => ({
    invoices: x.invoices,
    accounts: x.accounts.size,
    amount: x.amount.toFixed(2),
  });
  return {
    notDue: out(notDue),
    buckets: rows.map((r) => ({
      key: r.key,
      fromDays: r.fromDays,
      toDays: r.toDays,
      ...out(r),
    })),
    overdue: out(overdue),
  };
}

/** Collection rate in percent (2 dp, half-up); null when nothing was billed. */
export function ratePct(collected: Decimal.Value, billed: Decimal.Value): string | null {
  const b = new Decimal(billed);
  if (b.lte(0)) return null;
  return new Decimal(collected).div(b).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Whole calendar months from `from` to `to` (`YYYY-MM-DD`), e.g. 2026-11-05 → 2027-02-04 = 2. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}
