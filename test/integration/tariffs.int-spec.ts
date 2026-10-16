import { utilityCharge } from '@modules/tariffs/tariff-math';
import { UtilityTariffRepository } from '@modules/tariffs/utility-tariff.repository';

import { createIntDatabase, type IntDatabase } from '../support/int-db';

describe('utility tariff versions (seeded) + tariff math (D-140, D-021a)', () => {
  let db: IntDatabase;
  let repo: UtilityTariffRepository;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_tariff' });
    repo = new UtilityTariffRepository(db.prisma());
  });
  afterAll(async () => {
    await db.drop();
  });

  it('only published versions count by default; the seeded ones are entered (unverified)', async () => {
    expect(await repo.at('pea', '1.1.2', new Date('2025-06-15'))).toBeNull();
  });

  it('loads the version in force on a date and computes the effective average rate', async () => {
    const v = await repo.at('pea', '1.1.2', new Date('2025-06-15'), ['entered']);
    expect(v).toMatchObject({ tariffCode: '1.1.2', state: 'entered', needsCheck: false });
    expect(v!.effectiveFrom.toISOString().slice(0, 10)).toBe('2025-05-01');
    expect(utilityCharge(v!.structure, { units: '150' })).toMatchObject({
      totalExVat: '541.46',
      effectiveAverageRate: '3.6097',
    });

    const current = await repo.at('mea', '1.1.2', new Date('2026-10-17'), ['entered']);
    expect(current).toMatchObject({ needsCheck: true });
    expect(current!.structure.ft?.pricePerUnit).toBe('0.1623');
    expect(utilityCharge(current!.structure, { units: '400' }).effectiveAverageRate).toBe('3.8031');
  });

  it('periods whose Ft could not be confirmed have no version (no cap reference)', async () => {
    expect(await repo.at('pea', '1.1.1', new Date('2026-03-01'), ['entered'])).toBeNull();
  });

  it('water tariffs load and flag every unverified value', async () => {
    const v = await repo.at('mwa', 'residential', new Date('2026-10-17'), ['entered']);
    expect(v!.structure.unit).toBe('m3');
    expect(utilityCharge(v!.structure, { units: '35' })).toMatchObject({
      totalExVat: '305.15',
      needsCheck: expect.arrayContaining(['minimumCharge (not entered)']),
    });
  });
});
