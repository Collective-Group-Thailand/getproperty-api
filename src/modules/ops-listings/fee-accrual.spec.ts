import { coBrokeShare, feeFor, recordedCommission } from './fee-accrual';

describe('fee accruals (G2, D-287, D-293)', () => {
  const base = { commission: '15000.00', monthlyRent: '15000.00' };

  it('accrues nothing without a price (not on sale)', () => {
    expect(feeFor({ billingUnit: 'percent_of_amount', unitPrice: null, terms: {} }, base)).toBeNull();
    expect(feeFor({ billingUnit: 'per_unit', unitPrice: '10.0000', terms: {} }, base)).toBeNull();
  });

  it('percent of the recorded commission, of the rent, flat per deal, with a cap', () => {
    expect(feeFor({ billingUnit: 'percent_of_amount', unitPrice: '10.0000', terms: {} }, base)).toEqual({
      billingUnit: 'percent_of_amount',
      rate: '10.0000',
      baseAmount: '15000.00',
      amount: '1500.00',
      capped: false,
    });
    expect(
      feeFor(
        { billingUnit: 'percent_of_amount', unitPrice: '5', terms: { basis: 'monthly_rent' } },
        { commission: '30000.00', monthlyRent: '12345.67' },
      ),
    ).toMatchObject({ baseAmount: '12345.67', amount: '617.28' });
    // no recorded commission → one month's rent
    expect(
      feeFor(
        { billingUnit: 'percent_of_amount', unitPrice: '10', terms: {} },
        { commission: null, monthlyRent: '9000' },
      ),
    ).toMatchObject({ baseAmount: '9000.00', amount: '900.00' });
    expect(feeFor({ billingUnit: 'per_deal', unitPrice: '990.0000', terms: {} }, base)).toEqual({
      billingUnit: 'per_deal',
      rate: '990.0000',
      baseAmount: null,
      amount: '990.00',
      capped: false,
    });
    expect(
      feeFor({ billingUnit: 'percent_of_amount', unitPrice: '10', terms: { capAmount: '1000.00' } }, base),
    ).toMatchObject({ amount: '1000.00', capped: true });
  });

  it('records the commission from the mandate terms and the co-broke share', () => {
    expect(recordedCommission({ amount: '20000', percent: '50' }, '15000.00')).toBe('20000.00');
    expect(recordedCommission({ amount: null, percent: '100' }, '15000.00')).toBe('15000.00');
    expect(recordedCommission({ amount: null, percent: null }, '15000.00')).toBeNull();
    expect(coBrokeShare('15000.00', '40.0000')).toBe('6000.00');
    expect(coBrokeShare(null, '40')).toBeNull();
  });
});
