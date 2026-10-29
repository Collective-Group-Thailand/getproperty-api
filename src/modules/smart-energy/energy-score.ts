/**
 * Building energy score (G9, E15, D-301; model O-036) — pure. Reads hourly electricity rollups of a building
 * (`smart.telemetry_1h`, insight only — never billing, D-030) grouped by meter purpose and common-area label, and
 * computes building-level aggregates: total and common-area kWh, the common-area share, the peak hourly demand, the
 * load factor and the pump running hours per day. The score is 100 − linear penalties from the setting
 * `energy.insight.score_model`. Everything here is building-level: no unit, resident or per-meter figure leaves.
 */

export interface HourlyRow {
  /** Start of the hour (UTC instant). */
  bucket: Date;
  purpose: 'unit' | 'common_area' | 'main';
  label: string | null;
  /** kWh used in that hour by the meters of this purpose / label. */
  kwh: number;
}

export interface Band {
  from: number;
  to: number;
  points: number;
}

export interface ScoreModel {
  version: string;
  commonShare: Band;
  lowLoadFactor: Band;
  pumpHoursPerDay: Band;
  pumpLabelPattern: string;
  pumpOnKwhPerHour: number;
}

export interface EnergyMetrics {
  dataDays: number;
  /** Main meters when they reported, else unit + common-area meters. */
  basis: 'main' | 'sum';
  totalKwh: number;
  commonAreaKwh: number;
  commonAreaShare: number | null;
  peakKw: number;
  averageKw: number;
  loadFactor: number | null;
  pumpHoursPerDay: number | null;
}

export interface EnergyScore {
  score: number | null;
  reason: 'ok' | 'insufficient_data';
  metrics: EnergyMetrics;
  penalties: { commonShare: number; lowLoadFactor: number; pumpHours: number };
  modelVersion: string;
}

const BKK_MS = 7 * 3_600_000;
const bangkokDay = (d: Date) => new Date(d.getTime() + BKK_MS).toISOString().slice(0, 10);
const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** 0 below `from`, `points` above `to`, linear between. */
export function penalty(value: number | null, band: Band): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const t = (value - band.from) / (band.to - band.from);
  return band.points * Math.min(1, Math.max(0, t));
}

export function energyMetrics(rows: HourlyRow[], model: ScoreModel): EnergyMetrics {
  const days = new Set(rows.map((r) => bangkokDay(r.bucket)));
  const hasMain = rows.some((r) => r.purpose === 'main' && r.kwh > 0);
  const basis: 'main' | 'sum' = hasMain ? 'main' : 'sum';
  const inBasis = (r: HourlyRow) => (hasMain ? r.purpose === 'main' : r.purpose !== 'main');
  const hourly = new Map<number, number>();
  let total = 0;
  let common = 0;
  for (const r of rows) {
    if (r.purpose === 'common_area') common += r.kwh;
    if (!inBasis(r)) continue;
    total += r.kwh;
    hourly.set(r.bucket.getTime(), (hourly.get(r.bucket.getTime()) ?? 0) + r.kwh);
  }
  const peak = hourly.size ? Math.max(...hourly.values()) : 0;
  const average = hourly.size ? total / hourly.size : 0;
  let pattern: RegExp;
  try {
    pattern = new RegExp(model.pumpLabelPattern, 'i');
  } catch {
    pattern = /pump|ปั๊ม/i;
  }
  const pumpRows = rows.filter((r) => r.purpose === 'common_area' && r.label && pattern.test(r.label));
  const pumpHours = new Map<number, number>();
  for (const r of pumpRows)
    pumpHours.set(r.bucket.getTime(), (pumpHours.get(r.bucket.getTime()) ?? 0) + r.kwh);
  const pumpOn = [...pumpHours.values()].filter((k) => k >= model.pumpOnKwhPerHour).length;
  return {
    dataDays: days.size,
    basis,
    totalKwh: round(total, 3),
    commonAreaKwh: round(common, 3),
    commonAreaShare: total > 0 ? round(Math.min(1, common / total), 4) : null,
    peakKw: round(peak, 3),
    averageKw: round(average, 3),
    loadFactor: peak > 0 ? round(average / peak, 4) : null,
    pumpHoursPerDay: pumpRows.length && days.size ? round(pumpOn / days.size, 2) : null,
  };
}

/** The score of a building, or no score when fewer than `minDays` days carried data. */
export function energyScore(rows: HourlyRow[], model: ScoreModel, minDays: number): EnergyScore {
  const metrics = energyMetrics(rows, model);
  const penalties = {
    commonShare: penalty(metrics.commonAreaShare, model.commonShare),
    lowLoadFactor: penalty(metrics.loadFactor === null ? null : 1 - metrics.loadFactor, model.lowLoadFactor),
    pumpHours: penalty(metrics.pumpHoursPerDay, model.pumpHoursPerDay),
  };
  if (metrics.dataDays < minDays || metrics.totalKwh <= 0)
    return {
      score: null,
      reason: 'insufficient_data',
      metrics,
      penalties: { commonShare: 0, lowLoadFactor: 0, pumpHours: 0 },
      modelVersion: model.version,
    };
  const raw = 100 - penalties.commonShare - penalties.lowLoadFactor - penalties.pumpHours;
  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    reason: 'ok',
    metrics,
    penalties: {
      commonShare: round(penalties.commonShare, 1),
      lowLoadFactor: round(penalties.lowLoadFactor, 1),
      pumpHours: round(penalties.pumpHours, 1),
    },
    modelVersion: model.version,
  };
}

/** Coarse unit-count band shared with getenergy instead of the exact number (minimisation). */
export function unitCountBand(units: number): '1-10' | '11-30' | '31-100' | '101+' {
  if (units <= 10) return '1-10';
  if (units <= 30) return '11-30';
  if (units <= 100) return '31-100';
  return '101+';
}

/** A number as a decimal string with `digits` decimals (contract payloads carry no floats). */
export const decimal = (x: number, digits = 3): string => x.toFixed(digits);
