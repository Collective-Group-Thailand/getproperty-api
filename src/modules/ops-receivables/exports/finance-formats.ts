import { type AgingBuckets } from '../aging';
import { type Cell, csvOf, type SheetSpec, sumMoney } from './sheets';

/**
 * Finance export formats (B4.5, D-051) — pure: rows in, sheets / CSV text out (golden-tested). The builders in
 * `finance-exports.builders.ts` gather the rows. Money is a 2-decimal string throughout.
 */

export const INVOICE_STATUS_TH: Record<string, string> = {
  issued: 'ค้างชำระ',
  partially_paid: 'ชำระบางส่วน',
  overdue: 'เกินกำหนด',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิก',
  draft: 'ร่าง',
};
export const PAYMENT_METHOD_TH: Record<string, string> = {
  qr: 'Thai QR',
  transfer_slip: 'โอน (สลิป)',
  cash: 'เงินสด',
  bank_transfer_manual: 'โอน (บันทึกเอง)',
  card: 'บัตร',
  offset: 'หักจากเครดิต',
};

export interface InvoiceLineExport {
  lineNo: number;
  kind: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
  vat: boolean;
}

export interface InvoiceExport {
  number: string;
  issuedOn: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string | null;
  building: string;
  unitNo: string | null;
  payer: string;
  payerTaxId: string | null;
  payerBranch: string | null;
  payerAddress: string | null;
  status: string;
  subtotal: string;
  vat: string;
  total: string;
  paid: string;
  credited: string;
  debited: string;
  balance: string;
  lines: readonly InvoiceLineExport[];
}

export interface PaymentExport {
  paidOn: string;
  method: string;
  via: string | null;
  payer: string;
  unitNo: string | null;
  building: string;
  invoices: string;
  amount: string;
  wht: string;
  allocated: string;
  credited: string;
  receipt: string | null;
  status: string;
  providerRef: string | null;
}

export interface ReceiptExport {
  number: string;
  kind: 'receipt' | 'receipt_tax_invoice';
  issuedOn: string;
  payer: string;
  payerTaxId: string | null;
  payerBranch: string | null;
  unitNo: string | null;
  references: string;
  method: string;
  subtotal: string;
  vat: string;
  total: string;
  voided: boolean;
}

export interface ArrearsExport {
  payer: string;
  unitNo: string | null;
  building: string;
  balance: string;
  credit: string;
  openInvoices: number;
  oldestDueOn: string | null;
  daysOverdue: number;
  aging: AgingBuckets;
}

export interface OpenInvoiceExport {
  number: string;
  payer: string;
  unitNo: string | null;
  dueOn: string | null;
  daysOverdue: number;
  total: string;
  balance: string;
}

export interface VatDocExport {
  issuedOn: string;
  number: string;
  kind: string;
  buyer: string;
  buyerTaxId: string | null;
  buyerBranch: string | null;
  subtotal: string;
  vat: string;
  total: string;
  voided: boolean;
}

export interface IncomeExpenseExport {
  building: string;
  billed: string;
  received: string;
  electricity: string;
  water: string;
  workOrders: string;
}

const preamble = (title: string, issuer: string, period: string, generatedAt: string) => [
  title,
  `${issuer}`,
  `งวด ${period}`,
  `สร้างเมื่อ ${generatedAt}`,
];

export interface ExportMeta {
  issuer: string;
  period: string;
  generatedAt: string;
}

// ------------------------------------------------------------------------------------------- Excel

