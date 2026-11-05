import {
  distanceMetres,
  insideGeofence,
  matchPlate,
  normaliseLprPlate,
  openRetryAfter,
  type PlateCandidate,
  sosCancellable,
  visitActiveAt,
} from './gate-hardware-rules';

const BKK = 'กรุงเทพมหานคร';
const car = (
  id: string,
  unitId: string,
  source: PlateCandidate['source'],
  number = '1234',
  province = BKK,
  category = '1กข',
): PlateCandidate => ({ id, unitId, source, plate: { category, number, province } });

describe('J4.2 gate hardware rules (D-316, D-317, D-328)', () => {
  it('normalises camera reads: Thai numerals, spaces, dashes; refuses what cannot be a Thai plate', () => {
    expect(normaliseLprPlate({ category: '๑ กข', number: '๑๒-๓๔', province: '  กรุงเทพมหานคร ' })).toEqual({
      category: '1กข',
      number: '1234',
      province: BKK,
    });
    expect(normaliseLprPlate({ category: 'กข', number: '0012' })).toEqual({
      category: 'กข',
      number: '0012',
      province: null,
    });
    expect(normaliseLprPlate({ category: '12', number: '1234' })).toBeNull(); // no consonant
    expect(normaliseLprPlate({ category: 'AB', number: '1234' })).toBeNull();
    expect(normaliseLprPlate({ category: 'กข', number: '12345' })).toBeNull();
    expect(normaliseLprPlate({ category: 'กข', number: '' })).toBeNull();
  });

  it('matches category + number (+ province when read); a missing province matches one unit only', () => {
    const a = car('v1', 'u1', 'resident_vehicle');
    const b = car('v2', 'u2', 'remembered_vehicle', '1234', 'เชียงใหม่');
    expect(matchPlate({ category: '1กข', number: '1234', province: BKK }, [a, b])).toEqual({
      match: 'resident_vehicle',
      candidate: a,
    });
    expect(matchPlate({ category: '1กข', number: '1234', province: null }, [a, b])).toEqual({
      match: 'ambiguous',
    });
    expect(matchPlate({ category: '1กข', number: '1234', province: null }, [a])).toEqual({
      match: 'resident_vehicle',
      candidate: a,
    });
    expect(matchPlate({ category: '1กข', number: '9999', province: BKK }, [a, b])).toEqual({ match: 'none' });
    expect(matchPlate({ category: '2กข', number: '1234', province: BKK }, [a])).toEqual({ match: 'none' });
    // the unit's own car wins over a remembered car of the same unit
    const r = car('v3', 'u1', 'remembered_vehicle');
    expect(matchPlate({ category: '1กข', number: '1234', province: BKK }, [r, a])).toEqual({
      match: 'resident_vehicle',
      candidate: a,
    });
    expect(matchPlate({ category: '1กข', number: '1234', province: BKK }, [r])).toEqual({
      match: 'remembered_vehicle',
      candidate: r,
    });
  });

  it('geofence: distance + radius + accuracy credit capped at 100 m', () => {
    const estate = { lat: 13.69, lng: 100.685 };
    expect(distanceMetres(estate, estate)).toBe(0);
    // ~ 111 m per 0.001° latitude
    const near = { lat: 13.692, lng: 100.685 };
    expect(Math.round(distanceMetres(estate, near))).toBeGreaterThan(215);
    expect(Math.round(distanceMetres(estate, near))).toBeLessThan(230);
    expect(insideGeofence(estate, near, 300)).toBe(true);
    expect(insideGeofence(estate, { lat: 13.6935, lng: 100.685 }, 300)).toBe(false); // ~389 m
    expect(insideGeofence(estate, { lat: 13.6935, lng: 100.685, accuracyM: 95 }, 300)).toBe(true);
    // a 5 km accuracy is credited 100 m only
    expect(insideGeofence(estate, { lat: 13.7, lng: 100.685, accuracyM: 5000 }, 300)).toBe(false);
  });

  it('per-gate interval: seconds until the next open', () => {
    const now = new Date('2026-11-05T11:00:10.000Z');
    expect(openRetryAfter(null, now, 3)).toBe(0);
    expect(openRetryAfter(new Date('2026-11-05T11:00:09.000Z'), now, 3)).toBe(2);
    expect(openRetryAfter(new Date('2026-11-05T11:00:08.500Z'), now, 3)).toBe(2);
    expect(openRetryAfter(new Date('2026-11-05T11:00:07.000Z'), now, 3)).toBe(0);
  });

  it('SOS: visits inside at the time and the cancel window', () => {
    const at = new Date('2026-11-05T12:00:00Z');
    const t = (iso: string) => new Date(iso);
    expect(visitActiveAt({ enteredAt: t('2026-11-05T11:00:00Z'), exitedAt: null }, at, 30)).toBe(true);
    expect(
      visitActiveAt({ enteredAt: t('2026-11-05T11:00:00Z'), exitedAt: t('2026-11-05T11:45:00Z') }, at, 30),
    ).toBe(true);
    expect(
      visitActiveAt({ enteredAt: t('2026-11-05T11:00:00Z'), exitedAt: t('2026-11-05T11:20:00Z') }, at, 30),
    ).toBe(false);
    expect(visitActiveAt({ enteredAt: t('2026-11-05T12:05:00Z'), exitedAt: null }, at, 30)).toBe(false);
    expect(visitActiveAt({ enteredAt: null, exitedAt: null }, at, 30)).toBe(false);
    expect(sosCancellable(at, new Date(at.getTime() + 30_000), 30)).toBe(true);
    expect(sosCancellable(at, new Date(at.getTime() + 30_001), 30)).toBe(false);
  });
});
