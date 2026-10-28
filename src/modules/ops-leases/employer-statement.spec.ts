import Decimal from 'decimal.js';

import {
  bangkokMonthRange,
  csvCell,
  orderPeople,
  payrollCsv,
  splitInvoice,
  type StatementPerson,
} from './employer-statement';

const p = (name: string, id: string, no: string | null = null): StatementPerson => ({
  partyId: id,
  name,
  employeeNo: no,
});

describe('employer statement (G8, D-299)', () => {
  const lessee = p('หัวหน้าห้อง', 'l');

  it('splits an invoice equally per occupant; the satang left over go to the first people', () => {
    const shares = splitInvoice(
      new Decimal('1000.00'),
      'per_occupant',
      [p('A', 'a'), p('B', 'b'), p('C', 'c')],
      lessee,
      new Decimal(100),
    );
    expect(shares.map((s) => s.share.toFixed(2))).toEqual(['333.34', '333.33', '333.33']);
    expect(shares.reduce((n, s) => n.plus(s.share), new Decimal(0)).toFixed(2)).toBe('1000.00');
    expect(shares.every((s) => s.deduction.eq(s.share) && s.employerPays.isZero())).toBe(true);
  });

  it('per unit puts the whole invoice on the lessee; nobody staying also falls back to the lessee', () => {
    expect(
      splitInvoice(
        new Decimal('4500.50'),
        'per_unit',
        [p('A', 'a'), p('B', 'b')],
        lessee,
        new Decimal(50),
      ).map((s) => [s.partyId, s.share.toFixed(2), s.deduction.toFixed(2), s.employerPays.toFixed(2)]),
    ).toEqual([['l', '4500.50', '2250.25', '2250.25']]);
    expect(splitInvoice(new Decimal('10'), 'per_occupant', [], lessee, new Decimal(0))[0]).toMatchObject({
      partyId: 'l',
    });
  });

  it('rounds each deduction half-up to the satang; the employer carries the rest', () => {
    const [a, b] = splitInvoice(
      new Decimal('100.01'),
      'per_occupant',
      [p('A', 'a'), p('B', 'b')],
      lessee,
      new Decimal('33.33'),
    );
    expect([a!.share.toFixed(2), a!.deduction.toFixed(2), a!.employerPays.toFixed(2)]).toEqual([
      '50.01',
      '16.67',
      '33.34',
    ]);
    expect([b!.share.toFixed(2), b!.deduction.toFixed(2), b!.employerPays.toFixed(2)]).toEqual([
      '50.00',
      '16.67',
      '33.33',
    ]);
  });

  it('orders people by name then id (stable remainder)', () => {
    expect(orderPeople([p('ข', '2'), p('ก', '3'), p('ก', '1')]).map((x) => x.partyId)).toEqual([
      '1',
      '3',
      '2',
    ]);
  });

  it('writes the payroll CSV with a BOM, quoted cells and no spreadsheet formulas', () => {
    const csv = payrollCsv([
      {
        employeeNo: '=HYPERLINK("x")',
        name: 'Aung, Ko',
        unitNo: 'A-101',
        invoiceNumber: 'INV-1',
        share: new Decimal('333.34'),
        deduction: new Decimal('333.34'),
      },
    ]);
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.subarray(3).toString('utf8')).toBe(
      'employee_no,worker_name,unit_no,invoice_number,share_thb,deduction_thb\r\n' +
        `"'=HYPERLINK(""x"")","Aung, Ko",A-101,INV-1,333.34,333.34\r\n`,
    );
    expect(csvCell('-5', false)).toBe('-5');
    expect(csvCell('@sum')).toBe("'@sum");
  });

  it('maps a month to its Bangkok instants', () => {
    const { from, to } = bangkokMonthRange('2026-12');
    expect(from.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    expect(to.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });
});
