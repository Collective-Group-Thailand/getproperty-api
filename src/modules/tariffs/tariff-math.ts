import Decimal from 'decimal.js';

import { type UtilityTariffStructure, validateTariffStructure } from './tariff-structure';

/**
 * Pure utility tariff arithmetic (D-140, D-021a). The cap compared with a tenant's rate is the utility's
 * EFFECTIVE AVERAGE RATE for the consumption of the period:
 *
 *     effective average = (Σ tier blocks(u) + Ft × u + monthly service charge) / u     — excl. VAT
 *
 * (a utility minimum charge, when larger, replaces the computed total). Money is decimal.js; nothing is rounded
 * before the end: the average is rounded half-up to 4 decimals (numeric(14,4) `cap_per_unit`), the total to
 * satang. No I/O: the caller supplies the structure of the tariff version in force on the period's date.
 */
export interface TariffChargeInput {
  /** Units consumed in the period (kWh or m³), decimal string or number ≥ 0. */
  units: Decimal.Value;
  /** Required for `tou` structures: how the units split between peak and off-peak. */
  touSplit?: { onPeakUnits: Decimal.Value; offPeakUnits: Decimal.Value };
}

export interface TariffChargeLine {
  label: string;
  units: string | null;
  pricePerUnit: string | null;
  amount: string;
}

export interface TariffCharge {
  units: string;
  energy: string;
  ft: string;
  serviceCharge: string;
  /** Before the minimum charge. */
  computedTotal: string;
  minimumApplied: boolean;
  /** Excluding VAT, rounded to satang. */
  totalExVat: string;
  /** Effective average rate per unit, 4 decimals half-up; null when no units were consumed. */
  effectiveAverageRate: string | null;
  lines: TariffChargeLine[];
  /** Values of the structure flagged as unverified (`needsCheck`). */
  needsCheck: string[];
}

export class TariffMathError extends Error {
  override name = 'TariffMathError';
}

const D = (v: Decimal.Value) => new Decimal(v);
const money = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const exact = (v: Decimal) => v.toFixed();

/** Energy charge of `units` over cumulative tier blocks. */
export function tieredEnergy(
  tiers: NonNullable<UtilityTariffStructure['tiers']>,
  units: Decimal,
): { amount: Decimal; lines: TariffChargeLine[] } {
  let amount = D(0);
  const lines: TariffChargeLine[] = [];
  for (const t of tiers) {
    const from = D(t.fromUnits);
    if (units.lte(from)) break;
    const to = t.toUnits === null ? units : Decimal.min(units, D(t.toUnits));
    const inBlock = to.minus(from);
    if (inBlock.lte(0)) continue;
    const blockAmount = inBlock.times(t.pricePerUnit);
    amount = amount.plus(blockAmount);
    lines.push({
      label: `${t.fromUnits}–${t.toUnits ?? '∞'}`,
      units: exact(inBlock),
      pricePerUnit: t.pricePerUnit,
      amount: exact(blockAmount),
    });
  }
  return { amount, lines };
}

export function utilityCharge(structure: UtilityTariffStructure, input: TariffChargeInput): TariffCharge {
  const problems = validateTariffStructure(structure);
  if (problems.length) throw new TariffMathError(`invalid tariff structure: ${problems.join('; ')}`);
  const units = D(input.units);
  if (!units.isFinite() || units.isNeg()) throw new TariffMathError('units must be a finite number ≥ 0');

  let energy = D(0);
  let lines: TariffChargeLine[] = [];
  switch (structure.kind) {
    case 'tiered': {
      const r = tieredEnergy(structure.tiers!, units);
      energy = r.amount;
      lines = r.lines;
      break;
    }
    case 'flat': {
      energy = units.times(structure.flatPricePerUnit!);
      lines = [
        {
          label: 'flat',
          units: exact(units),
          pricePerUnit: structure.flatPricePerUnit!,
          amount: exact(energy),
        },
      ];
      break;
    }
    case 'tou': {
      if (!input.touSplit)
        throw new TariffMathError('a TOU tariff needs the on-peak/off-peak split of the units');
      const on = D(input.touSplit.onPeakUnits);
      const off = D(input.touSplit.offPeakUnits);
      if (!on.plus(off).eq(units)) throw new TariffMathError('touSplit must add up to units');
      const tou = structure.tou!;
      const onAmount = on.times(tou.onPeak.pricePerUnit);
      const offAmount = off.times(tou.offPeak.pricePerUnit);
      energy = onAmount.plus(offAmount);
      lines = [
        {
          label: 'on_peak',
          units: exact(on),
          pricePerUnit: tou.onPeak.pricePerUnit,
          amount: exact(onAmount),
        },
        {
          label: 'off_peak',
          units: exact(off),
          pricePerUnit: tou.offPeak.pricePerUnit,
          amount: exact(offAmount),
        },
      ];
      break;
    }
  }

  const ft = structure.ft ? units.times(structure.ft.pricePerUnit) : D(0);
  if (structure.ft)
    lines.push({
      label: 'ft',
      units: exact(units),
      pricePerUnit: structure.ft.pricePerUnit,
      amount: exact(ft),
    });
  const service = structure.serviceCharge ? D(structure.serviceCharge.amount) : D(0);
  if (structure.serviceCharge)
    lines.push({ label: 'service_charge', units: null, pricePerUnit: null, amount: exact(service) });

  const computed = energy.plus(ft).plus(service);
  const minimum = structure.minimumCharge ? D(structure.minimumCharge.amount) : null;
  const minimumApplied = minimum !== null && computed.lt(minimum);
  const total = minimumApplied ? minimum : computed;

  return {
    units: exact(units),
    energy: exact(energy),
    ft: exact(ft),
    serviceCharge: exact(service),
    computedTotal: exact(computed),
    minimumApplied,
    totalExVat: money(total),
    effectiveAverageRate: units.isZero()
      ? null
      : total.dividedBy(units).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    lines,
    needsCheck: structure.needsCheck ?? [],
  };
}

/** The effective average rate (D-140) — the value compared with a tenant's price per unit. */
export function effectiveAverageRate(
  structure: UtilityTariffStructure,
  input: TariffChargeInput,
): string | null {
  return utilityCharge(structure, input).effectiveAverageRate;
}

/** True when a tenant rate is above the cap for that consumption (compliance.tariff_cap, D-021a). */
export function isAboveCap(
  tenantPricePerUnit: Decimal.Value,
  structure: UtilityTariffStructure,
  input: TariffChargeInput,
): boolean {
  const cap = effectiveAverageRate(structure, input);
  return cap !== null && D(tenantPricePerUnit).gt(cap);
}
