import { type UtilityTariffStructure } from '../../../src/core/utility-tariffs/tariff-structure';

/**
 * Utility tariff versions seeded as the สคบ. 2568 cap reference (D-021a, D-140; schema-design §4.2.1).
 * Entered by the development team on 2026-10-17 from the sources below; every version is seeded with
 * state = 'entered' (unverified — the platform admin verifies and publishes it, maker-checker, B6.4).
 * `needs_check = true` (and `structure.needsCheck` lists the JSON paths) wherever a value could not be confirmed
 * from a primary source. Amounts exclude VAT 7 %.
 *
 * Electricity — MEA and PEA apply the same national residential tariff; codes follow PEA's numbering
 * (1.1.1 ≤ 150 kWh/month, 1.1.2 > 150 kWh/month, 1.2 TOU); MEA numbers the same classes differently (needs check).
 *   v2025-05  base tariff (PEA tariff document) + Ft 19.72 satang (ERC, May–Aug 2025; average 3.98 THB)
 *   v2025-09  same base + Ft 15.72 satang (ERC cut Ft by 4 satang for Sep–Dec 2025; average 3.94 THB) — Ft derived
 *   v2026-09  new residential structure from September 2026 bills (first 200 kWh "not exceeding 3.00 THB/kWh",
 *             201–400 kWh 4.1584, > 400 kWh 4.3583) + Ft 16.23 satang (ERC meeting 29/2569, Sep–Dec 2026)
 *   Jan–Aug 2026 is NOT seeded: the Ft of those periods could not be confirmed (no version = no cap → O-006).
 * Water — MWA and PWA residential progressive tables as known to the team; all values need checking.
 */
export interface TariffSeed {
  provider: 'mea' | 'pea' | 'mwa' | 'pwa';
  utility: 'electric' | 'water';
  tariffCode: string;
  nameTh: string;
  nameEn: string;
  versions: TariffVersionSeed[];
}

export interface TariffVersionSeed {
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceUrl: string;
  sourcePublishedAt: string | null;
  needsCheck: boolean;
  notes: string;
  structure: UtilityTariffStructure;
}

const PEA_TARIFF_DOC =
  'https://www.pea.co.th/sites/default/files/documents/tariff/EN_Electricity_Tariffs_May_2023.pdf';
const FT_2025_05 = 'https://www.hoonvision.com/?p=58500';
const FT_2025_09 = 'https://www.thebangkokinsight.com/news/business/economics/1529085/';
const FT_2026_09 = 'https://www.naewna.com/business/979048';
const NEW_STRUCTURE_2026_09 = 'https://www.infoquest.co.th/?p=630859';

const VAT = { rate: '0.07', included: false } as const;

const TIERS_111_BASE = [
  { fromUnits: '0', toUnits: '15', pricePerUnit: '2.3488' },
  { fromUnits: '15', toUnits: '25', pricePerUnit: '2.9882' },
  { fromUnits: '25', toUnits: '35', pricePerUnit: '3.2405' },
  { fromUnits: '35', toUnits: '100', pricePerUnit: '3.6237' },
  { fromUnits: '100', toUnits: '150', pricePerUnit: '3.7171' },
  { fromUnits: '150', toUnits: '400', pricePerUnit: '4.2218' },
  { fromUnits: '400', toUnits: null, pricePerUnit: '4.4217' },
];
const TIERS_112_BASE = [
  { fromUnits: '0', toUnits: '150', pricePerUnit: '3.2484' },
  { fromUnits: '150', toUnits: '400', pricePerUnit: '4.2218' },
  { fromUnits: '400', toUnits: null, pricePerUnit: '4.4217' },
];
/** From September 2026 bills: the first 200 kWh are announced as "not exceeding 3.00 THB/kWh" (block rates inside 0–200 not found). */
const TIERS_RESIDENTIAL_2026_09 = [
  { fromUnits: '0', toUnits: '200', pricePerUnit: '3.0000' },
  { fromUnits: '200', toUnits: '400', pricePerUnit: '4.1584' },
  { fromUnits: '400', toUnits: null, pricePerUnit: '4.3583' },
];
const TOU_BASE = {
  onPeak: { pricePerUnit: '5.7982', window: 'Mon–Fri 09:00–22:00' },
  offPeak: { pricePerUnit: '2.6369', window: 'Mon–Fri 22:00–09:00, Sat, Sun, public holidays' },
};

interface Period {
  effectiveFrom: string;
  effectiveTo: string | null;
  ft: string;
  ftPeriod: string;
  ftSource: string;
  publishedAt: string | null;
  ftNeedsCheck: boolean;
}
const PERIODS: Period[] = [
  {
    effectiveFrom: '2025-05-01',
    effectiveTo: '2025-09-01',
    ft: '0.1972',
    ftPeriod: '2025-05/2025-08',
    ftSource: FT_2025_05,
    publishedAt: null,
    ftNeedsCheck: false,
  },
  {
    effectiveFrom: '2025-09-01',
    effectiveTo: '2026-01-01',
    ft: '0.1572',
    ftPeriod: '2025-09/2025-12',
    ftSource: FT_2025_09,
    publishedAt: null,
    ftNeedsCheck: true,
  },
  {
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    ft: '0.1623',
    ftPeriod: '2026-09/2026-12',
    ftSource: FT_2026_09,
    publishedAt: '2026-07-23',
    ftNeedsCheck: true,
  },
];

