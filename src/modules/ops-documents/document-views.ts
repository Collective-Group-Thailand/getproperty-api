import { bahtText, thaiDate } from '@modules/ops-leases/thai-text';
import Decimal from 'decimal.js';

/**
 * View models of the billing documents (B4.3, D-022, D-050): plain data the Handlebars templates and the LINE Flex
 * builders read. Invoices are rendered from their **issue snapshot** (schema-design §4.2.3) so a document never
 * shows anything the issued invoice did not contain; receipts and tax invoices (B4.4) and notes from their rows.
 * Pure: no I/O, money as decimal strings.
 */
export type BillingDocType =
  'invoice' | 'credit_note' | 'debit_note' | 'receipt' | 'tax_invoice' | 'receipt_tax_invoice';

export interface IssuerView {
  name: string;
  displayName: string;
  taxId: string | null;
  /** "สำนักงานใหญ่" for a VAT-registered issuer (tax invoices). */
  branch: string | null;
  address: string;
  vatRegistered: boolean;
  logoDataUrl: string | null;
}

export interface MeterSegmentView {
  code: string;
  from: string;
  fromAt: string | null;
  fromSource: string;
  to: string | null;
  toAt: string | null;
  toSource: string | null;
}

export interface MeterView {
  segments: MeterSegmentView[];
  units: string | null;
  /** The utility's effective rate per unit (D-021a, D-140). */
  capPerUnit: string | null;
  utilityReference: string | null;
  aboveCap: boolean;
  estimated: boolean;
}

export interface LineView {
  no: number;
  kind: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  period: string | null;
  meter: MeterView | null;
}

export interface PaymentView {
  bankName: string | null;
  accountName: string | null;
  accountMasked: string | null;
  /** The payment reference (the invoice number without separators). */
  reference: string | null;
  /** Thai QR (D-042) as a PNG data URL when the invoice has one (B4.4). */
  qrDataUrl: string | null;
}

export interface InvoiceView {
  docType: 'invoice';
  title: string;
  number: string;
  issuedOn: string;
  dueOn: string;
  issuer: IssuerView;
  customer: { name: string };
  unitNo: string | null;
  buildingName: string;
  leaseNumber: string | null;
  period: { start: string; end: string };
  isFinal: boolean;
  lines: LineView[];
  subtotal: string;
  vat: { ratePct: string; amount: string } | null;
  total: string;
  totalText: string;
  priorBalance: string;
  hasPrior: boolean;
  amountDue: string;
  amountDueText: string;
  hasEstimate: boolean;
  hasAboveCap: boolean;
  payment: PaymentView;
  /** LIFF link of the invoice (Flex button). */
  link: string;
}

export interface NoteView {
  docType: 'credit_note' | 'debit_note';
  title: string;
  number: string;
  issuedOn: string;
  issuer: IssuerView;
  customer: { name: string };
  unitNo: string | null;
  invoice: { number: string; issuedOn: string; total: string };
  reason: string;
  reasonText: string;
  lines: { no: number; description: string; amount: string }[];
  subtotal: string;
  vat: { ratePct: string; amount: string } | null;
  total: string;
  totalText: string;
  /** Value of the invoice before and after this note (Revenue Code §86/9–86/10 working figures). */
  originalValue: string;
  correctedValue: string;
}

export interface ReceiptView {
  docType: 'receipt' | 'tax_invoice' | 'receipt_tax_invoice';
  title: string;
  number: string;
  issuedOn: string;
  issuer: IssuerView;
  customer: { name: string; address: string | null; taxId: string | null };
  unitNo: string | null;
  /** advance: money received before an invoice exists (overpayment, D-044). */
  kind: 'payment' | 'deposit' | 'advance';
  items: { description: string; reference: string | null; amount: string }[];
  method: string;
  paymentReference: string | null;
  subtotal: string;
  vat: { ratePct: string; amount: string } | null;
  total: string;
  totalText: string;
  link: string;
}

export type DocumentView = InvoiceView | NoteView | ReceiptView;

const D = (v: Decimal.Value) => new Decimal(v);
const money = (v: Decimal.Value) => D(v).toFixed(2);

/** One line of a Thai postal address from the tenant's `address` json. */
export function formatAddress(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const x = a as Record<string, unknown>;
  return ['line1', 'line2', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => (typeof x[k] === 'string' ? x[k].trim() : ''))
    .filter(Boolean)
    .join(' ');
}

export const READING_SOURCE_TH: Record<string, string> = {
  iot: 'มิเตอร์อัจฉริยะ',
  manual: 'จดโดยเจ้าหน้าที่',
  ocr: 'อ่านจากภาพถ่ายมิเตอร์',
  estimated: 'ประมาณการ',
  assignment: 'เลขตั้งต้นของมิเตอร์',
};

