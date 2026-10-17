import { Module } from '@nestjs/common';

import { AdminMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { webVitalsController } from '../shared/web-vitals.controller';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import {
  AdminBuildingsController,
  AdminDevicesController,
  AdminNotificationTemplatesController,
  AdminOutboxController,
  AdminUtilityTariffsController,
} from './admin-operations.controller';
import {
  AdminAuditLogController,
  AdminDsrController,
  AdminFeatureFlagsController,
  AdminPlatformUsersController,
  AdminSettingsController,
  AdminWorkflowDefinitionsController,
} from './admin-platform.controller';
import { AdminFleetController, AdminIngestController, AdminOtaController } from './admin-smart.controller';
import { AdminSystemController } from './admin-system.controller';
import { AdminSupportGrantsController, AdminTenantsController } from './admin-tenants.controller';

/** `/v1/admin/*` (contract §2): the platform admin zone (D-161) — B1.3 tenants, platform users, support, settings, tariffs, outbox, templates, devices. */
@Module({
  controllers: [
    systemPingController(SURFACES.admin),
    AdminSystemController,
    AdminMeController,
    AdminTenantsController,
    AdminSupportGrantsController,
    AdminPlatformUsersController,
    AdminSettingsController,
    AdminFeatureFlagsController,
    AdminAuditLogController,
    AdminDsrController,
    AdminWorkflowDefinitionsController,
    AdminUtilityTariffsController,
    AdminOutboxController,
    AdminNotificationTemplatesController,
    AdminDevicesController,
    AdminBuildingsController,
    AdminFleetController,
    AdminOtaController,
    AdminIngestController,
    notificationsController(SURFACES.admin),
    pushSubscriptionsController(SURFACES.admin),
    realtimeController(SURFACES.admin),
    webVitalsController('admin'),
  ],
  providers: [MeService],
})
export class AdminApiModule {}
