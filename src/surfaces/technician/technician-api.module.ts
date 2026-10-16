import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/**
 * `/v1/technician/*` (contract §2; D-151, D-154) — external technicians in `getproperty-liff`.
 * Placeholder (ping only) until service requests and work orders land (B5, R2).
 */
@Module({
  controllers: [systemPingController(SURFACES.technician)],
})
export class TechnicianApiModule {}