export function invoicesWorkbook(meta: ExportMeta, rows: readonly InvoiceExport[]): SheetSpec[] {
  const money = ['subtotal', 'vat', 'total', 'paid', 'credited', 'debited', 'balance'] as const;
  return [
    {
      name: 'ใบแจ้งหนี้',
      preamble: preamble('รายงานใบแจ้งหนี้', meta.issuer, meta.period, meta.generatedAt),
      columns: [
        { key: 'number', header: 'เลขที่', width: 18 },
        { key: 'issuedOn', header: 'วันที่ออก', type: 'date' },
        { key: 'period', header: 'งวด', width: 24 },
        { key: 'dueOn', header: 'ครบกำหนด', type: 'date' },
        { key: 'building', header: 'อาคาร' },
        { key: 'unitNo', header: 'ห้อง', width: 10 },
        { key: 'payer', header: 'ผู้ชำระ', width: 28 },
        { key: 'status', header: 'สถานะ', width: 14 },
        { key: 'subtotal', header: 'ก่อนภาษี', type: 'money' },
        { key: 'vat', header: 'ภาษีมูลค่าเพิ่ม', type: 'money' },
        { key: 'total', header: 'ยอดรวม', type: 'money' },
        { key: 'paid', header: 'ชำระแล้ว', type: 'money' },
        { key: 'credited', header: 'ลดหนี้', type: 'money' },
        { key: 'debited', header: 'เพิ่มหนี้', type: 'money' },
        { key: 'balance', header: 'คงค้าง', type: 'money' },
      ],
      rows: rows.map((r) => ({
        number: r.number,
        issuedOn: r.issuedOn,
        period: `${r.periodStart} – ${r.periodEnd}`,
        dueOn: r.dueOn,
        building: r.building,
        unitNo: r.unitNo,
        payer: r.payer,
        status: INVOICE_STATUS_TH[r.status] ?? r.status,
        subtotal: r.subtotal,
        vat: r.vat,
        total: r.total,
        paid: r.paid,
        credited: r.credited,
        debited: r.debited,
        balance: r.balance,
      })),
      totals: {
        number: `รวม ${rows.length} ฉบับ`,
        ...Object.fromEntries(
          money.map((k) => [k, sumMoney(rows.filter((r) => r.status !== 'void').map((r) => r[k]))]),
        ),
      },
    },
    {
      name: 'รายการ',
      columns: [
        { key: 'number', header: 'เลขที่', width: 18 },
        { key: 'lineNo', header: 'ลำดับ', type: 'int', width: 8 },
        { key: 'kind', header: 'ประเภท', width: 16 },
        { key: 'description', header: 'รายการ', width: 40 },
        { key: 'quantity', header: 'จำนวน', width: 10 },
        { key: 'unit', header: 'หน่วย', width: 10 },
        { key: 'unitPrice', header: 'ราคาต่อหน่วย', width: 14 },
        { key: 'amount', header: 'จำนวนเงิน', type: 'money' },
      ],
      rows: rows.flatMap((r) =>
        r.lines.map((l) => ({
          number: r.number,
          lineNo: l.lineNo,
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPrice: l.unitPrice,
          amount: l.amount,
        })),
      ),
    },
  ];
}

export function paymentsWorkbook(meta: ExportMeta, rows: readonly PaymentExport[]): SheetSpec[] {
  const counted = rows.filter((r) => r.status === 'confirmed');
  return [
    {
      name: 'รับชำระ',
      preamble: preamble('รายงานการรับชำระเงิน', meta.issuer, meta.period, meta.generatedAt),
      columns: [
        { key: 'paidOn', header: 'วันที่ชำระ', type: 'date' },
        { key: 'method', header: 'วิธีชำระ', width: 16 },
        { key: 'via', header: 'ยืนยันโดย', width: 16 },
        { key: 'payer', header: 'ผู้ชำระ', width: 28 },
        { key: 'building', header: 'อาคาร' },
        { key: 'unitNo', header: 'ห้อง', width: 10 },
        { key: 'invoices', header: 'ใบแจ้งหนี้', width: 30 },
        { key: 'amount', header: 'จำนวนเงิน', type: 'money' },
        { key: 'wht', header: 'ภาษีหัก ณ ที่จ่าย', type: 'money' },
        { key: 'allocated', header: 'ตัดชำระหนี้', type: 'money' },
        { key: 'credited', header: 'เครดิตคงเหลือ', type: 'money' },
        { key: 'receipt', header: 'ใบเสร็จ', width: 18 },
        { key: 'status', header: 'สถานะ', width: 12 },
        { key: 'providerRef', header: 'อ้างอิงธนาคาร', width: 20 },
      ],
      rows: rows.map((r) => ({
        ...r,
        method: PAYMENT_METHOD_TH[r.method] ?? r.method,
        status: r.status === 'confirmed' ? 'ยืนยันแล้ว' : r.status === 'reversed' ? 'กลับรายการ' : r.status,
      })),
      totals: {
        paidOn: null,
        payer: `รวม ${counted.length} รายการ (ไม่รวมที่กลับรายการ)`,
        amount: sumMoney(counted.map((r) => r.amount)),
        wht: sumMoney(counted.map((r) => r.wht)),
        allocated: sumMoney(counted.map((r) => r.allocated)),
        credited: sumMoney(counted.map((r) => r.credited)),
      },
    },
  ];
}

