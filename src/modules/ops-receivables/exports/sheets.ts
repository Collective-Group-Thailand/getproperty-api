import ExcelJS from 'exceljs';

/** A cell: text, a money string (`"1234.50"`, written as a number with 2 decimals), an integer, a date `YYYY-MM-DD`. */
export type Cell = string | number | null;
export type ColumnType = 'text' | 'money' | 'int' | 'date';

export interface Column {
  key: string;
  header: string;
  type?: ColumnType;
  width?: number;
}

export interface SheetSpec {
  name: string;
  columns: readonly Column[];
  rows: readonly Record<string, Cell>[];
  /** A bold last row (sums of money columns, labels). */
  totals?: Record<string, Cell>;
  /** Lines above the header (title, period, generated at). */
  preamble?: readonly string[];
}

const MONEY_FORMAT = '#,##0.00';

const cellValue = (v: Cell, type: ColumnType | undefined): ExcelJS.CellValue => {
  if (v === null || v === '') return null;
  if (type === 'money') return Number(v);
  if (type === 'int') return Number(v);
  if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    return new Date(`${v}T00:00:00Z`);
  return v;
};

/**
 * Writes an .xlsx workbook (exceljs): one worksheet per spec, an optional preamble, a bold frozen header, money as
 * numbers with `#,##0.00`, dates as dates (`yyyy-mm-dd`), an optional bold totals row. Deterministic content (the
 * creation time is the job's), so golden tests compare what the file says, not its bytes.
 */
export async function xlsxOf(
  sheets: readonly SheetSpec[],
  meta: { creator: string; createdAt: Date },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.creator;
  wb.created = meta.createdAt;
  wb.modified = meta.createdAt;
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31));
    for (const line of spec.preamble ?? []) ws.addRow([line]);
    if (spec.preamble?.length) ws.addRow([]);
    const header = ws.addRow(spec.columns.map((c) => c.header));
    header.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: header.number }];
    spec.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? (c.type === 'money' ? 14 : c.type === 'date' ? 12 : 18);
      if (c.type === 'money') col.numFmt = MONEY_FORMAT;
      if (c.type === 'date') col.numFmt = 'yyyy-mm-dd';
    });
    for (const r of spec.rows) ws.addRow(spec.columns.map((c) => cellValue(r[c.key] ?? null, c.type)));
    if (spec.totals) {
      const t = ws.addRow(spec.columns.map((c) => cellValue(spec.totals![c.key] ?? null, c.type)));
      t.font = { bold: true };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads a workbook back as plain values (tests, golden snapshots): sheet → rows of cells. */
export async function readXlsx(body: Buffer): Promise<Record<string, Cell[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  const out: Record<string, Cell[][]> = {};
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1);
      rows.push(
        // Array.from also visits the holes exceljs leaves for empty cells
        Array.from(values, (v): Cell => {
          if (v === null || v === undefined) return null;
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          if (typeof v === 'number') return Math.round(v * 100) / 100;
          if (typeof v === 'object') return JSON.stringify(v);
          return v as string;
        }),
      );
    });
    out[ws.name] = rows;
  });
  return out;
}

const needsQuote = /[",\r\n]/;

/** One CSV field: quoted when it holds a comma, quote or newline; `"` doubled (RFC 4180). */
export const csvField = (v: Cell): string => {
  if (v === null) return '';
  const s = String(v);
  return needsQuote.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV with CRLF line ends; `bom` (UTF-8 BOM) so Excel opens Thai text correctly. */
export function csvOf(
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  opts: { bom?: boolean } = {},
): string {
  const lines = [headers, ...rows].map((r) => r.map(csvField).join(','));
  return `${opts.bom === false ? '' : '﻿'}${lines.join('\r\n')}\r\n`;
}

/** Sum of money strings → `"0.00"`. */
export const sumMoney = (values: readonly (string | null | undefined)[]): string => {
  let cents = 0n;
  for (const v of values) {
    if (!v) continue;
    const neg = v.startsWith('-');
    const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
    const c = BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2));
    cents += neg ? -c : c;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
