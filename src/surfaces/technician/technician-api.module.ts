import { Module } from '@nestjs/common';

import { TechnicianAccessController } from '../owner/access.controller';
import { TechnicianWorkOrdersController } from '../owner/service.controller';
import { TechnicianMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { notificationsController } from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/v1/technician/*` (contract §2): technician LIFF — me, inbox and my work orders (B5.1, R2). */
@Module({
  controllers: [
    systemPingController(SURFACES.technician),
    TechnicianMeController,
    TechnicianWorkOrdersController,
    TechnicianAccessController,
    notificationsController(SURFACES.technician),
  ],
  providers: [MeService],
})
export class TechnicianApiModule {}
