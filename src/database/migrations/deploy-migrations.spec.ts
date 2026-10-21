import { migrateCore, MIN_ASSET_CORE_VERSION, versionAtLeast } from './deploy-migrations';

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
