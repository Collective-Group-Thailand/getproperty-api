import { Module } from '@nestjs/common';

import { filesController } from '../shared/files.controller';
import { OwnerMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { OwnerConsentsController } from '../shared/privacy.controllers';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import {
  OwnerAssetItemsController,
  OwnerBuildingsController,
  OwnerFloorsController,
  OwnerMetersController,
  OwnerPropertiesController,
  OwnerUnitBoardController,
  OwnerUnitImportsController,
  OwnerUnitProfilesController,
  OwnerUnitsController,
  OwnerUtilityAccountsController,
} from './assets.controller';
import {
  OwnerAssetGrantsController,
  OwnerAuditLogController,
  OwnerDsrController,
  OwnerNotificationRoutesController,
  OwnerSupportGrantsController,
} from './governance.controller';
import {
  OwnerBankAccountsController,
  OwnerComplianceAcknowledgementsController,
  OwnerSettingsController,
  OwnerUtilityTariffsController,
} from './money-settings.controller';
import {
  OwnerInvitationsController,
  OwnerMembersController,
  OwnerTenantController,
} from './tenancy.controller';

/** `/v1/owner/*` (contract §2): owner console — B1.3 identity, tenancy, settings, tariffs, governance, files; B2.1 properties, buildings, floors, units, board, profiles, utility accounts, meters, asset items, Excel import. */
@Module({
  controllers: [
    systemPingController(SURFACES.owner),
    OwnerMeController,
    OwnerTenantController,
    OwnerMembersController,
    OwnerInvitationsController,
    OwnerBankAccountsController,
    OwnerSettingsController,
    OwnerUtilityTariffsController,
    OwnerComplianceAcknowledgementsController,
    OwnerSupportGrantsController,
    OwnerAssetGrantsController,
    OwnerAuditLogController,
    OwnerDsrController,
    OwnerNotificationRoutesController,
    OwnerConsentsController,
    OwnerPropertiesController,
    OwnerBuildingsController,
    OwnerFloorsController,
    OwnerUnitBoardController,
    OwnerUnitsController,
    OwnerUnitProfilesController,
    OwnerUtilityAccountsController,
    OwnerMetersController,
    OwnerAssetItemsController,
    OwnerUnitImportsController,
    filesController(SURFACES.owner),
    notificationsController(SURFACES.owner),
    pushSubscriptionsController(SURFACES.owner),
    realtimeController(SURFACES.owner),
  ],
  providers: [MeService],
})
export class OwnerApiModule {}
