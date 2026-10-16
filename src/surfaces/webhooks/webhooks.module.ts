import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/webhooks/*` (contract §2): signature-verified provider callbacks, no token. Business controllers of this surface are added by their deliverables. */
@Module({
  controllers: [systemPingController(SURFACES.webhooks)],
})
export class WebhooksModule {}
