import {
  energyMetrics,
  energyScore,
  type HourlyRow,
  penalty,
  type ScoreModel,
  unitCountBand,
} from './energy-score';

const MODEL: ScoreModel = {
  version: 'v1',
  commonShare: { from: 0.2, to: 0.5, points: 40 },
  lowLoadFactor: { from: 0.5, to: 0.85, points: 30 },
  pumpHoursPerDay: { from: 8, to: 20, points: 30 },
  pumpLabelPattern: 'pump|ปั๊ม',
  pumpOnKwhPerHour: 0.1,
};

/** `days` Bangkok days from 2026-10-01: units flat `unitKw`, common area `commonKw`, a pump running `pumpHours` a day. */
function building(
  days: number,
  unitKw: number,
  commonKw: number,
  pumpHours: number,
  peakAt?: number,
): HourlyRow[] {
  const rows: HourlyRow[] = [];
  const start = Date.UTC(2026, 8, 30, 17); // 2026-10-01 00:00 Bangkok
  for (let h = 0; h < days * 24; h += 1) {
    const bucket = new Date(start + h * 3_600_000);
    rows.push({ bucket, purpose: 'unit', label: null, kwh: h === peakAt ? unitKw * 4 : unitKw });
    rows.push({ bucket, purpose: 'common_area', label: 'ไฟทางเดิน', kwh: commonKw });
    rows.push({ bucket, purpose: 'common_area', label: 'ปั๊มน้ำ', kwh: h % 24 < pumpHours ? 1.5 : 0 });
  }
  return rows;
}

describe('energy score (G9, D-301, O-036)', () => {
  it('penalties are linear between the band edges', () => {
    expect(penalty(0.1, MODEL.commonShare)).toBe(0);
    expect(penalty(0.35, MODEL.commonShare)).toBeCloseTo(20);
    expect(penalty(0.9, MODEL.commonShare)).toBe(40);
    expect(penalty(null, MODEL.commonShare)).toBe(0);
  });

  it('computes building-level metrics (sum basis without main meters, pump hours from labelled meters)', () => {
    const m = energyMetrics(building(20, 10, 2, 6), MODEL);
    expect(m.dataDays).toBe(20);
    expect(m.basis).toBe('sum');
    // per hour: 10 + 2 + pump (1.5 for 6 of 24 hours)
    expect(m.totalKwh).toBeCloseTo(20 * (24 * 12 + 6 * 1.5), 3);
    expect(m.commonAreaShare).toBeCloseTo((20 * (24 * 2 + 9)) / (20 * (24 * 12 + 9)), 3);
    expect(m.peakKw).toBe(13.5);
    expect(m.pumpHoursPerDay).toBe(6);
  });

  it('uses the main meters as the total when they report', () => {
    const rows = building(15, 10, 2, 0);
    for (const r of rows.filter((x) => x.purpose === 'unit'))
      rows.push({ bucket: r.bucket, purpose: 'main', label: null, kwh: 14 });
    const m = energyMetrics(rows, MODEL);
    expect(m.basis).toBe('main');
    expect(m.totalKwh).toBeCloseTo(15 * 24 * 14, 3);
    expect(m.loadFactor).toBe(1);
  });

  it('scores a good building high and a wasteful one low; no score without enough days', () => {
    const good = energyScore(building(30, 10, 1, 4), MODEL, 14);
    expect(good.reason).toBe('ok');
    expect(good.score).toBe(100);
    const bad = energyScore(building(30, 2, 3, 22, 5), MODEL, 14);
    expect(bad.score).toBeLessThan(50);
    expect(bad.penalties.pumpHours).toBe(30);
    expect(bad.penalties.commonShare).toBeGreaterThan(0);
    const short = energyScore(building(5, 10, 1, 4), MODEL, 14);
    expect(short).toMatchObject({ score: null, reason: 'insufficient_data' });
    expect(energyScore([], MODEL, 1)).toMatchObject({ score: null, reason: 'insufficient_data' });
  });

  it('shares only a unit-count band', () => {
    expect([1, 10, 11, 30, 31, 100, 101].map(unitCountBand)).toEqual([
      '1-10',
      '1-10',
      '11-30',
      '11-30',
      '31-100',
      '31-100',
      '101+',
    ]);
  });
});
