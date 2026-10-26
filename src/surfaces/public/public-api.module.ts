import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { PublicListingsController, PublicOwnersController } from './listings.controller';
import {
  PublicPlansController,
  PublicPricingController,
  PublicUtilityTariffsController,
} from './public.controllers';
import { PublicSignupController } from './signup.controller';

/** `/v1/public/*`: anonymous endpoints of the marketing site — price plans (D-156), tariff ceiling (D-021a), landlord sign-up (D-251), rental listings (D-252). */
@Module({
  controllers: [
    systemPingController(SURFACES.public),
    PublicPlansController,
    PublicPricingController,
    PublicUtilityTariffsController,
    PublicSignupController,
    PublicListingsController,
    PublicOwnersController,
  ],
})
export class PublicApiModule {}