export function arrearsWorkbook(
  meta: ExportMeta,
  rows: readonly ArrearsExport[],
  open: readonly OpenInvoiceExport[],
): SheetSpec[] {
  const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90p'] as const;
  return [
    {
      name: 'ลูกหนี้ค้างชำระ',
      preamble: preamble(
        'รายงานลูกหนี้ค้างชำระ (อายุหนี้)',
        meta.issuer,
        `ณ วันที่ ${meta.period}`,
        meta.generatedAt,
      ),
      columns: [
        { key: 'payer', header: 'ผู้ชำระ', width: 28 },
        { key: 'building', header: 'อาคาร' },
        { key: 'unitNo', header: 'ห้อง', width: 10 },
        { key: 'balance', header: 'ยอดค้างสุทธิ', type: 'money' },
        { key: 'credit', header: 'เครดิต', type: 'money' },
        { key: 'openInvoices', header: 'ใบแจ้งหนี้ค้าง', type: 'int', width: 10 },
        { key: 'oldestDueOn', header: 'ครบกำหนดเก่าสุด', type: 'date' },
        { key: 'daysOverdue', header: 'เกินกำหนด (วัน)', type: 'int', width: 10 },
        { key: 'current', header: 'ยังไม่ถึงกำหนด', type: 'money' },
        { key: 'd1_30', header: '1–30 วัน', type: 'money' },
        { key: 'd31_60', header: '31–60 วัน', type: 'money' },
        { key: 'd61_90', header: '61–90 วัน', type: 'money' },
        { key: 'd90p', header: 'เกิน 90 วัน', type: 'money' },
      ],
      rows: rows.map((r) => ({
        payer: r.payer,
        building: r.building,
        unitNo: r.unitNo,
        balance: r.balance,
        credit: r.credit,
        openInvoices: r.openInvoices,
        oldestDueOn: r.oldestDueOn,
        daysOverdue: r.daysOverdue,
        ...r.aging,
      })),
      totals: {
        payer: `รวม ${rows.length} ราย`,
        balance: sumMoney(rows.map((r) => r.balance)),
        credit: sumMoney(rows.map((r) => r.credit)),
        openInvoices: rows.reduce((s, r) => s + r.openInvoices, 0),
        ...Object.fromEntries(buckets.map((b) => [b, sumMoney(rows.map((r) => r.aging[b]))])),
      },
    },
    {
      name: 'ใบแจ้งหนี้ค้าง',
      columns: [
        { key: 'number', header: 'เลขที่', width: 18 },
        { key: 'payer', header: 'ผู้ชำระ', width: 28 },
        { key: 'unitNo', header: 'ห้อง', width: 10 },
        { key: 'dueOn', header: 'ครบกำหนด', type: 'date' },
        { key: 'daysOverdue', header: 'เกินกำหนด (วัน)', type: 'int', width: 10 },
        { key: 'total', header: 'ยอดรวม', type: 'money' },
        { key: 'balance', header: 'คงค้าง', type: 'money' },
      ],
      rows: open.map((o) => ({ ...o })),
      totals: { number: 'รวม', balance: sumMoney(open.map((o) => o.balance)) },
    },
  ];
}

export function vatPp30Workbook(
  meta: ExportMeta & { taxId: string | null; branch: string | null },
  docs: readonly VatDocExport[],
  purchaseVatReference: string,
): SheetSpec[] {
  const counted = docs.filter((d) => !d.voided);
  const base = sumMoney(counted.map((d) => d.subtotal));
  const vat = sumMoney(counted.map((d) => d.vat));
  return [
    {
      name: 'สรุป ภ.พ.30',
      preamble: [
        'ตัวเลขประกอบการยื่น ภ.พ.30 (ข้อมูลช่วยทำงาน — ตรวจสอบกับผู้ทำบัญชีก่อนยื่น)',
        `${meta.issuer} เลขประจำตัวผู้เสียภาษี ${meta.taxId ?? '-'} สาขา ${meta.branch ?? '00000'}`,
        `เดือนภาษี ${meta.period}`,
        `สร้างเมื่อ ${meta.generatedAt}`,
      ],
      columns: [
        { key: 'item', header: 'รายการ', width: 52 },
        { key: 'amount', header: 'จำนวนเงิน', type: 'money' },
      ],
      rows: [
        { item: '1. ยอดขายที่ต้องเสียภาษี (มูลค่าก่อนภาษีตามใบกำกับภาษีที่ออกในเดือน)', amount: base },
        { item: '2. ภาษีขายเดือนนี้', amount: vat },
        {
          item: '3. ภาษีซื้อเดือนนี้ (ไม่ได้บันทึกในระบบ — ภาษีในใบแจ้งหนี้ค่าน้ำค่าไฟเพื่ออ้างอิง)',
          amount: purchaseVatReference,
        },
        { item: `จำนวนใบกำกับภาษี (ไม่รวมที่ยกเลิก) ${counted.length} ฉบับ`, amount: null },
      ],
    },
    {
      name: 'รายงานภาษีขาย',
      columns: [
        { key: 'issuedOn', header: 'วันที่', type: 'date' },
        { key: 'number', header: 'เลขที่', width: 18 },
        { key: 'kind', header: 'ประเภท', width: 22 },
        { key: 'buyer', header: 'ชื่อผู้ซื้อ', width: 28 },
        { key: 'buyerTaxId', header: 'เลขประจำตัวผู้เสียภาษี', width: 16 },
        { key: 'buyerBranch', header: 'สาขา', width: 8 },
        { key: 'subtotal', header: 'มูลค่าสินค้า/บริการ', type: 'money' },
        { key: 'vat', header: 'ภาษีมูลค่าเพิ่ม', type: 'money' },
        { key: 'total', header: 'รวม', type: 'money' },
        { key: 'note', header: 'หมายเหตุ', width: 12 },
      ],
      rows: docs.map((d) => ({
        issuedOn: d.issuedOn,
        number: d.number,
        kind: d.kind === 'receipt_tax_invoice' ? 'ใบเสร็จรับเงิน/ใบกำกับภาษี' : 'ใบกำกับภาษี',
        buyer: d.buyer,
        buyerTaxId: d.buyerTaxId,
        buyerBranch: d.buyerBranch,
        subtotal: d.voided ? '0.00' : d.subtotal,
        vat: d.voided ? '0.00' : d.vat,
        total: d.voided ? '0.00' : d.total,
        note: d.voided ? 'ยกเลิก' : null,
      })),
      totals: { number: 'รวม', subtotal: base, vat, total: sumMoney(counted.map((d) => d.total)) },
    },
  ];
}

