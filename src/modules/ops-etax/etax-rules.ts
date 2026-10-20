import { type EtaxDocumentTypeCode, type EtaxLine } from '@integrations/etax/etax-provider.port';
import Decimal from 'decimal.js';

/** Attempts before a failing submission stops retrying (then the owner is told, D-215). */
export const ETAX_MAX_ATTEMPTS = 10;
/** Minutes to wait after the n-th failed attempt (1, 5, 15, 30 min, 1, 2, 4, 6 h …). */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 360];
/** A submitted document is polled every … minutes until the provider signs or rejects it. */
export const ETAX_POLL_MINUTES = 5;
/** A claimed submission is not picked up by another worker for … minutes (provider calls are slow). */
export const ETAX_CLAIM_MINUTES = 10;

export const backoffMinutes = (attempts: number): number =>
  BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1]!;

/**
 * ETDA document type (ขมธอ. 3-2560) of what the platform issues: a plain receipt is `T01`, a receipt-tax invoice
 * `T03`, a tax invoice on its own `388`, debit / credit notes `80` / `81`.
 */
export function etaxTypeCode(
  subjectType: 'receipt' | 'tax_invoice' | 'credit_note' | 'debit_note',
  taxInvoiceKind?: string,
): EtaxDocumentTypeCode {
  if (subjectType === 'receipt') return 'T01';
  if (subjectType === 'credit_note') return '81';
  if (subjectType === 'debit_note') return '80';
  return taxInvoiceKind === 'tax_invoice' ? '388' : 'T03';
}

/**
 * Lines of a receipt-tax invoice: one per invoice paid, its amount excl. VAT pro rata of the document's
 * subtotal / total, the last line absorbing the rounding so the lines add up to the subtotal exactly.
 */
export function vatLines(
  paid: { name: string; amount: string }[],
  subtotal: string,
  total: string,
  vatRatePct: string,
): EtaxLine[] {
  const t = new Decimal(total);
  const sub = new Decimal(subtotal);
  if (!paid.length || t.lte(0))
    return [
      { name: 'รับชำระ', quantity: '1', unitPrice: sub.toFixed(2), amount: sub.toFixed(2), vatRatePct },
    ];
  let left = sub;
  return paid.map((p, i) => {
    const amount =
      i === paid.length - 1
        ? left
        : new Decimal(p.amount).times(sub).div(t).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    left = left.minus(amount);
    return {
      name: p.name,
      quantity: '1',
      unitPrice: amount.toFixed(2),
      amount: amount.toFixed(2),
      vatRatePct,
    };
  });
}

/** The Bangkok month `YYYY-MM` → [from, to) as instants. */
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1) - 7 * 3_600_000);
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 7 * 3_600_000);
  return { from, to };
}

export const previousMonth = (bangkokDay: string): string => {
  const [y, m] = bangkokDay.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
