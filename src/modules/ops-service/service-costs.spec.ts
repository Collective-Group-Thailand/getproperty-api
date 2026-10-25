import { settlementOf, tenantFraction } from './service-costs.service';

describe('landlord repair settlement (D-263)', () => {
  const r = (amount: string, paidBy: 'owner' | 'tenant') => ({ amount, paidBy });

  it('splits by the cost bearer', () => {
    expect(tenantFraction('owner', null).toString()).toBe('0');
    expect(tenantFraction('tenant', null).toString()).toBe('1');
    expect(tenantFraction('shared', '33.33').toString()).toBe('0.3333');
    expect(tenantFraction(null, null).toString()).toBe('0');
  });

  it('bills the tenant their share of what the owner paid', () => {
    expect(settlementOf([r('1800.00', 'owner')], 'shared', '50.00', [])).toEqual({
      receiptsTotal: '1800.00',
      ownerShare: '900.00',
      tenantShare: '900.00',
      paidByOwner: '1800.00',
      paidByTenant: '0.00',
      tenantOwes: '900.00',
      settled: '0.00',
      due: '900.00',
    });
  });

  it('credits the tenant the owner’s share of what they paid, net of earlier settlements', () => {
    const view = settlementOf([r('1800.00', 'owner'), r('600.00', 'tenant')], 'shared', '50.00', ['900.00']);
    expect(view).toMatchObject({
      tenantShare: '1200.00',
      tenantOwes: '600.00',
      settled: '900.00',
      due: '-300.00',
    });
    expect(settlementOf([r('500.00', 'tenant')], 'owner', null, []).due).toBe('-500.00');
    expect(settlementOf([r('500.00', 'tenant')], 'tenant', null, []).due).toBe('0.00');
  });

  it('rounds a share to satang once, on the total', () => {
    expect(settlementOf([r('100.00', 'owner'), r('0.01', 'owner')], 'shared', '33.33', [])).toMatchObject({
      tenantShare: '33.33',
      ownerShare: '66.68',
    });
  });
});
