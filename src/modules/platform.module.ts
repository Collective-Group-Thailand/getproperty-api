import { Global, Module } from '@nestjs/common';

import { PilotKpisService } from './platform-analytics/pilot-kpis.service';
import { FieldWorkService } from './platform-subscriptions/field-work.service';
import { HaasService } from './platform-subscriptions/haas.service';
import { PilotsService } from './platform-subscriptions/pilots.service';
import { PlatformBillingService } from './platform-subscriptions/platform-billing.service';
import { PlatformDocuments } from './platform-subscriptions/platform-documents';
import { PlatformPaymentGateway } from './platform-subscriptions/platform-payment-gateway';
import { PricePlansService } from './platform-subscriptions/price-plans.service';
import { SubscriptionsService } from './platform-subscriptions/subscriptions.service';
import { TenantHealthService } from './platform-subscriptions/tenant-health.service';

const SERVICES = [
  PricePlansService,
  SubscriptionsService,
  PlatformBillingService,
  PlatformPaymentGateway,
  HaasService,
  FieldWorkService,
  PilotsService,
  TenantHealthService,
  PilotKpisService,
];

/**
 * The platform business of Collective Group (B6.1, B6.3 KPIs; D-081–D-083, D-156, D-204): price plans and
 * subscriptions with their lifecycle job, platform invoices / receipts / credit notes with the platform's own Thai QR,
 * the HaaS register, field orders and site surveys, pilot agreements and KPIs, tenant health. Shared by the HTTP and
 * worker processes; the document subscriber consumes in the worker.
 */
@Global()
@Module({
  providers: [...SERVICES, PlatformDocuments],
  exports: SERVICES,
})
export class PlatformModule {}
