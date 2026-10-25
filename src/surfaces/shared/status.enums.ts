/**
 * Named enum components shared by several DTO modules (contract §3: every enum is a named component so the web and
 * LIFF apps import it by name). A leaf module — it imports nothing — so DTO files can share it without cycles.
 * Values equal the PostgreSQL enums of schema-design v2.
 */

export enum LeaseStatusName {
  Draft = 'draft',
  PendingSignature = 'pending_signature',
  Active = 'active',
  NoticeGiven = 'notice_given',
  Ending = 'ending',
  Ended = 'ended',
  Terminated = 'terminated',
  Cancelled = 'cancelled',
}

export enum LeasePartyRoleName {
  Lessee = 'lessee',
  CoTenant = 'co_tenant',
  Guarantor = 'guarantor',
  Occupant = 'occupant',
}

/** `core.occupancy_role` — tenant = the lessee (D-151 vocabulary: a party living in a unit). */
export enum OccupancyRoleName {
  Tenant = 'tenant',
  CoTenant = 'co_tenant',
  OwnerOccupier = 'owner_occupier',
  Family = 'family',
  Staff = 'staff',
}

/** Platform roles (`platform.platform_role_assignment.role`, D-090). */
export enum PlatformRoleName {
  PlatformAdmin = 'platform_admin',
  Support = 'support',
  FieldEngineer = 'field_engineer',
  Finance = 'finance',
}

/** `core.user_status`. */
export enum UserStatusName {
  Active = 'active',
  Locked = 'locked',
  Disabled = 'disabled',
}

/** `core.document_kind` — every stored file, uploaded or generated. */
export enum DocumentKindName {
  Contract = 'contract',
  AsBuilt = 'as_built',
  FloorPlan = 'floor_plan',
  Certificate = 'certificate',
  Warranty = 'warranty',
  MeterPhoto = 'meter_photo',
  InspectionPhoto = 'inspection_photo',
  ServicePhoto = 'service_photo',
  Slip = 'slip',
  IdDocument = 'id_document',
  Logo = 'logo',
  PdfInvoice = 'pdf_invoice',
  PdfReceipt = 'pdf_receipt',
  PdfTaxInvoice = 'pdf_tax_invoice',
  PdfNote = 'pdf_note',
  PdfStatement = 'pdf_statement',
  PdfReport = 'pdf_report',
  UtilityInvoice = 'utility_invoice',
  Export = 'export',
  OtaArtifact = 'ota_artifact',
  LogBundle = 'log_bundle',
  TariffSource = 'tariff_source',
  Other = 'other',
  Signature = 'signature',
  ListingPhoto = 'listing_photo',
  InspectionReport = 'inspection_report',
}

/** Owner console menu keys (`src/core/rbac/menu.ts` OWNER_MENU; a unit test keeps them in step). */
export enum OwnerMenuKey {
  Portfolio = 'portfolio',
  Listings = 'listings',
  Dashboard = 'dashboard',
  Buildings = 'buildings',
  Units = 'units',
  Parties = 'parties',
  Leases = 'leases',
  Deposits = 'deposits',
  Readings = 'readings',
  Devices = 'devices',
  RatePlans = 'rate_plans',
  Invoices = 'invoices',
  Payments = 'payments',
  Reports = 'reports',
  UtilityLoss = 'utility_loss',
  ServiceRequests = 'service_requests',
  Access = 'access',
  Parcels = 'parcels',
  Announcements = 'announcements',
  Members = 'members',
  BankAccounts = 'bank_accounts',
  Settings = 'settings',
  Notifications = 'notifications',
  Privacy = 'privacy',
  AccessGrants = 'access_grants',
  SupportAccess = 'support_access',
  AuditLog = 'audit_log',
  Subscription = 'subscription',
}

/** Staff PWA menu keys (STAFF_MENU). */
export enum StaffMenuKey {
  Readings = 'readings',
  ReadingRounds = 'reading_rounds',
  Inspections = 'inspections',
  Installs = 'installs',
  ServiceRequests = 'service_requests',
  Parcels = 'parcels',
}

