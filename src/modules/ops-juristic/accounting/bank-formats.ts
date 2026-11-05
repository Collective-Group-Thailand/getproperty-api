import { createHash } from 'node:crypto';

import Decimal from 'decimal.js';

/**
 * Bank statement CSV column maps (D-329) — **data**, one per bank; the parser below is generic. The layouts follow
 * the CSV exports of each bank's corporate internet banking as described to us; they are **UNVERIFIED against live
 * provider files** (sample fixtures in `test/fixtures/bank-statements/` were written by us). A bank that changes its
 * export only needs a new map here. Dates may be Buddhist-era (year ≥ 2400 → − 543; two-digit years ≥ 50 are BE).
 */
export type BankFormatKey = 'kbank' | 'scb' | 'bbl' | 'ktb';

export interface BankFormat {
  key: BankFormatKey;
  /** Thai bank code (ITMX). */
  bankCode: string;
  nameTh: string;
  nameEn: string;
  delimiter: ',' | ';' | '\t';
  /** Header labels of the columns used (matched after trimming, case-insensitive). */
  columns: {
    date: string;
    description: string;
    reference?: string;
    /** Money out / in in two columns … */
    withdrawal?: string;
    deposit?: string;
    /** … or one signed column (money out negative). */
    amount?: string;
    balance?: string;
  };
  /** Order of the date parts. */
  dateOrder: 'dmy' | 'ymd';
}

export const BANK_FORMATS: Readonly<Record<BankFormatKey, BankFormat>> = {
  kbank: {
    key: 'kbank',
    bankCode: '004',
    nameTh: 'ธนาคารกสิกรไทย',
    nameEn: 'Kasikornbank',
    delimiter: ',',
    columns: {
      date: 'วันที่',
      description: 'รายการ',
      withdrawal: 'ถอนเงิน',
      deposit: 'ฝากเงิน',
      balance: 'ยอดคงเหลือ',
      reference: 'รายละเอียด',
    },
    dateOrder: 'dmy',
  },
  scb: {
    key: 'scb',
    bankCode: '014',
    nameTh: 'ธนาคารไทยพาณิชย์',
    nameEn: 'Siam Commercial Bank',
    delimiter: ',',
    columns: {
      date: 'Date',
      description: 'Description',
      withdrawal: 'Withdrawal',
      deposit: 'Deposit',
      balance: 'Balance',
      reference: 'Reference',
    },
    dateOrder: 'dmy',
  },
  bbl: {
    key: 'bbl',
    bankCode: '002',
    nameTh: 'ธนาคารกรุงเทพ',
    nameEn: 'Bangkok Bank',
    delimiter: ',',
    columns: {
      date: 'Trans. Date',
      description: 'Description',
      withdrawal: 'Debit',
      deposit: 'Credit',
      balance: 'Balance',
      reference: 'Cheque No./Ref.',
    },
    dateOrder: 'dmy',
  },
  ktb: {
    key: 'ktb',
    bankCode: '006',
    nameTh: 'ธนาคารกรุงไทย',
    nameEn: 'Krungthai Bank',
    delimiter: ',',
    columns: {
      date: 'วันที่ทำรายการ',
      description: 'รายการ',
      amount: 'จำนวนเงิน',
      balance: 'ยอดคงเหลือ',
      reference: 'รายละเอียด',
    },
    dateOrder: 'dmy',
  },
};

export const BANK_FORMAT_KEYS = Object.keys(BANK_FORMATS) as BankFormatKey[];

export interface ParsedLine {
  lineNo: number;
  bookedOn: string;
  /** Signed: + money in, − money out. */
  amount: string;
  description: string;
  reference: string | null;
  balance: string | null;
}

export class StatementParseError extends Error {
  constructor(
    message: string,
    readonly line: number | null = null,
  ) {
    super(message);
  }
}

/** Splits one CSV record (RFC 4180 quoting). */
export function splitCsv(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const money = (raw: string | undefined): Decimal | null => {
  const v = (raw ?? '')
    .replaceAll(',', '')
    .replaceAll(' ', '')
    .replace(/^\((.*)\)$/, '-$1');
  if (!v || v === '-') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(v)) throw new StatementParseError(`not an amount: ${raw}`);
  return new Decimal(v);
};

