import { Module } from '@nestjs/common';

import { ResidentInvitationsController, ResidentLeasesController } from '../owner/leases.controller';
import { ResidentPrivacyController } from '../owner/parties.controller';
import { ResidentMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { ResidentConsentsController, ResidentDsrController } from '../shared/privacy.controllers';
import { notificationsController, realtimeController } from '../shared/surface.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/v1/resident/*` (contract §2): LIFF — me, consents, PDPA requests, inbox, realtime (B1.3); privacy (B2.2); leases, e-signature, notice, invitations (B2.3). */
@Module({
  controllers: [
    systemPingController(SURFACES.resident),
    ResidentMeController,
    ResidentConsentsController,
    ResidentDsrController,
    ResidentPrivacyController,
    ResidentLeasesController,
    ResidentInvitationsController,
    notificationsController(SURFACES.resident),
    realtimeController(SURFACES.resident),
  ],
  providers: [MeService],
})
export class ResidentApiModule {}
