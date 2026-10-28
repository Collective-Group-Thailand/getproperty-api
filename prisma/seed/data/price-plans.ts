/**
 * Price plans of D-156 (Proposed until the pilot; every value an effective-dated version, B6.1). Only the apartment
 * plans (with the meter-rental add-on of Smart) and the landlord plan (free tier) are sold in Phase 1 — they are
 * active with a published version; the other plans are seeded inactive with a draft version so the catalogue is
 * complete. Prices exclude VAT (7 %); the annual discount is 15 %. Residents, technicians and committee members are
 * free (no plan). Hardware sold (~THB 1,500–2,500 per meter point) is invoiced through the getpack order flow, not here.
 */
export interface PricePlanSeed {
  key: string;
  tenantType: 'apartment' | 'condo_juristic' | 'pm_company' | 'landlord' | 'agency' | null;
  nameTh: string;
  nameEn: string;
  kind: 'software' | 'addon' | 'hardware_rental' | 'hardware_sale' | 'service';
  isActive: boolean;
  version: {
    billingUnit:
      | 'per_unit'
      | 'per_meter_point'
      | 'per_building'
      | 'per_tenant'
      | 'per_report'
      | 'per_deal'
      | 'percent_of_amount';
    unitPrice: string | null;
    priceRange: { from: string; to: string } | null;
    tiers: unknown[];
    minUnits: number | null;
    minMonthly: string | null;
    termMonths: number | null;
    includedAllowances: Record<string, unknown>;
    terms: Record<string, unknown>;
    published: boolean;
  };
}

/** Effective date of the seeded versions (before the first pilot, D-083). */
export const PRICE_PLAN_EFFECTIVE_FROM = '2026-01-01';

