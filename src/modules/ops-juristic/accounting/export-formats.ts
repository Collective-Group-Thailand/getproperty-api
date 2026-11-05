/**
 * Journal export column maps (D-312, D-329) — **data**: each format is a list of (header, field) with its date style,
 * delimiter and BOM; `renderJournalExport` is generic. `csv` is getproperty's own layout. `express` (Express
 * Accounting GL import) and `flowaccount` (FlowAccount journal import) follow the column layouts as documented to us
 * and are **UNVERIFIED against live provider** import screens — an accountant checks one import before relying on
 * them (O-043); changing a header is a data change here, not code.
 */

export type JournalExportFormat = 'csv' | 'express' | 'flowaccount';

export interface JournalExportRow {
  postedOn: string;
  journalNo: string;
  source: string;
  memo: string;
  building: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  unitNo: string;
  party: string;
}

type Field = keyof JournalExportRow;

export interface ExportColumnMap {
  format: JournalExportFormat;
  exportKind: 'juristic_journal_csv' | 'juristic_journal_express' | 'juristic_journal_flowaccount';
  fileExtension: 'csv' | 'txt';
  delimiter: ',' | '\t';
  bom: boolean;
  /** iso = YYYY-MM-DD · dmy_be = DD/MM/YYYY (Buddhist era) · dmy_ce = DD/MM/YYYY (common era). */
  dateStyle: 'iso' | 'dmy_be' | 'dmy_ce';
  /** Blank instead of 0.00 on the empty side. */
  blankZero: boolean;
  columns: readonly { header: string; field: Field }[];
}

export const JOURNAL_EXPORT_FORMATS: Readonly<Record<JournalExportFormat, ExportColumnMap>> = {
  csv: {
    format: 'csv',
    exportKind: 'juristic_journal_csv',
    fileExtension: 'csv',
    delimiter: ',',
    bom: true,
    dateStyle: 'iso',
    blankZero: false,
    columns: [
      { header: 'posted_on', field: 'postedOn' },
      { header: 'journal_no', field: 'journalNo' },
      { header: 'source', field: 'source' },
      { header: 'memo', field: 'memo' },
      { header: 'building', field: 'building' },
      { header: 'account_code', field: 'accountCode' },
      { header: 'account_name', field: 'accountName' },
      { header: 'debit', field: 'debit' },
      { header: 'credit', field: 'credit' },
      { header: 'unit_no', field: 'unitNo' },
      { header: 'party', field: 'party' },
    ],
  },
  express: {
    format: 'express',
    exportKind: 'juristic_journal_express',
    fileExtension: 'txt',
    delimiter: '\t',
    bom: false,
    dateStyle: 'dmy_be',
    blankZero: true,
    columns: [
      { header: 'DOCDAT', field: 'postedOn' },
      { header: 'DOCNUM', field: 'journalNo' },
      { header: 'ACCNUM', field: 'accountCode' },
      { header: 'ACCNAM', field: 'accountName' },
      { header: 'DEBIT', field: 'debit' },
      { header: 'CREDIT', field: 'credit' },
      { header: 'DESCRP', field: 'memo' },
      { header: 'DEPCOD', field: 'building' },
    ],
  },
  flowaccount: {
    format: 'flowaccount',
    exportKind: 'juristic_journal_flowaccount',
    fileExtension: 'csv',
    delimiter: ',',
    bom: true,
    dateStyle: 'dmy_ce',
    blankZero: true,
    columns: [
      { header: 'วันที่', field: 'postedOn' },
      { header: 'เลขที่เอกสาร', field: 'journalNo' },
      { header: 'รหัสบัญชี', field: 'accountCode' },
      { header: 'ชื่อบัญชี', field: 'accountName' },
      { header: 'เดบิต', field: 'debit' },
      { header: 'เครดิต', field: 'credit' },
      { header: 'คำอธิบาย', field: 'memo' },
    ],
  },
};

const formatDate = (iso: string, style: ExportColumnMap['dateStyle']) => {
  if (style === 'iso') return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${style === 'dmy_be' ? Number(y) + 543 : y}`;
};

/** A cell, quoted when needed; a leading = + − @ is neutralised (spreadsheet formula injection). */
function cell(value: string, delimiter: string): string {
  let v = value.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(v) && !/^-?\d/.test(v)) v = `'${v}`;
  if (delimiter === '\t') return v.replaceAll('\t', ' ');
  return /[",]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function renderJournalExport(format: JournalExportFormat, rows: readonly JournalExportRow[]): string {
  const map = JOURNAL_EXPORT_FORMATS[format];
  const lines = [
    map.columns.map((c) => cell(c.header, map.delimiter)).join(map.delimiter),
    ...rows.map((r) =>
      map.columns
        .map((c) => {
          let v = r[c.field];
          if (c.field === 'postedOn') v = formatDate(v, map.dateStyle);
          if ((c.field === 'debit' || c.field === 'credit') && map.blankZero && v === '0.00') v = '';
          return cell(v, map.delimiter);
        })
        .join(map.delimiter),
    ),
  ];
  return `${map.bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}
