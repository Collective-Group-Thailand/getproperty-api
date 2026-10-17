import { SETTINGS } from '@core/settings/catalogue';

import { publicPlans } from './plans';
import { PlanModuleKey, PricePlanStatus } from './public.dto';

describe('publicPlans (D-156 → GET /v1/public/plans)', () => {
  const setting = SETTINGS.find((s) => s.key === 'pricing.price_plans')!.value;
  const plans = publicPlans(setting);
  const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));

  it('publishes every labelled plan as proposed, THB, VAT excluded', () => {
    expect(plans.length).toBeGreaterThanOrEqual(6);
    expect(
      plans.every((p) => p.status === PricePlanStatus.Proposed && p.currency === 'THB' && !p.vatIncluded),
    ).toBe(true);
  });

  it('single prices, tier ranges, step ranges and add-ons', () => {
    expect(byKey.apartment_starter).toMatchObject({
      pricePerUnit: '25.00',
      priceUnit: 'unit_month',
      minimumUnits: 20,
    });
    expect(byKey.condo_juristic).toMatchObject({ pricePerUnit: null, priceFrom: '10.00', priceTo: '15.00' });
    expect(byKey.landlord).toMatchObject({
      pricePerUnit: null,
      priceFrom: '0.00',
      priceTo: '299.00',
      priceUnit: 'month',
    });
    expect(byKey.access_addon).toMatchObject({ kind: 'addon', tenantType: null, priceFrom: '3000.00' });
    expect(byKey.inspection_report).toMatchObject({
      priceUnit: 'report',
      priceFrom: '3000.00',
      priceTo: '5000.00',
    });
  });

  it('a confirmed setting publishes confirmed prices; unknown keys are not published', () => {
    const confirmed = publicPlans({
      status: 'confirmed',
      plans: { x_unknown: {}, apartment_starter: { pricePerUnit: '30.00' } },
    });
    expect(confirmed).toEqual([
      expect.objectContaining({ key: 'apartment_starter', status: 'confirmed', pricePerUnit: '30.00' }),
    ]);
    expect(publicPlans(null)).toEqual([]);
  });

  it('publishes every seeded module key as a PlanModuleKey (none silently dropped)', () => {
    const seeded = Object.values(
      (setting as { plans: Record<string, { modules?: string[] }> }).plans,
    ).flatMap((p) => p.modules ?? []);
    expect(seeded.length).toBeGreaterThan(0);
    for (const m of seeded) expect(Object.values(PlanModuleKey)).toContain(m);
    expect(byKey.apartment_smart!.features).toEqual(['A1', 'A2', 'A3', 'A4', 'C2']);
  });
});
