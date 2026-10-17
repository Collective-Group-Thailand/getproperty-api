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
  'public.system': `${SURFACE_DESCRIPTIONS[SURFACES.public]} System: ping.`,
  'public.plans':
    'Price plans of the platform for the public pricing page (D-156; Proposed until the pilot).',
  'public.utilityTariffs':
    'The published utility ceiling per unit for the landing-page loss calculator (D-021a, D-140).',
  'auth.operator':
    'Operator sign-in (owner console, staff PWA): SMS OTP with invitation acceptance, email + password (+ TOTP when enabled) — contract §4, D-090.',
  'auth.resident':
    'Resident sign-in from the LINE Mini App: LIFF id-token exchange with party linking, SMS OTP fallback (D-060, D-154).',
  'auth.technician': 'Technician sign-in from the LINE Mini App (work-order scopes arrive with B5, R2).',
  'auth.platform':
    'Collective staff sign-in: email + password + mandatory TOTP, enrolment on first sign-in (D-161).',
  'auth.sessions':
    'Refresh-token rotation with reuse detection, logout, JWKS (EdDSA) and the web-push public key (contract §4).',
  'device.identity':
    'Device JWT from the mTLS client certificate and certificate renewal (D-130, D-165; edge CR-002/CR-003).',
  'device.logs': 'Log bundle uploads for the `upload_logs` command (D-131; edge CR-004).',
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
  'owner.search':
    'Global search of the owner console top bar: buildings, units, parties, leases, devices (D-152).',
  'owner.telemetry': 'Real-user Web Vitals of the owner console, forwarded by its BFF (D-179).',
  'staff.telemetry': 'Real-user Web Vitals of the staff PWA, forwarded by its BFF (D-179).',
  'admin.telemetry': 'Real-user Web Vitals of the admin zone, forwarded by its BFF (D-179).',
  'resident.pushSubscriptions': 'Web push (VAPID) subscriptions of the resident app (D-063).',
  'resident.link': 'Link my login to a party from an invitation code (QR/SMS deep link, D-061).',
  'owner.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  'owner.properties': 'Properties: groups of buildings managed together (D-151).',
  'owner.buildings': 'Buildings the tenant owns, operates or holds a grant for (D-151, D-152).',
  'owner.floors': 'Floors of a building (B2.1).',
  'owner.unitBoard': 'The unit board of a building: floors with unit cards (B2.1, D-100).',
  'owner.units':
    'Units: create (one or floor × pattern), edit, status override, subscription count (D-082, D-151).',
  'owner.unitProfiles': 'Room types: default rent, deposit/advance months and lease lines (D-041).',
  'owner.utilityAccounts': 'The building’s MEA/PEA/MWA/PWA accounts (D-032).',
  'owner.meters': 'Meter positions: one meter per unit and utility, common-area and main meters (D-012).',
  'owner.assetItems': 'Appliances and furniture of units (contract annex, inspections).',
  'owner.unitImports': 'Excel template, preview and import of units; Excel export (D-014).',
  'owner.parties':
    'People and companies: lessees, co-tenants, guarantors; sealed ID numbers, ID document images, resident login links (D-148, D-151, D-172).',
  'owner.leases':
    'Leases on the สคบ. 2568 standard contract: drafts with compliance checks, contract PDF, e-signature and countersignature, activation, notices, move-out, termination, renewal, resident invitations (D-020, D-023, D-061, D-062).',
  'owner.leaseTemplates': 'The standard contract templates and the addendum clause types they allow (D-020).',
  'resident.leases': 'My leases: contract, e-signature with OTP + LINE, 30-day notice (D-020, D-062).',
  'resident.invitations': 'Lease invitations: preview and accept after the PDPA consents (D-025, D-061).',
  'owner.deposits':
    'Deposits: receipt, the 7-day settlement with itemised deductions and evidence, refund and statement, late flags (D-023, D-159).',
  'owner.inspections': 'Move-in / move-out inspections with photos, meter registers and signatures (D-023).',
  'staff.inspections': 'Move-in / move-out inspections done by staff on the PWA (D-023).',
  'resident.deposits': 'My deposits: the proposed settlement with its evidence, accept or dispute (D-023).',
  'staff.parties': 'People and companies captured by staff at move-in (D-151).',
  'resident.privacy': 'What the controllers hold about me, my consents and PDPA requests (D-025).',
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
  'admin.devices':
    'Device fleet: registration, inventory import, assignment, fleet counts, OTA rings, certificate revocation, retirement, provisioning codes and commands (D-033, D-130, D-131).',
  'admin.buildings': 'Building operator changes (D-152).',
  'admin.notifications': 'In-app inbox of the platform user.',
  'admin.pushSubscriptions': 'Web push (VAPID) subscriptions of the admin browser.',
  'admin.realtime': 'Realtime auth and the server-sent events stream (contract §6).',
  // B3 smart metering
  'owner.devices':
    'Gateways and meter devices of my buildings: health, channels, config versions, events, commands (D-033, D-034, D-131).',
  'staff.devices':
    'Gateways and meter devices of my buildings for field work: health and commands (D-033, D-131).',
  'owner.deviceInstalls':
    'Gateway provisioning from its QR, meter device install / removal with photo readings, meter swaps (D-033).',
  'staff.deviceInstalls':
    'Field work in the staff PWA: provision a gateway, install or remove a meter device, swap a meter (D-033).',
  'owner.meterReadings':
    'Meter readings (IoT, OCR, manual), usage series from the rollups and the reading rounds (D-012, D-030, D-035, D-162).',
  'staff.meterReadings':
    'Staff readings with photo + OCR, the reading round before the cut-off, usage series (D-031, D-035).',
  'owner.readingReviews':
    'Review queue: accept, correct (superseding reading, D-142) or reject doubtful readings (D-035).',
  'owner.utilityInvoices':
    'The building’s MEA/PEA/MWA/PWA invoices: manual entry, OCR prefill, e-bill import (D-032).',
  'owner.loss':
    'Utility loss per billing period with suspects and trend (D-032); billed units from readings until B4.',
  'resident.usage': 'My daily usage from the meters of my leased unit (D-063).',
  'device.config':
    'The gateway’s compiled configuration (cold start; also retained on MQTT, device protocol §3).',
  'device.ota': 'The signed OTA manifest for `ota_apply` (edge CR-011, D-131).',
  'device.readings': 'HTTPS batch fallback for buffered telemetry (edge CR-009, api-conventions §7).',
  'admin.ota': 'OTA releases (signed manifests) and ring-by-ring rollouts (D-131).',
  'admin.ingest': 'Ingest dead letters (refused MQTT / HTTPS payloads) and replay (D-162).',
  'webhooks.placeholder':
    'PLACEHOLDER provider callback shape (payload, signature header, expected response); the real providers (payment QR, slip verification, LINE) arrive in B4.',
};
