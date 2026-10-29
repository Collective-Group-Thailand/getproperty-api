/**
 * getenergy integration events (G9, D-289 (6), D-301) — a **provisional local contract** until
 * `collective-asset-core` carries it (O-028; asset-core's contracts name getbuild and getpack only). The envelope has
 * the asset-core shape (`eventId`, `type`, `version`, `occurredAt`, `idempotencyKey`, `sourcePlatform`, `tenantId`,
 * `payload`); additive changes only within version 1. Payloads are **aggregate / anonymised**: no names, contacts,
 * unit numbers, residents or per-unit figures (D-025) — contact sharing waits for O-036 and the shared PII key.
 */

export const GETENERGY_CONTRACT_VERSION = '0.1.0';
export const GETENERGY_EVENT_TYPES = ['energy.insight.shared', 'energy.insight.withdrawn'] as const;
export type GetenergyEventType = (typeof GETENERGY_EVENT_TYPES)[number];

export interface EnergyInsightSharedPayload {
  leadId: string;
  building: {
    ref: string;
    province: string | null;
    district: string | null;
    tenantType: string;
    unitCountBand: '1-10' | '11-30' | '31-100' | '101+';
  };
  window: { from: string; to: string; dataDays: number };
  score: number;
  scoreModel: string;
  metrics: {
    basis: 'main' | 'sum';
    totalKwh: string;
    commonAreaKwh: string;
    commonAreaShare: string | null;
    peakKw: string;
    loadFactor: string | null;
    pumpHoursPerDay: string | null;
  };
  consent: { purposeKey: 'energy.insight'; version: number; grantedAt: string };
}

export interface EnergyInsightWithdrawnPayload {
  leadId: string;
  building: { ref: string };
  withdrawnAt: string;
  reason: 'owner_opted_out';
}

export interface GetenergyEnvelope<P> {
  eventId: string;
  type: GetenergyEventType;
  version: 1;
  occurredAt: string;
  idempotencyKey: string;
  sourcePlatform: 'getproperty';
  tenantId: string | null;
  correlationId?: string;
  payload: P;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
const DEC = /^\d+(\.\d{1,6})?$/;
const BANDS = ['1-10', '11-30', '31-100', '101+'];
/** Keys a payload may carry — anything else (a name, a phone, a unit) is a contract breach. */
const SHARED_KEYS = ['leadId', 'building', 'window', 'score', 'scoreModel', 'metrics', 'consent'];
const BUILDING_KEYS = ['ref', 'province', 'district', 'tenantType', 'unitCountBand'];
const METRIC_KEYS = [
  'basis',
  'totalKwh',
  'commonAreaKwh',
  'commonAreaShare',
  'peakKw',
  'loadFactor',
  'pumpHoursPerDay',
];

type Check = (ok: boolean, message: string) => void;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
const strOrNull = (v: unknown, max = 100) => v === null || (typeof v === 'string' && v.length <= max);
const decOrNull = (v: unknown) => v === null || (typeof v === 'string' && DEC.test(v));

function checkShared(p: Record<string, unknown>, check: Check): void {
  check(onlyKeys(p, SHARED_KEYS), 'payload: unknown key');
  check(typeof p.leadId === 'string' && UUID.test(p.leadId), 'leadId: uuid');
  const b = p.building;
  check(isObj(b) && onlyKeys(b, BUILDING_KEYS), 'building: object with known keys');
  if (isObj(b)) {
    check(typeof b.ref === 'string' && UUID.test(b.ref), 'building.ref: uuid');
    check(strOrNull(b.province) && strOrNull(b.district), 'building.province / district');
    check(typeof b.tenantType === 'string' && b.tenantType.length <= 40, 'building.tenantType');
    check(typeof b.unitCountBand === 'string' && BANDS.includes(b.unitCountBand), 'building.unitCountBand');
  }
  const w = p.window;
  check(
    isObj(w) &&
      typeof w.from === 'string' &&
      ISO_D.test(w.from) &&
      typeof w.to === 'string' &&
      ISO_D.test(w.to) &&
      Number.isInteger(w.dataDays),
    'window: {from, to, dataDays}',
  );
  check(Number.isInteger(p.score) && (p.score as number) >= 0 && (p.score as number) <= 100, 'score: 0–100');
  check(typeof p.scoreModel === 'string' && p.scoreModel.length <= 20, 'scoreModel');
  const m = p.metrics;
  check(isObj(m) && onlyKeys(m, METRIC_KEYS), 'metrics: object with known keys');
  if (isObj(m)) {
    check(m.basis === 'main' || m.basis === 'sum', 'metrics.basis');
    for (const k of ['totalKwh', 'commonAreaKwh', 'peakKw'])
      check(typeof m[k] === 'string' && DEC.test(m[k]), `metrics.${k}: decimal string`);
    for (const k of ['commonAreaShare', 'loadFactor', 'pumpHoursPerDay'])
      check(decOrNull(m[k]), `metrics.${k}: decimal string or null`);
  }
  const c = p.consent;
  check(
    isObj(c) &&
      c.purposeKey === 'energy.insight' &&
      Number.isInteger(c.version) &&
      typeof c.grantedAt === 'string' &&
      ISO_DT.test(c.grantedAt),
    'consent: {purposeKey, version, grantedAt}',
  );
}

function checkWithdrawn(p: Record<string, unknown>, check: Check): void {
  check(onlyKeys(p, ['leadId', 'building', 'withdrawnAt', 'reason']), 'payload: unknown key');
  check(typeof p.leadId === 'string' && UUID.test(p.leadId), 'leadId: uuid');
  check(
    isObj(p.building) &&
      onlyKeys(p.building, ['ref']) &&
      typeof p.building.ref === 'string' &&
      UUID.test(p.building.ref),
    'building.ref: uuid',
  );
  check(typeof p.withdrawnAt === 'string' && ISO_DT.test(p.withdrawnAt), 'withdrawnAt: date-time');
  check(p.reason === 'owner_opted_out', 'reason');
}

/** Validates an outbound getenergy envelope against the provisional contract. */
export function parseGetenergyEvent(
  raw: unknown,
): { success: true; data: GetenergyEnvelope<unknown> } | { success: false; error: string } {
  const errors: string[] = [];
  const check: Check = (ok, message) => {
    if (!ok) errors.push(message);
  };
  if (!isObj(raw)) return { success: false, error: 'envelope: object' };
  check(typeof raw.eventId === 'string' && UUID.test(raw.eventId), 'eventId: uuid');
  check(GETENERGY_EVENT_TYPES.includes(raw.type as GetenergyEventType), 'type: energy.insight.*');
  check(raw.version === 1, 'version: 1');
  check(typeof raw.occurredAt === 'string' && ISO_DT.test(raw.occurredAt), 'occurredAt: date-time');
  check(
    typeof raw.idempotencyKey === 'string' &&
      raw.idempotencyKey.length > 0 &&
      raw.idempotencyKey.length <= 300,
    'idempotencyKey',
  );
  check(raw.sourcePlatform === 'getproperty', 'sourcePlatform: getproperty');
  check(raw.tenantId === null || (typeof raw.tenantId === 'string' && UUID.test(raw.tenantId)), 'tenantId');
  if (!isObj(raw.payload)) errors.push('payload: object');
  else if (raw.type === 'energy.insight.shared') checkShared(raw.payload, check);
  else if (raw.type === 'energy.insight.withdrawn') checkWithdrawn(raw.payload, check);
  return errors.length
    ? { success: false, error: errors.join('; ') }
    : { success: true, data: raw as unknown as GetenergyEnvelope<unknown> };
}