const add = (a: string, b: string) => (Math.round((Number(a) + Number(b)) * 10000) / 10000).toFixed(4);

function electricVersions(code: '1.1.1' | '1.1.2' | '1.2', provider: 'mea' | 'pea'): TariffVersionSeed[] {
  return PERIODS.map((p) => {
    const isNew = p.effectiveFrom >= '2026-09-01';
    const needs: string[] = [];
    if (p.ftNeedsCheck) needs.push('ft.pricePerUnit');
    if (provider === 'mea')
      needs.push(
        'source (MEA page not consulted; PEA document used for the national tariff)',
        'tariffCode (MEA numbering)',
      );
    let structure: UtilityTariffStructure;
    const ft = { pricePerUnit: p.ft, period: p.ftPeriod, sourceUrl: p.ftSource };
    const service = { amount: code === '1.1.1' ? '8.19' : '24.62', basis: 'per_month' as const };
    if (code === '1.2') {
      if (isNew) needs.push('tou.onPeak.pricePerUnit', 'tou.offPeak.pricePerUnit', 'serviceCharge.amount');
      structure = {
        kind: 'tou',
        unit: 'kwh',
        currency: 'THB',
        tou: TOU_BASE,
        ft,
        serviceCharge: { amount: '24.62', basis: 'per_month' },
        minimumCharge: null,
        vat: VAT,
        ceilingPerUnit: add(TOU_BASE.onPeak.pricePerUnit, p.ft),
        capBasis: 'effective_average_rate',
        needsCheck: needs,
        notes_th: 'ประเภทที่ 1.2 อัตราตามช่วงเวลาของการใช้ (TOU) แรงดันต่ำกว่า 22 kV',
        notes_en: 'Type 1.2 residential time-of-use, below 22 kV; the cap needs the on/off-peak split.',
      };
    } else {
      const tiers = isNew ? TIERS_RESIDENTIAL_2026_09 : code === '1.1.1' ? TIERS_111_BASE : TIERS_112_BASE;
      if (isNew)
        needs.push(
          'tiers[0].pricePerUnit (announced as "not exceeding 3.00"; block rates inside 0–200 kWh not found)',
          'serviceCharge.amount',
        );
      if (code === '1.1.1') needs.push('applicability (≤ 150 kWh/month vs meter ≤ 5 A classification)');
      structure = {
        kind: 'tiered',
        unit: 'kwh',
        currency: 'THB',
        tiers,
        ft,
        serviceCharge: service,
        minimumCharge: null,
        vat: VAT,
        ceilingPerUnit: add(tiers[tiers.length - 1]!.pricePerUnit, p.ft),
        capBasis: 'effective_average_rate',
        needsCheck: needs,
        notes_th:
          code === '1.1.1'
            ? 'ประเภทที่ 1.1.1 บ้านอยู่อาศัย ใช้ไม่เกิน 150 หน่วยต่อเดือน'
            : 'ประเภทที่ 1.1.2 บ้านอยู่อาศัย ใช้เกินกว่า 150 หน่วยต่อเดือน',
      };
    }
    return {
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      sourceUrl: isNew ? NEW_STRUCTURE_2026_09 : PEA_TARIFF_DOC,
      sourcePublishedAt: isNew ? p.publishedAt : null,
      needsCheck: needs.length > 0,
      notes: `Base: ${isNew ? NEW_STRUCTURE_2026_09 : PEA_TARIFF_DOC}; Ft ${p.ftPeriod}: ${p.ftSource}. Entered 2026-10-17 by the dev team, unverified.`,
      structure,
    };
  });
}

function electric(provider: 'mea' | 'pea'): TariffSeed[] {
  const owner = provider === 'mea' ? 'กฟน.' : 'กฟภ.';
  return [
    {
      provider,
      utility: 'electric',
      tariffCode: '1.1.1',
      nameTh: `${owner} ประเภทที่ 1.1.1 บ้านอยู่อาศัย (ไม่เกิน 150 หน่วย/เดือน)`,
      nameEn: `${provider.toUpperCase()} residential 1.1.1 (≤ 150 kWh/month)`,
      versions: electricVersions('1.1.1', provider),
    },
    {
      provider,
      utility: 'electric',
      tariffCode: '1.1.2',
      nameTh: `${owner} ประเภทที่ 1.1.2 บ้านอยู่อาศัย (เกิน 150 หน่วย/เดือน)`,
      nameEn: `${provider.toUpperCase()} residential 1.1.2 (> 150 kWh/month)`,
      versions: electricVersions('1.1.2', provider),
    },
    {
      provider,
      utility: 'electric',
      tariffCode: '1.2',
      nameTh: `${owner} ประเภทที่ 1.2 บ้านอยู่อาศัย อัตรา TOU`,
      nameEn: `${provider.toUpperCase()} residential 1.2 time-of-use`,
      versions: electricVersions('1.2', provider),
    },
  ];
}

