import { PRICE_PLAN_EFFECTIVE_FROM, PRICE_PLANS } from '../../../prisma/seed/data/price-plans';
import { type CataloguePlan, publicPlansFromCatalogue } from './plans';
import { PlanModuleKey, PricePlanStatus } from './public.dto';

/** The seeded catalogue (B6.1) as the rows `GET /v1/public/plans` reads. */
const catalogue: CataloguePlan[] = PRICE_PLANS.map((p) => ({
  key: p.key,
  tenantType: p.tenantType,
  nameTh: p.nameTh,
  nameEn: p.nameEn,
  isActive: p.isActive,
  versions: [
    {
      effectiveFrom: new Date(`${PRICE_PLAN_EFFECTIVE_FROM}T00:00:00Z`),
      effectiveTo: null,
      state: p.version.published ? 'published' : 'draft',
      billingUnit: p.version.billingUnit,
      unitPrice: p.version.unitPrice,
      priceRange: p.version.priceRange,
      tiers: p.version.tiers,
      minUnits: p.version.minUnits,
      minMonthly: p.version.minMonthly,
      currency: 'THB',
      terms: p.version.terms,
    },
  ],
}));

describe('publicPlansFromCatalogue (price-plan tables → GET /v1/public/plans, D-204, D-208)', () => {
  const plans = publicPlansFromCatalogue(catalogue, '2026-11-01');
  const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));

  it('publishes every plan of the catalogue as proposed, THB, VAT excluded', () => {
    expect(plans).toHaveLength(PRICE_PLANS.length);
    expect(
      plans.every((p) => p.status === PricePlanStatus.Proposed && p.currency === 'THB' && !p.vatIncluded),
    ).toBe(true);
  });

  it('sold = a published version in force on an active plan; drafts are proposals', () => {
    expect(byKey.apartment_starter).toMatchObject({ sold: true, effectiveFrom: '2026-01-01' });
    expect(byKey.condo_juristic).toMatchObject({ sold: false, effectiveFrom: null });
    // before the effective date nothing is in force: the published plan is not shown without a draft
    expect(publicPlansFromCatalogue(catalogue, '2025-12-31').find((p) => p.key === 'apartment_starter')).toBe(
      undefined,
    );
  });

  it('single prices, tier ranges, step ranges, minimum fees and add-ons', () => {
    expect(byKey.apartment_starter).toMatchObject({
      pricePerUnit: '25.00',
      priceUnit: 'unit_month',
      minimumUnits: 20,
    });
    expect(byKey.meter_rental).toMatchObject({
      kind: 'addon',
      pricePerUnit: '60.00',
      priceUnit: 'meter_point_month',
    });
    expect(byKey.condo_juristic).toMatchObject({ pricePerUnit: null, priceFrom: '10.00', priceTo: '15.00' });
    expect(byKey.landlord).toMatchObject({
      pricePerUnit: null,
      priceFrom: '0.00',
      priceTo: '299.00',
      priceUnit: 'month',
    });
    expect(byKey.pm_portfolio).toMatchObject({ priceFrom: '50000.00', priceUnit: 'month' });
    expect(byKey.access_addon).toMatchObject({ kind: 'addon', tenantType: null, priceFrom: '3000.00' });
    expect(byKey.inspection_report).toMatchObject({
      priceUnit: 'report',
      priceFrom: '3000.00',
      priceTo: '5000.00',
    });
  });

  it('a version with confirmed terms publishes confirmed prices', () => {
    const confirmed = publicPlansFromCatalogue(
      [
        {
          ...catalogue[0]!,
          versions: [{ ...catalogue[0]!.versions[0]!, terms: { status: 'confirmed' }, unitPrice: '30.0000' }],
        },
      ],
      '2026-11-01',
    );
    expect(confirmed).toEqual([
      expect.objectContaining({ key: 'apartment_starter', status: 'confirmed', pricePerUnit: '30.00' }),
    ]);
    expect(publicPlansFromCatalogue([], '2026-11-01')).toEqual([]);
  });

  it('publishes every seeded module key as a PlanModuleKey (none silently dropped)', () => {
    const seeded = PRICE_PLANS.flatMap((p) => (p.version.terms.modules as string[] | undefined) ?? []);
    expect(seeded.length).toBeGreaterThan(0);
    for (const m of seeded) expect(Object.values(PlanModuleKey)).toContain(m);
    expect(byKey.apartment_smart!.features).toEqual(['A1', 'A2', 'A3', 'A4', 'C2']);
  });
});
