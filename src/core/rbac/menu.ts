/**
 * Menu entitlements (`GET /v1/{owner,staff,admin}/me`, B1.3): what the web app shows, decided by the backend from
 * permissions (D-090/D-091), the tenant type (D-150) and feature flags. Keys are stable identifiers the web maps to
 * routes; adding an entry is additive.
 */
/** `condo_juristic` is the deprecated alias of `juristic` (asset-core 0.8.0 stores `juristic`, D-J01). */
export type TenantTypeKey =
  'apartment' | 'condo_juristic' | 'juristic' | 'pm_company' | 'landlord' | 'agency';

export interface MenuEntry {
  key: string;
  /** Any of these permissions shows the entry. */
  anyOf: readonly string[];
  tenantTypes?: readonly TenantTypeKey[];
  /** Shown only while the flag is on for the tenant. */
  flag?: string;
}

/** Operator tenants that run buildings (everything but the landlord's portfolio-first console, D-251). */
const BUILDING_OPERATORS: readonly TenantTypeKey[] = [
  'apartment',
  'juristic',
  'condo_juristic',
  'pm_company',
];

/** Juristic tenants (and the deprecated alias). */
const JURISTIC: readonly TenantTypeKey[] = ['juristic', 'condo_juristic'];

export const OWNER_MENU: readonly MenuEntry[] = [
  // D-251: a landlord's home is the portfolio of its units across projects, not a building
  { key: 'portfolio', anyOf: ['unit.read'], tenantTypes: ['landlord'] },
  // D-252: listings — landlords first (apartments later for vacant units)
  { key: 'listings', anyOf: ['listing.read'], tenantTypes: ['landlord', 'agency'] },
  // B7.3: the enquiries inbox beside the listings
  { key: 'leads', anyOf: ['listing.read'], tenantTypes: ['landlord', 'agency'] },
  // G2 (D-284, D-293): an agency works on the units owners mandated to it; owners see their mandates and deals
  { key: 'mandated_units', anyOf: ['listing.read'], tenantTypes: ['agency'] },
  { key: 'mandates', anyOf: ['listing.read', 'tenant.grant.manage'], tenantTypes: ['landlord', 'agency'] },
  { key: 'co_broke', anyOf: ['listing.read'], tenantTypes: ['agency'] },
  { key: 'deals', anyOf: ['listing.read'], tenantTypes: ['landlord', 'agency'] },
  { key: 'dashboard', anyOf: ['report.read', 'property.read'], tenantTypes: BUILDING_OPERATORS },
  { key: 'buildings', anyOf: ['property.read'], tenantTypes: BUILDING_OPERATORS },
  { key: 'units', anyOf: ['unit.read'], tenantTypes: BUILDING_OPERATORS },
  { key: 'parties', anyOf: ['party.read'] },
  { key: 'leases', anyOf: ['lease.read'] },
  { key: 'deposits', anyOf: ['deposit.read'] },
  { key: 'readings', anyOf: ['reading.read'] },
  { key: 'devices', anyOf: ['device.read'], tenantTypes: BUILDING_OPERATORS },
  { key: 'rate_plans', anyOf: ['rate_plan.read'] },
  { key: 'invoices', anyOf: ['invoice.read'] },
  { key: 'payments', anyOf: ['payment.read'] },
  { key: 'reports', anyOf: ['report.read', 'export.create'] },
  {
    key: 'utility_loss',
    anyOf: ['report.read'],
    tenantTypes: ['apartment', 'juristic', 'condo_juristic', 'pm_company'],
  },
  { key: 'service_requests', anyOf: ['service_request.read'], flag: 'module.service_requests' },
  { key: 'access', anyOf: ['access.read'], flag: 'module.smart_access', tenantTypes: BUILDING_OPERATORS },
  { key: 'parcels', anyOf: ['parcel.manage'], flag: 'module.community', tenantTypes: BUILDING_OPERATORS },
  {
    key: 'announcements',
    anyOf: ['announcement.manage'],
    flag: 'module.community',
    tenantTypes: BUILDING_OPERATORS,
  },
  // pack J (D-302, D-J20 J-DESIGN §5): juristic console keys whose endpoints exist; later steps add theirs
  { key: 'juristic_register', anyOf: ['juristic.register.read'], tenantTypes: JURISTIC },
  { key: 'juristic_cycles', anyOf: ['invoice.read'], tenantTypes: JURISTIC },
  {
    key: 'juristic_budgets',
    anyOf: ['juristic.budget.read', 'juristic.resolution.read'],
    tenantTypes: JURISTIC,
  },
  // J1.2a (D-306, D-308): payment plans and debt clearance certificates
  { key: 'juristic_payment_plans', anyOf: ['juristic.collections.read'], tenantTypes: JURISTIC },
  { key: 'juristic_debt_clearances', anyOf: ['juristic.collections.read'], tenantTypes: JURISTIC },
  // J1.2b (D-305, D-307, D-326): receivables console, statements, the collections ladder
  { key: 'juristic_receivables', anyOf: ['juristic.collections.read'], tenantTypes: JURISTIC },
  { key: 'juristic_statements', anyOf: ['juristic.collections.read'], tenantTypes: JURISTIC },
  { key: 'juristic_collection_ladder', anyOf: ['juristic.collections.read'], tenantTypes: JURISTIC },
  // J4.1 (D-315, D-327): the gate — juristic estates always; apartments / PM companies once the module is switched on
  { key: 'juristic_gate', anyOf: ['gate.read'], tenantTypes: JURISTIC },
  { key: 'gate', anyOf: ['gate.read'], flag: 'module.gate', tenantTypes: ['apartment', 'pm_company'] },
  // D-270 (J1.2b): a landlord invites its condo's juristic office for its units in a stub
  { key: 'juristic_workspace_invitations', anyOf: ['tenant.grant.manage'], tenantTypes: ['landlord'] },
  { key: 'members', anyOf: ['tenant.member.read'] },
  { key: 'bank_accounts', anyOf: ['tenant.bank_account.manage'] },
  { key: 'settings', anyOf: ['tenant.settings.read'] },
  { key: 'notifications', anyOf: ['notification.route.manage'] },
  { key: 'privacy', anyOf: ['privacy.manage'] },
  { key: 'access_grants', anyOf: ['tenant.grant.manage'] },
  { key: 'support_access', anyOf: ['tenant.support_grant.approve'] },
  { key: 'audit_log', anyOf: ['tenant.audit.read'] },
  { key: 'subscription', anyOf: ['tenant.subscription.read'] },
];

