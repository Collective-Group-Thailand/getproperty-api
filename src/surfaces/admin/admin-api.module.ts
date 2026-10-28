import { Module } from '@nestjs/common';

import { AdminComplianceController } from '../owner/compliance.controller';
import { AdminDocumentTemplatesController } from '../owner/documents.controller';
import { AdminRentalHandoffsController } from '../shared/growth-network.controllers';
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
import { AdminFilesController, AdminIntegrationEventsController } from './admin-backlog.controller';
import { AdminBroadcastController, AdminSponsoredCampaignsController } from './admin-broadcast.controller';
import { ADMIN_BUSINESS_CONTROLLERS } from './admin-business.controller';
import { AdminContractLibraryController } from './admin-contract-library.controller';
import { AdminProviderCredentialsController } from './admin-credentials.controller';
import { AdminFeeAccrualsController, AdminMediaServicesController } from './admin-growth.controller';
import { AdminGuidesController } from './admin-guides.controller';
import { AdminListingsController } from './admin-listings.controller';
import { AdminMessagingRatesController } from './admin-messaging.controller';
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
import { AdminStorageController, AdminTenantStorageQuotaController } from './admin-storage.controller';
import { AdminSystemController } from './admin-system.controller';
import { AdminSupportGrantsController, AdminTenantsController } from './admin-tenants.controller';

/** `/v1/admin/*` (contract §2): the platform admin zone (D-161) — B1.3 tenants, platform users, support, settings, tariffs, outbox, templates, devices. */
@Module({
  controllers: [
    ...ADMIN_BUSINESS_CONTROLLERS,
    systemPingController(SURFACES.admin),
    AdminSponsoredCampaignsController,
    AdminBroadcastController,
    AdminSystemController,
    AdminMeController,
    AdminTenantsController,
    AdminSupportGrantsController,
    AdminPlatformUsersController,
    AdminSettingsController,
    AdminStorageController,
    AdminFeeAccrualsController,
    AdminRentalHandoffsController,
    AdminMediaServicesController,
    AdminTenantStorageQuotaController,
    AdminMessagingRatesController,
    AdminGuidesController,
    AdminContractLibraryController,
    AdminListingsController,
    AdminComplianceController,
    AdminDocumentTemplatesController,
    AdminFeatureFlagsController,
    AdminAuditLogController,
    AdminDsrController,
    AdminWorkflowDefinitionsController,
    AdminUtilityTariffsController,
    AdminOutboxController,
    AdminIntegrationEventsController,
    AdminFilesController,
    AdminNotificationTemplatesController,
    AdminDevicesController,
    AdminBuildingsController,
    AdminFleetController,
    AdminOtaController,
    AdminIngestController,
    AdminProviderCredentialsController,
    notificationsController(SURFACES.admin),
    pushSubscriptionsController(SURFACES.admin),
    realtimeController(SURFACES.admin),
    webVitalsController('admin'),
  ],
  providers: [MeService],
})
export class AdminApiModule {}