const PROVIDER_TH: Record<string, string> = {
  mea: 'การไฟฟ้านครหลวง',
  pea: 'การไฟฟ้าส่วนภูมิภาค',
  mwa: 'การประปานครหลวง',
  pwa: 'การประปาส่วนภูมิภาค',
};

export const NOTE_REASON_TH: Record<string, string> = {
  reading_correction: 'แก้ไขเลขมิเตอร์',
  tariff_correction: 'แก้ไขอัตราค่าบริการ',
  goodwill: 'ส่วนลดพิเศษ',
  duplicate: 'เรียกเก็บซ้ำ',
  estimate_settlement: 'ปรับค่าประมาณการตามค่าจริง',
  other: 'อื่น ๆ',
};

const datePart = (v: unknown): string | null =>
  typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null;

interface SnapshotLine {
  lineNo: number;
  lineKind: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  periodFrom: string | null;
  periodTo: string | null;
}

interface SnapshotMeter {
  lineNo: number;
  segments: {
    code: string;
    fromReading: { register: string; readAt: string; source: string } | null;
    toReading: { register: string; readAt: string; source: string } | null;
  }[];
  units: string | null;
  isEstimated: boolean;
  capPerUnit: string | null;
  utilityTariffVersion: { provider: string; tariffCode: string; effectiveFrom: string } | null;
  compliance: { aboveCap: boolean };
}

/** The issue snapshot as stored on `ops.invoice.snapshot` (schema version 2). */
export interface InvoiceSnapshot {
  number: string;
  issuedAt: string;
  dueDate: string;
  tenant: {
    legalName: string;
    displayName: string;
    taxId: string | null;
    vatRegistered: boolean;
    address: unknown;
    bankAccount: { bankName: string | null; accountName: string; masked: string } | null;
  };
  building: { name: string };
  unit: { unitNo: string } | null;
  billedParty: { displayName: string };
  lease: { number: string | null } | null;
  period: { start: string; end: string; isFinal: boolean };
  lines: SnapshotLine[];
  meters: SnapshotMeter[];
  settings: Record<string, { value: unknown } | null>;
  priorBalance: { amount: string };
  totals: { subtotal: string; vat: string; total: string; amountDue: string };
}

export function issuerOf(t: InvoiceSnapshot['tenant'], logoDataUrl: string | null): IssuerView {
  return {
    name: t.legalName,
    displayName: t.displayName,
    taxId: t.taxId,
    branch: t.vatRegistered ? 'สำนักงานใหญ่' : null,
    address: formatAddress(t.address),
    vatRegistered: t.vatRegistered,
    logoDataUrl,
  };
}

function vatView(s: InvoiceSnapshot): InvoiceView['vat'] {
  if (!s.tenant.vatRegistered) return null;
  const rate = (s.settings['tax.vat']?.value as { rate?: string } | undefined)?.rate ?? '0';
  return { ratePct: D(rate).times(100).toDecimalPlaces(2).toString(), amount: money(s.totals.vat) };
}