export const STAFF_MENU: readonly MenuEntry[] = [
  { key: 'readings', anyOf: ['reading.capture'] },
  { key: 'reading_rounds', anyOf: ['reading.capture'] },
  { key: 'inspections', anyOf: ['inspection.perform'] },
  { key: 'installs', anyOf: ['device.install'] },
  { key: 'service_requests', anyOf: ['service_request.handle'], flag: 'module.service_requests' },
  { key: 'parcels', anyOf: ['parcel.manage'], flag: 'module.community' },
];

export const ADMIN_MENU: readonly MenuEntry[] = [
  { key: 'tenants', anyOf: ['admin.tenant.read'] },
  { key: 'listings', anyOf: ['admin.listing.moderate', 'admin.listing.verify'] },
  { key: 'guides', anyOf: ['admin.guide.manage'] },
  { key: 'platform_users', anyOf: ['admin.user.manage'] },
  { key: 'utility_tariffs', anyOf: ['admin.utility_tariff.enter', 'admin.utility_tariff.verify'] },
  { key: 'settings', anyOf: ['admin.setting.manage', 'admin.compliance.manage'] },
  { key: 'feature_flags', anyOf: ['admin.feature_flag.manage'] },
  { key: 'devices', anyOf: ['admin.device.manage'] },
  { key: 'ota_releases', anyOf: ['admin.device.manage'] },
  { key: 'support_grants', anyOf: ['admin.support_grant.request', 'admin.support_grant.approve_incident'] },
  { key: 'subscriptions', anyOf: ['admin.subscription.manage'] },
  { key: 'notification_templates', anyOf: ['admin.notification_template.manage'] },
  { key: 'outbox', anyOf: ['admin.outbox.manage'] },
  { key: 'ingest_dead_letters', anyOf: ['admin.device.manage'] },
  { key: 'data_subject_requests', anyOf: ['admin.dsr.manage'] },
  { key: 'integration_events', anyOf: ['admin.integration_event.read'] },
  { key: 'audit_log', anyOf: ['admin.audit.read'] },
  { key: 'ai_usage', anyOf: ['admin.ai_usage.read'] },
];

export function entitledMenu(
  menu: readonly MenuEntry[],
  permissions: ReadonlySet<string>,
  tenantType: TenantTypeKey | null,
  flags: Readonly<Record<string, boolean>>,
): string[] {
  return menu
    .filter((m) => m.anyOf.some((p) => permissions.has(p)))
    .filter((m) => !m.tenantTypes || (tenantType !== null && m.tenantTypes.includes(tenantType)))
    .filter((m) => !m.flag || flags[m.flag] === true)
    .map((m) => m.key);
}
