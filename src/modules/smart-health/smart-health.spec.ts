import Decimal from 'decimal.js';

import { lossNumbers, lossSuspects, type PositionInput, type SuspectRules } from './loss-rules';
import { meterHealthOf, timeDurationMs } from './meter-health.service';

const RULES: SuspectRules = {
  nightFrom: '01:00',
  nightTo: '05:00',
  nightFlowM3Per15m: '0.010',
  anomalySigma: '2',
  trailingPeriods: 6,
};

const pos = (over: Partial<PositionInput>): PositionInput => ({
  key: 'unit:A-101',
  unitId: 'u1',
  unitNo: 'A-101',
  assetItemIds: ['m1'],
  purpose: 'unit',
  units: new Decimal(100),
  occupied: true,
  estimated: false,
  stale: false,
  nightFlowNights: 0,
  history: [],
  ...over,
});

describe('loss (D-032)', () => {
  it('loss = invoice − unit-billed − common area, in units, % and THB', () => {
    const n = lossNumbers(
      new Decimal('1000'),
      [
        pos({ units: new Decimal('600') }),
        pos({ key: 'common_area:CA', purpose: 'common_area', units: new Decimal('300') }),
      ],
      new Decimal('4.6189'),
    );
    expect(n.unitBilledUnits.toFixed(3)).toBe('600.000');
    expect(n.commonAreaUnits.toFixed(3)).toBe('300.000');
    expect(n.lossUnits.toFixed(3)).toBe('100.000');
    expect(n.lossPct!.toFixed(4)).toBe('10.0000');
    expect(n.lossThb.toFixed(2)).toBe('461.89');
  });

  it('ranks suspects: vacant usage, zero use while occupied, estimates, night flow, stale, anomaly', () => {
    const s = lossSuspects(
      'water',
      [
        pos({ key: 'unit:A-101', units: new Decimal(0) }),
        pos({ key: 'unit:A-102', unitId: 'u2', unitNo: 'A-102', occupied: false, units: new Decimal(20) }),
        pos({ key: 'unit:A-103', unitId: 'u3', unitNo: 'A-103', estimated: true }),
        pos({ key: 'unit:A-104', unitId: 'u4', unitNo: 'A-104', nightFlowNights: 6 }),
        pos({ key: 'unit:A-105', unitId: 'u5', unitNo: 'A-105', stale: true }),
        pos({
          key: 'unit:A-106',
          unitId: 'u6',
          unitNo: 'A-106',
          units: new Decimal(300),
          history: [100, 102, 98, 101].map((v) => new Decimal(v)),
        }),
      ],
      RULES,
    );
    expect(s.map((x) => `${x.kind}:${x.key}`)).toEqual([
      'consumption_anomaly:unit:A-106',
      'night_water_flow:unit:A-104',
      'zero_consumption_occupied:unit:A-101',
      'usage_while_vacant:unit:A-102',
      'estimated_reading:unit:A-103',
      'stale_meter:unit:A-105',
    ]);
    expect(lossSuspects('electric', [pos({ nightFlowNights: 9 })], RULES)).toEqual([]);
  });
});

describe('meter health (D-034)', () => {
  const rules = { electric: 'PT2H', water: 'PT24H', silent: 'P3D' };
  const now = new Date('2026-10-17T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('parses time durations', () => {
    expect(timeDurationMs('PT2H')).toBe(7_200_000);
    expect(timeDurationMs('PT30M')).toBe(1_800_000);
    expect(timeDurationMs('P3D')).toBe(259_200_000);
  });

  it('ok → stale → silent per utility; no channel → no_device; unknown before data', () => {
    const base = { hasChannel: true, utility: 'electric' as const, since: ago(86_400_000), now, rules };
    expect(meterHealthOf({ ...base, lastSeenAt: ago(3_600_000) })).toBe('ok');
    expect(meterHealthOf({ ...base, lastSeenAt: ago(3 * 3_600_000) })).toBe('stale');
    expect(meterHealthOf({ ...base, utility: 'water', lastSeenAt: ago(3 * 3_600_000) })).toBe('ok');
    expect(meterHealthOf({ ...base, lastSeenAt: ago(4 * 86_400_000) })).toBe('silent');
    expect(meterHealthOf({ ...base, hasChannel: false, lastSeenAt: null })).toBe('no_device');
    expect(meterHealthOf({ ...base, since: ago(60_000), lastSeenAt: null })).toBe('unknown');
  });
});
