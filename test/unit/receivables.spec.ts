import 'reflect-metadata';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bucketOf, daysPastDue, positionOf, totalsOf } from '@modules/ops-receivables/aging';
import { scheduleDays } from '@modules/ops-receivables/dunning.service';
import {
  type ArrearsExport,
  arrearsWorkbook,
  type ExportMeta,
  flowAccountCsv,
  incomeExpenseWorkbook,
  type InvoiceExport,
  invoicesWorkbook,
  type PaymentExport,
  paymentsWorkbook,
  peakCsv,
  type ReceiptExport,
  type VatDocExport,
  vatPp30Workbook,
} from '@modules/ops-receivables/exports/finance-formats';
import { csvField, csvOf, readXlsx, sumMoney, xlsxOf } from '@modules/ops-receivables/exports/sheets';

const DIR = join(__dirname, '..', 'golden', 'exports');

function goldenText(name: string, text: string): void {
  const file = join(DIR, name);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text).toBe(readFileSync(file, 'utf8'));
}

/** XLSX goldens hold what the workbook says (sheet → rows of cells), compared parsed (prettier may reformat). */
async function goldenXlsx(name: string, body: Buffer): Promise<void> {
  const content = await readXlsx(body);
  const file = join(DIR, `${name}.xlsx.json`);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  }
  expect(content).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

const META: ExportMeta = {
  issuer: 'บริษัท ตัวอย่าง จำกัด',
  period: '2026-11',
  generatedAt: '2026-12-01 09:00',
};
const CREATED = new Date('2026-12-01T02:00:00Z');
const xlsx = (sheets: Parameters<typeof xlsxOf>[0]) =>
  xlsxOf(sheets, { creator: 'getproperty', createdAt: CREATED });

describe('aging (D-045): buckets by days past the due date on a Bangkok day', () => {
  const today = '2026-11-17';
  const fixtures = [
    { balance: '1000.00', dueOn: '2026-11-30' }, // not yet due
    { balance: '50.00', dueOn: '2026-11-17' }, // due today: still current
    { balance: '500.00', dueOn: '2026-11-16' }, // 1 day
    { balance: '200.00', dueOn: '2026-10-18' }, // 30 days
    { balance: '300.00', dueOn: '2026-10-17' }, // 31 days
    { balance: '400.00', dueOn: '2026-09-18' }, // 60 days
    { balance: '600.00', dueOn: '2026-09-17' }, // 61 days
    { balance: '700.00', dueOn: '2026-08-19' }, // 90 days
    { balance: '800.00', dueOn: '2026-08-18' }, // 91 days
    { balance: '25.50', dueOn: null }, // no due date: current
    { balance: '0.00', dueOn: '2026-01-01' }, // paid: ignored
  ];

  it('days past due and bucket edges', () => {
    expect(daysPastDue('2026-11-17', today)).toBe(0);
    expect(daysPastDue('2026-11-16', today)).toBe(1);
    expect(daysPastDue('2026-10-18', today)).toBe(30);
    expect(daysPastDue('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysPastDue('2024-02-28', '2024-03-01')).toBe(2); // leap year
    expect([0, 1, 30, 31, 60, 61, 90, 91, -5].map(bucketOf)).toEqual([
      'current',
      'd1_30',
      'd1_30',
      'd31_60',
      'd31_60',
      'd61_90',
      'd61_90',
      'd90p',
      'current',
    ]);
  });

  it('positions of the fixtures', () => {
    expect(positionOf(fixtures, '150.00', today)).toEqual({
      balance: '4425.50',
      openBalance: '4575.50',
      creditBalance: '150.00',
      openInvoicesCount: 10,
      oldestDueOn: '2026-08-18',
      daysOverdue: 91,
      aging: { current: '1075.50', d1_30: '700.00', d31_60: '700.00', d61_90: '1300.00', d90p: '800.00' },
    });
    // nothing open, only credit → negative net balance, nothing overdue
    expect(positionOf([], '252.00', today)).toEqual({
      balance: '-252.00',
      openBalance: '0.00',
      creditBalance: '252.00',
      openInvoicesCount: 0,
      oldestDueOn: null,
      daysOverdue: 0,
      aging: { current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90p: '0.00' },
    });
    // only invoices not yet due: 0 days overdue though the oldest due date is set
    expect(positionOf([{ balance: '10.00', dueOn: '2026-12-05' }], 0, today)).toMatchObject({
      oldestDueOn: '2026-12-05',
      daysOverdue: 0,
    });
  });

  it('totals add up the buckets', () => {
    const a = positionOf(fixtures, '150.00', today);
    const b = positionOf([{ balance: '99.99', dueOn: '2026-11-01' }], 0, today);
    expect(totalsOf([a, b])).toEqual({
      balance: '4525.49',
      creditBalance: '150.00',
      aging: { current: '1075.50', d1_30: '799.99', d31_60: '700.00', d61_90: '1300.00', d90p: '800.00' },
    });
  });

  it('reminders.schedule: positive whole days, unique, ascending', () => {
    expect(scheduleDays([7, 1, 3, 3])).toEqual([1, 3, 7]);
    expect(scheduleDays([0, -1, 1.5, '2', 14])).toEqual([14]);
    expect(scheduleDays(null)).toEqual([]);
  });
});

describe('CSV and money helpers', () => {
  it('quotes per RFC 4180; BOM + CRLF', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(' lead')).toBe('" lead"');
    expect(csvField(null)).toBe('');
    expect(csvOf(['a', 'b'], [[1, 'x']])).toBe('﻿a,b\r\n1,x\r\n');
  });

  it('sums money strings exactly', () => {
    expect(sumMoney(['0.10', '0.20', '-0.05', null])).toBe('0.25');
    expect(sumMoney(['-5.00', '1.00'])).toBe('-4.00');
    expect(sumMoney([])).toBe('0.00');
  });
});

