import Decimal from 'decimal.js';

/** A price plan version as the pricing engine needs it (D-156; values from `platform.price_plan_version`). */
export interface PriceVersion {
  planKey: string;
  nameTh: string;
  kind: 'software' | 'addon' | 'hardware_rental' | 'hardware_sale' | 'service';
  billingUnit:
    | 'per_unit'
    | 'per_meter_point'
    | 'per_building'
    | 'per_tenant'
    | 'per_report'
    // pack G add-ons: purchased one by one (G1 storage packages; G5 boosts / fees) — never a subscription line
    | 'per_package'
    | 'per_listing'
    | 'per_recipient'
    | 'per_deal'
    | 'percent_of_amount';
  unitPrice: string | null;
  /** Volume tiers (`fromUnits`/`toUnits` inclusive, `pricePerUnit`) or flat steps (`upToUnits`, `monthly`). */
  tiers: PriceTier[];
  minUnits: number | null;
  minMonthly: string | null;
  annualDiscountPct: string;
  vatRate: string;
  includedAllowances: { ocrPhotosPerMonth?: number; ocrOveragePerPhoto?: string };
}

export type PriceTier =
  | { fromUnits: number | null; toUnits: number | null; pricePerUnit: string }
  | { upToUnits: number; monthly: string };

export interface UsageCounts {
  /** Units whose status is not `inactive` on the counting day (D-082, D-156). */
  units: number;
  /** Rented meter points in service (HaaS meters, D-081). */
  meterPoints: number;
  buildings: number;
  /** Meter photos read by OCR in the previous month (D-161). */
  ocrImages: number;
}

