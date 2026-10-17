import { Module } from '@nestjs/common';

import { ResidentDepositsController } from '../owner/deposits.controller';
import { ResidentInvitationsController, ResidentLeasesController } from '../owner/leases.controller';
import { ResidentPrivacyController } from '../owner/parties.controller';
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

/** `/v1/resident/*` (contract §2): LIFF — me, consents, PDPA requests, inbox, realtime (B1.3); privacy (B2.2); leases, e-signature, notice, invitations (B2.3); deposits (B2.4). */
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
    notificationsController(SURFACES.resident),
    realtimeController(SURFACES.resident),
    pushSubscriptionsController(SURFACES.resident),
  ],
  providers: [MeService],
})
export class ResidentApiModule {}
