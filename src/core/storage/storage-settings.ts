/**
 * Storage metering settings (D-276): every number is a setting with effective dates, per tenant type, edited by the
 * platform admin. Amounts stay null until the founder sets them — null free allowance = metering not active for that
 * tenant type (usage is still snapshotted, nothing is held, no notice is sent); null price = overage not sold.
 */
export const TENANT_TYPES = ['apartment', 'condo_juristic', 'pm_company', 'landlord'] as const;
export type StorageTenantType = (typeof TENANT_TYPES)[number];

const DECIMAL = /^\d{1,6}(\.\d{1,4})?$/;

/** `{apartment: "5" | null, …}`: one decimal string (or null) per tenant type. */
export function perTenantTypeProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be an object'];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (!(TENANT_TYPES as readonly string[]).includes(key)) problems.push(`${key}: unknown tenant type`);
    else if (v !== null && (typeof v !== 'string' || !DECIMAL.test(v)))
      problems.push(`${key}: a decimal string or null`);
  }
  return problems;
}

export interface StoragePackSetting {
  key: string;
  gb: string;
  monthlyPrice: string;
}

export function packsProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ['must be an array'];
  const problems: string[] = [];
  const keys = new Set<string>();
  value.forEach((pack: unknown, i) => {
    const p = pack as Partial<StoragePackSetting> | null;
    if (!p || typeof p.key !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(p.key))
      problems.push(`[${i}].key: slug`);
    else if (keys.has(p.key)) problems.push(`[${i}].key: duplicate`);
    else keys.add(p.key);
    if (typeof p?.gb !== 'string' || !DECIMAL.test(p.gb)) problems.push(`[${i}].gb: decimal string`);
    if (typeof p?.monthlyPrice !== 'string' || !DECIMAL.test(p.monthlyPrice))
      problems.push(`[${i}].monthlyPrice: decimal string`);
  });
  return problems;
}

/** `{_default: 1024, invoice: 2048, …}` bytes per record type; `_default` is required. */
export function recordBytesProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be an object'];
  const entries = Object.entries(value);
  const problems = entries
    .filter(([, v]) => !Number.isInteger(v) || (v as number) < 0 || (v as number) > 10_000_000)
    .map(([k]) => `${k}: integer bytes 0–10000000`);
  if (!entries.some(([k]) => k === '_default')) problems.push('_default: required');
  return problems;
}

export function noticeProblems(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ['a non-empty array of percentages'];
  return value.some((v) => !Number.isInteger(v) || v <= 0 || v > 1000) ? ['percentages 1–1000'] : [];
}

/** Record types counted per tenant (table → counted type); records of the platform itself are never counted. */
export const COUNTED_RECORDS = {
  invoice: 'ops.invoice',
  receipt: 'ops.receipt',
  payment: 'ops.payment',
  lease: 'ops.lease',
  meter_reading: 'smart.meter_reading',
  service_request: 'ops.service_request',
} as const;
export type CountedRecordType = keyof typeof COUNTED_RECORDS;

/** Recommended counted sizes (founder pre-approved recommendation, D-276 "e.g. 2 KB"). */
export const DEFAULT_RECORD_BYTES: Record<CountedRecordType | '_default', number> = {
  _default: 1024,
  invoice: 2048,
  receipt: 2048,
  payment: 1024,
  lease: 4096,
  meter_reading: 256,
  service_request: 2048,
};

export const NOT_SET_PER_TYPE = Object.fromEntries(TENANT_TYPES.map((t) => [t, null])) as Record<
  StorageTenantType,
  null
>;