export interface ChargeLine {
  kind:
    | 'subscription'
    | 'addon'
    | 'hardware_rental'
    | 'ai_overage'
    | 'discount'
    | 'adjustment'
    | 'storage'
    | 'setup'
    | 'messaging_addon';
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface Charges {
  lines: ChargeLine[];
  subtotal: string;
  discount: string;
  vatAmount: string;
  total: string;
}

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const qty = (n: Decimal | number) => new Decimal(n).toFixed(3);
const price = (d: Decimal) => d.toFixed(4);

export class PricingError extends Error {
  constructor(
    readonly code: 'price_plan.not_billable' | 'price_plan.tier_missing',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The monthly price of one plan for the counted usage, before discounts and VAT:
 * - `per_unit`: unit price × max(units, min units); with volume tiers, the tier containing the unit count prices
 *   every unit (condo 15 / 12 / 10, breakpoints from the version);
 * - `per_meter_point`: unit price × rented meter points;
 * - `per_building`: unit price × buildings;
 * - `per_tenant`: the first flat step whose `upToUnits` covers the units (landlord 0 / 99 / 299), else `min_monthly`;
 * - a plan quoted as a range (no unit price, no tiers, no minimum) cannot be billed automatically.
 */
export function planCharge(
  v: PriceVersion,
  usage: UsageCounts,
): { quantity: Decimal; unitPrice: Decimal; amount: Decimal } {
  const unitPrice = v.unitPrice === null ? null : new Decimal(v.unitPrice);
  switch (v.billingUnit) {
    case 'per_unit': {
      const counted = Math.max(usage.units, v.minUnits ?? 0);
      const volume = v.tiers.filter(
        (t): t is Extract<PriceTier, { pricePerUnit: string }> => 'pricePerUnit' in t,
      );
      if (volume.length) {
        const tier = volume.find(
          (t) => (t.fromUnits ?? 0) <= counted && (t.toUnits === null || counted <= t.toUnits),
        );
        if (!tier) throw new PricingError('price_plan.tier_missing', `no tier for ${counted} units`);
        const p = new Decimal(tier.pricePerUnit);
        return { quantity: new Decimal(counted), unitPrice: p, amount: money(p.times(counted)) };
      }
      if (!unitPrice) throw new PricingError('price_plan.not_billable', `${v.planKey} has no unit price`);
      return { quantity: new Decimal(counted), unitPrice, amount: money(unitPrice.times(counted)) };
    }
    case 'per_meter_point':
      if (!unitPrice) throw new PricingError('price_plan.not_billable', `${v.planKey} has no unit price`);
      return {
        quantity: new Decimal(usage.meterPoints),
        unitPrice,
        amount: money(unitPrice.times(usage.meterPoints)),
      };
    case 'per_building':
      if (!unitPrice)
        throw new PricingError('price_plan.not_billable', `${v.planKey} is quoted per building`);
      return {
        quantity: new Decimal(usage.buildings),
        unitPrice,
        amount: money(unitPrice.times(usage.buildings)),
      };
    case 'per_tenant': {
      const steps = v.tiers.filter((t): t is Extract<PriceTier, { upToUnits: number }> => 'upToUnits' in t);
      const step = steps.find((s) => usage.units <= s.upToUnits);
      const monthly = step ? new Decimal(step.monthly) : v.minMonthly ? new Decimal(v.minMonthly) : null;
      if (!monthly)
        throw new PricingError(
          'price_plan.not_billable',
          `${v.planKey}: ${usage.units} units above the last step`,
        );
      return { quantity: new Decimal(1), unitPrice: monthly, amount: money(monthly) };
    }
    case 'per_report':
      throw new PricingError('price_plan.not_billable', `${v.planKey} is billed per report`);
    case 'per_package':
    case 'per_listing':
    case 'per_recipient':
    case 'per_deal':
    case 'percent_of_amount':
      throw new PricingError('price_plan.not_billable', `${v.planKey} is bought as a purchase (pack G)`);
  }
}

/**
 * One platform invoice (D-156, D-161, D-083): the plan line, add-on lines (meter rental per rented point), the OCR
 * overage beyond the plan's allowance (D-161), pro-rata by calendar days for a partial first period, the subscription
 * discount (pilot, D-083) as a negative line, VAT at the plan's rate on the discounted subtotal. Rounding per line
 * half-up to satang (D-046). Annual billing is 12 months less the version's annual discount.
 */
export function computeCharges(input: {
  plan: PriceVersion;
  addons: PriceVersion[];
  usage: UsageCounts;
  /** Days billed ÷ days in the month (1 for a full month). */
  proRata?: { days: number; daysInMonth: number };
  billingPeriod?: 'monthly' | 'annual';
  discountPct?: string;
  discountReason?: string | null;
}): Charges {
  const factor = input.proRata
    ? new Decimal(input.proRata.days).div(input.proRata.daysInMonth)
    : new Decimal(1);
  const annual = input.billingPeriod === 'annual';
  const months = annual ? new Decimal(12) : new Decimal(1);
  const lines: ChargeLine[] = [];
  const push = (
    kind: ChargeLine['kind'],
    description: string,
    q: Decimal,
    unitPrice: Decimal,
    version: PriceVersion,
  ) => {
    const discountFactor = annual
      ? new Decimal(1).minus(new Decimal(version.annualDiscountPct).div(100))
      : new Decimal(1);
    const amount = money(q.times(unitPrice).times(factor).times(months).times(discountFactor));
    lines.push({
      kind,
      description,
      quantity: qty(q),
      unitPrice: price(unitPrice),
      amount: amount.toFixed(2),
    });
  };
  const main = planCharge(input.plan, input.usage);
  const suffix = input.proRata
    ? ` (${input.proRata.days}/${input.proRata.daysInMonth} วัน)`
    : annual
      ? ' (รายปี)'
      : '';
  push('subscription', `${input.plan.nameTh}${suffix}`, main.quantity, main.unitPrice, input.plan);
  for (const addon of input.addons) {
    const c = planCharge(addon, input.usage);
    if (c.quantity.isZero()) continue;
    push(
      addon.kind === 'hardware_rental' ? 'hardware_rental' : 'addon',
      `${addon.nameTh}${suffix}`,
      c.quantity,
      c.unitPrice,
      addon,
    );
  }
  const allowance = input.plan.includedAllowances.ocrPhotosPerMonth;
  const overagePrice = input.plan.includedAllowances.ocrOveragePerPhoto;
  if (allowance !== undefined && overagePrice !== undefined && input.usage.ocrImages > allowance) {
    const extra = new Decimal(input.usage.ocrImages - allowance);
    const p = new Decimal(overagePrice);
    lines.push({
      kind: 'ai_overage',
      description: `อ่านมิเตอร์ด้วย OCR เกินโควตา ${allowance} ภาพ`,
      quantity: qty(extra),
      unitPrice: price(p),
      amount: money(extra.times(p)).toFixed(2),
    });
  }
  const subtotal = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const pct = new Decimal(input.discountPct ?? 0);
  const discount = money(subtotal.times(pct).div(100));
  if (discount.gt(0))
    lines.push({
      kind: 'discount',
      description: `ส่วนลด ${pct.toDecimalPlaces(2).toString()}%${input.discountReason ? ` (${input.discountReason})` : ''}`,
      quantity: qty(1),
      unitPrice: price(discount.negated()),
      amount: discount.negated().toFixed(2),
    });
  const vat = money(subtotal.minus(discount).times(input.plan.vatRate));
  return {
    lines,
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    vatAmount: vat.toFixed(2),
    total: subtotal.minus(discount).plus(vat).toFixed(2),
  };
}
