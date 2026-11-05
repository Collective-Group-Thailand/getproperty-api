import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Decimal from 'decimal.js';

import {
  BANK_FORMATS,
  lineKeys,
  parseStatement,
  parseStatementDate,
  rankCandidates,
  StatementParseError,
} from './bank-formats';
import { ACCOUNT_ROLES, CHART_TEMPLATES, chartTemplate } from './chart-templates';
import {
  approvalBandsProblems,
  bandFor,
  DEFAULT_APPROVAL_BANDS,
  DEFAULT_WHT_RATES,
  whtFormOf,
  whtOf,
  whtRatesProblems,
} from './expense-rules';
import { renderJournalExport } from './export-formats';
import {
  allocateCredit,
  countDifferenceLegs,
  creditNoteLegs,
  expenseLegs,
  fundTransferLegs,
  invoiceLegs,
  paymentLegs,
  recognitionLegs,
  reversalLegs,
  toLines,
} from './posting';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'bank-statements');
const sum = (lines: { debit: string; credit: string }[], side: 'debit' | 'credit') =>
  lines.reduce((s, l) => s.plus(l[side]), new Decimal(0)).toFixed(2);
const byAccount = (lines: { account: string; debit: string; credit: string }[]) =>
  Object.fromEntries(lines.map((l) => [l.account, new Decimal(l.debit).minus(l.credit).toFixed(2)]));

describe('J2.1 chart of accounts templates (D-312, D-329)', () => {
  it('every template carries every posting role once, with unique codes', () => {
    for (const [form, accounts] of Object.entries(CHART_TEMPLATES)) {
      expect(new Set(accounts.map((a) => a.role))).toEqual(new Set(ACCOUNT_ROLES));
      expect(new Set(accounts.map((a) => a.code)).size).toBe(accounts.length);
      expect(accounts.every((a) => a.nameTh && a.nameEn)).toBe(true);
      expect(form).toMatch(/^(condo_act|land_allocation_act|voluntary|lease_contract)$/);
    }
  });

  it('housing estates use land-allocation wording; unknown forms fall back to condo_act', () => {
    const village = chartTemplate('land_allocation_act');
    expect(village.accounts.find((a) => a.role === 'income_common_fee')!.nameTh).toContain('สาธารณูปโภค');
    expect(chartTemplate(null).key).toBe('juristic_chart.condo_act.v1');
  });
});

