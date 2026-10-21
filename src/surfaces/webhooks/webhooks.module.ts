import { Module } from '@nestjs/common';

import { PaymentWebhooksController } from '../owner/payments.controller';
import { PlatformPaymentWebhooksController } from '../owner/subscription.controller';
import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { IntegrationWebhooksController } from './integration-webhooks.controller';

/** `/webhooks/*` (contract §2): signature-verified callbacks, no token — payment providers (B4.4), Collective products (D-238). */
@Module({
  controllers: [
    systemPingController(SURFACES.webhooks),
    PaymentWebhooksController,
    PlatformPaymentWebhooksController,
    IntegrationWebhooksController,
  ],
})
export class WebhooksModule {}
