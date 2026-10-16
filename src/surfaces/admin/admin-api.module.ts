import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { AdminSystemController } from './admin-system.controller';

/** `/v1/admin/*` (contract §2): the platform admin zone. Business controllers are added by B1.3–B6. */
@Module({
  controllers: [systemPingController(SURFACES.admin), AdminSystemController],
})
export class AdminApiModule {}
