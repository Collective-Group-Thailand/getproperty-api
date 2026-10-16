/**
 * Shape of `platform.utility_tariff_version.structure` (schema-design v2 §4.2.1) — the published utility rate
 * table that is the สคบ. 2568 cap reference (D-021a, D-140). Amounts are decimal strings (D-046), excluding VAT.
 */
export type TariffKind = 'tiered' | 'flat' | 'tou';
export type TariffUnit = 'kwh' | 'm3';

export interface TariffTier {
  /** Cumulative block start (exclusive lower bound), e.g. "0", "150". */
  fromUnits: string;
  /** Block end (inclusive), null = no upper bound. */
  toUnits: string | null;
  pricePerUnit: string;
}

export interface TouRates {
  onPeak: { pricePerUnit: string; window?: string };
  offPeak: { pricePerUnit: string; window?: string };
}

export interface UtilityTariffStructure {
  kind: TariffKind;
  unit: TariffUnit;
  currency: 'THB';
  tiers?: TariffTier[] | null;
  flatPricePerUnit?: string | null;
  tou?: TouRates | null;
  /** Fuel adjustment (electricity), per unit, for the stated period. */
  ft?: { pricePerUnit: string; period: string; sourceUrl?: string } | null;
  /** Monthly service charge, folded into the effective average rate (D-140), never a separate invoice line. */
  serviceCharge?: { amount: string; basis: 'per_month' } | null;
  /** Utility's own minimum charge (water); caps a lease/rate-plan minimum (D-141). */
  minimumCharge?: { amount: string } | null;
  vat: { rate: string; included: boolean };
  /** Highest marginal rate + Ft excl. VAT — a UI hint only. */
  ceilingPerUnit: string;
  capBasis: 'effective_average_rate';
  /** JSON paths of values that still need confirmation against the source (seeded `needs_check`). */
  needsCheck?: string[];
  notes_th?: string;
  notes_en?: string;
}

/** Minimal structural validation (the admin service validates fully in B1.3). Returns problems. */
export function validateTariffStructure(s: unknown): string[] {
  const problems: string[] = [];
  const x = s as Partial<UtilityTariffStructure> | null;
  if (!x || typeof x !== 'object') return ['structure must be an object'];
  if (!['tiered', 'flat', 'tou'].includes(String(x.kind))) problems.push('kind must be tiered | flat | tou');
  if (!['kwh', 'm3'].includes(String(x.unit))) problems.push('unit must be kwh | m3');
  if (x.kind === 'tiered') {
    if (!Array.isArray(x.tiers) || x.tiers.length === 0) problems.push('tiered structure needs tiers');
    else {
      let expectedFrom = '0';
      x.tiers.forEach((t, i) => {
        if (t.fromUnits !== expectedFrom) problems.push(`tiers[${i}].fromUnits must be ${expectedFrom}`);
        if (t.toUnits === null && i !== x.tiers!.length - 1)
          problems.push(`tiers[${i}] is open-ended but not last`);
        if (t.toUnits !== null && Number(t.toUnits) <= Number(t.fromUnits))
          problems.push(`tiers[${i}] is empty`);
        expectedFrom = t.toUnits ?? expectedFrom;
      });
      if (x.tiers[x.tiers.length - 1]?.toUnits !== null)
        problems.push('the last tier must be open-ended (toUnits null)');
    }
  }
  if (x.kind === 'flat' && !x.flatPricePerUnit) problems.push('flat structure needs flatPricePerUnit');
  if (x.kind === 'tou' && !x.tou) problems.push('tou structure needs tou rates');
  if (!x.vat || typeof x.vat.rate !== 'string') problems.push('vat.rate is required');
  if (x.capBasis !== 'effective_average_rate')
    problems.push('capBasis must be effective_average_rate (D-140)');
  return problems;
}