// ------------------------------------------------------------------------------------------- golden exports

const INVOICES: InvoiceExport[] = [
  {
    number: 'INV-2026-00001',
    issuedOn: '2026-11-01',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    dueOn: '2026-11-05',
    building: 'อาคาร A',
    unitNo: 'A-101',
    payer: 'นาย สมชาย ใจดี',
    payerTaxId: null,
    payerBranch: null,
    payerAddress: null,
    status: 'paid',
    subtotal: '5344.00',
    vat: '0.00',
    total: '5344.00',
    paid: '5344.00',
    credited: '0.00',
    debited: '0.00',
    balance: '0.00',
    lines: [
      {
        lineNo: 1,
        kind: 'rent',
        description: 'ค่าเช่าห้อง A-101',
        quantity: '1',
        unit: 'เดือน',
        unitPrice: '4500.00',
        amount: '4500.00',
        vat: false,
      },
      {
        lineNo: 2,
        kind: 'electricity',
        description: 'ค่าไฟฟ้า 1,234.5 → 1,334.5 (100 หน่วย)',
        quantity: '100',
        unit: 'kWh',
        unitPrice: '7.00',
        amount: '700.00',
        vat: false,
      },
      {
        lineNo: 3,
        kind: 'water',
        description: 'ค่าน้ำ "ขั้นต่ำ"',
        quantity: '7',
        unit: 'ลบ.ม.',
        unitPrice: '20.00',
        amount: '144.00',
        vat: false,
      },
    ],
  },
  {
    number: 'INV-2026-00002',
    issuedOn: '2026-11-01',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    dueOn: '2026-11-05',
    building: 'อาคาร A',
    unitNo: 'A-102',
    payer: 'บริษัท ผู้เช่า จำกัด',
    payerTaxId: '0105556000001',
    payerBranch: '00000',
    payerAddress: '1 ถนนตัวอย่าง กรุงเทพฯ',
    status: 'overdue',
    subtotal: '3000.00',
    vat: '210.00',
    total: '3210.00',
    paid: '1000.00',
    credited: '0.00',
    debited: '0.00',
    balance: '2210.00',
    lines: [
      {
        lineNo: 1,
        kind: 'rent',
        description: 'ค่าเช่าห้อง A-102',
        quantity: '1',
        unit: 'เดือน',
        unitPrice: '3000.00',
        amount: '3000.00',
        vat: true,
      },
    ],
  },
  {
    number: 'INV-2026-00003',
    issuedOn: '2026-11-02',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    dueOn: '2026-11-05',
    building: 'อาคาร A',
    unitNo: 'A-103',
    payer: 'นาง ทดสอบ',
    payerTaxId: null,
    payerBranch: null,
    payerAddress: null,
    status: 'void',
    subtotal: '100.00',
    vat: '0.00',
    total: '100.00',
    paid: '0.00',
    credited: '0.00',
    debited: '0.00',
    balance: '0.00',
    lines: [
      {
        lineNo: 1,
        kind: 'one_off',
        description: 'ค่ากุญแจ',
        quantity: '1',
        unit: null,
        unitPrice: '100.00',
        amount: '100.00',
        vat: false,
      },
    ],
  },
];

