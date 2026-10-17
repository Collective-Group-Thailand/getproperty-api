import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { DeviceBootstrapController } from './device-bootstrap.controller';

/** `/v1/device/*` (contract §2): gateway bootstrap (B1.3); config, OTA and uploads arrive with B3. */
@Module({
  controllers: [systemPingController(SURFACES.device), DeviceBootstrapController],
})
export class DeviceApiModule {}
