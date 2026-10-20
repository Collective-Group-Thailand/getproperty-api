import { Global, Module } from '@nestjs/common';

import { IntegrationEventsService } from './bridge-integrations/integration-events.service';
import { BillingCyclesService } from './ops-billing/billing-cycles.service';
import { BillingInputs } from './ops-billing/billing-inputs';
import { InvoiceScoreSource } from './ops-billing/invoice-score.source';
import { InvoicesService } from './ops-billing/invoices.service';
import { RatePlansService } from './ops-billing/rate-plans.service';
import { ResidentInvoicesService } from './ops-billing/resident-invoices.service';
import { DepositDocuments } from './ops-deposits/deposit-documents';
import { DepositsService } from './ops-deposits/deposits.service';
import { DepositDeadlineSubscriber } from './ops-deposits/deposits.subscriber';
import { InspectionsService } from './ops-deposits/inspections.service';
import { ResidentDepositsService } from './ops-deposits/resident-deposits.service';
import { BillingDocuments } from './ops-documents/billing-documents.service';
import { BillingNotifications } from './ops-documents/billing-notifications';
import { DocumentArchiveBuilder } from './ops-documents/document-archive.builder';
import { BillingDocumentsSubscriber } from './ops-documents/documents.subscriber';
import { ExportsService } from './ops-documents/exports.service';
import { InvoiceDocumentsService } from './ops-documents/invoice-documents.service';
import { ContractRenderer } from './ops-leases/contract-renderer';
import { LeasesService } from './ops-leases/leases.service';
import { ResidentLeasesService } from './ops-leases/resident-leases.service';
import { PartiesService } from './ops-parties/parties.service';
import { ResidentDocumentsService } from './ops-parties/resident-documents.service';
import { ResidentPrivacyService } from './ops-parties/resident-privacy.service';
import { MerchantResolver } from './ops-payments/merchants';
import { PaymentNotifications } from './ops-payments/payment-notifications';
import { PaymentReadySubscriber } from './ops-payments/payment-ready.subscriber';
import { PaymentWebhooksService } from './ops-payments/payment-webhooks.service';
import { PaymentsService } from './ops-payments/payments.service';
import { ReceiptsService } from './ops-payments/receipts.service';
import { ResidentPaymentsService } from './ops-payments/resident-payments.service';
import { SettlementsService } from './ops-payments/settlements.service';
import { SlipsService } from './ops-payments/slips.service';
import { DashboardService } from './ops-receivables/dashboard.service';
import { DunningService } from './ops-receivables/dunning.service';
import { FinanceExports } from './ops-receivables/exports/finance-exports.builders';
import { ReceivablesService } from './ops-receivables/receivables.service';
import { ReceivablesNotifications } from './ops-receivables/receivables-notifications';
import {
  ResidentServiceRequestsService,
  TechnicianWorkOrdersService,
} from './ops-service/field-access.service';
import { MaintenancePlansService } from './ops-service/maintenance-plans.service';
import { AutoServiceRequests, ServiceNotifications, WarrantyBridge } from './ops-service/service.subscribers';
import { ServiceCategoriesService } from './ops-service/service-categories.service';
import { ServiceRequestsService } from './ops-service/service-requests.service';
import { WorkOrdersService } from './ops-service/work-orders.service';
import { BoardService } from './ops-units/board.service';
import { AmenitiesService, MetersService } from './ops-units/meters-items.service';
import { UnitProfilesService, UtilityAccountsService } from './ops-units/profiles-accounts.service';
import { SearchService } from './ops-units/search.service';
import { StructureService } from './ops-units/structure.service';
import { UnitImportService } from './ops-units/unit-import.service';
import { UnitsService } from './ops-units/units.service';

const SERVICES = [
  StructureService,
  UnitsService,
  UnitProfilesService,
  UtilityAccountsService,
  MetersService,
  AmenitiesService,
  BoardService,
  UnitImportService,
  SearchService,
  PartiesService,
  ResidentPrivacyService,
  ResidentDocumentsService,
  ContractRenderer,
  LeasesService,
  ResidentLeasesService,
  DepositDocuments,
  InspectionsService,
  DepositsService,
  DepositDeadlineSubscriber,
  ResidentDepositsService,
  RatePlansService,
  BillingInputs,
  InvoicesService,
  BillingCyclesService,
  InvoiceScoreSource,
  ResidentInvoicesService,
  BillingDocuments,
  BillingDocumentsSubscriber,
  BillingNotifications,
  ExportsService,
  DocumentArchiveBuilder,
  InvoiceDocumentsService,
  MerchantResolver,
  PaymentsService,
  PaymentReadySubscriber,
  PaymentWebhooksService,
  SettlementsService,
  SlipsService,
  ReceiptsService,
  PaymentNotifications,
  ResidentPaymentsService,
  ReceivablesService,
  DunningService,
  DashboardService,
  ReceivablesNotifications,
  FinanceExports,
  IntegrationEventsService,
  ServiceCategoriesService,
  ServiceRequestsService,
  WorkOrdersService,
  MaintenancePlansService,
  TechnicianWorkOrdersService,
  ResidentServiceRequestsService,
  ServiceNotifications,
  AutoServiceRequests,
  WarrantyBridge,
];

/**
 * Group A business modules (master plan §4: `modules/ops-*`), shared by the HTTP and worker processes so their
 * event subscribers run in the worker. B2: units (2.1), parties (2.2), leases (2.3), deposits & inspections (2.4); B4: rate plans, billing cycles, invoices (4.2); documents, Flex, exports (4.3); payments, slips, receipts (4.4); receivables, dunning, penalties, dashboard, finance exports (4.5); B5: service requests, work orders, preventive maintenance, warranty bridge (5.1).
 */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class OpsModule {}
