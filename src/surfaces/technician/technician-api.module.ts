import { Module } from '@nestjs/common';

import { TechnicianMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { notificationsController } from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/v1/technician/*` (contract §2): technician LIFF — me and inbox now; work orders with B5 (R2). */
@Module({
  controllers: [
    systemPingController(SURFACES.technician),
    TechnicianMeController,
    notificationsController(SURFACES.technician),
  ],
  providers: [MeService],
})
export class TechnicianApiModule {}
