import { TenantTypeName } from '../shared/me.dto';
import { PlanModuleKey, PricePlanKind, PricePlanStatus, PriceUnit, type PublicPlanDto } from './public.dto';

const MODULE_KEYS = new Set<string>(Object.values(PlanModuleKey));

/** Module keys of a plan as the named enum (unknown keys are a catalogue error, caught by the plans unit test). */
export const planModules = (modules: unknown): PlanModuleKey[] =>
  Array.isArray(modules) ? modules.map(String).filter((m): m is PlanModuleKey => MODULE_KEYS.has(m)) : [];

/** The `pricing.price_plans` setting value (D-156, seeded by the settings catalogue). */
interface PricePlansSetting {
  status?: string;
  currency?: string;
  vatIncluded?: boolean;
  plans?: Record<string, Record<string, unknown>>;
}

/** Marketing labels per plan key (the prices themselves always come from the setting). */
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
};

const UNIT_BY_BILLING: Record<string, PriceUnit> = {
  per_unit: PriceUnit.UnitMonth,
  per_building: PriceUnit.BuildingMonth,
  per_tenant: PriceUnit.Month,
  per_report: PriceUnit.Report,
};

const money = (v: unknown): string | null =>
  typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v).toFixed(2) : null;

function range(v: unknown): { from: string | null; to: string | null } {
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return { from: money(r.from), to: money(r.to) };
  }
  return { from: null, to: null };
}

/**
 * Projects the D-156 `pricing.price_plans` setting onto the public pricing list (`GET /v1/public/plans`): a single
 * price where the plan has one, a from/to range where it is quoted, `status = proposed` while D-156 is Proposed.
 * Plans without a marketing label are not published.
 */
export function publicPlans(setting: unknown): PublicPlanDto[] {
  const s = (setting ?? {}) as PricePlansSetting;
  const status = s.status === 'confirmed' ? PricePlanStatus.Confirmed : PricePlanStatus.Proposed;
  const out: PublicPlanDto[] = [];
  for (const [key, plan] of Object.entries(s.plans ?? {})) {
    const label = LABELS[key];
    if (!label) continue;
    const billing = typeof plan.billingUnit === 'string' ? plan.billingUnit : 'per_unit';
    let priceUnit = UNIT_BY_BILLING[billing] ?? PriceUnit.Month;
    const pricePerUnit = money(plan.pricePerUnit) ?? money(plan.price);
    let { from, to } = range(plan.price);
    if (!from && plan.monthly) ({ from, to } = range(plan.monthly));
    if (!from && plan.agmModulePerBuildingYear) {
      ({ from, to } = range(plan.agmModulePerBuildingYear));
      if (!pricePerUnit) priceUnit = PriceUnit.BuildingYear;
    }
    if (!from && typeof plan.monthlyFrom === 'string') from = money(plan.monthlyFrom);
    if (!pricePerUnit && Array.isArray(plan.tiers) && plan.tiers.length) {
      const tiers = (plan.tiers as unknown[]).map(money).filter((t): t is string => t !== null);
      if (tiers.length) {
        from = tiers.reduce((a, b) => (Number(a) < Number(b) ? a : b));
        to = tiers.reduce((a, b) => (Number(a) > Number(b) ? a : b));
      }
    }
    if (!pricePerUnit && Array.isArray(plan.steps) && plan.steps.length) {
      const prices = (plan.steps as { monthly?: unknown }[])
        .map((st) => money(st.monthly))
        .filter((p): p is string => p !== null);
      if (prices.length) {
        from = prices[0]!;
        to = prices[prices.length - 1]!;
      }
    }
    if (pricePerUnit) {
      from = null;
      to = null;
    }
    out.push({
      key,
      kind: label.tenantType ? PricePlanKind.Plan : PricePlanKind.Addon,
      tenantType: label.tenantType,
      name: label.name,
      summary: label.summary,
      pricePerUnit,
      priceFrom: from,
      priceTo: to,
      priceUnit,
      minimumUnits: typeof plan.minUnits === 'number' ? plan.minUnits : null,
      currency: s.currency ?? 'THB',
      vatIncluded: s.vatIncluded ?? false,
      status,
      features: planModules(plan.modules),
    });
  }
  return out;
}
