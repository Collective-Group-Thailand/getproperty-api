import { rentOverTerm, stampDutyFor } from './stamp-duty';

describe('stamp duty on leases (B7.5, O-019)', () => {
  it('sums the rent of every month of the term', () => {
    expect(rentOverTerm('15000', '2026-11-01', 12).toFixed(2)).toBe('180000.00');
  });

  it('applies an agreed increase from the month it takes effect', () => {
    const total = rentOverTerm('4500', '2026-11-01', 12, [{ effectiveFrom: '2027-05-01', rent: '4800' }]);
    expect(total.toFixed(2)).toBe(String(6 * 4500 + 6 * 4800) + '.00');
  });

  it('counts an increase effective mid-month from the next month', () => {
    const total = rentOverTerm('1000', '2026-01-15', 3, [{ effectiveFrom: '2026-02-20', rent: '2000' }]);
    // months start 2026-01-15, 2026-02-15, 2026-03-15 → 1000 + 1000 + 2000
    expect(total.toFixed(2)).toBe('4000.00');
  });

  it('charges one baht per 1,000 baht or fraction', () => {
    expect(stampDutyFor('180000', '1')).toBe('180.00');
    expect(stampDutyFor('180000.01', '1')).toBe('181.00');
    expect(stampDutyFor('54000', '1')).toBe('54.00');
    expect(stampDutyFor('999', '1')).toBe('1.00');
    expect(stampDutyFor('0', '1')).toBe('0.00');
  });
});
