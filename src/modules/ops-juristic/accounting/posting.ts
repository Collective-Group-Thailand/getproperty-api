import Decimal from 'decimal.js';

import { type AccountRole, type FundAccountRole } from './chart-templates';

/**
 * Posting rules of the light GL (D-312, D-329) — pure: business figures in, journal legs out. An account is named by
 * its role (`receivable`, `income_common_fee` …), a fund role of the journal's fund (`fund_bank`, `fund_equity`) or an
 * explicit account id (`id:<uuid>`); the ledger service resolves them. A leg's amount is signed (+ debit, − credit)
 * and `toLines` turns legs into debit-or-credit lines, dropping zeros and flipping negatives, and refuses an
 * unbalanced result (the database refuses it too, at commit).
 */

export type AccountKey = AccountRole | FundAccountRole | `id:${string}`;

export interface Leg {
  account: AccountKey;
  /** + debit, − credit. */
  amount: Decimal;
  unitId?: string | null;
  partyId?: string | null;
  memo?: string | null;
}

export interface PostingLine {
  account: AccountKey;
  debit: string;
  credit: string;
  unitId: string | null;
  partyId: string | null;
  memo: string | null;
}

type Extra = Pick<Leg, 'unitId' | 'partyId' | 'memo'>;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
export const dr = (account: AccountKey, amount: Decimal.Value, extra: Extra = {}): Leg => ({
  account,
  amount: D(amount),
  ...extra,
});
export const cr = (account: AccountKey, amount: Decimal.Value, extra: Extra = {}): Leg => ({
  account,
  amount: D(amount).negated(),
  ...extra,
});

export const idKey = (accountId: string): AccountKey => `id:${accountId}`;

/** Legs → lines (zero legs dropped, negative sides flipped); throws when Σ debit ≠ Σ credit or nothing is left. */
export function toLines(legs: readonly Leg[]): PostingLine[] {
  const lines = legs
    .filter((l) => !l.amount.eq(0))
    .map((l) => ({
      account: l.account,
      debit: l.amount.gt(0) ? l.amount.toFixed(2) : '0.00',
      credit: l.amount.lt(0) ? l.amount.negated().toFixed(2) : '0.00',
      unitId: l.unitId ?? null,
      partyId: l.partyId ?? null,
      memo: l.memo ?? null,
    }));
  const debit = lines.reduce((s, l) => s.plus(l.debit), D(0));
  const credit = lines.reduce((s, l) => s.plus(l.credit), D(0));
  if (!debit.eq(credit))
    throw new Error(`unbalanced posting: debit ${debit.toFixed(2)} ≠ credit ${credit.toFixed(2)}`);
  return lines;
}

/** The account a billed line of a kind is credited to (D-329). Fund contributions are fund equity, never revenue. */
export function lineKindAccount(kind: string): AccountKey {
  switch (kind) {
    case 'common_fee':
      return 'income_common_fee';
    case 'fund':
      return 'fund_equity';
    case 'late_fee':
      return 'income_surcharge';
    // the debt only moved (onto a payment plan / from an older invoice): receivable both sides
    case 'plan_instalment':
    case 'prior_balance':
      return 'receivable';
    case 'deposit_offset':
      return 'deposits';
    default:
      return 'income_other';
  }
}

/** Accounts a line reaches directly even when billed in advance (not revenue: nothing to recognise). */
const NOT_REVENUE = new Set<AccountKey>(['fund_equity', 'receivable', 'deposits']);
export const isRevenueKind = (kind: string): boolean => !NOT_REVENUE.has(lineKindAccount(kind));

export interface BilledLine {
  kind: string;
  amount: Decimal.Value;
  /** Has revenue-schedule rows (advance cycle, D-323): credited to unearned revenue, recognised monthly. */
  scheduled?: boolean;
}

interface DocumentFigures {
  total: Decimal.Value;
  vatAmount: Decimal.Value;
  unitId: string | null;
  partyId: string | null;
}

/** Invoice issued (or debit note): Dr receivable / Cr income · unearned · fund equity per line, Cr output VAT. */
export function invoiceLegs(doc: DocumentFigures & { lines: readonly BilledLine[] }): Leg[] {
  const who = { unitId: doc.unitId, partyId: doc.partyId };
  const legs: Leg[] = [dr('receivable', doc.total, who)];
  let sum = D(0);
  for (const l of doc.lines) {
    const target = lineKindAccount(l.kind);
    legs.push(cr(l.scheduled && isRevenueKind(l.kind) ? 'unearned' : target, l.amount, who));
    sum = sum.plus(D(l.amount));
  }
  legs.push(cr('output_vat', doc.vatAmount, who));
  // a rounding difference between the lines and the total (never expected) stays visible as other income
  legs.push(cr('income_other', D(doc.total).minus(sum).minus(D(doc.vatAmount)), who));
  return legs;
}

export interface CreditedLine {
  kind: string;
  amount: Decimal.Value;
  /** Part taken back from unearned revenue (the line's unrecognised months, last first). */
  fromUnearned?: Decimal.Value;
}

/**
 * Credit note: Dr the line's account (unearned first for advance lines) / Cr receivable. A `payment_plan` credit note
 * only moves the debt onto the plan (D-325): receivable on both sides, revenue unchanged.
 */