const OCR = { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50', status: 'proposed', decision: 'D-161' };
const proposed = (extra: Record<string, unknown> = {}) => ({
  status: 'proposed',
  decision: 'D-156',
  ...extra,
});

export const PRICE_PLANS: readonly PricePlanSeed[] = [
  {
    key: 'apartment_starter',
    tenantType: 'apartment',
    nameTh: 'Apartment Starter',
    nameEn: 'Apartment Starter',
    kind: 'software',
    isActive: true,
    version: {
      billingUnit: 'per_unit',
      unitPrice: '25.0000',
      priceRange: null,
      tiers: [],
      minUnits: 20,
      minMonthly: null,
      termMonths: null,
      includedAllowances: OCR,
      terms: proposed({ modules: ['A1', 'A2', 'A4', 'resident_liff', 'promptpay'] }),
      published: true,
    },
  },
  {
    key: 'apartment_smart',
    tenantType: 'apartment',
    nameTh: 'Apartment Smart',
    nameEn: 'Apartment Smart',
    kind: 'software',
    isActive: true,
    version: {
      billingUnit: 'per_unit',
      unitPrice: '40.0000',
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: OCR,
      terms: proposed({
        modules: ['A1', 'A2', 'A3', 'A4', 'C2'],
        meterSale: { fromPerPoint: '1500.00', toPerPoint: '2500.00', via: 'getpack order flow' },
      }),
      published: true,
    },
  },
  {
    key: 'meter_rental',
    tenantType: null,
    nameTh: 'เช่ามิเตอร์อัจฉริยะ (ต่อจุด)',
    nameEn: 'Smart meter rental (per point)',
    kind: 'hardware_rental',
    isActive: true,
    version: {
      billingUnit: 'per_meter_point',
      unitPrice: '60.0000',
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: 36,
      includedAllowances: {},
      terms: proposed({ addonOf: ['apartment_smart'], haas: 'D-081' }),
      published: true,
    },
  },
  {
    key: 'landlord',
    tenantType: 'landlord',
    nameTh: 'Landlord',
    nameEn: 'Landlord',
    kind: 'software',
    isActive: true,
    version: {
      billingUnit: 'per_tenant',
      unitPrice: null,
      priceRange: null,
      tiers: [
        { upToUnits: 3, monthly: '0.00' },
        { upToUnits: 10, monthly: '99.00' },
        { upToUnits: 20, monthly: '299.00' },
      ],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: proposed({ phase1SoldUpToUnits: 3, modules: ['A1', 'A2', 'resident_liff', 'promptpay'] }),
      published: true,
    },
  },
  {
    key: 'condo_juristic',
    tenantType: 'condo_juristic',
    nameTh: 'Condo Juristic',
    nameEn: 'Condo Juristic',
    kind: 'software',
    isActive: false,
    version: {
      billingUnit: 'per_unit',
      unitPrice: null,
      priceRange: null,
      // breakpoints are not given by D-156: the draft keeps the three prices without them (not sellable until set)
      tiers: [
        { fromUnits: null, toUnits: null, pricePerUnit: '15.00' },
        { fromUnits: null, toUnits: null, pricePerUnit: '12.00' },
        { fromUnits: null, toUnits: null, pricePerUnit: '10.00' },
      ],
      minUnits: 100,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: proposed({ note: 'tier breakpoints not specified by D-156' }),
      published: false,
    },
  },
  {
    key: 'juristic_pro',
    tenantType: 'condo_juristic',
    nameTh: 'Juristic Pro',
    nameEn: 'Juristic Pro',
    kind: 'software',
    isActive: false,
    version: {
      billingUnit: 'per_unit',
      unitPrice: '20.0000',
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: proposed({ agmModulePerBuildingYear: { from: '6000.00', to: '15000.00' } }),
      published: false,
    },
  },
  {
    key: 'access_addon',
    tenantType: null,
    nameTh: 'Access Add-on',
    nameEn: 'Access Add-on',
    kind: 'addon',
    isActive: false,
    version: {
      billingUnit: 'per_building',
      unitPrice: null,
      priceRange: { from: '3000.00', to: '8000.00' },
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: proposed(),
      published: false,
    },
  },
  {
    key: 'pm_portfolio',
    tenantType: 'pm_company',
    nameTh: 'PM Portfolio',
    nameEn: 'PM Portfolio',
    kind: 'software',
    isActive: false,
    version: {
      billingUnit: 'per_tenant',
      unitPrice: null,
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: '50000.00',
      termMonths: null,
      includedAllowances: {},
      terms: proposed({ buildingsIncluded: 10 }),
      published: false,
    },
  },
  {
    key: 'inspection_report',
    tenantType: null,
    nameTh: 'Inspection Report',
    nameEn: 'Inspection Report',
    kind: 'service',
    isActive: false,
    version: {
      billingUnit: 'per_report',
      unitPrice: null,
      priceRange: { from: '3000.00', to: '5000.00' },
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: proposed(),
      published: false,
    },
  },
  {
    // G2 (D-287, D-293): success fee on a deal closed through the platform, paid by the listing agency; no price until the
    // platform admin publishes a version (O-027) — without a price nothing is accrued
    key: 'success_fee',
    tenantType: 'agency',
    nameTh: 'ค่าธรรมเนียมความสำเร็จ',
    nameEn: 'Success fee',
    kind: 'service',
    isActive: true,
    version: {
      billingUnit: 'percent_of_amount',
      unitPrice: null,
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: { status: 'proposed', decision: 'D-287', basis: 'commission', capAmount: null },
      published: false,
    },
  },
  {
    // G2 (D-287, D-293): co-broke fee on a deal closed through the platform, paid by the co-agency; no price until the
    // platform admin publishes a version (O-027) — without a price nothing is accrued
    key: 'co_broke_fee',
    tenantType: 'agency',
    nameTh: 'ค่าธรรมเนียม co-broke',
    nameEn: 'Co-broke fee',
    kind: 'service',
    isActive: true,
    version: {
      billingUnit: 'percent_of_amount',
      unitPrice: null,
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: { status: 'proposed', decision: 'D-287', basis: 'commission', capAmount: null },
      published: false,
    },
  },
  {
    // G4 (D-287, D-296): an agency's own LINE OA integration — monthly fee (unit price) + one-time setup fee (setup_fee);
    // no price until the platform admin publishes a version (O-027): connecting stays free and nothing is charged
    key: 'line_oa_integration',
    tenantType: 'agency',
    nameTh: 'เชื่อม LINE OA ของบริษัทนายหน้า',
    nameEn: 'Agency LINE OA integration',
    kind: 'addon',
    isActive: true,
    version: {
      billingUnit: 'per_tenant',
      unitPrice: null,
      priceRange: null,
      tiers: [],
      minUnits: null,
      minMonthly: null,
      termMonths: null,
      includedAllowances: {},
      terms: { product: 'line_oa_integration', status: 'proposed', decision: 'D-287' },
      published: false,
    },
  },
];
