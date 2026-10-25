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
import { webVitalsController } from '../shared/web-vitals.controller';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { OwnerAccessController } from './access.controller';
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
  OwnerBillingCyclesController,
  OwnerInvoiceChargesController,
  OwnerInvoicesController,
  OwnerRatePlansController,
} from './billing.controller';
import {
  OwnerAnnouncementsController,
  OwnerFacilitiesController,
  OwnerRulesContactsController,
  parcelsController,
} from './community.controller';
import { OwnerComplianceController } from './compliance.controller';
import { inspectionsController, OwnerDepositsController } from './deposits.controller';
import { OwnerBillingDocumentsController, OwnerExportsController } from './documents.controller';
import { OwnerEtaxController, OwnerTm30Controller } from './etax-tm30.controller';
import {
  OwnerAssetGrantsController,
  OwnerAuditLogController,
  OwnerDsrController,
  OwnerNotificationRoutesController,
  OwnerSupportGrantsController,
} from './governance.controller';
import { OwnerInsightsController } from './insights.controller';
import { OwnerLeadsController } from './leads.controller';
import { OwnerLeasesController, OwnerLeaseTemplatesController } from './leases.controller';
import { OwnerListingsController } from './listings.controller';
import {
  OwnerBankAccountsController,
  OwnerComplianceAcknowledgementsController,
  OwnerSettingsController,
  OwnerUtilityTariffsController,
} from './money-settings.controller';
import {
  OwnerPartyDetailsController,
  OwnerPartyLinkRequestsController,
  partiesController,
} from './parties.controller';
import { OwnerPaymentsController } from './payments.controller';
import { OwnerPortfolioController } from './portfolio.controller';
import { OwnerDashboardController, OwnerReceivablesController } from './receivables.controller';
import { OwnerSearchController } from './search.controller';
import {
  OwnerMaintenancePlansController,
  OwnerServiceCategoriesController,
  OwnerWorkOrderVerifyController,
  serviceRequestsController,
  workOrdersController,
} from './service.controller';
import {
  deviceInstallsController,
  devicesController,
  meterReadingsController,
  OwnerLossController,
  OwnerReadingReviewsController,
  OwnerUtilityInvoicesController,
} from './smart.controller';
import { OwnerStorageController } from './storage.controller';
import { OwnerSubscriptionController } from './subscription.controller';
import {
  OwnerInvitationsController,
  OwnerMembersController,
  OwnerTenantController,
} from './tenancy.controller';

/** `/v1/owner/*` (contract §2): owner console — B1.3 identity, tenancy, settings, tariffs, governance, files; B2.1 properties, buildings, floors, units, board, profiles, utility accounts, meters, asset items, Excel import; B2.2 parties; B2.3 leases, lease templates, lease invitations; B2.4 deposits, inspections. */
@Module({
  controllers: [
    OwnerSubscriptionController,
    OwnerStorageController,
    OwnerInsightsController,
    OwnerEtaxController,
    OwnerTm30Controller,
    OwnerServiceCategoriesController,
    serviceRequestsController(SURFACES.owner),
    workOrdersController(SURFACES.owner),
    OwnerWorkOrderVerifyController,
    OwnerMaintenancePlansController,
    OwnerAccessController,
    OwnerAnnouncementsController,
    parcelsController(SURFACES.owner),
    OwnerFacilitiesController,
    OwnerRulesContactsController,
    systemPingController(SURFACES.owner),
    OwnerMeController,
    OwnerTenantController,
    OwnerMembersController,
    OwnerInvitationsController,
    OwnerBankAccountsController,
    OwnerSettingsController,
    OwnerUtilityTariffsController,
    OwnerComplianceAcknowledgementsController,
    OwnerComplianceController,
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
    OwnerPortfolioController,
    OwnerListingsController,
    OwnerLeadsController,
    OwnerUnitProfilesController,
    OwnerUtilityAccountsController,
    OwnerMetersController,
    OwnerAssetItemsController,
    OwnerUnitImportsController,
    partiesController(SURFACES.owner),
    OwnerPartyDetailsController,
    OwnerPartyLinkRequestsController,
    OwnerLeasesController,
    OwnerLeaseTemplatesController,
    OwnerDepositsController,
    OwnerRatePlansController,
    OwnerBillingCyclesController,
    OwnerInvoicesController,
    OwnerInvoiceChargesController,
    OwnerBillingDocumentsController,
    OwnerExportsController,
    OwnerPaymentsController,
    OwnerReceivablesController,
    OwnerDashboardController,
    inspectionsController(SURFACES.owner),
    filesController(SURFACES.owner),
    notificationsController(SURFACES.owner),
    pushSubscriptionsController(SURFACES.owner),
    realtimeController(SURFACES.owner),
    OwnerSearchController,
    devicesController(SURFACES.owner),
    deviceInstallsController(SURFACES.owner),
    meterReadingsController(SURFACES.owner),
    OwnerReadingReviewsController,
    OwnerUtilityInvoicesController,
    OwnerLossController,
    webVitalsController('owner'),
  ],
  providers: [MeService],
})
export class OwnerApiModule {}
