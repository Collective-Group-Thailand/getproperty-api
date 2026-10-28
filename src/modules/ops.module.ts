import { Global, Module } from '@nestjs/common';

import { IntegrationDeliveryService } from './bridge-integrations/integration-delivery.service';
import { IntegrationEventsService } from './bridge-integrations/integration-events.service';
import { RentalHandoffsService } from './bridge-integrations/rental-handoffs.service';
import { BillingCyclesService } from './ops-billing/billing-cycles.service';
import { BillingInputs } from './ops-billing/billing-inputs';
import { InvoiceScoreSource } from './ops-billing/invoice-score.source';
import { InvoicesService } from './ops-billing/invoices.service';
import { RatePlansService } from './ops-billing/rate-plans.service';
import { ResidentInvoicesService } from './ops-billing/resident-invoices.service';
import { AnnouncementsService } from './ops-community/announcements.service';
import { CommunitySubscribers } from './ops-community/community.subscribers';
import { FacilitiesService } from './ops-community/facilities.service';
import { ParcelsService } from './ops-community/parcels.service';
import { ResidentCommunityService } from './ops-community/resident-community.service';
import { BuildingRulesService } from './ops-community/rules-contacts.service';
import { DepositDocuments } from './ops-deposits/deposit-documents';
import { DepositsService } from './ops-deposits/deposits.service';
import { DepositDeadlineSubscriber } from './ops-deposits/deposits.subscriber';
import { InspectionsService } from './ops-deposits/inspections.service';
import { ResidentDepositsService } from './ops-deposits/resident-deposits.service';
import { ResidentInspectionsService } from './ops-deposits/resident-inspections.service';
import { BillingDocuments } from './ops-documents/billing-documents.service';
import { BillingNotifications } from './ops-documents/billing-notifications';
import { DocumentArchiveBuilder } from './ops-documents/document-archive.builder';
import { BillingDocumentsSubscriber } from './ops-documents/documents.subscriber';
import { ExportsService } from './ops-documents/exports.service';
import { InvoiceDocumentsService } from './ops-documents/invoice-documents.service';
import { EtaxHooks } from './ops-etax/etax.hooks';
import { EtaxService } from './ops-etax/etax.service';
import { ContractLibraryService } from './ops-leases/contract-library.service';
import { ContractRenderer } from './ops-leases/contract-renderer';
import { ContractsService } from './ops-leases/contracts.service';
import { EmployerHousingService } from './ops-leases/employer-housing.service';
import { IncomeSummariesService } from './ops-leases/income-summaries.service';
import { LeaseNoticesService } from './ops-leases/lease-notices.service';
import { LeaseRenewalsService } from './ops-leases/lease-renewals.service';
import { LeaseStampDutyService } from './ops-leases/lease-stamp-duty.service';
import { LeasesService } from './ops-leases/leases.service';
import { RentCertificatesService } from './ops-leases/rent-certificates.service';
import { RentRecordService } from './ops-leases/rent-record.service';
import { ResidentLeasesService } from './ops-leases/resident-leases.service';
import { CoBrokeService } from './ops-listings/co-broke.service';
import { DealsService } from './ops-listings/deals.service';
import { ListingNotifications } from './ops-listings/listing.notifications';
import { ListingLeaseHooks, SelfViewingDoorHook } from './ops-listings/listing.subscribers';
import { ListingInsightsService } from './ops-listings/listing-insights.service';
import { ListingLeadsService } from './ops-listings/listing-leads.service';
import { ListingModerationService } from './ops-listings/listing-moderation.service';
import { ListingOgImageService } from './ops-listings/listing-og-image.service';
import { ListingShareService } from './ops-listings/listing-share.service';
import { ListingSocialService } from './ops-listings/listing-social.service';
import { ListingsService } from './ops-listings/listings.service';
import { MandatesService } from './ops-listings/mandates.service';
import { PublicListingsService } from './ops-listings/public-listings.service';
import { RelocationService } from './ops-listings/relocation.service';
import { SelfViewingService } from './ops-listings/self-viewing.service';
import { SocialChannelsService } from './ops-listings/social-channels.service';
import { PartiesService } from './ops-parties/parties.service';
import { PartyNotifications } from './ops-parties/party-notifications';
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
import { ServiceCostsService } from './ops-service/service-costs.service';
import { ServiceMessagesService } from './ops-service/service-messages.service';
import { ServiceRequestsService } from './ops-service/service-requests.service';
import { WorkOrdersService } from './ops-service/work-orders.service';
import { StaffTasksService } from './ops-tasks/staff-tasks.service';
import { Tm30Service } from './ops-tm30/tm30.service';
import { BoardService } from './ops-units/board.service';
import { AmenitiesService, MetersService } from './ops-units/meters-items.service';
import { PortfolioService } from './ops-units/portfolio.service';
import { UnitProfilesService, UtilityAccountsService } from './ops-units/profiles-accounts.service';
import { SearchService } from './ops-units/search.service';
import { StructureService } from './ops-units/structure.service';
import { UnitImportService } from './ops-units/unit-import.service';
import { UnitsService } from './ops-units/units.service';