/** The invoice document from its snapshot; `extra` carries what the snapshot does not (logo, QR, links). */
export function invoiceView(
  s: InvoiceSnapshot,
  extra: {
    logoDataUrl?: string | null;
    qrDataUrl?: string | null;
    promptpayRef?: string | null;
    link: string;
  },
): InvoiceView {
  const meters = new Map(s.meters.map((m) => [m.lineNo, m]));
  const lines: LineView[] = s.lines.map((l) => {
    const m = meters.get(l.lineNo);
    return {
      no: l.lineNo,
      kind: l.lineKind,
      description: l.description,
      quantity: D(l.quantity).toFixed(D(l.quantity).isInteger() ? 0 : 3),
      unit: l.unit,
      // two decimals unless the rate has more (a tiered average such as 3.2169, D-022)
      unitPrice: l.unitPrice ? D(l.unitPrice).toFixed(D(l.unitPrice).decimalPlaces() <= 2 ? 2 : 4) : null,
      amount: money(l.amount),
      period: l.periodFrom && l.periodTo ? `${l.periodFrom}|${l.periodTo}` : null,
      meter: m
        ? {
            segments: m.segments.map((g) => ({
              code: g.code,
              from: g.fromReading?.register ?? '',
              fromAt: datePart(g.fromReading?.readAt),
              fromSource: READING_SOURCE_TH[g.fromReading?.source ?? ''] ?? g.fromReading?.source ?? '',
              to: g.toReading?.register ?? null,
              toAt: datePart(g.toReading?.readAt),
              toSource: g.toReading ? (READING_SOURCE_TH[g.toReading.source] ?? g.toReading.source) : null,
            })),
            units: m.units,
            capPerUnit: m.capPerUnit,
            utilityReference: m.utilityTariffVersion
              ? `${PROVIDER_TH[m.utilityTariffVersion.provider] ?? m.utilityTariffVersion.provider} ประเภท ${
                  m.utilityTariffVersion.tariffCode === 'residential'
                    ? 'ที่อยู่อาศัย'
                    : m.utilityTariffVersion.tariffCode
                } อัตราที่มีผล ${thaiDate(m.utilityTariffVersion.effectiveFrom)}`
              : null,
            aboveCap: m.compliance.aboveCap,
            estimated: m.isEstimated,
          }
        : null,
    };
  });
  const prior = D(s.priorBalance.amount);
  return {
    docType: 'invoice',
    title: s.period.isFinal ? 'ใบแจ้งหนี้ (งวดสุดท้าย)' : 'ใบแจ้งหนี้',
    number: s.number,
    issuedOn: s.issuedAt.slice(0, 10),
    dueOn: s.dueDate,
    issuer: issuerOf(s.tenant, extra.logoDataUrl ?? null),
    customer: { name: s.billedParty.displayName },
    unitNo: s.unit?.unitNo ?? null,
    buildingName: s.building.name,
    leaseNumber: s.lease?.number ?? null,
    period: { start: s.period.start, end: s.period.end },
    isFinal: s.period.isFinal,
    lines,
    subtotal: money(s.totals.subtotal),
    vat: vatView(s),
    total: money(s.totals.total),
    totalText: bahtText(s.totals.total),
    priorBalance: money(prior),
    hasPrior: prior.gt(0),
    amountDue: money(s.totals.amountDue),
    amountDueText: bahtText(s.totals.amountDue),
    hasEstimate: lines.some((l) => l.meter?.estimated),
    hasAboveCap: lines.some((l) => l.meter?.aboveCap),
    payment: {
      bankName: s.tenant.bankAccount?.bankName ?? null,
      accountName: s.tenant.bankAccount?.accountName ?? null,
      accountMasked: s.tenant.bankAccount?.masked ?? null,
      reference: extra.promptpayRef ?? null,
      qrDataUrl: extra.qrDataUrl ?? null,
    },
    link: extra.link,
  };
}

/** A credit or debit note against an issued invoice (D-040). */
export function noteView(input: {
  kind: 'credit' | 'debit';
  number: string;
  issuedAt: string;
  reason: string;
  reasonText: string;
  lines: { lineNo: number; description: string; amount: string }[];
  subtotal: string;
  vatAmount: string;
  total: string;
  invoice: InvoiceSnapshot;
  /** Value of the invoice (total + earlier debits − earlier credits) before this note. */
  valueBefore: string;
  logoDataUrl?: string | null;
}): NoteView {
  const s = input.invoice;
  const before = D(input.valueBefore);
  const after = input.kind === 'credit' ? before.minus(input.total) : before.plus(input.total);
  const vat = vatView(s);
  return {
    docType: input.kind === 'credit' ? 'credit_note' : 'debit_note',
    title: input.kind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้',
    number: input.number,
    issuedOn: input.issuedAt.slice(0, 10),
    issuer: issuerOf(s.tenant, input.logoDataUrl ?? null),
    customer: { name: s.billedParty.displayName },
    unitNo: s.unit?.unitNo ?? null,
    invoice: { number: s.number, issuedOn: s.issuedAt.slice(0, 10), total: money(s.totals.total) },
    reason: NOTE_REASON_TH[input.reason] ?? input.reason,
    reasonText: input.reasonText,
    lines: input.lines.map((l) => ({ no: l.lineNo, description: l.description, amount: money(l.amount) })),
    subtotal: money(input.subtotal),
    vat: vat ? { ratePct: vat.ratePct, amount: money(input.vatAmount) } : null,
    total: money(input.total),
    totalText: bahtText(input.total),
    originalValue: money(before),
    correctedValue: money(after),
  };
}

export const RECEIPT_TITLES: Record<ReceiptView['docType'], string> = {
  receipt: 'ใบเสร็จรับเงิน',
  tax_invoice: 'ใบกำกับภาษี',
  receipt_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษี',
};

export const PAYMENT_METHOD_TH: Record<string, string> = {
  qr: 'Thai QR (พร้อมเพย์)',
  transfer_slip: 'โอนเงิน (แนบสลิป)',
  cash: 'เงินสด',
  bank_transfer_manual: 'โอนเงินเข้าบัญชี',
  offset: 'หักกลบยอดเครดิต',
};

/** Receipts and tax invoices (B4.4 fills the data from `ops.receipt` / `ops.tax_invoice`). */
export function receiptView(input: Omit<ReceiptView, 'title' | 'totalText'>): ReceiptView {
  const title =
    input.kind === 'advance' && input.docType === 'receipt'
      ? 'ใบเสร็จรับเงิน (รับชำระล่วงหน้า)'
      : RECEIPT_TITLES[input.docType];
  return { ...input, title, totalText: bahtText(input.total) };
}
