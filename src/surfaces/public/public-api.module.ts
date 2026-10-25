import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { PublicPlansController, PublicUtilityTariffsController } from './public.controllers';
import { PublicSignupController } from './signup.controller';

/** `/v1/public/*`: anonymous endpoints of the marketing site — price plans (D-156), tariff ceiling (D-021a), landlord sign-up (D-251). */
@Module({
  controllers: [
    systemPingController(SURFACES.public),
    PublicPlansController,
    PublicUtilityTariffsController,
    PublicSignupController,
  ],
})
export class PublicApiModule {}
