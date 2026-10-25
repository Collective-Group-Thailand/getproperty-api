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
    expect(surfaceOfPath('/v1/resident/invoices')).toBe(SURFACES.resident);
    expect(surfaceOfPath('/v1/technician/work-orders')).toBe(SURFACES.technician);
    expect(surfaceOfPath('/v1/tenant/ping')).toBeUndefined();
    expect(SURFACE_AUDIENCE.owner).toBe('operator');
    expect(SURFACE_AUDIENCE.staff).toBe('operator');
    expect(SURFACE_AUDIENCE.resident).toBe('resident');
    expect(SURFACE_AUDIENCE.technician).toBe('technician');
    expect(SURFACE_AUDIENCE.admin).toBe('platform');
    expect(SURFACE_AUDIENCE.device).toBe('device');
    expect(surfaceOfPath('/v1/prospect/enquiries')).toBe(SURFACES.prospect);
    expect(SURFACE_AUDIENCE.prospect).toBe('prospect');
    expect(SURFACE_AUDIENCE.auth).toBeNull();
  });
});
