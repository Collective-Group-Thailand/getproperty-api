import { ApiProperty } from '@nestjs/swagger';

import { type Surface, SURFACES } from './surfaces';

export enum SurfaceName {
  Auth = 'auth',
  Owner = 'owner',
  Staff = 'staff',
  Resident = 'resident',
  Technician = 'technician',
  Prospect = 'prospect',
  Admin = 'admin',
  Device = 'device',
  Webhooks = 'webhooks',
  Public = 'public',
}

/** Answer of `GET /v1/{surface}/ping` — proves the surface, its versioning and its contract wiring. */
export class SystemPingDto {
  @ApiProperty({ enum: SurfaceName, enumName: 'SurfaceName', example: SurfaceName.Owner })
  surface!: SurfaceName;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-01T00:15:00+07:00',
    description: 'Server time in Asia/Bangkok',
  })
  serverTime!: string;

  @ApiProperty({ example: '0.1.0', description: 'API version (package.json)' })
  version!: string;
}

export const pingExample = (surface: Surface): SystemPingDto => ({
  surface: surface as SurfaceName,
  serverTime: '2026-11-01T00:15:00+07:00',
  version: '0.1.0',
});

// Keep the enum and the surface registry in step (a unit test checks both directions).
export const SURFACE_NAMES: readonly Surface[] = Object.values(SURFACES);
