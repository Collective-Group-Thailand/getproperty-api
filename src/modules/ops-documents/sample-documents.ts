import {
  type DocumentView,
  type InvoiceSnapshot,
  invoiceView,
  noteView,
  receiptView,
} from './document-views';

/**
 * Obviously fake sample documents (B4.3): the platform admin's template preview and the PDF text snapshot tests
 * render these. One per document type; the invoice has a rent line, a fixed service, a metered electricity line
 * above the utility rate (acknowledged), an estimated water line and a prior balance.
 */
export function sampleInvoiceSnapshot(vatRegistered = false): InvoiceSnapshot {
  return {
    number: 'INV-2026-00042',
    issuedAt: '2026-11-01T09:00:00+07:00',
    dueDate: '2026-11-05',
    tenant: {
      legalName: 'บริษัท ตัวอย่าง จำกัด (ทดสอบ)',
      displayName: 'หอพักตัวอย่าง',
      taxId: vatRegistered ? '0000000000042' : null,
      vatRegistered,
      address: {
        line1: '99/9 ถนนตัวอย่าง',
        subdistrict: 'แขวงตัวอย่าง',
        district: 'เขตตัวอย่าง',
        province: 'กรุงเทพมหานคร',
        postcode: '10000',
        country: 'TH',
      },
      bankAccount: {
        bankName: 'ธนาคารตัวอย่าง',
        accountName: 'บริษัท ตัวอย่าง จำกัด',
        masked: 'xxx-x-x1234-x',
      },
    },
    building: { name: 'อาคาร A' },
    unit: { unitNo: 'A-101' },
    billedParty: { displayName: 'ผู้เช่า ตัวอย่าง (ทดสอบ)' },
    lease: { number: 'CTR-2026-00001' },
    period: { start: '2026-10-01', end: '2026-10-31', isFinal: false },
    lines: [
      {
        lineNo: 1,
        lineKind: 'rent',
        description: 'ค่าเช่าห้อง A-101',
        quantity: '1.000',
        unit: 'month',
        unitPrice: '4500.0000',
        amount: '4500.00',
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
      },
      {
        lineNo: 2,
        lineKind: 'internet',
        description: 'อินเทอร์เน็ต',
        quantity: '1.000',
        unit: 'month',
        unitPrice: '300.0000',
        amount: '300.00',
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
      },
      {
        lineNo: 3,
        lineKind: 'electricity',
        description: 'ค่าไฟฟ้า 120.000 หน่วย',
        quantity: '120.000',
        unit: 'kwh',
        unitPrice: '7.0000',
        amount: '840.00',
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
      },
      {
        lineNo: 4,
        lineKind: 'water',
        description: 'ค่าน้ำประปา 6.000 ลบ.ม. (ประมาณการ)',
        quantity: '6.000',
        unit: 'm3',
        unitPrice: '18.0000',
        amount: '108.00',
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
      },
    ],
    meters: [
      {
        lineNo: 3,
        segments: [
          {
            code: 'A-101-E',
            fromReading: { register: '1114.500', readAt: '2026-09-30T23:58:00+07:00', source: 'iot' },
            toReading: { register: '1234.500', readAt: '2026-10-31T23:58:00+07:00', source: 'iot' },
          },
        ],
        units: '120.000',
        isEstimated: false,
        capPerUnit: '3.9900',
        utilityTariffVersion: { provider: 'mea', tariffCode: '1.1.1', effectiveFrom: '2026-09-01' },
        compliance: { aboveCap: true },
      },
      {
        lineNo: 4,
        segments: [
          {
            code: 'A-101-W',
            fromReading: { register: '50.000', readAt: '2026-09-30T10:00:00+07:00', source: 'manual' },
            toReading: { register: '56.000', readAt: '2026-11-01T23:59:00+07:00', source: 'estimated' },
          },
        ],
        units: '6.000',
        isEstimated: true,
        capPerUnit: '9.0950',
        utilityTariffVersion: { provider: 'mwa', tariffCode: 'residential', effectiveFrom: '2025-01-01' },
        compliance: { aboveCap: true },
      },
    ],
    settings: { 'tax.vat': { value: { rate: '0.07', applicableLineKinds: [] } } },
    priorBalance: { amount: '1200.00' },
    // VAT applies to no line kind until O-007 is answered, so even a VAT-registered issuer shows 0.00 here
    totals: { subtotal: '5748.00', vat: '0.00', total: '5748.00', amountDue: '6948.00' },
  };
}

export type SampleKey =
  | 'invoice'
  | 'credit_note'
  | 'debit_note'
  | 'receipt'
  | 'receipt_advance'
  | 'tax_invoice'
  | 'receipt_tax_invoice';

export function sampleView(key: SampleKey): DocumentView {
  const snap = sampleInvoiceSnapshot(key === 'tax_invoice' || key === 'receipt_tax_invoice');
  const link = 'https://liff.example.invalid/invoices/sample';
  switch (key) {
    case 'invoice':
      return invoiceView(snap, { promptpayRef: 'INV202600042', link });
    case 'credit_note':
    case 'debit_note':
      return noteView({
        kind: key === 'credit_note' ? 'credit' : 'debit',
        number: key === 'credit_note' ? 'CRN-2026-00001' : 'DBN-2026-00001',
        issuedAt: '2026-11-03T10:00:00+07:00',
        reason: 'reading_correction',
        reasonText: 'อ่านมิเตอร์ไฟฟ้าผิด 10 หน่วย',
        lines: [{ lineNo: 1, description: 'ค่าไฟฟ้า 10 หน่วย × 7.00', amount: '70.00' }],
        subtotal: '70.00',
        vatAmount: '0.00',
        total: '70.00',
        invoice: snap,
        valueBefore: '5748.00',
      });
    case 'receipt':
    case 'receipt_advance':
    case 'tax_invoice':
    case 'receipt_tax_invoice': {
      const vat = key === 'tax_invoice' || key === 'receipt_tax_invoice';
      return receiptView({
        docType: key === 'receipt_advance' ? 'receipt' : key,
        number: vat ? 'RTI-2026-00001' : 'RCP-2026-00001',
        issuedOn: '2026-11-04',
        issuer: invoiceView(snap, { link }).issuer,
        customer: { name: 'ผู้เช่า ตัวอย่าง (ทดสอบ)', address: null, taxId: null },
        unitNo: 'A-101',
        kind: key === 'receipt_advance' ? 'advance' : 'payment',
        items:
          key === 'receipt_advance'
            ? [
                {
                  description: 'รับชำระเกินยอด (เครดิตสำหรับใบแจ้งหนี้ถัดไป)',
                  reference: null,
                  amount: '252.00',
                },
              ]
            : [{ description: 'ชำระใบแจ้งหนี้', reference: 'INV-2026-00042', amount: '5748.00' }],
        method: 'Thai QR (พร้อมเพย์)',
        paymentReference: 'KB202611040001',
        subtotal: vat ? '5372.00' : key === 'receipt_advance' ? '252.00' : '5748.00',
        vat: vat ? { ratePct: '7', amount: '376.00' } : null,
        total: key === 'receipt_advance' ? '252.00' : '5748.00',
        link,
      });
    }
  }
}

export const SAMPLE_KEYS: SampleKey[] = [
  'invoice',
  'credit_note',
  'debit_note',
  'receipt',
  'receipt_advance',
  'tax_invoice',
  'receipt_tax_invoice',
];
