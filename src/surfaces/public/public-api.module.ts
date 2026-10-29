import { Module } from '@nestjs/common';

import { PublicHandoffsController } from '../shared/growth-network.controllers';
import { PublicRentRecordsController } from '../shared/rent-record.controllers';
import { PublicListingReviewsController } from '../shared/reviews.controllers';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { PublicGuidesController } from './guides.controller';
import {
  PublicListingsController,
  PublicOwnersController,
  PublicShareLinksController,
} from './listings.controller';
import {
  PublicPlansController,
  PublicPricingController,
  PublicUtilityTariffsController,
} from './public.controllers';
import { PublicAgencySignupController, PublicSignupController } from './signup.controller';

/** `/v1/public/*`: anonymous endpoints of the marketing site — price plans (D-156), tariff ceiling (D-021a), landlord sign-up (D-251), rental listings (D-252). */
@Module({
  controllers: [
    systemPingController(SURFACES.public),
    PublicPlansController,
    PublicPricingController,
    PublicUtilityTariffsController,
    PublicSignupController,
    PublicAgencySignupController,
    PublicListingsController,
    PublicOwnersController,
    PublicShareLinksController,
    PublicRentRecordsController,
    PublicGuidesController,
    PublicHandoffsController,
    PublicListingReviewsController,
  ],
})
export class PublicApiModule {}
