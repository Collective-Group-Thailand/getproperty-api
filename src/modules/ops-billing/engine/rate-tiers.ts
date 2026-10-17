import Decimal from 'decimal.js';

/**
 * `ops.rate_plan_version.tiers` (schema-design §4.2.2) and the one engine that interprets it for every tenant type
 * (blueprint rule 7, D-151): apartments bill meter units against flat or tiered prices, condos bill common fees per m²
 * or by ownership ratio of a budget, services and rent can be fixed amounts per unit type. Pure, decimal.js only:
 * block amounts are exact, the line amount is rounded half-up to satang once (D-046), the effective price per unit
 * to 4 decimals (numeric(14,4)).
 */
export type RatePlanKindName = 'power' | 'water' | 'common_fee' | 'fund' | 'rent' | 'service';
export type RateBasisName = 'per_unit' | 'per_sqm' | 'per_ownership_ratio' | 'fixed';

export interface RateTier {
  fromUnits: string;
  toUnits: string | null;
  pricePerUnit: string;
}

export type RateTiers =
  | { kind: 'flat'; unit?: string; pricePerUnit: string }
  | { kind: 'tiered'; unit?: string; tiers: RateTier[] }
  | { kind: 'fixed'; amount: string; byUnitType?: Record<string, string> }
  | { kind: 'budget'; amount: string; period?: 'month' };

export interface RateVersionLike {
  id: string;
  effectiveFrom: string;
  tiers: RateTiers;
  basis: RateBasisName;
  minimumCharge: string | null;
}

const DEC = /^\d{1,10}(\.\d{1,4})?$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const UNIT_TYPES = ['room', 'condo_unit', 'house', 'shop', 'parking'];

/** Which tier shapes and bases each plan kind accepts. */
export const ALLOWED: Record<RatePlanKindName, { basis: RateBasisName[]; kinds: RateTiers['kind'][] }> = {
  power: { basis: ['per_unit'], kinds: ['flat', 'tiered'] },
  water: { basis: ['per_unit'], kinds: ['flat', 'tiered'] },
  common_fee: { basis: ['per_sqm', 'per_ownership_ratio', 'fixed'], kinds: ['flat', 'budget', 'fixed'] },
  fund: { basis: ['per_sqm', 'per_ownership_ratio', 'fixed'], kinds: ['flat', 'budget', 'fixed'] },
  rent: { basis: ['fixed', 'per_sqm'], kinds: ['fixed', 'flat'] },
  service: { basis: ['fixed', 'per_sqm', 'per_unit'], kinds: ['fixed', 'flat', 'tiered'] },
};