export function parseStatementDate(raw: string, order: 'dmy' | 'ymd'): string {
  const parts = raw.trim().split(/[\s]/)[0]!.split(/[/.-]/);
  if (parts.length !== 3) throw new StatementParseError(`not a date: ${raw}`);
  const [d0, m0, y] = order === 'dmy' ? parts : [parts[2]!, parts[1]!, parts[0]!];
  let year = Number(y);
  if (!Number.isInteger(year) || !Number.isInteger(Number(m0)) || !Number.isInteger(Number(d0)))
    throw new StatementParseError(`not a date: ${raw}`);
  if (y!.length <= 2) year = year >= 50 ? 2500 + year - 543 : 2000 + year;
  else if (year >= 2400) year -= 543;
  const d = d0!.padStart(2, '0');
  const m = m0!.padStart(2, '0');
  const iso = `${year}-${m}-${d}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso)
    throw new StatementParseError(`not a date: ${raw}`);
  return iso;
}

/** Parses a statement file with a column map: lines before the header row are skipped; blank rows end nothing. */
export function parseStatement(content: string, format: BankFormat): ParsedLine[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = text.split('\n');
  const want = (label?: string) => label?.trim().toLowerCase();
  const headerAt = rows.findIndex((r) =>
    splitCsv(r, format.delimiter)
      .map((c) => c.toLowerCase())
      .includes(want(format.columns.date)!),
  );
  if (headerAt < 0)
    throw new StatementParseError(`no header row with "${format.columns.date}" (${format.key})`);
  const header = splitCsv(rows[headerAt]!, format.delimiter).map((c) => c.toLowerCase());
  const col = (label?: string) => {
    if (!label) return -1;
    const i = header.indexOf(want(label)!);
    if (i < 0) throw new StatementParseError(`column "${label}" missing (${format.key})`, headerAt + 1);
    return i;
  };
  const c = {
    date: col(format.columns.date),
    description: col(format.columns.description),
    reference: col(format.columns.reference),
    withdrawal: col(format.columns.withdrawal),
    deposit: col(format.columns.deposit),
    amount: col(format.columns.amount),
    balance: col(format.columns.balance),
  };
  const out: ParsedLine[] = [];
  for (let i = headerAt + 1; i < rows.length; i += 1) {
    const raw = rows[i]!;
    if (!raw.trim()) continue;
    const cells = splitCsv(raw, format.delimiter);
    const dateCell = cells[c.date] ?? '';
    if (!dateCell.trim()) continue;
    try {
      let amount: Decimal | null;
      if (c.amount >= 0) amount = money(cells[c.amount]);
      else {
        const out_ = money(cells[c.withdrawal]);
        const in_ = money(cells[c.deposit]);
        amount = (in_ ?? new Decimal(0)).minus(out_ ?? new Decimal(0));
      }
      if (!amount || amount.eq(0)) continue; // balance-only rows (opening / closing lines)
      if (amount.decimalPlaces() > 2) throw new StatementParseError('more than 2 decimals');
      const reference = c.reference >= 0 ? (cells[c.reference] ?? '').trim() : '';
      const balance = c.balance >= 0 ? money(cells[c.balance]) : null;
      out.push({
        lineNo: out.length + 1,
        bookedOn: parseStatementDate(dateCell, format.dateOrder),
        amount: amount.toFixed(2),
        description: (cells[c.description] ?? '').slice(0, 500),
        reference: reference ? reference.slice(0, 200) : null,
        balance: balance ? balance.toFixed(2) : null,
      });
    } catch (error) {
      if (error instanceof StatementParseError) throw new StatementParseError(error.message, i + 1);
      throw error;
    }
  }
  if (out.length > 5000) throw new StatementParseError('at most 5,000 lines per file');
  return out;
}

/**
 * Stable key of a line on a bank account: (date, amount, reference, description, n-th identical line of the file) —
 * overlapping files skip the lines already imported.
 */
export function lineKeys(bankAccountId: string, lines: readonly ParsedLine[]): Buffer[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [bankAccountId, l.bookedOn, l.amount, l.reference ?? '', l.description].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash('sha256').update(`${base}|${n}`).digest();
  });
}

// ------------------------------------------------------------------------------------------- matching

export interface MatchCandidate {
  kind: 'payment' | 'expense' | 'fund_transfer';
  id: string;
  /** Signed as it appears on this statement (+ in, − out). */
  amount: string;
  on: string;
  /** References that identify it on a bank line (slip ref, payment reference, expense number …). */
  refs: string[];
  label: string;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^0-9a-z฀-๿]/g, '');
const dayDiff = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;

/**
 * Candidates for a line (D-329 heuristics): the same signed amount, within `windowDays`, ranked by a reference found in
 * the line's reference / description, then by date distance. Auto-match only when unambiguous: exactly one candidate
 * with a reference hit, or — without any reference hit — exactly one candidate at all.
 */
export function rankCandidates(
  line: { bookedOn: string; amount: string; reference: string | null; description: string },
  candidates: readonly MatchCandidate[],
  windowDays: number,
): {
  suggestions: (MatchCandidate & { referenceHit: boolean; days: number })[];
  auto: MatchCandidate | null;
} {
  const text = norm(`${line.reference ?? ''} ${line.description}`);
  const ranked = candidates
    .filter((c) => new Decimal(c.amount).eq(line.amount))
    .map((c) => ({
      ...c,
      days: dayDiff(c.on, line.bookedOn),
      referenceHit: c.refs.some((r) => norm(r).length >= 4 && text.includes(norm(r))),
    }))
    .filter((c) => c.days <= windowDays)
    .sort(
      (a, b) => Number(b.referenceHit) - Number(a.referenceHit) || a.days - b.days || (a.id < b.id ? -1 : 1),
    );
  const hits = ranked.filter((c) => c.referenceHit);
  const auto = hits.length === 1 ? hits[0]! : hits.length === 0 && ranked.length === 1 ? ranked[0]! : null;
  return { suggestions: ranked.slice(0, 5), auto };
}