export function incomeExpenseWorkbook(meta: ExportMeta, rows: readonly IncomeExpenseExport[]): SheetSpec[] {
  const neg = (v: string) => (v.startsWith('-') ? v.slice(1) : `-${v}`);
  const net = (r: IncomeExpenseExport) =>
    sumMoney([r.received, neg(r.electricity), neg(r.water), neg(r.workOrders)]);
  return [
    {
      name: 'รายรับรายจ่าย',
      preamble: preamble('สรุปรายรับ–รายจ่ายรายอาคาร', meta.issuer, meta.period, meta.generatedAt),
      columns: [
        { key: 'building', header: 'อาคาร', width: 24 },
        { key: 'billed', header: 'ยอดแจ้งหนี้', type: 'money' },
        { key: 'received', header: 'รับชำระจริง', type: 'money' },
        { key: 'electricity', header: 'ค่าไฟฟ้า (การไฟฟ้า)', type: 'money' },
        { key: 'water', header: 'ค่าน้ำ (การประปา)', type: 'money' },
        { key: 'workOrders', header: 'ค่าซ่อมบำรุง', type: 'money' },
        { key: 'net', header: 'สุทธิ (รับ − จ่าย)', type: 'money' },
      ],
      rows: rows.map((r) => ({ ...r, net: net(r) })),
      totals: {
        building: 'รวม',
        billed: sumMoney(rows.map((r) => r.billed)),
        received: sumMoney(rows.map((r) => r.received)),
        electricity: sumMoney(rows.map((r) => r.electricity)),
        water: sumMoney(rows.map((r) => r.water)),
        workOrders: sumMoney(rows.map((r) => r.workOrders)),
        net: sumMoney(rows.map(net)),
      },
    },
  ];
}

// ------------------------------------------------------------------------------------------- accounting imports

/**
 * FlowAccount document import (sales: ใบแจ้งหนี้ / ใบเสร็จรับเงิน), one row per document line, UTF-8 CSV with BOM.
 * // UNVERIFIED against live provider: the column set follows FlowAccount's spreadsheet import of sales documents as
 * described publicly; confirm with the tenant's accountant / a FlowAccount import before relying on it.
 */
export const FLOWACCOUNT_HEADERS = [
  'ประเภทเอกสาร',
  'เลขที่เอกสาร',
  'วันที่เอกสาร',
  'วันครบกำหนด',
  'ชื่อลูกค้า',
  'เลขประจำตัวผู้เสียภาษี',
  'สาขา',
  'ที่อยู่',
  'อ้างอิง',
  'ลำดับ',
  'ชื่อสินค้า/บริการ',
  'จำนวน',
  'หน่วย',
  'ราคาต่อหน่วย',
  'ภาษีมูลค่าเพิ่ม',
  'จำนวนเงิน',
  'หมายเหตุ',
] as const;

