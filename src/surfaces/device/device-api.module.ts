import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { DeviceBootstrapController } from './device-bootstrap.controller';
import { DeviceIdentityController, DeviceLogsController } from './device-identity.controller';
import {
  DeviceConfigController,
  DeviceOtaController,
  DeviceReadingsController,
} from './device-smart.controller';

/** `/v1/device/*` (contract §2): gateway bootstrap (B1.3); token, certificate renewal and log uploads (contract requests CR-001…CR-004); config, OTA, readings batch (B3). */
@Module({
  controllers: [
    systemPingController(SURFACES.device),
    DeviceBootstrapController,
    DeviceIdentityController,
    DeviceLogsController,
    DeviceConfigController,
    DeviceOtaController,
    DeviceReadingsController,
  ],
})
export class DeviceApiModule {}