const RECEIPTS: ReceiptExport[] = [
  {
    number: 'RCP-2026-00001',
    kind: 'receipt',
    issuedOn: '2026-11-03',
    payer: 'นาย สมชาย ใจดี',
    payerTaxId: null,
    payerBranch: null,
    unitNo: 'A-101',
    references: 'INV-2026-00001',
    method: 'Thai QR',
    subtotal: '5344.00',
    vat: '0.00',
    total: '5344.00',
    voided: false,
  },
  {
    number: 'RTI-2026-00001',
    kind: 'receipt_tax_invoice',
    issuedOn: '2026-11-04',
    payer: 'บริษัท ผู้เช่า จำกัด',
    payerTaxId: '0105556000001',
    payerBranch: null,
    unitNo: 'A-102',
    references: 'INV-2026-00002',
    method: 'เงินสด',
    subtotal: '934.58',
    vat: '65.42',
    total: '1000.00',
    voided: false,
  },
  {
    number: 'RCP-2026-00002',
    kind: 'receipt',
    issuedOn: '2026-11-05',
    payer: 'นาง ทดสอบ',
    payerTaxId: null,
    payerBranch: null,
    unitNo: 'A-103',
    references: '',
    method: 'เงินสด',
    subtotal: '10.00',
    vat: '0.00',
    total: '10.00',
    voided: true,
  },
];