/** Platform admin menu keys (ADMIN_MENU). */
export enum AdminMenuKey {
  Tenants = 'tenants',
  Listings = 'listings',
  PlatformUsers = 'platform_users',
  UtilityTariffs = 'utility_tariffs',
  Settings = 'settings',
  FeatureFlags = 'feature_flags',
  Devices = 'devices',
  OtaReleases = 'ota_releases',
  SupportGrants = 'support_grants',
  Subscriptions = 'subscriptions',
  NotificationTemplates = 'notification_templates',
  Outbox = 'outbox',
  IngestDeadLetters = 'ingest_dead_letters',
  DataSubjectRequests = 'data_subject_requests',
  IntegrationEvents = 'integration_events',
  AuditLog = 'audit_log',
  AiUsage = 'ai_usage',
}

/** What the resident app shows in its bottom navigation and home tiles (D-063). */
export enum ResidentEntitlement {
  Bills = 'bills',
  Usage = 'usage',
  ServiceRequests = 'service_requests',
  Lease = 'lease',
  Announcements = 'announcements',
  Parcels = 'parcels',
  /** Facility bookings (B5.3): module.community and a bookable facility in one of my buildings (LIFF #27). */
  Facilities = 'facilities',
  /** Door codes and unlock log (B5.2): module.smart_access and an active lock on one of my units (LIFF #27). */
  Access = 'access',
}

// ------------------------------------------------------------------------------------------- B4 billing & payments

/** `ops.invoice_status` (D-040, D-044): draft → issued → partially_paid / overdue → paid; void before any payment. */
export enum InvoiceStatusName {
  Draft = 'draft',
  Issued = 'issued',
  PartiallyPaid = 'partially_paid',
  Paid = 'paid',
  Overdue = 'overdue',
  Void = 'void',
}

/** `ops.payment_status` (schema-design §4.2.4; payments arrive in B4.4). */
export enum PaymentStatusName {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Failed = 'failed',
  Refunded = 'refunded',
  Reversed = 'reversed',
}

/** `ops.invoice_line_source_type` (D-151). */
export enum InvoiceLineSourceTypeName {
  Rent = 'rent',
  Meter = 'meter',
  CommonFee = 'common_fee',
  Fund = 'fund',
  Penalty = 'penalty',
  Service = 'service',
  Deposit = 'deposit',
  Adjustment = 'adjustment',
}

/** `ops.invoice_line_kind` (D-041; catalogue `ops.invoice_line_kind_rule`). */
export enum InvoiceLineKindName {
  Rent = 'rent',
  Electricity = 'electricity',
  Water = 'water',
  Internet = 'internet',
  Parking = 'parking',
  Cleaning = 'cleaning',
  Furniture = 'furniture',
  CommonFee = 'common_fee',
  Fund = 'fund',
  WaterMinimum = 'water_minimum',
  OtherFixed = 'other_fixed',
  OneOff = 'one_off',
  LateFee = 'late_fee',
  EstimateSettlement = 'estimate_settlement',
  PriorBalance = 'prior_balance',
  Discount = 'discount',
  DepositOffset = 'deposit_offset',
  ServiceChargeWork = 'service_charge_work',
}

/** `ops.billing_cycle_status` (D-031). */
export enum BillingCycleStatusName {
  Open = 'open',
  ReadingsPending = 'readings_pending',
  Computed = 'computed',
  Issued = 'issued',
  Closed = 'closed',
  Cancelled = 'cancelled',
}

/** `ops.rate_plan_kind` (D-151). */
export enum RatePlanKindName {
  Power = 'power',
  Water = 'water',
  CommonFee = 'common_fee',
  Fund = 'fund',
  Rent = 'rent',
  Service = 'service',
}

/** `ops.rate_basis`. */
export enum RateBasisName {
  PerUnit = 'per_unit',
  PerSqm = 'per_sqm',
  PerOwnershipRatio = 'per_ownership_ratio',
  Fixed = 'fixed',
}

/** `ops.note_reason` (credit / debit notes, D-040). */
export enum NoteReasonName {
  ReadingCorrection = 'reading_correction',
  TariffCorrection = 'tariff_correction',
  Goodwill = 'goodwill',
  Duplicate = 'duplicate',
  EstimateSettlement = 'estimate_settlement',
  Other = 'other',
}

/** `ops.invoice_charge_status` (one-off charges queued for the next invoice). */
export enum InvoiceChargeStatusName {
  Pending = 'pending',
  Applied = 'applied',
  Cancelled = 'cancelled',
}

/** `ops.estimate_policy` (D-031). */
export enum EstimatePolicyName {
  Allow = 'allow',
  Block = 'block',
}
