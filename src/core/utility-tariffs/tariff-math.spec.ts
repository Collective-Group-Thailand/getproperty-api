import { UTILITY_TARIFFS } from '../../../prisma/seed/data/utility-tariffs';
import { effectiveAverageRate, isAboveCap, TariffMathError, utilityCharge } from './tariff-math';
import { type UtilityTariffStructure, validateTariffStructure } from './tariff-structure';

function seeded(provider: string, code: string, effectiveFrom: string): UtilityTariffStructure {
  const v = UTILITY_TARIFFS.find((t) => t.provider === provider && t.tariffCode === code)?.versions.find(
    (x) => x.effectiveFrom === effectiveFrom,
  );
  if (!v) throw new Error(`no seeded version ${provider} ${code} ${effectiveFrom}`);
  return v.structure;
}

/**
 * Golden values (hand-computed from the published blocks, D-140): effective average = (Σ blocks + Ft × u +
 * service charge) / u, excl. VAT, 4 decimals half-up.
 */
describe('tariff math — effective average rate (D-140, D-021a)', () => {
  describe('PEA 1.1.1, May–Aug 2025 (Ft 0.1972, service 8.19)', () => {
    const s = seeded('pea', '1.1.1', '2025-05-01');
    it.each([
      // 50 kWh: 15×2.3488 + 10×2.9882 + 10×3.2405 + 15×3.6237 = 151.8745; + Ft 9.86 + 8.19
      ['50', '169.92', '3.3985'],
      // 150 kWh: … + 65×3.6237 + 50×3.7171 = 518.9145; + Ft 29.58 + 8.19
      ['150', '556.68', '3.7112'],
      // 400 kWh: 518.9145 + 250×4.2218 = 1574.3645; + Ft 78.88 + 8.19
      ['400', '1661.43', '4.1536'],
    ])('%s kWh → %s THB, %s THB/kWh', (units, total, avg) => {
      expect(utilityCharge(s, { units })).toMatchObject({ totalExVat: total, effectiveAverageRate: avg });
    });
  });

  describe('PEA 1.1.2, May–Aug 2025 (Ft 0.1972, service 24.62)', () => {
    const s = seeded('pea', '1.1.2', '2025-05-01');
    it.each([
      ['50', '196.90', '3.9380'], // 50×3.2484 + 9.86 + 24.62
      ['150', '541.46', '3.6097'], // 150×3.2484 + 29.58 + 24.62
      ['400', '1646.21', '4.1155'], // 487.26 + 250×4.2218 + 78.88 + 24.62 = 1646.21 → 4.115525
    ])('%s kWh → %s THB, %s THB/kWh', (units, total, avg) => {
      expect(utilityCharge(s, { units })).toMatchObject({ totalExVat: total, effectiveAverageRate: avg });
    });
  });

  describe('MEA 1.1.2 from September 2026 (new residential blocks, Ft 0.1623; flagged needs_check)', () => {
    const s = seeded('mea', '1.1.2', '2026-09-01');
    it.each([
      ['50', '182.74', '3.6547'], // 50×3.0000 + 8.115 + 24.62 = 182.735
      ['150', '498.97', '3.3264'], // 450 + 24.345 + 24.62 = 498.965
      ['400', '1521.22', '3.8031'], // 600 + 200×4.1584 + 64.92 + 24.62 = 1521.22 → 3.80305
    ])('%s kWh → %s THB, %s THB/kWh', (units, total, avg) => {
      const c = utilityCharge(s, { units });
      expect(c).toMatchObject({ totalExVat: total, effectiveAverageRate: avg });
      expect(c.needsCheck.length).toBeGreaterThan(0);
    });
  });

  it('a rate above the effective average is above the cap; the cap depends on consumption', () => {
    const s = seeded('pea', '1.1.2', '2025-05-01');
    expect(isAboveCap('7.00', s, { units: '150' })).toBe(true);
    expect(isAboveCap('3.6097', s, { units: '150' })).toBe(false);
    expect(isAboveCap('3.70', s, { units: '150' })).toBe(true);
    expect(isAboveCap('3.70', s, { units: '400' })).toBe(false);
  });

  it('TOU needs the on/off-peak split', () => {
    const s = seeded('pea', '1.2', '2025-05-01');
    expect(() => utilityCharge(s, { units: '100' })).toThrow(TariffMathError);
    // 60×5.7982 + 40×2.6369 + 100×0.1972 + 24.62 = 347.892 + 105.476 + 19.72 + 24.62 = 497.708
    expect(
      utilityCharge(s, { units: '100', touSplit: { onPeakUnits: '60', offPeakUnits: '40' } }),
    ).toMatchObject({
      totalExVat: '497.71',
      effectiveAverageRate: '4.9771',
    });
    expect(() =>
      utilityCharge(s, { units: '100', touSplit: { onPeakUnits: '60', offPeakUnits: '30' } }),
    ).toThrow(/add up/);
  });

  it('water: progressive blocks; a minimum charge replaces a smaller total', () => {
    const s = seeded('mwa', 'residential', '2025-01-01');
    expect(utilityCharge(s, { units: '35' })).toMatchObject({
      totalExVat: '305.15',
      effectiveAverageRate: '8.7186',
    });
    const withMinimum = { ...s, minimumCharge: { amount: '45.00' } };
    expect(utilityCharge(withMinimum, { units: '2' })).toMatchObject({
      minimumApplied: true,
      totalExVat: '45.00',
      effectiveAverageRate: '22.5000',
    });
  });

  it('zero consumption has no average; negative units are refused', () => {
    const s = seeded('pea', '1.1.2', '2025-05-01');
    expect(effectiveAverageRate(s, { units: '0' })).toBeNull();
    expect(() => utilityCharge(s, { units: '-1' })).toThrow(TariffMathError);
  });

  it('every seeded structure is valid and its ceiling is the highest rate + Ft', () => {
    for (const t of UTILITY_TARIFFS) {
      for (const v of t.versions) {
        expect(validateTariffStructure(v.structure)).toEqual([]);
        const top =
          v.structure.kind === 'tou'
            ? Number(v.structure.tou!.onPeak.pricePerUnit)
            : Math.max(...v.structure.tiers!.map((x) => Number(x.pricePerUnit)));
        expect(Number(v.structure.ceilingPerUnit)).toBeCloseTo(
          top + Number(v.structure.ft?.pricePerUnit ?? 0),
          4,
        );
        expect(v.sourceUrl).toMatch(/^https:\/\//);
      }
    }
  });
});
