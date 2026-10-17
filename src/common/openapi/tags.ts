import { SURFACE_DESCRIPTIONS, SURFACES } from '../../surfaces/surfaces';

/**
 * Every OpenAPI tag with its description (contract §5). An operation tag missing here fails the
 * contract build. Tags are `<surface>.<resource>` (`owner.bills`) or `ops.<area>`.
 * Business modules add their tags here in their own deliverable (B2–B6).
 */
export const API_TAGS: Record<string, string> = {
  'ops.health': 'Liveness and readiness of the API and its dependencies, for load balancers and ops.',
  'auth.system': `${SURFACE_DESCRIPTIONS[SURFACES.auth]} System: ping.`,
  'owner.system': `${SURFACE_DESCRIPTIONS[SURFACES.owner]} System: ping.`,
  'staff.system': `${SURFACE_DESCRIPTIONS[SURFACES.staff]} System: ping.`,
  'resident.system': `${SURFACE_DESCRIPTIONS[SURFACES.resident]} System: ping.`,
  'technician.system': `${SURFACE_DESCRIPTIONS[SURFACES.technician]} Placeholder until B5 (ping only).`,
  'admin.system': `${SURFACE_DESCRIPTIONS[SURFACES.admin]} System: ping and build information.`,
  'device.system': `${SURFACE_DESCRIPTIONS[SURFACES.device]} System: ping.`,
  'webhooks.system': `${SURFACE_DESCRIPTIONS[SURFACES.webhooks]} Placeholder until B4 (ping only).`,
  'auth.operator':
    'Operator sign-in (owner console, staff PWA): SMS OTP with invitation acceptance, email + password (+ TOTP when enabled) — contract §4, D-090.',
  'auth.resident':
    'Resident sign-in from the LINE Mini App: LIFF id-token exchange with party linking, SMS OTP fallback (D-060, D-154).',
  'auth.technician': 'Technician sign-in from the LINE Mini App (work-order scopes arrive with B5, R2).',
  'auth.platform':
    'Collective staff sign-in: email + password + mandatory TOTP, enrolment on first sign-in (D-161).',
  'auth.sessions':
    'Refresh-token rotation with reuse detection, logout, JWKS (EdDSA) and the web-push public key (contract §4).',
  'device.bootstrap':
    'Gateway first boot: provisioning code + CSR → certificate from the platform CA, device JWT and MQTT ACL (D-130).',
  'owner.me':
    'Who I am in the owner console: tenants, current tenant and type, role, permissions, menu entitlements, feature flags, subscription state; password and TOTP setup.',
  'owner.tenant': 'Company data of the current tenant (D-050, D-151).',
  'owner.members': 'People working for the tenant: roles and building limits (D-090).',
  'owner.invitations': 'Invitations of operators by SMS, QR or link (D-145).',
  'owner.bankAccounts':
    'Receiving bank accounts; changes are confirmed by an OTP to the Owner (D-042, D-091).',
  'owner.settings': 'Effective-dated tenant and property settings (ADR-0004, D-144).',
  'owner.utilityTariffs':
    'The utility tariff in force — the สคบ. 2568 cap reference with its effective average rate (D-021a, D-140).',
  'owner.complianceAcknowledgements': 'Owner acknowledgements of compliance warnings (D-021a, contract §3).',
  'owner.supportGrants':
    'Time-boxed access of Collective support to the tenant, approved by the Owner (D-090).',
  'owner.assetGrants': 'Cross-tenant access to buildings and units per module (D-152).',
  'owner.auditLog': 'Security, money and PDPA-relevant actions of the tenant (D-025, D-090).',
  'owner.dataSubjectRequests': 'PDPA requests addressed to the tenant as controller (D-025, D-159).',
  'owner.notificationRoutes': 'Which channels resident notifications use (routing matrix, D-063).',
  'owner.consents': 'Operator consents to platform terms and notices (D-025).',
  'owner.files': 'Uploads and signed downloads (contract §3 Files).',
  'owner.notifications': 'In-app inbox of the signed-in operator.',
  'owner.pushSubscriptions': 'Web push (VAPID) subscriptions of the browser.',
  'owner.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  'staff.me': 'Who I am in the staff PWA: tenant, role, building limits, permissions, menu.',
  'staff.files': 'Uploads and signed downloads limited to my buildings (contract §3 Files).',
  'staff.notifications': 'In-app inbox of the signed-in staff member.',
  'staff.pushSubscriptions': 'Web push (VAPID) subscriptions of the staff PWA.',
  'staff.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  'resident.me': 'Who I am in the LINE Mini App: leases, units, language, consent state (D-060, D-154).',
  'resident.consents': 'PDPA consents of the resident (D-025).',
  'resident.dataSubjectRequests': 'PDPA requests filed by the resident (D-025).',
  'resident.notifications': 'In-app inbox of the resident.',
  'resident.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  'technician.me': 'Who I am as a technician (work orders arrive with B5, R2).',
  'technician.notifications': 'In-app inbox of the technician.',
  'admin.me': 'Who I am in the platform admin zone: roles, permissions, menu, TOTP state (D-161).',
  'admin.tenants':
    'Tenant onboarding and administration; tenant data only under a support grant (D-090, D-161).',
  'admin.supportGrants': 'Support access requests and incident approvals (D-090).',
  'admin.platformUsers': 'Collective staff accounts and platform roles (D-161).',
  'admin.settings': 'Platform defaults of configurable business values (ADR-0004).',
  'admin.featureFlags': 'Feature flags and tenant overrides.',
  'admin.auditLog': 'Platform-wide audit log (D-161).',
  'admin.dataSubjectRequests': 'PDPA requests across tenants (D-025).',
  'admin.workflowDefinitions': 'Workflow engine definitions and SLA rules (D-159).',
  'admin.utilityTariffs': 'Utility tariff versions: enter → verify by a second user → publish (D-021a).',
  'admin.outbox': 'Event relay dead letters and replay (B1.3).',
  'admin.notificationTemplates': 'Notification templates: versions, preview, publish, test send.',
  'admin.devices': 'Device fleet registration and gateway provisioning codes (D-130).',
  'admin.buildings': 'Building operator changes (D-152).',
  'admin.notifications': 'In-app inbox of the platform user.',
  'admin.pushSubscriptions': 'Web push (VAPID) subscriptions of the admin browser.',
  'admin.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  'webhooks.placeholder':
    'PLACEHOLDER provider callback shape (payload, signature header, expected response); the real providers (payment QR, slip verification, LINE) arrive in B4.',
};
