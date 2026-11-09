import { CONTRACT_FIXTURES_V2 } from '@collective/asset-core/contracts';
import Decimal from 'decimal.js';

import {
  type HandoverPayload,
  handoverProblems,
  handoverTotals,
  minimisePayload,
  splitByShares,
} from './handover-plan';

const fixture = () =>
  minimisePayload(
    structuredClone(CONTRACT_FIXTURES_V2['building.handover.requested']!.payload as Record<string, unknown>),
  );

describe('developer handover plan (J3.2, D-333)', () => {
  it('drops the shared-key PII envelopes of the parties', () => {
    const p = fixture();
    expect(p.parties[0]).toEqual({ ref: 'p-1', type: 'person', displayName: 'ผู้ซื้อ ตัวอย่าง' });
    expect(JSON.stringify(p)).not.toContain('"enc"');
  });

  it('totals the finance block', () => {
    expect(handoverTotals(fixture())).toMatchObject({
      units: 1,
      parties: 1,
      ownerships: 1,
      unitsWithMoney: 1,
      advanceCommonFees: '14400.00',
      firstFundContributions: '16250.00',
      receivablesBroughtForward: '1200.00',
      receivableItems: 1,
    });
  });

  it('a unit holding money needs an owner on the as-of date; unknown refs and shares above 100 % are problems', () => {
    const p: HandoverPayload = fixture();
    expect(handoverProblems(p)).toEqual([]);
    p.unitOwnerships = [{ unitRef: 'u-101', partyRef: 'p-x', sharePct: '60', validFrom: '2026-11-15' }];
    p.unitOwnerships.push({ unitRef: 'u-101', partyRef: 'p-1', sharePct: '50', validFrom: '2026-12-01' });
    expect(
      handoverProblems(p)
        .map((x) => x.code)
        .sort(),
    ).toEqual(['owner_missing', 'party_unknown', 'shares_exceeded']);
  });

  it('splits by share half-up with the satang remainder on the largest share; the parts sum exactly', () => {
    const parts = splitByShares('100.01', [
      { key: 'b', sharePct: '60' },
      { key: 'a', sharePct: '40' },
    ]);
    expect(parts.get('a')!.toFixed(2)).toBe('40.00');
    expect(parts.get('b')!.toFixed(2)).toBe('60.01');
    const thirds = splitByShares('100.00', [
      { key: 'a', sharePct: '33.3333' },
      { key: 'b', sharePct: '33.3333' },
      { key: 'c', sharePct: '33.3334' },
    ]);
    expect([...thirds.values()].reduce((s, v) => s.plus(v), new Decimal(0)).toFixed(2)).toBe('100.00');
    expect(thirds.get('c')!.toFixed(2)).toBe('33.34');
  });
});