/** Structural validation of a version for a plan kind; returns field errors (empty = valid). */
export function validateRateVersion(
  kind: RatePlanKindName,
  basis: RateBasisName,
  tiers: unknown,
  minimumCharge: string | null,
): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const allowed = ALLOWED[kind];
  if (!allowed.basis.includes(basis))
    problems.push({ path: 'basis', message: `${kind} plans bill ${allowed.basis.join(' | ')}` });
  const t = tiers as Partial<RateTiers> | null;
  if (!t || typeof t !== 'object' || !('kind' in t))
    return [...problems, { path: 'tiers', message: 'tiers.kind is required' }];
  if (!allowed.kinds.includes(t.kind as RateTiers['kind']))
    problems.push({ path: 'tiers.kind', message: `${kind} plans use ${allowed.kinds.join(' | ')}` });
  const pairs: Record<RateBasisName, RateTiers['kind'][]> = {
    per_unit: ['flat', 'tiered'],
    per_sqm: ['flat'],
    per_ownership_ratio: ['budget'],
    fixed: ['fixed'],
  };
  if (!pairs[basis].includes(t.kind as RateTiers['kind']))
    problems.push({ path: 'tiers.kind', message: `basis ${basis} needs ${pairs[basis].join(' | ')} tiers` });
  switch (t.kind) {
    case 'flat': {
      const f = t as { pricePerUnit?: unknown };
      if (typeof f.pricePerUnit !== 'string' || !DEC.test(f.pricePerUnit))
        problems.push({ path: 'tiers.pricePerUnit', message: 'a decimal string with up to 4 decimals' });
      break;
    }
    case 'tiered': {
      const tt = (t as { tiers?: unknown }).tiers;
      if (!Array.isArray(tt) || tt.length === 0) {
        problems.push({ path: 'tiers.tiers', message: 'at least one tier' });
        break;
      }
      let expected = '0';
      (tt as Partial<RateTier>[]).forEach((x, i) => {
        if (x.fromUnits !== expected)
          problems.push({ path: `tiers.tiers[${i}].fromUnits`, message: `must be ${expected}` });
        if (typeof x.pricePerUnit !== 'string' || !DEC.test(x.pricePerUnit))
          problems.push({
            path: `tiers.tiers[${i}].pricePerUnit`,
            message: 'a decimal string with up to 4 decimals',
          });
        if (x.toUnits !== null && (typeof x.toUnits !== 'string' || !DEC.test(x.toUnits)))
          problems.push({ path: `tiers.tiers[${i}].toUnits`, message: 'a decimal string or null' });
        else if (x.toUnits !== null && new Decimal(x.toUnits).lte(x.fromUnits ?? '0'))
          problems.push({ path: `tiers.tiers[${i}].toUnits`, message: 'must be above fromUnits' });
        if (x.toUnits === null && i !== tt.length - 1)
          problems.push({ path: `tiers.tiers[${i}].toUnits`, message: 'only the last tier is open-ended' });
        expected = x.toUnits ?? expected;
      });
      if ((tt as Partial<RateTier>[])[tt.length - 1]?.toUnits !== null)
        problems.push({
          path: `tiers.tiers[${tt.length - 1}].toUnits`,
          message: 'the last tier must be open-ended (null)',
        });
      break;
    }
    case 'fixed': {
      const f = t as { amount?: unknown; byUnitType?: unknown };
      if (typeof f.amount !== 'string' || !MONEY.test(f.amount))
        problems.push({ path: 'tiers.amount', message: 'a money string' });
      if (f.byUnitType !== undefined) {
        if (!f.byUnitType || typeof f.byUnitType !== 'object')
          problems.push({ path: 'tiers.byUnitType', message: 'an object of unit type → amount' });
        else
          for (const [k, v] of Object.entries(f.byUnitType as Record<string, unknown>)) {
            if (!UNIT_TYPES.includes(k))
              problems.push({ path: `tiers.byUnitType.${k}`, message: 'unknown unit type' });
            if (typeof v !== 'string' || !MONEY.test(v))
              problems.push({ path: `tiers.byUnitType.${k}`, message: 'a money string' });
          }
      }
      break;
    }
    case 'budget': {
      const f = t as { amount?: unknown };
      if (typeof f.amount !== 'string' || !MONEY.test(f.amount))
        problems.push({
          path: 'tiers.amount',
          message: 'a money string (the budget split by ownership ratio)',
        });
      break;
    }
    default:
      problems.push({ path: 'tiers.kind', message: 'flat | tiered | fixed | budget' });
  }
  if (minimumCharge !== null && !MONEY.test(minimumCharge))
    problems.push({ path: 'minimumCharge', message: 'a money string' });
  if (minimumCharge !== null && kind !== 'water' && kind !== 'power')
    problems.push({ path: 'minimumCharge', message: 'a minimum charge applies to metered plans only' });
  return problems;
}

export interface ChargeInput {
  /** Meter units (per_unit). */
  units?: Decimal.Value;
  areaSqm?: string | null;
  ownershipRatio?: string | null;
  unitType?: string;
}

export interface TierPart {
  label: string;
  units: string | null;
  pricePerUnit: string | null;
  amount: string;
}

export interface RateCharge {
  /** What the price is multiplied by (units, m², ratio, 1), 3 decimals. */
  quantity: string;
  unit: string;
  /** Effective price per quantity unit (the line's `unit_price`), 4 decimals. */
  unitPrice: string;
  /** Satang, half-up (D-046). */
  amount: string;
  /** Exact amount before rounding. */
  exact: string;
  tierBreakdown: TierPart[];
  /** Amount the version's minimum charge adds on top (a separate line, D-141). */
  minimumTopUp: string;
}

const D = (v: Decimal.Value) => new Decimal(v);
const q3 = (v: Decimal) => v.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
const p4 = (v: Decimal) => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
const m2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export class RateEngineError extends Error {
  override name = 'RateEngineError';
}