const pct = (rate: string) => `${Number((Number(rate) * 100).toFixed(2))}%`;

export function flowAccountCsv(
  invoices: readonly InvoiceExport[],
  receipts: readonly ReceiptExport[],
  vatRate: string,
): string {
  const vatFlag = (vat: boolean) => (vat ? pct(vatRate) : 'ไม่มีภาษี');
  const rows: Cell[][] = [];
  for (const inv of invoices.filter((i) => i.status !== 'void'))
    for (const l of inv.lines)
      rows.push([
        'ใบแจ้งหนี้',
        inv.number,
        inv.issuedOn,
        inv.dueOn,
        inv.payer,
        inv.payerTaxId,
        inv.payerBranch,
        inv.payerAddress,
        inv.unitNo ? `ห้อง ${inv.unitNo}` : null,
        l.lineNo,
        l.description,
        l.quantity,
        l.unit,
        l.unitPrice,
        vatFlag(l.vat),
        l.amount,
        `งวด ${inv.periodStart} – ${inv.periodEnd}`,
      ]);
  for (const r of receipts.filter((x) => !x.voided))
    rows.push([
      r.kind === 'receipt_tax_invoice' ? 'ใบเสร็จรับเงิน/ใบกำกับภาษี' : 'ใบเสร็จรับเงิน',
      r.number,
      r.issuedOn,
      null,
      r.payer,
      r.payerTaxId,
      r.payerBranch,
      null,
      r.references,
      1,
      `รับชำระ ${r.references}`.trim(),
      '1',
      null,
      r.subtotal,
      vatFlag(r.kind === 'receipt_tax_invoice' && r.vat !== '0.00'),
      r.subtotal,
      r.method,
    ]);
  return csvOf(FLOWACCOUNT_HEADERS, rows);
}

/**
 * PEAK import (รายได้: ใบแจ้งหนี้ / ใบเสร็จรับเงิน), one row per document line, UTF-8 CSV with BOM; documents of the
 * same number share the group number. // UNVERIFIED against live provider: the column set follows PEAK's
 * spreadsheet import as described publicly; confirm with a PEAK import before relying on it.
 */
export const PEAK_HEADERS = [
  'ลำดับเอกสาร',
  'ประเภทเอกสาร',
  'วันที่เอกสาร',
  'เลขที่เอกสาร',
  'อ้างอิง',
  'ผู้ติดต่อ',
  'เลขทะเบียน 13 หลัก',
  'เลขสาขา 5 หลัก',
  'วันที่ครบกำหนด',
  'ประเภทราคา',
  'คำอธิบายรายการ',
  'จำนวน',
  'ราคาต่อหน่วย',
  'อัตราภาษี',
  'มูลค่ารวม',
  'หมายเหตุ',
] as const;

export function peakCsv(
  invoices: readonly InvoiceExport[],
  receipts: readonly ReceiptExport[],
  vatRate: string,
): string {
  const rows: Cell[][] = [];
  let group = 0;
  for (const inv of invoices.filter((i) => i.status !== 'void')) {
    group += 1;
    for (const l of inv.lines)
      rows.push([
        group,
        'ใบแจ้งหนี้',
        inv.issuedOn,
        inv.number,
        inv.unitNo ? `ห้อง ${inv.unitNo}` : null,
        inv.payer,
        inv.payerTaxId,
        inv.payerBranch ?? (inv.payerTaxId ? '00000' : null),
        inv.dueOn,
        l.vat ? 'แยกภาษี' : 'ไม่มีภาษี',
        l.description,
        l.quantity,
        l.unitPrice,
        l.vat ? pct(vatRate) : '0%',
        l.amount,
        `งวด ${inv.periodStart} – ${inv.periodEnd}`,
      ]);
  }
  for (const r of receipts.filter((x) => !x.voided)) {
    group += 1;
    const vat = r.kind === 'receipt_tax_invoice' && r.vat !== '0.00';
    rows.push([
      group,
      r.kind === 'receipt_tax_invoice' ? 'ใบเสร็จรับเงิน/ใบกำกับภาษี' : 'ใบเสร็จรับเงิน',
      r.issuedOn,
      r.number,
      r.references,
      r.payer,
      r.payerTaxId,
      r.payerBranch ?? (r.payerTaxId ? '00000' : null),
      null,
      vat ? 'แยกภาษี' : 'ไม่มีภาษี',
      `รับชำระ ${r.references}`.trim(),
      '1',
      r.subtotal,
      vat ? pct(vatRate) : '0%',
      r.subtotal,
      r.method,
    ]);
  }
  return csvOf(PEAK_HEADERS, rows);
}
