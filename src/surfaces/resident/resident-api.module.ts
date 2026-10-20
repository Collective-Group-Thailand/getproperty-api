import { Module } from '@nestjs/common';

import { ResidentAccessController } from '../owner/access.controller';
import { ResidentInvoicesController } from '../owner/billing.controller';
import { ResidentDepositsController, ResidentUploadsController } from '../owner/deposits.controller';
import { ResidentInvoiceDocumentsController } from '../owner/documents.controller';
import { ResidentInvitationsController, ResidentLeasesController } from '../owner/leases.controller';
import { ResidentPrivacyController } from '../owner/parties.controller';
import { ResidentPaymentsController } from '../owner/payments.controller';
import { ResidentServiceRequestsController } from '../owner/service.controller';
import { ResidentUsageController } from '../owner/smart.controller';
import { ResidentLinkController, ResidentMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { ResidentConsentsController, ResidentDsrController } from '../shared/privacy.controllers';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import {
  ResidentDocumentsController,
  ResidentNotificationPreferencesController,
} from './resident-profile.controller';

/** `/v1/resident/*` (contract §2): LIFF — me, consents, PDPA requests, inbox, realtime (B1.3); privacy (B2.2); leases, e-signature, notice, invitations (B2.3); deposits (B2.4); invoices (B4.2); payments, slips, receipts (B4.4); service requests (B5.1). */
@Module({
  controllers: [
    systemPingController(SURFACES.resident),
    ResidentMeController,
    ResidentLinkController,
    ResidentConsentsController,
    ResidentDsrController,
    ResidentPrivacyController,
    ResidentLeasesController,
    ResidentInvitationsController,
    ResidentDepositsController,
    ResidentUploadsController,
    ResidentServiceRequestsController,
    ResidentAccessController,
    ResidentInvoicesController,
    ResidentInvoiceDocumentsController,
    ResidentPaymentsController,
    ResidentUsageController,
    ResidentDocumentsController,
    ResidentNotificationPreferencesController,
    notificationsController(SURFACES.resident),
    realtimeController(SURFACES.resident),
    pushSubscriptionsController(SURFACES.resident),
  ],
  providers: [MeService],
})
export class ResidentApiModule {}
