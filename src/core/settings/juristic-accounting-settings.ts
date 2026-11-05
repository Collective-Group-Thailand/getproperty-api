import Decimal from 'decimal.js';

/**
 * Settings of the juristic light GL (D-311, D-329) shared by the setting catalogue and the expense rules:
 * `juristic.approval_bands` and `juristic.wht_rates` (⚖ O-041) — shapes, seeded defaults and validators.
 */
export const BAND_ROLES = ['owner', 'manager', 'committee'] as const;
export type BandRole = (typeof BAND_ROLES)[number];

export interface ApprovalBand {
  /** Inclusive upper bound (decimal string, THB); null = no upper bound (the last band). */
  upTo: string | null;
  roles: BandRole[];
  approvals: number;
}

/** Default bands (editable, assumption recorded in D-329): ≤ 10,000 one approval; ≤ 100,000 two; above three. */
export const DEFAULT_APPROVAL_BANDS: ApprovalBand[] = [
  { upTo: '10000.00', roles: ['owner', 'manager', 'committee'], approvals: 1 },
  { upTo: '100000.00', roles: ['owner', 'manager', 'committee'], approvals: 2 },
  { upTo: null, roles: ['owner', 'committee'], approvals: 3 },
];

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export function approvalBandsProblems(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return ['1–10 bands'];
  const out: string[] = [];
  let prev: Decimal | null = null;
  value.forEach((b: unknown, i) => {
    const band = b as Partial<ApprovalBand> | null;
    if (!band || typeof band !== 'object') {
      out.push(`band ${i}: an object`);
      return;
    }
    const last = i === value.length - 1;
    if (last ? band.upTo !== null : typeof band.upTo !== 'string' || !MONEY.test(band.upTo))
      out.push(last ? `band ${i}: the last band has upTo null` : `band ${i}: upTo a money string`);
    else if (!last) {
      const up = new Decimal(band.upTo as string);
      if (prev && up.lte(prev)) out.push(`band ${i}: upTo ascending`);
      prev = up;
    }
    if (
      !Array.isArray(band.roles) ||
      band.roles.length < 1 ||
      !band.roles.every((r) => (BAND_ROLES as readonly string[]).includes(r)) ||
      new Set(band.roles).size !== band.roles.length
    )
      out.push(`band ${i}: roles from owner, manager, committee`);
    if (!Number.isInteger(band.approvals) || (band.approvals as number) < 1 || (band.approvals as number) > 5)
      out.push(`band ${i}: approvals 1–5`);
  });
  return out;
}

export interface WhtRate {
  key: string;
  labelTh: string;
  labelEn: string;
  /** Income type printed on the 50 ทวิ (e.g. `40(8)`, `3 เตรส`). */
  incomeType: string;
  /** Percent, decimal string. */
  ratePct: string;
  verified: boolean;
}

/** Seeded common rates (⚖ O-041: not verified for juristic persons — editable data, never assumed in code). */
export const DEFAULT_WHT_RATES: WhtRate[] = [
  {
    key: 'transport',
    labelTh: 'ค่าขนส่ง',
    labelEn: 'Transport',
    incomeType: '3 เตรส',
    ratePct: '1.00',
    verified: false,
  },
  {
    key: 'advertising',
    labelTh: 'ค่าโฆษณา',
    labelEn: 'Advertising',
    incomeType: '3 เตรส',
    ratePct: '2.00',
    verified: false,
  },
  {
    key: 'service',
    labelTh: 'ค่าบริการ / ค่าจ้างทำของ',
    labelEn: 'Services / hire of work',
    incomeType: '3 เตรส',
    ratePct: '3.00',
    verified: false,
  },
  {
    key: 'professional',
    labelTh: 'ค่าวิชาชีพอิสระ',
    labelEn: 'Professional fees',
    incomeType: '40(6)',
    ratePct: '3.00',
    verified: false,
  },
  { key: 'rent', labelTh: 'ค่าเช่า', labelEn: 'Rent', incomeType: '40(5)', ratePct: '5.00', verified: false },
];

export function whtRatesProblems(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) return ['an array of at most 30 rates'];
  const keys = new Set<string>();
  const out: string[] = [];
  value.forEach((r: unknown, i) => {
    const rate = r as Partial<WhtRate> | null;
    if (!rate || typeof rate !== 'object') return void out.push(`rate ${i}: an object`);
    if (typeof rate.key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(rate.key)) out.push(`rate ${i}: key`);
    else if (keys.has(rate.key)) out.push(`rate ${i}: duplicate key`);
    else keys.add(rate.key);
    for (const f of ['labelTh', 'labelEn', 'incomeType'] as const)
      if (typeof rate[f] !== 'string' || !rate[f].trim() || rate[f].length > 120) out.push(`rate ${i}: ${f}`);
    if (
      typeof rate.ratePct !== 'string' ||
      !/^\d{1,3}(\.\d{1,2})?$/.test(rate.ratePct) ||
      Number(rate.ratePct) <= 0 ||
      Number(rate.ratePct) > 100
    )
      out.push(`rate ${i}: ratePct a percent > 0`);
    if (typeof rate.verified !== 'boolean') out.push(`rate ${i}: verified boolean`);
  });
  return out;
}
