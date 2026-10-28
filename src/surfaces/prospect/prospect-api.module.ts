import { Module } from '@nestjs/common';

import { ProspectContractsController } from '../owner/contracts.controller';
import { ProspectMessagingLinksController } from '../owner/messaging.controller';
import { ProspectRecommendationsController } from '../shared/audience.controllers';
import { ProspectIdentityVerificationController } from '../shared/identity-verification.controllers';
import { ProspectMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { ProspectRentRecordController } from '../shared/rent-record.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { ProspectEnquiriesController } from './prospect.controller';
import { ProspectSelfViewingController } from './self-viewing.controller';

/** `/v1/prospect/*` (contract §2): people looking for a place to rent — me, enquiries, viewings (B7.3, D-252). */
@Module({
  controllers: [
    systemPingController(SURFACES.prospect),
    ProspectMeController,
    ProspectEnquiriesController,
    ProspectIdentityVerificationController,
    ProspectRentRecordController,
    ProspectContractsController,
    ProspectSelfViewingController,
    ProspectMessagingLinksController,
    ProspectRecommendationsController,
  ],
  providers: [MeService],
})
export class ProspectApiModule {}
