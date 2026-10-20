import { Module } from '@nestjs/common';

import { StaffAccessController } from '../owner/access.controller';
import { parcelsController } from '../owner/community.controller';
import { inspectionsController } from '../owner/deposits.controller';
import { partiesController } from '../owner/parties.controller';
import { serviceRequestsController, workOrdersController } from '../owner/service.controller';
import {
  deviceInstallsController,
  devicesController,
  meterReadingsController,
} from '../owner/smart.controller';
import { StaffInstallOrdersController } from '../owner/subscription.controller';
import { filesController } from '../shared/files.controller';
import { StaffMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { webVitalsController } from '../shared/web-vitals.controller';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { StaffFieldController } from './staff-field.controller';
import { StaffTasksController } from './tasks.controller';

/** `/v1/staff/*` (contract §2): staff PWA — me, files, inbox, web push, realtime (B1.3). */
@Module({
  controllers: [
    systemPingController(SURFACES.staff),
    StaffMeController,
    StaffFieldController,
    StaffTasksController,
    StaffInstallOrdersController,
    filesController(SURFACES.staff),
    partiesController(SURFACES.staff),
    inspectionsController(SURFACES.staff),
    devicesController(SURFACES.staff),
    deviceInstallsController(SURFACES.staff),
    meterReadingsController(SURFACES.staff),
    serviceRequestsController(SURFACES.staff),
    workOrdersController(SURFACES.staff),
    StaffAccessController,
    parcelsController(SURFACES.staff),
    notificationsController(SURFACES.staff),
    pushSubscriptionsController(SURFACES.staff),
    realtimeController(SURFACES.staff),
    webVitalsController('staff'),
  ],
  providers: [MeService],
})
export class StaffApiModule {}