/** The charge of one rate plan version for one unit (meter units, area, ratio or a fixed amount). */
export function chargeFor(
  version: Pick<RateVersionLike, 'tiers' | 'basis' | 'minimumCharge'>,
  input: ChargeInput,
): RateCharge {
  const t = version.tiers;
  let quantity: Decimal;
  let unit: string;
  let exact = D(0);
  const parts: TierPart[] = [];
  switch (version.basis) {
    case 'per_unit': {
      quantity = D(input.units ?? 0);
      if (quantity.isNeg()) throw new RateEngineError('units must be ≥ 0');
      unit = (t as { unit?: string }).unit ?? 'unit';
      if (t.kind === 'flat') {
        exact = quantity.times(t.pricePerUnit);
        parts.push({
          label: 'flat',
          units: q3(quantity),
          pricePerUnit: t.pricePerUnit,
          amount: exact.toFixed(),
        });
      } else if (t.kind === 'tiered') {
        for (const tier of t.tiers) {
          const from = D(tier.fromUnits);
          if (quantity.lte(from)) break;
          const to = tier.toUnits === null ? quantity : Decimal.min(quantity, D(tier.toUnits));
          const inBlock = to.minus(from);
          if (inBlock.lte(0)) continue;
          const amount = inBlock.times(tier.pricePerUnit);
          exact = exact.plus(amount);
          parts.push({
            label: `${tier.fromUnits}–${tier.toUnits ?? '∞'}`,
            units: q3(inBlock),
            pricePerUnit: tier.pricePerUnit,
            amount: amount.toFixed(),
          });
        }
      } else throw new RateEngineError(`per_unit basis cannot use ${t.kind} tiers`);
      break;
    }
    case 'per_sqm': {
      if (t.kind !== 'flat') throw new RateEngineError('per_sqm basis needs flat tiers');
      if (!input.areaSqm) throw new RateEngineError('the unit has no area (m²)');
      quantity = D(input.areaSqm);
      unit = 'sqm';
      exact = quantity.times(t.pricePerUnit);
      parts.push({
        label: 'per_sqm',
        units: q3(quantity),
        pricePerUnit: t.pricePerUnit,
        amount: exact.toFixed(),
      });
      break;
    }
    case 'per_ownership_ratio': {
      if (t.kind !== 'budget') throw new RateEngineError('per_ownership_ratio basis needs budget tiers');
      if (!input.ownershipRatio) throw new RateEngineError('the unit has no ownership ratio');
      quantity = D(input.ownershipRatio);
      unit = 'ratio';
      exact = quantity.times(t.amount);
      parts.push({
        label: 'ownership_ratio',
        units: quantity.toFixed(6),
        pricePerUnit: t.amount,
        amount: exact.toFixed(),
      });
      break;
    }
    case 'fixed': {
      if (t.kind !== 'fixed') throw new RateEngineError('fixed basis needs fixed tiers');
      quantity = D(1);
      unit = 'month';
      exact = D((input.unitType && t.byUnitType?.[input.unitType]) ?? t.amount);
      parts.push({ label: 'fixed', units: '1.000', pricePerUnit: exact.toFixed(2), amount: exact.toFixed() });
      break;
    }
  }
  const amount = D(m2(exact));
  let unitPrice: Decimal;
  if (quantity.gt(0)) unitPrice = exact.div(quantity);
  else if (t.kind === 'flat') unitPrice = D(t.pricePerUnit);
  else if (t.kind === 'tiered') unitPrice = D(t.tiers[0]!.pricePerUnit);
  else unitPrice = D(0);
  const minimum = version.minimumCharge ? D(version.minimumCharge) : null;
  const topUp = minimum && amount.lt(minimum) ? minimum.minus(amount) : D(0);
  return {
    quantity: version.basis === 'per_ownership_ratio' ? quantity.toFixed(3) : q3(quantity),
    unit,
    unitPrice: p4(unitPrice),
    amount: amount.toFixed(2),
    exact: exact.toFixed(),
    tierBreakdown: parts,
    minimumTopUp: m2(topUp),
  };
}

/** True when `candidate` charges more than `agreed` for the same consumption (compliance.no_midterm_increase). */
export function chargesMore(
  candidate: Pick<RateVersionLike, 'tiers' | 'basis' | 'minimumCharge'>,
  agreed: Pick<RateVersionLike, 'tiers' | 'basis' | 'minimumCharge'>,
  input: ChargeInput,
): boolean {
  const a = chargeFor(candidate, input);
  const b = chargeFor(agreed, input);
  return D(a.exact).plus(a.minimumTopUp).gt(D(b.exact).plus(b.minimumTopUp));
}
