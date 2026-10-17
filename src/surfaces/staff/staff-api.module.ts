import { Module } from '@nestjs/common';

import { filesController } from '../shared/files.controller';
import { StaffMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/v1/staff/*` (contract §2): staff PWA — me, files, inbox, web push, realtime (B1.3). */
@Module({
  controllers: [
    systemPingController(SURFACES.staff),
    StaffMeController,
    filesController(SURFACES.staff),
    notificationsController(SURFACES.staff),
    pushSubscriptionsController(SURFACES.staff),
    realtimeController(SURFACES.staff),
  ],
  providers: [MeService],
})
export class StaffApiModule {}
