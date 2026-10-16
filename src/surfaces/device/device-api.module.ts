import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/v1/device/*` (contract §2). Business controllers of this surface are added by their deliverables. */
@Module({
  controllers: [systemPingController(SURFACES.device)],
})
export class DeviceApiModule {}
