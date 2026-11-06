import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';

import { isRevenueKind, lineKindAccount } from '../accounting/posting';
import { cycleDifferences, type ExistingState, fillShares, planImport, reconcileItems } from './import-plan';
import {
  badRowsFile,
  csvRecords,
  issueMessage,
  parseDate,
  parseLast4,
  parseMoney,
  parsePeriod,
  parseSheet,
  readTable,
  resolveHeader,
  SHEET_KEYS,
  SHEETS,
  template,
} from './import-sheets';

const csv = (lines: string[]) => Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
const EMPTY: ExistingState = {
  building: { id: 'b', name: 'อาคาร A', code: 'A', type: 'condo' },
  units: [],
  floors: [],
  parties: [],
  bankAccounts: [{ id: 'ba1', last4: '4321' }],
  funds: [{ id: 'f1', name: 'กองทุนสำรอง', bankAccountId: null }],
};

describe('J3.1 import sheets (D-332)', () => {
  it('cells: dates (Buddhist years), periods, money, last 4 (masked ok, full refused)', () => {
    expect(parseDate('31/10/2569')).toBe('2026-10-31');
    expect(parseDate('2026-02-29')).toBeNull();
    expect(parseDate('2024-02-29')).toBe('2024-02-29');
    expect(parsePeriod('2569-07')).toEqual({ key: '2026-07', from: '2026-07-01', to: '2026-07-31' });
    expect(parsePeriod('2026-q4')).toEqual({ key: '2026-Q4', from: '2026-10-01', to: '2026-12-31' });
    expect(parsePeriod('2026-H1')).toEqual({ key: '2026-H1', from: '2026-01-01', to: '2026-06-30' });
    expect(parsePeriod('2026')).toEqual({ key: '2026', from: '2026-01-01', to: '2026-12-31' });
    expect(parsePeriod('2026-13')).toBeNull();
    expect(parseMoney('1,043.10')).toBe('1043.10');
    expect(parseMoney('฿ 25')).toBe('25.00');
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseLast4('1234')).toEqual({ value: '1234' });
    expect(parseLast4('XXXXXXXXX1234')).toEqual({ value: '1234' });
    expect(parseLast4('x-xxxx-xxxxx-12-3')).toEqual({ error: 'id_full_refused' });
    expect(parseLast4('1103700012345')).toEqual({ error: 'id_full_refused' });
    expect(parseLast4('12')).toEqual({ error: 'id_format' });
  });

  it('CSV records keep quoted commas and line breaks; headers by key, Thai, English or label (key)', async () => {
    expect(csvRecords('a,"b, c","d\n""e"""\r\nx,y,z', ',')).toEqual([
      ['a', 'b, c', 'd\n"e"'],
      ['x', 'y', 'z'],
    ]);
    const index = resolveHeader('register', [
      'เลขที่ห้อง / แปลง (unit_no) *',
      'Owner name',
      'phone',
      'ignored',
    ]);
    expect([...index.entries()]).toEqual([
      ['unit_no', 0],
      ['owner_name', 1],
      ['phone', 2],
    ]);
    expect(() => resolveHeader('register', ['unit_no'])).toThrow(/owner_name/);
    const t = await readTable(csv(['unit_no;owner_name', '#A-1;ตัวอย่าง', 'A-1;สมชาย', ';']), 'register');
    expect(t).toMatchObject({
      format: 'csv',
      header: ['unit_no', 'owner_name'],
      rows: [{ rowNo: 3, cells: ['A-1', 'สมชาย'] }],
    });
  });

  it('rows: a full ID number is refused and not kept; other bad cells keep their text for the bad-rows file', async () => {
    const { rows } = await parseSheet(
      csv(['unit_no,owner_name,id_last4,phone,area_sqm', 'A-1,สมชาย,1103700012345,08x,abc']),
      'register',
    );
    expect(rows[0]!.errors.map((e) => [e.column, e.code])).toEqual([
      ['area_sqm', 'area'],
      ['id_last4', 'id_full_refused'],
      ['phone', 'phone'],
    ]);
    expect(rows[0]!.data.id_last4).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain('1103700012345');
    expect(rows[0]!.raw).toEqual({ area_sqm: 'abc', phone: '08x' });
    const file = await badRowsFile('register', rows, 'csv', 'en');
    const text = file.body.toString('utf8');
    expect(text).toContain('abc');
    expect(text).not.toContain('1103700012345');
    expect(text).toContain('full ID numbers are refused (PDPA)');
  });

  it('templates of every sheet round-trip through the parser (XLSX and CSV, th and en)', async () => {
    for (const sheet of SHEET_KEYS)
      for (const format of ['xlsx', 'csv'] as const)
        for (const lang of ['th', 'en'] as const) {
          const t = await template(sheet, format, lang);
          // the examples are marked `#`: an untouched template has no data rows
          const parsed = await parseSheet(t.body, sheet);
          expect(parsed).toMatchObject({ format, rows: [] });
        }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await template('opening_balance', 'xlsx', 'en')).body as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['opening_balance', 'Instructions']);
    expect(SHEETS.register.columns.filter((c) => c.required).map((c) => c.key)).toEqual([
      'unit_no',
      'owner_name',
    ]);
    expect(issueMessage({ column: 'x', code: 'duplicate', params: { row: 4 } }, 'th')).toBe('ซ้ำกับแถว 4');
  });
});