export function creditNoteLegs(
  doc: DocumentFigures & { reason: string; lines: readonly CreditedLine[] },
): Leg[] {
  const who = { unitId: doc.unitId, partyId: doc.partyId };
  if (doc.reason === 'payment_plan')
    return [dr('receivable', doc.total, who), cr('receivable', doc.total, who)];
  const legs: Leg[] = [];
  let sum = D(0);
  for (const l of doc.lines) {
    const unearned = D(l.fromUnearned ?? 0);
    legs.push(dr('unearned', unearned, who));
    legs.push(dr(lineKindAccount(l.kind), D(l.amount).minus(unearned), who));
    sum = sum.plus(D(l.amount));
  }
  legs.push(dr('output_vat', doc.vatAmount, who));
  legs.push(dr('income_other', D(doc.total).minus(sum).minus(D(doc.vatAmount)), who));
  legs.push(cr('receivable', doc.total, who));
  return legs;
}

/** Money received (D-329): Dr bank / cash (+ WHT the payer withheld) / Cr receivable — the excess is the payer's credit. */
export function paymentLegs(p: {
  amount: Decimal.Value;
  wht: Decimal.Value;
  into: AccountKey;
  unitId: string | null;
  partyId: string | null;
}): Leg[] {
  const who = { unitId: p.unitId, partyId: p.partyId };
  return [
    dr(p.into, p.amount, who),
    dr('wht_prepaid', p.wht, who),
    cr('receivable', D(p.amount).plus(D(p.wht)), who),
  ];
}

export function refundLegs(r: {
  amount: Decimal.Value;
  from: AccountKey;
  unitId: string | null;
  partyId: string | null;
}): Leg[] {
  const who = { unitId: r.unitId, partyId: r.partyId };
  return [dr('receivable', r.amount, who), cr(r.from, r.amount, who)];
}

/** One month of advance-billed revenue earned: Dr unearned / Cr the line's income. */
export function recognitionLegs(r: {
  kind: string;
  amount: Decimal.Value;
  unitId: string | null;
  partyId: string | null;
}): Leg[] {
  const who = { unitId: r.unitId, partyId: r.partyId };
  return [dr('unearned', r.amount, who), cr(lineKindAccount(r.kind), r.amount, who)];
}

/** The exact opposite of posted lines (a reversal journal). */
export function reversalLegs(
  lines: readonly {
    accountId: string;
    debit: Decimal.Value;
    credit: Decimal.Value;
    unitId: string | null;
    partyId: string | null;
  }[],
): Leg[] {
  return lines.map((l) => ({
    account: idKey(l.accountId),
    amount: D(l.credit).minus(D(l.debit)),
    unitId: l.unitId,
    partyId: l.partyId,
  }));
}

/**
 * An expense paid: Dr each line's expense account / Cr WHT payable / Cr the account paid from (net). Paid from a fund
 * (with its resolution) also moves the amount from fund equity to the accumulated surplus — the fund was used.
 */
export function expenseLegs(e: {
  lines: readonly { accountId: string; amount: Decimal.Value; memo?: string | null }[];
  wht: Decimal.Value;
  net: Decimal.Value;
  paidFrom: AccountKey;
  fromFund: boolean;
}): Leg[] {
  const legs: Leg[] = e.lines.map((l) => dr(idKey(l.accountId), l.amount, { memo: l.memo ?? null }));
  const gross = e.lines.reduce((s, l) => s.plus(D(l.amount)), D(0));
  legs.push(cr('wht_payable', e.wht), cr(e.paidFrom, e.net));
  if (e.fromFund) legs.push(dr('fund_equity', gross), cr('accumulated_surplus', gross));
  return legs;
}

/** A petty cash count difference (counted − book): a shortage is an expense, an overage other income. */
export function countDifferenceLegs(pettyAccountId: string, difference: Decimal.Value): Leg[] {
  const d = D(difference);
  return d.lt(0)
    ? [dr('exp_other', d.negated()), cr(idKey(pettyAccountId), d.negated())]
    : [dr(idKey(pettyAccountId), d), cr('income_other', d)];
}

/** Money into a fund (Dr fund bank) or out of it with a resolution (Cr fund bank + fund equity used). */
export function fundTransferLegs(t: {
  direction: 'in' | 'out';
  amount: Decimal.Value;
  counter: AccountKey;
}): Leg[] {
  return t.direction === 'in'
    ? [dr('fund_bank', t.amount), cr(t.counter, t.amount)]
    : [
        dr(t.counter, t.amount),
        cr('fund_bank', t.amount),
        dr('fund_equity', t.amount),
        cr('accumulated_surplus', t.amount),
      ];
}

/**
 * A credit note on an advance-billed line takes its amount from the line's **unrecognised** months, last month first
 * (D-329); what no unrecognised month can absorb is taken from income. Returns the new `credited` per row and that rest.
 */
export function allocateCredit(
  rows: readonly {
    id: string;
    month: string;
    amount: Decimal.Value;
    credited: Decimal.Value;
    recognised: boolean;
  }[],
  amount: Decimal.Value,
): { updates: { id: string; credited: string }[]; fromUnearned: string; rest: string } {
  let left = D(amount);
  const updates: { id: string; credited: string }[] = [];
  const open = rows
    .filter((r) => !r.recognised && D(r.amount).gt(0))
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  for (const r of open) {
    if (left.lte(0)) break;
    const room = D(r.amount).minus(D(r.credited));
    if (room.lte(0)) continue;
    const take = Decimal.min(room, left);
    updates.push({ id: r.id, credited: D(r.credited).plus(take).toFixed(2) });
    left = left.minus(take);
  }
  return { updates, fromUnearned: D(amount).minus(left).toFixed(2), rest: left.toFixed(2) };
}
