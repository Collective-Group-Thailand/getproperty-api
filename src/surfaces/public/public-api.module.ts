import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { PublicListingsController } from './listings.controller';
import { PublicPlansController, PublicUtilityTariffsController } from './public.controllers';
import { PublicSignupController } from './signup.controller';

/** `/v1/public/*`: anonymous endpoints of the marketing site — price plans (D-156), tariff ceiling (D-021a), landlord sign-up (D-251), rental listings (D-252). */
@Module({
  controllers: [
    systemPingController(SURFACES.public),
    PublicPlansController,
    PublicUtilityTariffsController,
    PublicSignupController,
    PublicListingsController,
  ],
})
export class PublicApiModule {}
