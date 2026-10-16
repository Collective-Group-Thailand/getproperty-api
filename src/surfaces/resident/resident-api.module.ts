import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/**
 * `/v1/resident/*` (contract §2; D-151, D-154) — consumed by the separate `getproperty-liff` repo.
 * Business controllers of this surface are added by their deliverables.
 */
@Module({
  controllers: [systemPingController(SURFACES.resident)],
})
export class ResidentApiModule {}