describe('J2.1 posting rules (D-329)', () => {
  it('an invoice: receivable / common fee, fund equity, surcharge, unearned for advance lines — balanced', () => {
    const lines = toLines(
      invoiceLegs({
        total: '4130.00',
        vatAmount: '0.00',
        unitId: 'u',
        partyId: 'p',
        lines: [
          { kind: 'common_fee', amount: '3000.00', scheduled: true },
          { kind: 'fund', amount: '600.00', scheduled: true },
          { kind: 'late_fee', amount: '30.00' },
          { kind: 'plan_instalment', amount: '500.00' },
        ],
      }),
    );
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    // plan instalment: receivable both sides → net 3630 on the receivable
    expect(byAccount(lines.filter((l) => l.account !== 'receivable'))).toEqual({
      unearned: '-3000.00',
      fund_equity: '-600.00',
      income_surcharge: '-30.00',
    });
    const receivable = lines.filter((l) => l.account === 'receivable');
    expect(receivable.reduce((s, l) => s.plus(l.debit).minus(l.credit), new Decimal(0)).toFixed(2)).toBe(
      '3630.00',
    );
  });

  it('negative lines (discount) flip side; zero legs disappear', () => {
    const lines = toLines(
      invoiceLegs({
        total: '900.00',
        vatAmount: '0.00',
        unitId: null,
        partyId: null,
        lines: [
          { kind: 'common_fee', amount: '1000.00' },
          { kind: 'discount', amount: '-100.00' },
        ],
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.account === 'income_other')).toMatchObject({
      debit: '100.00',
      credit: '0.00',
    });
  });

  it('credit notes take unearned first; a payment-plan note moves the debt only', () => {
    const cn = toLines(
      creditNoteLegs({
        reason: 'ownership_transfer',
        total: '1000.00',
        vatAmount: '0.00',
        unitId: 'u',
        partyId: 'p',
        lines: [{ kind: 'common_fee', amount: '1000.00', fromUnearned: '800.00' }],
      }),
    );
    expect(byAccount(cn)).toEqual({
      unearned: '800.00',
      income_common_fee: '200.00',
      receivable: '-1000.00',
    });
    const plan = toLines(
      creditNoteLegs({
        reason: 'payment_plan',
        total: '500.00',
        vatAmount: '0.00',
        unitId: 'u',
        partyId: 'p',
        lines: [],
      }),
    );
    expect(plan.every((l) => l.account === 'receivable')).toBe(true);
    expect(sum(plan, 'debit')).toBe('500.00');
  });

  it('payment with WHT withheld by the payer, recognition, reversal, refund', () => {
    expect(
      byAccount(
        toLines(paymentLegs({ amount: '970.00', wht: '30.00', into: 'bank', unitId: null, partyId: null })),
      ),
    ).toEqual({
      bank: '970.00',
      wht_prepaid: '30.00',
      receivable: '-1000.00',
    });
    expect(
      byAccount(
        toLines(recognitionLegs({ kind: 'common_fee', amount: '254.79', unitId: null, partyId: null })),
      ),
    ).toEqual({
      unearned: '254.79',
      income_common_fee: '-254.79',
    });
    const rev = toLines(
      reversalLegs([
        { accountId: 'a', debit: '10.00', credit: '0.00', unitId: null, partyId: null },
        { accountId: 'b', debit: '0.00', credit: '10.00', unitId: null, partyId: null },
      ]),
    );
    expect(rev).toEqual([
      expect.objectContaining({ account: 'id:a', debit: '0.00', credit: '10.00' }),
      expect.objectContaining({ account: 'id:b', debit: '10.00', credit: '0.00' }),
    ]);
  });

  it('expenses: WHT payable and net paid; a fund payment also uses the fund equity', () => {
    const lines = toLines(
      expenseLegs({
        lines: [{ accountId: 'e', amount: '42800.00' }],
        wht: '1200.00',
        net: '41600.00',
        paidFrom: 'fund_bank',
        fromFund: true,
      }),
    );
    expect(byAccount(lines)).toEqual({
      'id:e': '42800.00',
      wht_payable: '-1200.00',
      fund_bank: '-41600.00',
      fund_equity: '42800.00',
      accumulated_surplus: '-42800.00',
    });
  });

  it('fund transfers and petty cash count differences', () => {
    expect(
      byAccount(toLines(fundTransferLegs({ direction: 'in', amount: '500.00', counter: 'bank' }))),
    ).toEqual({
      fund_bank: '500.00',
      bank: '-500.00',
    });
    expect(
      byAccount(toLines(fundTransferLegs({ direction: 'out', amount: '500.00', counter: 'bank' }))),
    ).toEqual({
      bank: '500.00',
      fund_bank: '-500.00',
      fund_equity: '500.00',
      accumulated_surplus: '-500.00',
    });
    expect(byAccount(toLines(countDifferenceLegs('pc', '-40.00')))).toEqual({
      exp_other: '40.00',
      'id:pc': '-40.00',
    });
    expect(byAccount(toLines(countDifferenceLegs('pc', '15.00')))).toEqual({
      'id:pc': '15.00',
      income_other: '-15.00',
    });
  });

  it('an unbalanced posting is refused before the database sees it', () => {
    expect(() => toLines([{ account: 'bank', amount: new Decimal('1.00') }])).toThrow(/unbalanced/);
  });

  it('a credit on an advance line takes the last unrecognised months first; the rest comes from income', () => {
    const rows = [
      { id: 'jan', month: '2027-01-01', amount: '1000.00', credited: '0.00', recognised: true },
      { id: 'feb', month: '2027-02-01', amount: '1000.00', credited: '0.00', recognised: false },
      { id: 'mar', month: '2027-03-01', amount: '1000.00', credited: '0.00', recognised: false },
    ];
    expect(allocateCredit(rows, '1500.00')).toEqual({
      updates: [
        { id: 'mar', credited: '1000.00' },
        { id: 'feb', credited: '500.00' },
      ],
      fromUnearned: '1500.00',
      rest: '0.00',
    });
    expect(allocateCredit(rows, '2500.00')).toMatchObject({ fromUnearned: '2000.00', rest: '500.00' });
  });
});

describe('J2.1 expense rules (D-091, D-311, O-041)', () => {
  it('bands: inclusive upper bounds, the last band open', () => {
    expect(approvalBandsProblems(DEFAULT_APPROVAL_BANDS)).toEqual([]);
    expect(bandFor(DEFAULT_APPROVAL_BANDS, '10000.00')).toMatchObject({ key: 'le:10000.00', approvals: 1 });
    expect(bandFor(DEFAULT_APPROVAL_BANDS, '10000.01')).toMatchObject({ key: 'le:100000.00', approvals: 2 });
    expect(bandFor(DEFAULT_APPROVAL_BANDS, '250000.00')).toMatchObject({
      key: 'gt:100000.00',
      approvals: 3,
      roles: ['owner', 'committee'],
    });
    expect(approvalBandsProblems([{ upTo: '10.00', roles: ['guard'], approvals: 9 }])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('last band'),
        expect.stringContaining('roles'),
        expect.stringContaining('approvals'),
      ]),
    );
    expect(
      approvalBandsProblems([
        { upTo: '50.00', roles: ['owner'], approvals: 1 },
        { upTo: '10.00', roles: ['owner'], approvals: 1 },
        { upTo: null, roles: ['owner'], approvals: 1 },
      ]),
    ).toEqual(['band 1: upTo ascending']);
  });

  it('WHT: (amount − VAT) × rate half-up; the seeded rates are data pending verification', () => {
    expect(whtOf('42800.00', '2800.00', '3.00')).toBe('1200.00');
    expect(whtOf('1070.00', '70.00', '1.00')).toBe('10.00');
    expect(whtOf('333.33', '0', '3.00')).toBe('10.00');
    expect(whtRatesProblems(DEFAULT_WHT_RATES)).toEqual([]);
    expect(DEFAULT_WHT_RATES.every((r) => r.verified === false)).toBe(true);
    expect(DEFAULT_WHT_RATES.map((r) => r.ratePct).sort()).toEqual(['1.00', '2.00', '3.00', '3.00', '5.00']);
    expect(
      whtRatesProblems([
        { key: 'x', labelTh: '', labelEn: 'a', incomeType: 'b', ratePct: '0', verified: 'no' },
      ]),
    ).not.toEqual([]);
    expect(whtFormOf('company')).toBe('pnd53');
    expect(whtFormOf('person')).toBe('pnd3');
  });
});

