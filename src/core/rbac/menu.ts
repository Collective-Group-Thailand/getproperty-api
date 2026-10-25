/**
 * Menu entitlements (`GET /v1/{owner,staff,admin}/me`, B1.3): what the web app shows, decided by the backend from
 * permissions (D-090/D-091), the tenant type (D-150) and feature flags. Keys are stable identifiers the web maps to
 * routes; adding an entry is additive.
 */
export type TenantTypeKey = 'apartment' | 'condo_juristic' | 'pm_company' | 'landlord';

export interface MenuEntry {
  key: string;
  /** Any of these permissions shows the entry. */
  anyOf: readonly string[];
  tenantTypes?: readonly TenantTypeKey[];
  /** Shown only while the flag is on for the tenant. */
  flag?: string;
}

/** Operator tenants that run buildings (everything but the landlord's portfolio-first console, D-251). */
const BUILDING_OPERATORS: readonly TenantTypeKey[] = ['apartment', 'condo_juristic', 'pm_company'];

export const OWNER_MENU: readonly MenuEntry[] = [
  // D-251: a landlord's home is the portfolio of its units across projects, not a building
  { key: 'portfolio', anyOf: ['unit.read'], tenantTypes: ['landlord'] },
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
  { key: 'utility_loss', anyOf: ['report.read'], tenantTypes: ['apartment', 'condo_juristic', 'pm_company'] },
  { key: 'service_requests', anyOf: ['service_request.read'], flag: 'module.service_requests' },
  { key: 'access', anyOf: ['access.read'], flag: 'module.smart_access', tenantTypes: BUILDING_OPERATORS },
  { key: 'parcels', anyOf: ['parcel.manage'], flag: 'module.community', tenantTypes: BUILDING_OPERATORS },
  {
    key: 'announcements',
    anyOf: ['announcement.manage'],
    flag: 'module.community',
    tenantTypes: BUILDING_OPERATORS,
  },
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
