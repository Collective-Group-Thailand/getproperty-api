import { Module } from '@nestjs/common';

import { ResidentAccessController } from '../owner/access.controller';
import { ResidentInvoicesController } from '../owner/billing.controller';
import { ResidentCommunityController } from '../owner/community.controller';
import { ResidentDepositsController, ResidentUploadsController } from '../owner/deposits.controller';
import { ResidentInvoiceDocumentsController } from '../owner/documents.controller';
import { ResidentLeaseNoticesController } from '../owner/lease-notices.controller';
import { ResidentInvitationsController, ResidentLeasesController } from '../owner/leases.controller';
import { ResidentMessagingLinksController } from '../owner/messaging.controller';
import { ResidentPrivacyController } from '../owner/parties.controller';
import { ResidentPaymentsController } from '../owner/payments.controller';
import { ResidentRentCertificatesController } from '../owner/rent-certificates.controller';
import { ResidentServiceRequestsController } from '../owner/service.controller';
import { ResidentUsageController } from '../owner/smart.controller';
import { ResidentIdentitiesController } from '../shared/identities.controllers';
import { ResidentIdentityVerificationController } from '../shared/identity-verification.controllers';
import { ResidentLinkController, ResidentMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { ResidentConsentsController, ResidentDsrController } from '../shared/privacy.controllers';
import { ResidentRentRecordController } from '../shared/rent-record.controllers';
import {
  notificationsController,
  pushSubscriptionsController,
  realtimeController,
} from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { ResidentInspectionsController } from './resident-inspections.controller';
import {
  ResidentDocumentsController,
  ResidentNotificationPreferencesController,
} from './resident-profile.controller';
import { ResidentCsatSurveyController } from './resident-survey.controller';

/** `/v1/resident/*` (contract §2): LIFF — me, consents, PDPA requests, inbox, realtime (B1.3); privacy (B2.2); leases, e-signature, notice, invitations (B2.3); deposits (B2.4); invoices (B4.2); payments, slips, receipts (B4.4); service requests (B5.1); door codes (B5.2); community (B5.3); satisfaction survey (B6.3). */
@Module({
  controllers: [
    ResidentCsatSurveyController,
    systemPingController(SURFACES.resident),
    ResidentMeController,
    ResidentIdentitiesController,
    ResidentIdentityVerificationController,
    ResidentRentRecordController,
    ResidentMessagingLinksController,
    ResidentLinkController,
    ResidentConsentsController,
    ResidentDsrController,
    ResidentPrivacyController,
    ResidentLeasesController,
    ResidentLeaseNoticesController,
    ResidentRentCertificatesController,
    ResidentInvitationsController,
    ResidentDepositsController,
    ResidentInspectionsController,
    ResidentUploadsController,
    ResidentServiceRequestsController,
    ResidentAccessController,
    ResidentCommunityController,
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