describe('J2.1 bank statement formats (data) and matching (D-329)', () => {
  const file = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

  it('reads the four sample files with their column maps', () => {
    const kbank = parseStatement(file('kbank.csv'), BANK_FORMATS.kbank);
    expect(kbank.map((l) => [l.bookedOn, l.amount, l.reference])).toEqual([
      ['2027-01-05', '3600.00', 'REF KB0501A001'],
      ['2027-01-05', '-41600.00', 'EXP-2027-00001'],
      ['2027-01-06', '3600.00', 'SLIP-UNKNOWN-99'],
      ['2027-01-07', '-15.00', 'ค่าธรรมเนียมรายเดือน'],
    ]);
    expect(parseStatement(file('scb.csv'), BANK_FORMATS.scb).map((l) => l.amount)).toEqual([
      '3600.00',
      '-15.00',
    ]);
    expect(parseStatement(file('bbl.csv'), BANK_FORMATS.bbl).map((l) => [l.bookedOn, l.amount])).toEqual([
      ['2027-01-05', '3600.00'],
      ['2027-01-10', '-20000.00'],
    ]);
    expect(parseStatement(file('ktb.csv'), BANK_FORMATS.ktb).map((l) => [l.bookedOn, l.amount])).toEqual([
      ['2027-01-05', '3600.00'],
      ['2027-01-10', '-20000.00'],
    ]);
  });

  it('dates: Buddhist era, two-digit years, impossible dates refused', () => {
    expect(parseStatementDate('31/12/2569', 'dmy')).toBe('2026-12-31');
    expect(parseStatementDate('01/02/69', 'dmy')).toBe('2026-02-01');
    expect(parseStatementDate('01/02/27', 'dmy')).toBe('2027-02-01');
    expect(() => parseStatementDate('31/02/2027', 'dmy')).toThrow(StatementParseError);
    expect(() => parseStatement('a,b\n1,2', BANK_FORMATS.scb)).toThrow(/no header row/);
  });

  it('line keys repeat for overlapping files and differ for identical lines inside one file', () => {
    const lines = parseStatement(file('kbank.csv'), BANK_FORMATS.kbank);
    const a = lineKeys('acc', lines);
    const b = lineKeys('acc', lines.slice(0, 2));
    expect(b.map((k) => k.toString('hex'))).toEqual(a.slice(0, 2).map((k) => k.toString('hex')));
    const twins = lineKeys('acc', [lines[0]!, { ...lines[0]!, lineNo: 2 }]);
    expect(twins[0]!.equals(twins[1]!)).toBe(false);
  });

  it('auto-match only when unambiguous: a reference hit, or a single candidate', () => {
    const line = {
      bookedOn: '2027-01-05',
      amount: '3600.00',
      reference: 'REF KB0501A001',
      description: 'รับโอนเงิน',
    };
    const pay = (id: string, refs: string[], on = '2027-01-05') => ({
      kind: 'payment' as const,
      id,
      amount: '3600.00',
      on,
      refs,
      label: id,
    });
    expect(rankCandidates(line, [pay('a', ['KB0501A001']), pay('b', [])], 3).auto?.id).toBe('a');
    expect(rankCandidates(line, [pay('a', []), pay('b', [])], 3).auto).toBeNull();
    expect(rankCandidates(line, [pay('a', [], '2027-01-04')], 3).auto?.id).toBe('a');
    expect(rankCandidates(line, [pay('a', [], '2027-01-15')], 3).suggestions).toHaveLength(0);
    expect(rankCandidates({ ...line, amount: '-3600.00' }, [pay('a', ['KB0501A001'])], 3).auto).toBeNull();
  });
});

