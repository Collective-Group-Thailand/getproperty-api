import { bangkokDate } from '@common/time/bangkok';
import Decimal from 'decimal.js';

/** How getproperty confirmed a payment: only these count for a rent record (D-256 — gateway or verified slip). */
export const PLATFORM_CONFIRMED = ['webhook', 'settlement_file', 'slip_verified'] as const;

export type RentRecordMonthStatus = 'on_time' | 'late' | 'outstanding';

export interface RentRecordInvoice {
  periodStart: Date;
  dueDate: Date | null;
  status: string;
  balance: string;
  /** Payments allocated to the invoice (not reversed). */
  payments: { paidAt: Date; status: string; confirmedVia: string | null }[];
}

export interface RentRecordFacts {
  /** One row per month (Bangkok, YYYY-MM), newest first. */
  months: { month: string; status: RentRecordMonthStatus }[];
  onTime: number;
  late: number;
  outstanding: number;
  /** Months paid in a way getproperty did not confirm (cash, owner-recorded transfer) — not counted above. */
  notConfirmed: number;
  firstMonth: string | null;
  lastMonth: string | null;
}

const RANK: Record<RentRecordMonthStatus, number> = { on_time: 0, late: 1, outstanding: 2 };

/**
 * The rent record of D-256 from a person's invoices — facts only, never a score: a month is **on time** when its
 * invoice was paid in full by the due date through payments getproperty confirmed, **late** when paid in full after
 * it, **outstanding** when money is still owed past the due date. Open invoices not yet due are left out; a month
 * paid any other way (cash, a transfer the owner recorded) is counted as `notConfirmed` only. Several invoices in one
 * month: the month takes the worst of them.
 */
export function rentRecordFacts(invoices: RentRecordInvoice[], now: Date): RentRecordFacts {
  const today = bangkokDate(now);
  const byMonth = new Map<string, RentRecordMonthStatus>();
  const unconfirmed = new Set<string>();
  for (const invoice of invoices) {
    if (!invoice.dueDate || invoice.status === 'void' || invoice.status === 'draft') continue;
    const month = bangkokDate(invoice.periodStart).slice(0, 7);
    const due = invoice.dueDate.toISOString().slice(0, 10);
    let status: RentRecordMonthStatus | null = null;
    if (new Decimal(invoice.balance).gt(0)) {
      if (due < today) status = 'outstanding';
    } else {
      const counted = invoice.payments.filter((p) => p.status === 'confirmed');
      if (!counted.length) continue; // settled by a credit only: nothing to tell
      if (!counted.every((p) => (PLATFORM_CONFIRMED as readonly string[]).includes(p.confirmedVia ?? ''))) {
        unconfirmed.add(month);
        continue;
      }
      const paidOn = counted
        .map((p) => bangkokDate(p.paidAt))
        .sort()
        .at(-1)!;
      status = paidOn <= due ? 'on_time' : 'late';
    }
    if (!status) continue;
    const before = byMonth.get(month);
    if (!before || RANK[status] > RANK[before]) byMonth.set(month, status);
  }
  const months = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([month, status]) => ({ month, status }));
  for (const m of months) unconfirmed.delete(m.month);
  const count = (s: RentRecordMonthStatus) => months.filter((m) => m.status === s).length;
  return {
    months,
    onTime: count('on_time'),
    late: count('late'),
    outstanding: count('outstanding'),
    notConfirmed: unconfirmed.size,
    firstMonth: months.at(-1)?.month ?? null,
    lastMonth: months[0]?.month ?? null,
  };
}
