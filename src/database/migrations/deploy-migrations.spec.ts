import {
  applyOptionalTimescale,
  migrateCore,
  MIN_ASSET_CORE_VERSION,
  TIMESCALE_COMPRESSION_STEP,
  TIMESCALE_STEP,
  TIMESCALE_STEPS,
  versionAtLeast,
} from './deploy-migrations';

describe('migrate command — asset-core version guard (T-3, ADR-0013)', () => {
  it('compares plain semantic versions', () => {
    expect(versionAtLeast('0.4.0', '0.4.0')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.4.0')).toBe(true);
    expect(versionAtLeast('1.0.0', '0.4.0')).toBe(true);
    expect(versionAtLeast('0.3.9', '0.4.0')).toBe(false);
  });

  it('refuses an asset-core older than the first runner that migrates as a product login', async () => {
    const db = { query: jest.fn() };
    await expect(migrateCore(db, () => undefined, '0.3.0')).rejects.toThrow(MIN_ASSET_CORE_VERSION);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('optional TimescaleDB steps (D-234, T-12)', () => {
  /** A database stand-in: records the optional ledger and the SQL it ran; TimescaleDB installed or not. */
  function fakeDb(installed: boolean) {
    const ledger = new Map<string, string>();
    const ran: string[] = [];
    const db = {
      query: (text: string, params?: unknown[]) => {
        if (text.includes('FROM pg_extension'))
          return Promise.resolve({ rows: [{ installed, available: installed, superuser: false }] });
        if (text.includes('SELECT name, checksum FROM public."_optional_migrations"'))
          return Promise.resolve({
            rows: [...ledger].map(([name, checksum]) => ({ name, checksum })),
          });
        if (text.startsWith('INSERT INTO public."_optional_migrations"')) {
          ledger.set(String(params![0]), String(params![1]));
          return Promise.resolve({ rows: [] });
        }
        ran.push(text.trim());
        return Promise.resolve({ rows: [] });
      },
    };
    return { db, ledger, ran };
  }

  it('applies 001 then 002 once each, in their own transactions; then reports already_applied', async () => {
    const { db, ledger, ran } = fakeDb(true);
    expect(await applyOptionalTimescale(db, 'on')).toBe('applied');
    expect([...ledger.keys()]).toEqual([...TIMESCALE_STEPS]);
    expect(ran.filter((r) => r === 'BEGIN')).toHaveLength(2);
    expect(ran.some((r) => r.includes('create_hypertable'))).toBe(true);
    expect(
      ran.some((r) => r.includes('add_compression_policy') && r.includes('DISABLE ROW LEVEL SECURITY')),
    ).toBe(true);
    expect(await applyOptionalTimescale(db, 'on')).toBe('already_applied');
  });

  it('applies only the new step on a database that has step 1, and refuses an edited step', async () => {
    const { db, ledger } = fakeDb(true);
    await applyOptionalTimescale(db, 'auto');
    ledger.delete(TIMESCALE_COMPRESSION_STEP);
    expect(await applyOptionalTimescale(db, 'auto')).toBe('applied');
    ledger.set(TIMESCALE_STEP, 'f'.repeat(64));
    await expect(applyOptionalTimescale(db, 'auto')).rejects.toThrow(/modified after it was applied/);
  });

  it('without the extension: skipped (auto) or refused (on)', async () => {
    expect(await applyOptionalTimescale(fakeDb(false).db, 'auto')).toBe('skipped_unavailable');
    await expect(applyOptionalTimescale(fakeDb(false).db, 'on')).rejects.toThrow(/not available/);
  });
});
