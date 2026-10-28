import Decimal from 'decimal.js';

/**
 * Employer housing (G8, D-299): how an invoice addressed to an employer is split between the workers who stay in the
 * unit, and what the employer may recover from each worker's pay. Pure functions — the service reads the rows.
 *
 * - `per_occupant`: the invoice total is split equally between the people staying under the lease in the invoice
 *   period; the satang left over goes one by one to the first people in the given order (stable: by name, then id).
 * - `per_unit`: the whole invoice is the lessee's share (the unit's representative).
 * - deduction = share × `deduct_percent` / 100, rounded half-up to the satang; the employer carries the rest.
 */
export type SplitRule = 'per_occupant' | 'per_unit';

export interface StatementPerson {
  partyId: string;
  name: string;
  employeeNo: string | null;
}

export interface WorkerShare extends StatementPerson {
  share: Decimal;
  deduction: Decimal;
  employerPays: Decimal;
}

const SATANG = new Decimal('0.01');

/** Splits `total` (≥ 0, two decimals) by the rule; `people` already ordered; the lessee is used when nobody stays. */
export function splitInvoice(
  total: Decimal,
  rule: SplitRule,
  people: StatementPerson[],
  lessee: StatementPerson,
  deductPercent: Decimal,
): WorkerShare[] {
  const amount = total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const who = rule === 'per_unit' || people.length === 0 ? [lessee] : people;
  const n = who.length;
  const base = amount.div(n).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  let remainder = amount.minus(base.times(n)).div(SATANG).round().toNumber();
  return who.map((person) => {
    let share = base;
    if (remainder > 0) {
      share = share.plus(SATANG);
      remainder -= 1;
    }
    const deduction = share.times(deductPercent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return { ...person, share, deduction, employerPays: share.minus(deduction) };
  });
}

/** Stable order of the people in a unit: by name (Thai collation), then party id. */
export function orderPeople<T extends { name: string; partyId: string }>(people: T[]): T[] {
  return [...people].sort((a, b) => a.name.localeCompare(b.name, 'th') || a.partyId.localeCompare(b.partyId));
}

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is prefixed with `'`. */
export function csvCell(value: string, text = true): string {
  let v = value.replace(/\r\n?/g, '\n');
  if (text && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface PayrollRow {
  employeeNo: string | null;
  name: string;
  unitNo: string;
  invoiceNumber: string;
  share: Decimal;
  deduction: Decimal;
}

export const PAYROLL_CSV_HEADER = [
  'employee_no',
  'worker_name',
  'unit_no',
  'invoice_number',
  'share_thb',
  'deduction_thb',
] as const;

/** The `generic_csv` payroll-deduction file: UTF-8 with BOM (Excel opens Thai correctly), CRLF line ends. */
export function payrollCsv(rows: PayrollRow[]): Buffer {
  const lines = [
    PAYROLL_CSV_HEADER.join(','),
    ...rows.map((r) =>
      [
        csvCell(r.employeeNo ?? ''),
        csvCell(r.name),
        csvCell(r.unitNo),
        csvCell(r.invoiceNumber),
        csvCell(r.share.toFixed(2), false),
        csvCell(r.deduction.toFixed(2), false),
      ].join(','),
    ),
  ];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
}

/** `YYYY-MM` → the Bangkok month as [start, end) instants. */
export function bangkokMonthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1, -7));
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, -7));
  return { from, to };
}