describe('J2.1 journal export column maps (data)', () => {
  const rows = [
    {
      postedOn: '2027-01-05',
      journalNo: 'JV-1',
      source: 'invoice',
      memo: 'ใบแจ้งหนี้ INV-2027-00001, "A"',
      building: 'อาคาร A',
      accountCode: '1140',
      accountName: 'ลูกหนี้',
      debit: '3600.00',
      credit: '0.00',
      unitNo: 'A-201',
      party: '=HYPERLINK("x")',
    },
  ];
  it('csv: BOM, quoting, formula guard', () => {
    const out = renderJournalExport('csv', rows);
    expect(out.startsWith('﻿posted_on,journal_no,')).toBe(true);
    expect(out).toContain('"ใบแจ้งหนี้ INV-2027-00001, ""A"""');
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('express: tab separated, Buddhist-era dates, blank zero side; flowaccount: Thai headers, CE dates', () => {
    const express = renderJournalExport('express', rows).split('\r\n');
    expect(express[0]).toBe('DOCDAT\tDOCNUM\tACCNUM\tACCNAM\tDEBIT\tCREDIT\tDESCRP\tDEPCOD');
    expect(express[1]!.split('\t').slice(0, 6)).toEqual([
      '05/01/2570',
      'JV-1',
      '1140',
      'ลูกหนี้',
      '3600.00',
      '',
    ]);
    const flow = renderJournalExport('flowaccount', rows).replace('﻿', '').split('\r\n');
    expect(flow[0]).toBe('วันที่,เลขที่เอกสาร,รหัสบัญชี,ชื่อบัญชี,เดบิต,เครดิต,คำอธิบาย');
    expect(flow[1]!.startsWith('05/01/2027,JV-1,1140,')).toBe(true);
  });
});
