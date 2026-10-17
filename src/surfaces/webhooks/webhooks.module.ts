import { Module } from '@nestjs/common';

import { PaymentWebhooksController } from '../owner/payments.controller';
import { PlatformPaymentWebhooksController } from '../owner/subscription.controller';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';

/** `/webhooks/*` (contract §2): signature-verified provider callbacks, no token. Payment provider callbacks (B4.4). */
@Module({
  controllers: [
    systemPingController(SURFACES.webhooks),
    PaymentWebhooksController,
    PlatformPaymentWebhooksController,
  ],
})
export class WebhooksModule {}
