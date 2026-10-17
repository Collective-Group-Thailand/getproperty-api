import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { PublicPlansController, PublicUtilityTariffsController } from './public.controllers';

/** `/v1/public/*`: anonymous, cacheable reads for the marketing site — price plans (D-156), tariff ceiling (D-021a). */
@Module({
  controllers: [systemPingController(SURFACES.public), PublicPlansController, PublicUtilityTariffsController],
})
export class PublicApiModule {}