const SERVICES = [
  StructureService,
  UnitsService,
  PortfolioService,
  ListingsService,
  ListingModerationService,
  ListingLeadsService,
  SelfViewingService,
  SelfViewingDoorHook,
  ListingNotifications,
  ListingLeaseHooks,
  MandatesService,
  CoBrokeService,
  DealsService,
  PublicListingsService,
  ListingInsightsService,
  ListingShareService,
  ListingOgImageService,
  SocialChannelsService,
  ListingSocialService,
  UnitProfilesService,
  UtilityAccountsService,
  MetersService,
  AmenitiesService,
  BoardService,
  UnitImportService,
  SearchService,
  PartiesService,
  PartyNotifications,
  ResidentPrivacyService,
  ResidentDocumentsService,
  ContractRenderer,
  LeasesService,
  LeaseStampDutyService,
  LeaseNoticesService,
  ContractLibraryService,
  ContractsService,
  LeaseRenewalsService,
  RentCertificatesService,
  RentRecordService,
  IncomeSummariesService,
  ResidentLeasesService,
  DepositDocuments,
  InspectionsService,
  DepositsService,
  DepositDeadlineSubscriber,
  ResidentDepositsService,
  ResidentInspectionsService,
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
  IntegrationDeliveryService,
  RentalHandoffsService,
  EmployerHousingService,
  RelocationService,
  ServiceCategoriesService,
  ServiceRequestsService,
  ServiceCostsService,
  WorkOrdersService,
  MaintenancePlansService,
  TechnicianWorkOrdersService,
  ResidentServiceRequestsService,
  ServiceMessagesService,
  ServiceNotifications,
  AutoServiceRequests,
  WarrantyBridge,
  AnnouncementsService,
  ParcelsService,
  FacilitiesService,
  BuildingRulesService,
  StaffTasksService,
  EtaxService,
  EtaxHooks,
  Tm30Service,
  ResidentCommunityService,
  CommunitySubscribers,
];

/**
 * Group A business modules (master plan §4: `modules/ops-*`), shared by the HTTP and worker processes so their
 * event subscribers run in the worker. B2: units (2.1), parties (2.2), leases (2.3), deposits & inspections (2.4); B4: rate plans, billing cycles, invoices (4.2); documents, Flex, exports (4.3); payments, slips, receipts (4.4); receivables, dunning, penalties, dashboard, finance exports (4.5); B5: service requests, work orders, preventive maintenance, warranty bridge (5.1); access lives in smart (5.2); community (5.3); staff tasks (5.4); B6.2: e-Tax submissions, TM30 notifications; G8: getbuild rental handoffs, employer housing, relocation offers.
 */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class OpsModule {}