export const UTILITY_TARIFFS: TariffSeed[] = [
  ...electric('mea'),
  ...electric('pea'),
  {
    provider: 'mwa',
    utility: 'water',
    tariffCode: 'residential',
    nameTh: 'กปน. ประเภทที่ 1 ที่อยู่อาศัย',
    nameEn: 'MWA type 1 residential',
    versions: [
      {
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        sourceUrl: 'https://www.mwa.co.th/',
        sourcePublishedAt: null,
        needsCheck: true,
        notes:
          'Progressive table as known to the team; effective date of the published table, monthly service charge per meter size and minimum charge not confirmed. 2025-01-01 = date from which this seed asserts validity, not the utility’s effective date.',
        structure: {
          kind: 'tiered',
          unit: 'm3',
          currency: 'THB',
          tiers: [
            { fromUnits: '0', toUnits: '30', pricePerUnit: '8.5000' },
            { fromUnits: '30', toUnits: '40', pricePerUnit: '10.0300' },
            { fromUnits: '40', toUnits: '50', pricePerUnit: '10.3500' },
            { fromUnits: '50', toUnits: '60', pricePerUnit: '10.6800' },
            { fromUnits: '60', toUnits: '70', pricePerUnit: '11.0000' },
            { fromUnits: '70', toUnits: '80', pricePerUnit: '11.3300' },
            { fromUnits: '80', toUnits: '90', pricePerUnit: '12.5000' },
            { fromUnits: '90', toUnits: '100', pricePerUnit: '12.8200' },
            { fromUnits: '100', toUnits: '120', pricePerUnit: '13.1500' },
            { fromUnits: '120', toUnits: '160', pricePerUnit: '13.4700' },
            { fromUnits: '160', toUnits: '200', pricePerUnit: '13.8000' },
            { fromUnits: '200', toUnits: null, pricePerUnit: '14.4500' },
          ],
          ft: null,
          serviceCharge: null,
          minimumCharge: null,
          vat: VAT,
          ceilingPerUnit: '14.4500',
          capBasis: 'effective_average_rate',
          needsCheck: [
            'tiers[*].pricePerUnit',
            'serviceCharge (per meter size, not entered)',
            'minimumCharge (not entered)',
            'effectiveFrom',
          ],
          notes_th:
            'อัตราก้าวหน้า ไม่รวมภาษีมูลค่าเพิ่ม และค่าบริการรายเดือนตามขนาดมาตรวัด (ยังไม่ได้บันทึก)',
        },
      },
    ],
  },
  {
    provider: 'pwa',
    utility: 'water',
    tariffCode: 'residential',
    nameTh: 'กปภ. ประเภทที่ 1 ที่อยู่อาศัย',
    nameEn: 'PWA type 1 residential',
    versions: [
      {
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        sourceUrl: 'https://www.pwa.co.th/',
        sourcePublishedAt: null,
        needsCheck: true,
        notes:
          'Progressive table as recalled by the team — every value needs confirmation against PWA’s published table (service charge and minimum charge not entered). 2025-01-01 = date from which this seed asserts validity.',
        structure: {
          kind: 'tiered',
          unit: 'm3',
          currency: 'THB',
          tiers: [
            { fromUnits: '0', toUnits: '10', pricePerUnit: '10.2000' },
            { fromUnits: '10', toUnits: '20', pricePerUnit: '16.0000' },
            { fromUnits: '20', toUnits: '30', pricePerUnit: '19.0000' },
            { fromUnits: '30', toUnits: '50', pricePerUnit: '21.2000' },
            { fromUnits: '50', toUnits: '80', pricePerUnit: '21.6000' },
            { fromUnits: '80', toUnits: '100', pricePerUnit: '21.6500' },
            { fromUnits: '100', toUnits: '300', pricePerUnit: '21.7000' },
            { fromUnits: '300', toUnits: '1000', pricePerUnit: '21.7500' },
            { fromUnits: '1000', toUnits: '2000', pricePerUnit: '21.8000' },
            { fromUnits: '2000', toUnits: '3000', pricePerUnit: '21.8500' },
            { fromUnits: '3000', toUnits: null, pricePerUnit: '21.9000' },
          ],
          ft: null,
          serviceCharge: null,
          minimumCharge: null,
          vat: VAT,
          ceilingPerUnit: '21.9000',
          capBasis: 'effective_average_rate',
          needsCheck: [
            'tiers[*].pricePerUnit',
            'serviceCharge (per meter size, not entered)',
            'minimumCharge (not entered)',
            'effectiveFrom',
          ],
        },
      },
    ],
  },
];
