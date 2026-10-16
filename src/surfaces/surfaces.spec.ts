import { SURFACE_AUDIENCE, surfaceOfPath, SURFACES } from './surfaces';
import { SURFACE_NAMES, SurfaceName } from './system-ping.dto';

describe('surfaces registry', () => {
  it('keeps the SurfaceName enum in step with SURFACES', () => {
    expect(Object.values(SurfaceName).sort()).toEqual([...SURFACE_NAMES].sort());
  });

  it('maps paths to surfaces and audiences (contract §2)', () => {
    expect(surfaceOfPath('/v1/owner/bills')).toBe(SURFACES.owner);
    expect(surfaceOfPath('/webhooks/kbank')).toBe(SURFACES.webhooks);
    expect(surfaceOfPath('/health')).toBeUndefined();
    expect(SURFACE_AUDIENCE.owner).toBe('org');
    expect(SURFACE_AUDIENCE.staff).toBe('org');
    expect(SURFACE_AUDIENCE.tenant).toBe('tenant');
    expect(SURFACE_AUDIENCE.admin).toBe('platform');
    expect(SURFACE_AUDIENCE.device).toBe('device');
    expect(SURFACE_AUDIENCE.auth).toBeNull();
  });
});
