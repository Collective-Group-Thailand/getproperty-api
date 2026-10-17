import { utilityCharge } from '@core/utility-tariffs/tariff-math';
import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import { UtilityTariffsService } from '@core/utility-tariffs/utility-tariffs.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

describe('utility tariff versions (seeded) + tariff math (D-140, D-021a)', () => {
  let db: IntDatabase;
  let t: IntApp;

  /** The seeded (entered, unverified) version of a tariff in force on a date, read directly. */
  async function entered(provider: string, tariffCode: string, date: string) {
    const { rows } = await db.admin.query<{
      structure: UtilityTariffStructure;
      effective_from: string;
      needs_check: boolean;
    }>(
      `SELECT v.structure, v.effective_from::text AS effective_from, v.needs_check
         FROM platform.utility_tariff_version v JOIN platform.utility_tariff t ON t.id = v.utility_tariff_id
        WHERE t.provider = $1 AND t.tariff_code = $2 AND v.state = 'entered'
          AND v.effective_from <= $3::date AND (v.effective_to IS NULL OR v.effective_to > $3::date)`,
      [provider, tariffCode, date],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_tariff' });
    t = await createIntApp(db);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('only published versions are the cap reference; the seeded ones are entered (unverified)', async () => {
    const tariffs = t.app.get(UtilityTariffsService);
    expect(await tariffs.at('pea', '1.1.2', new Date('2025-06-15'))).toBeNull();
    expect(await tariffs.at('mea', '1.1.2', new Date('2026-10-17'))).toBeNull();
  });

  it('loads the version in force on a date and computes the effective average rate', async () => {
    const v = await entered('pea', '1.1.2', '2025-06-15');
    expect(v).toMatchObject({ effective_from: '2025-05-01', needs_check: false });
    expect(utilityCharge(v!.structure, { units: '150' })).toMatchObject({
      totalExVat: '541.46',
      effectiveAverageRate: '3.6097',
    });

    const current = await entered('mea', '1.1.2', '2026-10-17');
    expect(current).toMatchObject({ needs_check: true });
    expect(current!.structure.ft?.pricePerUnit).toBe('0.1623');
    expect(utilityCharge(current!.structure, { units: '400' }).effectiveAverageRate).toBe('3.8031');
  });

  it('periods whose Ft could not be confirmed have no version (no cap reference)', async () => {
    expect(await entered('pea', '1.1.1', '2026-03-01')).toBeNull();
  });

  it('water tariffs load and flag every unverified value', async () => {
    const v = await entered('mwa', 'residential', '2026-10-17');
    expect(v!.structure.unit).toBe('m3');
    expect(utilityCharge(v!.structure, { units: '35' })).toMatchObject({
      totalExVat: '305.15',
      needsCheck: expect.arrayContaining(['minimumCharge (not entered)']),
    });
  });
});
