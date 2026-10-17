import { bookValue } from './haas.service';
import { computeCharges, planCharge, type PriceVersion, PricingError } from './pricing';

const base: Pick<
  PriceVersion,
  'annualDiscountPct' | 'vatRate' | 'includedAllowances' | 'tiers' | 'minUnits' | 'minMonthly'
> = {
  annualDiscountPct: '15',
  vatRate: '0.07',
  includedAllowances: {},
  tiers: [],
  minUnits: null,
  minMonthly: null,
};
const starter: PriceVersion = {
  ...base,
  planKey: 'apartment_starter',
  nameTh: 'Apartment Starter',
  kind: 'software',
  billingUnit: 'per_unit',
  unitPrice: '25',
  minUnits: 20,
  includedAllowances: { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50' },
};
const smart: PriceVersion = {
  ...base,
  planKey: 'apartment_smart',
  nameTh: 'Apartment Smart',
  kind: 'software',
  billingUnit: 'per_unit',
  unitPrice: '40',
};
const rental: PriceVersion = {
  ...base,
  planKey: 'meter_rental',
  nameTh: 'เช่ามิเตอร์',
  kind: 'hardware_rental',
  billingUnit: 'per_meter_point',
  unitPrice: '60',
};
const landlord: PriceVersion = {
  ...base,
  planKey: 'landlord',
  nameTh: 'Landlord',
  kind: 'software',
  billingUnit: 'per_tenant',
  unitPrice: null,
  tiers: [
    { upToUnits: 3, monthly: '0.00' },
    { upToUnits: 10, monthly: '99.00' },
    { upToUnits: 20, monthly: '299.00' },
  ],
};
const usage = (units: number, extra: Partial<{ meterPoints: number; ocrImages: number }> = {}) => ({
  units,
  meterPoints: 0,
  buildings: 1,
  ocrImages: 0,
  ...extra,
});

describe('platform pricing (D-156, D-161, D-083)', () => {
  it('Starter: THB 25 per unit with a 20-unit minimum, VAT 7 %', () => {
    expect(computeCharges({ plan: starter, addons: [], usage: usage(12) })).toMatchObject({
      subtotal: '500.00',
      discount: '0.00',
      vatAmount: '35.00',
      total: '535.00',
    });
    expect(computeCharges({ plan: starter, addons: [], usage: usage(60) }).total).toBe('1605.00');
  });

  it('Smart + meter rental per rented point; a zero-quantity add-on adds no line', () => {
    const c = computeCharges({ plan: smart, addons: [rental], usage: usage(60, { meterPoints: 120 }) });
    expect(c.lines.map((l) => [l.kind, l.quantity, l.amount])).toEqual([
      ['subscription', '60.000', '2400.00'],
      ['hardware_rental', '120.000', '7200.00'],
    ]);
    expect(c.total).toBe('10272.00');
    expect(computeCharges({ plan: smart, addons: [rental], usage: usage(60) }).lines).toHaveLength(1);
  });

  it('landlord steps: ≤ 3 units free, then 99 / 299; above the last step is not billable', () => {
    expect(computeCharges({ plan: landlord, addons: [], usage: usage(3) }).total).toBe('0.00');
    expect(computeCharges({ plan: landlord, addons: [], usage: usage(4) }).subtotal).toBe('99.00');
    expect(computeCharges({ plan: landlord, addons: [], usage: usage(20) }).subtotal).toBe('299.00');
    expect(() => planCharge(landlord, usage(21))).toThrow(PricingError);
  });

  it('pilot discount (D-083) is a negative line; VAT on the discounted subtotal; pro-rata by days', () => {
    const c = computeCharges({
      plan: starter,
      addons: [],
      usage: usage(12),
      discountPct: '30',
      discountReason: 'pilot',
      proRata: { days: 12, daysInMonth: 30 },
    });
    expect(c.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['subscription', '200.00'],
      ['discount', '-60.00'],
    ]);
    expect(c).toMatchObject({ subtotal: '200.00', discount: '60.00', vatAmount: '9.80', total: '149.80' });
  });

  it('annual billing: 12 months less the annual discount', () => {
    expect(
      computeCharges({ plan: starter, addons: [], usage: usage(20), billingPeriod: 'annual' }).subtotal,
    ).toBe('5100.00');
  });

  it('OCR overage beyond the allowance (D-161): THB 0.50 per extra photo', () => {
    const c = computeCharges({ plan: starter, addons: [], usage: usage(20, { ocrImages: 640 }) });
    expect(c.lines.find((l) => l.kind === 'ai_overage')).toMatchObject({
      quantity: '140.000',
      amount: '70.00',
    });
    expect(
      computeCharges({ plan: starter, addons: [], usage: usage(20, { ocrImages: 500 }) }).lines,
    ).toHaveLength(1);
  });

  it('volume tiers price every unit at the tier of the count; a quoted plan is not billable', () => {
    const condo: PriceVersion = {
      ...base,
      planKey: 'condo_juristic',
      nameTh: 'Condo',
      kind: 'software',
      billingUnit: 'per_unit',
      unitPrice: null,
      minUnits: 100,
      tiers: [
        { fromUnits: 0, toUnits: 199, pricePerUnit: '15' },
        { fromUnits: 200, toUnits: 499, pricePerUnit: '12' },
        { fromUnits: 500, toUnits: null, pricePerUnit: '10' },
      ],
    };
    expect(planCharge(condo, usage(50)).amount.toFixed(2)).toBe('1500.00');
    expect(planCharge(condo, usage(300)).amount.toFixed(2)).toBe('3600.00');
    const access: PriceVersion = {
      ...base,
      planKey: 'access_addon',
      nameTh: 'Access',
      kind: 'addon',
      billingUnit: 'per_building',
      unitPrice: null,
    };
    expect(() => planCharge(access, usage(10))).toThrow(PricingError);
  });
});

describe('HaaS book value (D-081, straight line)', () => {
  const asset = {
    acquisitionCost: { toString: () => '1800.00' },
    termMonths: 36,
    installedAt: new Date('2027-02-01T00:00:00Z'),
  };
  it('full cost before installation, then decreasing by whole months, never below 0', () => {
    expect(bookValue({ ...asset, installedAt: null } as never, '2027-01-01')).toBe('1800.00');
    expect(bookValue(asset as never, '2027-02-01')).toBe('1800.00');
    expect(bookValue(asset as never, '2027-03-01')).toBe('1750.00');
    expect(bookValue(asset as never, '2028-02-01')).toBe('1200.00');
    expect(bookValue(asset as never, '2031-01-01')).toBe('0.00');
  });
});