describe('J3.1 import plan (D-332)', () => {
  const sheets = async (files: Record<string, string[]>) => {
    const out: Record<string, Awaited<ReturnType<typeof parseSheet>>['rows']> = {};
    for (const [k, lines] of Object.entries(files)) out[k] = (await parseSheet(csv(lines), k as never)).rows;
    return out;
  };

  it('opening balances post to accumulated surplus, never to revenue (D-332)', () => {
    expect(lineKindAccount('opening_balance')).toBe('accumulated_surplus');
    expect(isRevenueKind('opening_balance')).toBe(false);
  });

  it('shares: blanks share what is left; Σ exactly 100', () => {
    expect(fillShares([null, null, null]).shares).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(fillShares(['60', null]).shares).toEqual(['60.0000', '40.0000']);
    expect(fillShares(['70', '50']).sum.toFixed(2)).toBe('120.00');
  });

  it('register → units, floors / sois, parties (attached by name + phone), ownerships, bill-to; opening balances → invoices', async () => {
    const s = await sheets({
      register: [
        'floor,unit_no,area_sqm,owner_code,owner_name,phone,share_pct,bill_to_name,bill_to_kind',
        '12,A-1201,34.77,OW-1,สมชาย ใจดี,0812345678,60,,',
        '12,A-1201,34.77,OW-2,สมศรี ใจดี,0812345679,,บริษัท ตัวแทน,agency',
        'ซอย 3,H-3/1,,OW-3,บ้าน สาม,0812345670,,,',
        'ซอย 3,H-3/2,,OW-3,บ้าน สาม,0812345670,,,',
      ],
      opening_balance: [
        'unit_no,owner_code,charge,period,principal,surcharge',
        'A-1201,OW-2,common_fee,2026-09,625.86,25.00',
        'A-1201,OW-2,fund,2026-H1,600.00,',
        'H-3/1,,common_fee,2026-10,500.00,',
        'H-3/2,OW-9,common_fee,2026-10,500.00,',
        'A-1201,,common_fee,2026-10,1.00,',
      ],
      bank_balance: [
        'account_type,bank_account_last4,fund_name,balance',
        'operating,4321,,1000.00',
        'fund,,กองทุนสำรอง,50.00',
        'fund,,ไม่มี,1.00',
      ],
    });
    const existing: ExistingState = {
      ...EMPTY,
      floors: [{ id: 'fl12', level: 12, name: 'ชั้น 12' }],
      parties: [{ id: 'p-old', displayName: 'บ้าน สาม', phone: '+66812345670', email: null }],
    };
    const r = planImport({ asOf: '2026-10-31', sheets: s, existing });
    expect(r.plan.floors).toEqual([{ key: 'name:ซอย 3', level: 13, name: 'ซอย 3' }]);
    expect(r.plan.units.map((u) => [u.unitNo, u.floorId ?? u.floorKey, u.type])).toEqual([
      ['A-1201', 'fl12', 'condo_unit'],
      ['H-3/1', 'name:ซอย 3', 'condo_unit'],
      ['H-3/2', 'name:ซอย 3', 'condo_unit'],
    ]);
    expect(r.plan.parties.map((p) => [p.displayName, p.existingId])).toEqual([
      ['สมชาย ใจดี', null],
      ['สมศรี ใจดี', null],
      ['บริษัท ตัวแทน', null],
      ['บ้าน สาม', 'p-old'],
    ]);
    expect(r.plan.ownerships.map((o) => [o.unitNo, o.sharePct])).toEqual([
      ['A-1201', '60.0000'],
      ['A-1201', '40.0000'],
      ['H-3/1', '100.0000'],
      ['H-3/2', '100.0000'],
    ]);
    expect(r.plan.billTos).toHaveLength(1);
    // OW-2's balance is billed to the agency it named; the fund line stays a fund line
    const a = r.plan.invoices.find((i) => i.unitNo === 'A-1201')!;
    expect(a.billedKey).toMatch(/^billto:/);
    expect(a.lines.map((l) => [l.lineKind, l.sourceType, l.amount])).toEqual([
      ['opening_balance', 'fund', '600.00'],
      ['opening_balance', 'common_fee', '625.86'],
      ['late_fee', 'penalty', '25.00'],
    ]);
    expect(a.total).toBe('1250.86');
    // cross-file errors: unknown owner; several owners and none named
    const ob = r.rows.opening_balance!;
    expect(ob[3]!.errors).toEqual([
      expect.objectContaining({ column: 'owner_code', code: 'owner_not_in_register' }),
    ]);
    expect(ob[4]!.errors).toEqual([
      expect.objectContaining({ column: 'owner_code', code: 'owner_ambiguous' }),
    ]);
    // bank rows: account and fund matched; an unknown fund is an error
    expect(r.plan.bankRows.map((b) => [b.accountType, b.bankAccountId, b.fundId, b.balance])).toEqual([
      ['operating', 'ba1', null, '1000.00'],
      ['fund', null, 'f1', '50.00'],
    ]);
    expect(r.rows.bank_balance![2]!.errors[0]).toMatchObject({ code: 'fund_not_found' });
    expect(r.totals).toMatchObject({
      units: 3,
      floorsNew: 1,
      partiesNew: 3,
      partiesAttached: 1,
      openingInvoices: 2,
      unitsInArrears: 2,
      principal: '1725.86',
      surcharge: '25.00',
      receivables: '1750.86',
      bankOperating: '1000.00',
      bankFund: '50.00',
      errors: 3,
    });
    // the plan hash is stable
    expect(planImport({ asOf: '2026-10-31', sheets: s, existing }).hash).toBe(r.hash);
  });

  it('an existing unit with owners is an error; one without keeps its attributes (warning)', async () => {
    const s = await sheets({
      register: ['unit_no,owner_name,area_sqm', 'X-1,ก,40.00', 'X-2,ข,55.00'],
      opening_balance: ['unit_no,period,principal'],
    });
    const existing: ExistingState = {
      ...EMPTY,
      units: [
        {
          id: 'u1',
          unitNo: 'x-1',
          type: 'condo_unit',
          areaSqm: '40.00',
          landAreaSqwa: null,
          plotNo: null,
          ownershipRatio: null,
          floorId: null,
          currentOwners: 1,
        },
        {
          id: 'u2',
          unitNo: 'X-2',
          type: 'condo_unit',
          areaSqm: '50.00',
          landAreaSqwa: null,
          plotNo: null,
          ownershipRatio: null,
          floorId: null,
          currentOwners: 0,
        },
      ],
    };
    const r = planImport({ asOf: '2026-10-31', sheets: s, existing });
    expect(r.rows.register![0]!.errors).toEqual([expect.objectContaining({ code: 'unit_has_owners' })]);
    expect(r.rows.register![1]!.errors).toEqual([]);
    expect(r.rows.register![1]!.warnings).toEqual([
      expect.objectContaining({ code: 'unit_attribute_differs', params: { unit: 'X-2', current: '50.00' } }),
    ]);
    expect(r.plan.units.find((u) => u.unitNo === 'X-2')).toMatchObject({
      existingId: 'u2',
      areaSqm: '50.00',
    });
  });

  it('payment history: within 12 months of the as-of date, by an owner of the register', async () => {
    const s = await sheets({
      register: ['unit_no,owner_name', 'A-1,ก'],
      opening_balance: ['unit_no,period,principal'],
      payment_history: [
        'unit_no,paid_on,amount,method',
        'A-1,05/10/2569,100.00,โอน',
        'A-1,2025-10-01,100.00,cash',
        'A-1,2026-11-01,100.00,cash',
        'B-1,2026-10-01,100.00,cash',
      ],
    });
    const r = planImport({ asOf: '2026-10-31', sheets: s, existing: EMPTY });
    expect(r.plan.payments).toEqual([
      {
        unitNo: 'A-1',
        partyKey: expect.any(String),
        paidOn: '2026-10-05',
        amount: '100.00',
        method: 'transfer',
        reference: null,
      },
    ]);
    expect(r.rows.payment_history!.map((x) => x.errors.map((e) => e.code))).toEqual([
      [],
      ['paid_on_too_old'],
      ['after_as_of'],
      ['unit_not_in_register'],
    ]);
  });

  it('reconcile: receivables against the declared total, bank rows against the statement', () => {
    expect(
      reconcileItems({ receivables: '100.00' }, '100.00', [
        { rowNo: 2, label: 'operating ••4321', balance: '50.00', statementBalance: '50.00' },
      ]),
    ).toMatchObject({ explanationRequired: false });
    const r = reconcileItems({ receivables: '100.00' }, '90.00', [
      { rowNo: 2, label: 'fund', balance: '5.00', statementBalance: null },
    ]);
    expect(r.explanationRequired).toBe(true);
    expect(r.items.map((i) => [i.status, i.difference])).toEqual([
      ['mismatch', '10.00'],
      ['no_statement', null],
    ]);
  });

  it('parallel cycle differences per unit, both sides', () => {
    const computed = new Map([
      ['a-1', { unitId: 'u1', unitNo: 'A-1', amount: new Decimal('100.00') }],
      ['a-2', { unitId: 'u2', unitNo: 'A-2', amount: new Decimal('50.00') }],
    ]);
    expect(
      cycleDifferences(computed, [
        { unitNo: 'A-1', amount: '60.00' },
        { unitNo: 'a-1', amount: '40.00' },
        { unitNo: 'A-3', amount: '10.00' },
      ]),
    ).toEqual([
      { unitNo: 'A-1', unitId: 'u1', computed: '100.00', legacy: '100.00', difference: '0.00' },
      { unitNo: 'A-2', unitId: 'u2', computed: '50.00', legacy: '0.00', difference: '50.00' },
      { unitNo: 'A-3', unitId: null, computed: '0.00', legacy: '10.00', difference: '-10.00' },
    ]);
  });
});
