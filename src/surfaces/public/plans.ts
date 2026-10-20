import { TenantTypeName } from '../shared/me.dto';
import { PlanModuleKey, PricePlanKind, PricePlanStatus, PriceUnit, type PublicPlanDto } from './public.dto';

const MODULE_KEYS = new Set<string>(Object.values(PlanModuleKey));

/** Module keys of a plan as the named enum (unknown keys are a catalogue error, caught by the plans unit test). */
export const planModules = (modules: unknown): PlanModuleKey[] =>
  Array.isArray(modules) ? modules.map(String).filter((m): m is PlanModuleKey => MODULE_KEYS.has(m)) : [];

/** Marketing labels per plan key (the prices themselves always come from the price-plan catalogue). */
const LABELS: Record<string, { name: string; summary: string; tenantType: TenantTypeName | null }> = {
  apartment_starter: {
    name: 'Apartment Starter',
    summary: 'ออกบิล เก็บเงิน และแจ้งผู้เช่าผ่าน LINE สำหรับหอพักที่จดมิเตอร์เอง',
    tenantType: TenantTypeName.Apartment,
  },
  apartment_smart: {
    name: 'Apartment Smart',
    summary: 'มิเตอร์อัจฉริยะส่งค่าอัตโนมัติ ออกบิลเอง และรายงานไฟน้ำสูญหาย',
    tenantType: TenantTypeName.Apartment,
  },
  condo_juristic: {
    name: 'Condo Juristic',
    summary: 'นิติบุคคลอาคารชุด: ค่าส่วนกลาง ประกาศ พัสดุ และการเงิน',
    tenantType: TenantTypeName.CondoJuristic,
  },
  juristic_pro: {
    name: 'Juristic Pro',
    summary: 'นิติบุคคลพร้อมระบบประชุมใหญ่และลงคะแนนออนไลน์',
    tenantType: TenantTypeName.CondoJuristic,
  },
  pm_portfolio: {
    name: 'PM Portfolio',
    summary: 'บริษัทบริหารอาคาร: หลายอาคารในบัญชีเดียว',
    tenantType: TenantTypeName.PmCompany,
  },
  landlord: {
    name: 'Landlord',
    summary: 'เจ้าของห้องให้เช่าในคอนโด: สัญญา บิล และรับเงิน',
    tenantType: TenantTypeName.Landlord,
  },
  access_addon: {
    name: 'Access Add-on',
    summary: 'ระบบประตูและกุญแจอัจฉริยะต่ออาคาร',
    tenantType: null,
  },
  inspection_report: {
    name: 'Inspection Report',
    summary: 'รายงานตรวจรับห้องหรืออาคารโดยผู้ตรวจ',
    tenantType: null,
  },
  meter_rental: {
    name: 'Smart Meter Rental',
    summary: 'เช่ามิเตอร์อัจฉริยะพร้อมติดตั้งและดูแล ต่อจุดต่อเดือน (สัญญา 36 เดือน)',
    tenantType: null,
  },
};

const UNIT_BY_BILLING: Record<string, PriceUnit> = {
  per_unit: PriceUnit.UnitMonth,
  per_meter_point: PriceUnit.MeterPointMonth,
  per_building: PriceUnit.BuildingMonth,
  per_tenant: PriceUnit.Month,
  per_report: PriceUnit.Report,
};

const money = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') && /^\d+(\.\d+)?$/.test(String(v))
    ? Number(v).toFixed(2)
    : null;

function range(v: unknown): { from: string | null; to: string | null } {
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return { from: money(r.from), to: money(r.to) };
  }
  return { from: null, to: null };
}

/** One row of `platform.price_plan` with its versions (B6.1, D-204). */
export interface CataloguePlan {
  key: string;
  tenantType: string | null;
  nameTh: string;
  nameEn: string;
  isActive: boolean;
  versions: {
    effectiveFrom: Date;
    effectiveTo: Date | null;
    state: string;
    billingUnit: string;
    unitPrice: { toString(): string } | null;
    priceRange: unknown;
    tiers: unknown;
    minUnits: number | null;
    minMonthly: { toString(): string } | null;
    currency: string;
    terms: unknown;
  }[];
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Projects the price-plan catalogue (`platform.price_plan` + `price_plan_version`, B6.1, D-204) onto the public
 * pricing list (`GET /v1/public/plans`, web contract request, D-208): per plan the published version in force today
 * — `sold: true` when the plan is active — else its newest draft (a proposal shown with its quoted range,
 * `sold: false`). A single price where the version has one, a from/to range from the price range, tiers, steps or a
 * minimum monthly fee; `status` follows the version terms (`proposed` while D-156 is Proposed).
 */
export function publicPlansFromCatalogue(plans: readonly CataloguePlan[], today: string): PublicPlanDto[] {
  const out: PublicPlanDto[] = [];
  for (const plan of plans) {
    const inForce = plan.versions
      .filter(
        (v) =>
          v.state === 'published' &&
          dayOf(v.effectiveFrom) <= today &&
          (!v.effectiveTo || dayOf(v.effectiveTo) > today),
      )
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
    const draft = plan.versions
      .filter((v) => v.state === 'draft')
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
    const v = inForce ?? draft;
    if (!v) continue;
    const label = LABELS[plan.key];
    const terms = (v.terms ?? {}) as Record<string, unknown>;
    let priceUnit = UNIT_BY_BILLING[v.billingUnit] ?? PriceUnit.Month;
    const pricePerUnit = money(v.unitPrice?.toString());
    let { from, to } = range(v.priceRange);
    const tiers = Array.isArray(v.tiers) ? (v.tiers as Record<string, unknown>[]) : [];
    if (!pricePerUnit && !from && tiers.length) {
      const prices = tiers
        .map((t) => money(t.pricePerUnit) ?? money(t.monthly))
        .filter((x): x is string => x !== null)
        .sort((a, b) => Number(a) - Number(b));
      if (prices.length) {
        from = prices[0]!;
        to = prices[prices.length - 1]!;
        if (tiers.some((t) => t.monthly !== undefined)) priceUnit = PriceUnit.Month;
      }
    }
    if (!pricePerUnit && !from && v.minMonthly) {
      from = money(v.minMonthly.toString());
      priceUnit = PriceUnit.Month;
    }
    if (!pricePerUnit && !from && terms.agmModulePerBuildingYear) {
      ({ from, to } = range(terms.agmModulePerBuildingYear));
      priceUnit = PriceUnit.BuildingYear;
    }
    const tenantType = (plan.tenantType as TenantTypeName | null) ?? null;
    out.push({
      key: plan.key,
      kind: tenantType ? PricePlanKind.Plan : PricePlanKind.Addon,
      tenantType,
      name: label?.name ?? plan.nameEn,
      summary: label?.summary ?? plan.nameTh,
      pricePerUnit,
      priceFrom: pricePerUnit ? null : from,
      priceTo: pricePerUnit ? null : to,
      priceUnit,
      minimumUnits: v.minUnits,
      currency: v.currency.trim() || 'THB',
      vatIncluded: false,
      status: terms.status === 'confirmed' ? PricePlanStatus.Confirmed : PricePlanStatus.Proposed,
      features: planModules(terms.modules),
      sold: Boolean(inForce) && plan.isActive,
      effectiveFrom: inForce ? dayOf(inForce.effectiveFrom) : null,
    });
  }
  return out;
}
