import { Prisma } from '@generated/prisma/client';

import { districtName, provinceEn, stationKey, stationName } from './area-names';
import { rentBand } from './listing-insights.service';

/** Area pages (D-272): one page per district or station however owners write it, with an ASCII slug. */
describe('area names (D-272)', () => {
  it('matches districts with or without เขต / อำเภอ and gives the English name and slug', () => {
    expect(districtName('เขตพญาไท', 'กรุงเทพมหานคร')).toEqual({ en: 'Phaya Thai', slug: 'phaya-thai' });
    expect(districtName('อำเภอปากเกร็ด', 'นนทบุรี')).toEqual({ en: 'Pak Kret', slug: 'pak-kret' });
    expect(provinceEn('กรุงเทพมหานคร')).toBe('Bangkok');
  });

  it('gives an unknown district a stable hashed slug and keeps its Thai name', () => {
    const a = districtName('เมืองเชียงใหม่', 'เชียงใหม่');
    expect(a.slug).toMatch(/^area-[a-z0-9]{7}$/);
    expect(a.en).toBe('เมืองเชียงใหม่');
    expect(districtName('อำเภอเมืองเชียงใหม่', 'เชียงใหม่').slug).toBe(a.slug);
  });

  it('strips the system and สถานี from station names; a station sharing a district name gets -station', () => {
    expect(stationKey('BTS อารีย์')).toBe('อารีย์');
    expect(stationKey('สถานีรถไฟฟ้า MRT ลาดพร้าว')).toBe('ลาดพร้าว');
    expect(stationName('อารีย์ BTS')).toMatchObject({ en: 'Ari', slug: 'ari', system: 'BTS' });
    expect(stationName('MRT ลาดพร้าว')).toMatchObject({ slug: 'lat-phrao-station', system: 'MRT' });
    expect(stationName('สถานีบางกระสอ').slug).toMatch(/^station-[a-z0-9]{7}$/);
  });

  it('computes the rent band like percentile_cont', () => {
    const band = rentBand(
      ['12000', '13000', '14000', '14500', '15000', '16000', '17000', '18000'].map(
        (v) => new Prisma.Decimal(v),
      ),
    );
    expect(band).toEqual({ p25: '13750.00', p50: '14750.00', p75: '16250.00' });
    expect(rentBand([])).toBeNull();
  });
});
