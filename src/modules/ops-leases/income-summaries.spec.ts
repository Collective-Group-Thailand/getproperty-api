import { splitReceipt } from './income-summaries.service';

const line = (lineKind: string, amount: string) => ({ lineKind, amount });

describe('rent and charges of a receipt (D-282)', () => {
  it('splits each invoice paid pro rata of its rent lines', () => {
    const r = splitReceipt('16200', [
      {
        amount: '16200',
        invoice: { lines: [line('rent', '15000'), line('electricity', '900'), line('water', '300')] },
      },
    ]);
    expect(r.rent.toFixed(2)).toBe('15000.00');
    expect(r.charges.toFixed(2)).toBe('1200.00');
  });

  it('counts furniture rent as rent and a partial payment pro rata', () => {
    const r = splitReceipt('8000', [
      {
        amount: '8000',
        invoice: { lines: [line('rent', '14000'), line('furniture', '1000'), line('internet', '1000')] },
      },
    ]);
    expect(r.rent.toFixed(2)).toBe('7500.00');
    expect(r.charges.toFixed(2)).toBe('500.00');
  });

  it('treats money not allocated to an invoice as advance rent', () => {
    const r = splitReceipt('15000', []);
    expect(r.rent.toFixed(2)).toBe('15000.00');
    expect(r.charges.toFixed(2)).toBe('0.00');
    const credit = splitReceipt('1000', [
      { amount: '600', invoice: { lines: [line('electricity', '600')] } },
    ]);
    expect(credit.rent.toFixed(2)).toBe('400.00');
    expect(credit.charges.toFixed(2)).toBe('600.00');
  });
});
