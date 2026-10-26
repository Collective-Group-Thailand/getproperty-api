import { Module } from '@nestjs/common';

import { ProspectIdentityVerificationController } from '../shared/identity-verification.controllers';
import { ProspectMeController } from '../shared/me.controllers';
import { MeService } from '../shared/me.service';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { ProspectEnquiriesController } from './prospect.controller';

/** `/v1/prospect/*` (contract §2): people looking for a place to rent — me, enquiries, viewings (B7.3, D-252). */
@Module({
  controllers: [
    systemPingController(SURFACES.prospect),
    ProspectMeController,
    ProspectEnquiriesController,
    ProspectIdentityVerificationController,
  ],
  providers: [MeService],
})
export class ProspectApiModule {}