describe('finance exports (golden: test/golden/exports, UPDATE_GOLDEN=1 rewrites)', () => {
  it('FlowAccount CSV: one row per invoice line and per receipt; voided documents left out', () => {
    const csv = flowAccountCsv(INVOICES, RECEIPTS, '0.07');
    goldenText('flowaccount-2026-11.csv', csv);
    expect(csv.startsWith('﻿ประเภทเอกสาร,เลขที่เอกสาร')).toBe(true);
    expect(csv).not.toContain('INV-2026-00003');
    expect(csv).not.toContain('RCP-2026-00002');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + 4 + 2);
  });

  it('PEAK CSV: document groups, tax rate per line', () => {
    const csv = peakCsv(INVOICES, RECEIPTS, '0.07');
    goldenText('peak-2026-11.csv', csv);
    expect(csv).toContain(',7%,');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + 4 + 2);
  });

  it('invoices workbook: invoices with totals (void excluded) + lines', async () => {
    const body = await xlsx(invoicesWorkbook(META, INVOICES));
    await goldenXlsx('invoices-2026-11', body);
    const sheets = await readXlsx(body);
    const main = sheets['ใบแจ้งหนี้']!;
    expect(main.at(-1)).toEqual([
      'รวม 3 ฉบับ',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      8344,
      210,
      8554,
      6344,
      0,
      0,
      2210,
    ]);
    expect(sheets['รายการ']).toHaveLength(1 + 5);
  });

  it('payments workbook', async () => {
    const rows: PaymentExport[] = [
      {
        paidOn: '2026-11-03',
        method: 'qr',
        via: 'webhook',
        payer: 'นาย สมชาย ใจดี',
        unitNo: 'A-101',
        building: 'อาคาร A',
        invoices: 'INV-2026-00001',
        amount: '5344.00',
        wht: '0.00',
        allocated: '5344.00',
        credited: '0.00',
        receipt: 'RCP-2026-00001',
        status: 'confirmed',
        providerRef: 'KB-0001',
      },
      {
        paidOn: '2026-11-04',
        method: 'cash',
        via: 'manual',
        payer: 'บริษัท ผู้เช่า จำกัด',
        unitNo: 'A-102',
        building: 'อาคาร A',
        invoices: 'INV-2026-00002',
        amount: '1000.00',
        wht: '0.00',
        allocated: '1000.00',
        credited: '0.00',
        receipt: 'RTI-2026-00001',
        status: 'confirmed',
        providerRef: null,
      },
      {
        paidOn: '2026-11-05',
        method: 'cash',
        via: 'manual',
        payer: 'นาง ทดสอบ',
        unitNo: 'A-103',
        building: 'อาคาร A',
        invoices: '',
        amount: '10.00',
        wht: '0.00',
        allocated: '0.00',
        credited: '10.00',
        receipt: 'RCP-2026-00002',
        status: 'reversed',
        providerRef: null,
      },
    ];
    await goldenXlsx('payments-2026-11', await xlsx(paymentsWorkbook(META, rows)));
  });

  it('arrears workbook with aging', async () => {
    const pos = positionOf([{ balance: '2210.00', dueOn: '2026-11-05' }], 0, '2026-11-30');
    const rows: ArrearsExport[] = [
      {
        payer: 'บริษัท ผู้เช่า จำกัด',
        unitNo: 'A-102',
        building: 'อาคาร A',
        balance: pos.balance,
        credit: pos.creditBalance,
        openInvoices: pos.openInvoicesCount,
        oldestDueOn: pos.oldestDueOn,
        daysOverdue: pos.daysOverdue,
        aging: pos.aging,
      },
      {
        payer: 'นาง ทดสอบ',
        unitNo: 'A-103',
        building: 'อาคาร A',
        balance: '-10.00',
        credit: '10.00',
        openInvoices: 0,
        oldestDueOn: null,
        daysOverdue: 0,
        aging: { current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90p: '0.00' },
      },
    ];
    const body = await xlsx(
      arrearsWorkbook({ ...META, period: '2026-11-30' }, rows, [
        {
          number: 'INV-2026-00002',
          payer: 'บริษัท ผู้เช่า จำกัด',
          unitNo: 'A-102',
          dueOn: '2026-11-05',
          daysOverdue: 25,
          total: '3210.00',
          balance: '2210.00',
        },
      ]),
    );
    await goldenXlsx('arrears-2026-11-30', body);
    expect(rows[0]!.daysOverdue).toBe(25);
    expect(rows[0]!.aging.d1_30).toBe('2210.00');
  });

  it('VAT ภ.พ.30 figures: output VAT of the tax invoices of the month (voided shown as 0)', async () => {
    const docs: VatDocExport[] = [
      {
        issuedOn: '2026-11-04',
        number: 'RTI-2026-00001',
        kind: 'receipt_tax_invoice',
        buyer: 'บริษัท ผู้เช่า จำกัด',
        buyerTaxId: '0105556000001',
        buyerBranch: '00000',
        subtotal: '934.58',
        vat: '65.42',
        total: '1000.00',
        voided: false,
      },
      {
        issuedOn: '2026-11-20',
        number: 'RTI-2026-00002',
        kind: 'receipt_tax_invoice',
        buyer: 'บริษัท ผู้เช่า จำกัด',
        buyerTaxId: '0105556000001',
        buyerBranch: '00000',
        subtotal: '2065.42',
        vat: '144.58',
        total: '2210.00',
        voided: false,
      },
      {
        issuedOn: '2026-11-21',
        number: 'RTI-2026-00003',
        kind: 'receipt_tax_invoice',
        buyer: 'นาง ทดสอบ',
        buyerTaxId: null,
        buyerBranch: null,
        subtotal: '93.46',
        vat: '6.54',
        total: '100.00',
        voided: true,
      },
    ];
    const body = await xlsx(
      vatPp30Workbook({ ...META, taxId: '0105550000000', branch: '00000' }, docs, '1820.33'),
    );
    await goldenXlsx('vat-pp30-2026-11', body);
    const sheets = await readXlsx(body);
    const summary = sheets['สรุป ภ.พ.30']!;
    expect(summary.find((r) => String(r[0]).startsWith('1.'))?.[1]).toBe(3000);
    expect(summary.find((r) => String(r[0]).startsWith('2.'))?.[1]).toBe(210);
  });

  it('income / expense per building', async () => {
    const body = await xlsx(
      incomeExpenseWorkbook(META, [
        {
          building: 'อาคาร A',
          billed: '8554.00',
          received: '6344.00',
          electricity: '4813.20',
          water: '512.00',
          workOrders: '0.00',
        },
        {
          building: 'อาคาร B',
          billed: '0.00',
          received: '0.00',
          electricity: '120.00',
          water: '0.00',
          workOrders: '0.00',
        },
      ]),
    );
    await goldenXlsx('income-expense-2026-11', body);
    const rows = (await readXlsx(body))['รายรับรายจ่าย']!;
    expect(rows.at(-1)).toEqual(['รวม', 8554, 6344, 4933.2, 512, 0, 898.8]);
  });
});
