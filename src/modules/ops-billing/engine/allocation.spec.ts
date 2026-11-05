import { planAllocation, splitInstalments } from './allocation';

const at = (d: string) => new Date(`${d}T00:00:00+07:00`);
// Jan common fee 3,000.00; Feb common fee 3,000.00 + the January late fee 150.00 (surcharge)
const JAN = { invoiceId: 'a-jan', issuedAt: at('2027-01-01'), balance: '3000.00', surchargeOpen: '0.00' };
const FEB = { invoiceId: 'b-feb', issuedAt: at('2027-02-01'), balance: '3150.00', surchargeOpen: '150.00' };

describe('planAllocation (D-308, D-325)', () => {
  it('oldest_first: invoice by invoice by issue date, each one’s surcharge first', () => {
    expect(planAllocation('3100.00', [FEB, JAN], 'oldest_first')).toEqual({
      slices: [
        { invoiceId: 'a-jan', amount: '3000.00', surcharge: '0.00' },
        { invoiceId: 'b-feb', amount: '100.00', surcharge: '100.00' },
      ],
      remainder: '0.00',
    });
  });

  it('surcharge_first: every open surcharge first, then the principal oldest first', () => {
    expect(planAllocation('3100.00', [JAN, FEB], 'surcharge_first')).toEqual({
      slices: [
        { invoiceId: 'a-jan', amount: '2950.00', surcharge: '0.00' },
        { invoiceId: 'b-feb', amount: '150.00', surcharge: '150.00' },
      ],
      remainder: '0.00',
    });
  });

  it('what exceeds the targets is the remainder (payer credit), satang exact', () => {
    const r = planAllocation('6150.01', [JAN, FEB], 'surcharge_first');
    expect(r.slices.map((s) => s.amount)).toEqual(['3000.00', '3150.00']);
    expect(r.remainder).toBe('0.01');
  });

  it('accepts a set of invoices of several units (statement payments, J1.2b) and ignores paid ones', () => {
    const r = planAllocation(
      '0.03',
      [
        { invoiceId: 'u1', issuedAt: at('2027-01-01'), balance: '0.01', surchargeOpen: '0.01' },
        { invoiceId: 'u2', issuedAt: at('2027-01-01'), balance: '0.00', surchargeOpen: '0.00' },
        { invoiceId: 'u3', issuedAt: at('2026-12-01'), balance: '0.01', surchargeOpen: '0.00' },
      ],
      'oldest_first',
    );
    expect(r).toEqual({
      slices: [
        { invoiceId: 'u3', amount: '0.01', surcharge: '0.00' },
        { invoiceId: 'u1', amount: '0.01', surcharge: '0.01' },
      ],
      remainder: '0.01',
    });
  });

  it('a surcharge above the balance is capped by the balance', () => {
    expect(
      planAllocation(
        '50.00',
        [{ invoiceId: 'x', issuedAt: at('2027-01-01'), balance: '40.00', surchargeOpen: '90.00' }],
        'surcharge_first',
      ),
    ).toEqual({ slices: [{ invoiceId: 'x', amount: '40.00', surcharge: '40.00' }], remainder: '10.00' });
  });
});

describe('splitInstalments (D-325)', () => {
  it('half-up per instalment, the remainder on the last: Σ = principal', () => {
    expect(splitInstalments('10000.00', 3)).toEqual(['3333.33', '3333.33', '3333.34']);
    expect(splitInstalments('100.00', 6)).toEqual(['16.67', '16.67', '16.67', '16.67', '16.67', '16.65']);
    const parts = splitInstalments('1234567.89', 12);
    expect(parts.reduce((s, p) => s + Math.round(Number(p) * 100), 0)).toBe(123456789);
  });
});
