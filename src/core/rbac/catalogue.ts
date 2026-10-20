/**
 * Roles and the `resource.action` permission catalogue (D-090, D-091; audiences per D-151). The code is the
 * truth: `prisma/seed` mirrors it into platform.role / platform.permission / platform.role_permission and
 * `pnpm rbac:build` renders docs/rbac.md (a unit test fails when the committed file is stale). Guards (`@Can`)
 * arrive in B1.3; later deliverables add permissions here (additive) and re-run the seed.
 *
 * Tenant roles live on core.membership.role; platform roles on platform.platform_role_assignment.
 * Residents and technicians are audiences, not roles (D-090).
 */
export type RoleKey =
  'owner' | 'manager' | 'staff' | 'accountant' | 'platform_admin' | 'support' | 'field_engineer' | 'finance';

export type Surface = 'owner' | 'staff' | 'admin';

export interface RoleDef {
  key: RoleKey;
  scopeKind: 'tenant' | 'platform';
  nameTh: string;
  nameEn: string;
  description: string;
}

export interface PermissionDef {
  key: string;
  description: string;
  surfaces: Surface[];
}

export const ROLES: readonly RoleDef[] = [
  {
    key: 'owner',
    scopeKind: 'tenant',
    nameTh: 'เจ้าของ',
    nameEn: 'Owner',
    description: 'Everything in the tenant (D-090).',
  },
  {
    key: 'manager',
    scopeKind: 'tenant',
    nameTh: 'ผู้จัดการ',
    nameEn: 'Manager',
    description: 'Everything except billing settings, bank account and subscription (D-090).',
  },
  {
    key: 'staff',
    scopeKind: 'tenant',
    nameTh: 'พนักงาน',
    nameEn: 'Staff',
    description:
      'Readings, move-in/out, repairs, parcels, device installs; no money (D-090). May be limited to buildings.',
  },
  {
    key: 'accountant',
    scopeKind: 'tenant',
    nameTh: 'นักบัญชี',
    nameEn: 'Accountant',
    description: 'Read invoices/payments/exports, issue documents, no settings (D-090).',
  },
  {
    key: 'platform_admin',
    scopeKind: 'platform',
    nameTh: 'ผู้ดูแลแพลตฟอร์ม',
    nameEn: 'Platform admin',
    description: 'Collective Group platform administration (D-090, D-161).',
  },
  {
    key: 'support',
    scopeKind: 'platform',
    nameTh: 'ฝ่ายสนับสนุน',
    nameEn: 'Support',
    description: 'Read-only into a tenant with a time-boxed, logged support grant (D-090).',
  },
  {
    key: 'field_engineer',
    scopeKind: 'platform',
    nameTh: 'วิศวกรภาคสนาม',
    nameEn: 'Field engineer',
    description: 'Device fleet, installs (D-090, D-033).',
  },
  {
    key: 'finance',
    scopeKind: 'platform',
    nameTh: 'การเงิน',
    nameEn: 'Finance',
    description: 'Subscriptions and platform AR (D-090, D-091).',
  },
];

/** The catalogue. Keys are `resource.action`; tenant permissions are used on /v1/owner and /v1/staff, platform ones on /v1/admin. */
export const PERMISSIONS: readonly PermissionDef[] = [
  // tenant & membership
  {
    key: 'tenant.read',
    description: 'View the tenant profile and company data',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'tenant.update',
    description: 'Edit company data (legal name, tax id, address, logo)',
    surfaces: ['owner'],
  },
  {
    key: 'tenant.bank_account.manage',
    description: 'Add/change receiving bank accounts (Owner OTP, D-091)',
    surfaces: ['owner'],
  },
  { key: 'tenant.member.read', description: 'List members and invitations', surfaces: ['owner'] },
  { key: 'tenant.member.invite', description: 'Invite members', surfaces: ['owner'] },
  {
    key: 'tenant.member.manage',
    description: 'Change roles, building scopes, remove members',
    surfaces: ['owner'],
  },
  { key: 'tenant.settings.read', description: 'View tenant settings', surfaces: ['owner', 'staff'] },
  {
    key: 'tenant.settings.update',
    description: 'Edit operational tenant settings (reminders, quiet hours, readings)',
    surfaces: ['owner'],
  },
  {
    key: 'tenant.billing_settings.update',
    description: 'Edit billing settings (cut-off, estimate policy, late fee, rate plans)',
    surfaces: ['owner'],
  },
  {
    key: 'tenant.subscription.read',
    description: 'View the subscription and platform invoices',
    surfaces: ['owner'],
  },
  { key: 'tenant.subscription.manage', description: 'Change plan, cancel (D-082)', surfaces: ['owner'] },
  { key: 'tenant.audit.read', description: 'Read the tenant audit log', surfaces: ['owner'] },
  {
    key: 'tenant.support_grant.approve',
    description: 'Approve or revoke Support access (D-090)',
    surfaces: ['owner'],
  },
  {
    key: 'tenant.grant.manage',
    description: 'Create/revoke asset access grants for the tenant’s buildings (D-152)',
    surfaces: ['owner'],
  },
  // asset core
  { key: 'property.read', description: 'View properties and buildings', surfaces: ['owner', 'staff'] },
  {
    key: 'property.manage',
    description: 'Create/edit properties, buildings and floors',
    surfaces: ['owner'],
  },
  { key: 'unit.read', description: 'View units', surfaces: ['owner', 'staff'] },
  { key: 'unit.manage', description: 'Create/edit units, unit profiles', surfaces: ['owner'] },
  {
    key: 'party.read',
    description: 'View parties (lessees, owners, co-occupants)',
    surfaces: ['owner', 'staff'],
  },
  { key: 'party.manage', description: 'Create/edit parties', surfaces: ['owner', 'staff'] },
  {
    key: 'party.pii.decrypt',
    description: 'Reveal ID/passport numbers and emergency-contact phones (audited, D-148, D-172)',
    surfaces: ['owner'],
  },
  {
    key: 'party.id_document.read',
    description: 'List and download ID document images (every download audited, D-025, D-172)',
    surfaces: ['owner'],
  },
  {
    key: 'party.link.manage',
    description: 'Unlink a resident login (LINE/phone) from a party — the Owner approval of D-061/D-172',
    surfaces: ['owner'],
  },
  {
    key: 'asset_item.read',
    description: 'View meters, gateways, locks and other asset items',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'asset_item.manage',
    description: 'Create/edit asset items and meter assignments',
    surfaces: ['owner', 'staff'],
  },
  { key: 'document.read', description: 'Download documents of the tenant', surfaces: ['owner', 'staff'] },
  { key: 'document.upload', description: 'Upload documents and photos', surfaces: ['owner', 'staff'] },
  // A1 leases & occupants
  { key: 'lease.read', description: 'View leases', surfaces: ['owner', 'staff'] },
  { key: 'lease.manage', description: 'Create, sign, renew, end leases', surfaces: ['owner'] },
  { key: 'deposit.read', description: 'View deposits and settlements', surfaces: ['owner'] },
  {
    key: 'deposit.settle',
    description: 'Propose and agree deposit settlements (D-023)',
    surfaces: ['owner'],
  },
  {
    key: 'inspection.perform',
    description: 'Move-in/move-out inspections with photos',
    surfaces: ['owner', 'staff'],
  },
  // A3 metering
  { key: 'reading.read', description: 'View meter readings and usage', surfaces: ['owner', 'staff'] },
  {
    key: 'reading.capture',
    description: 'Capture manual/OCR readings with photos (D-035)',
    surfaces: ['owner', 'staff'],
  },
  { key: 'reading.review', description: 'Review readings in the review queue', surfaces: ['owner'] },
  {
    key: 'device.install',
    description: 'Install and provision devices (staff PWA, D-033)',
    surfaces: ['staff', 'owner'],
  },
  {
    key: 'device.read',
    description: 'View devices, gateways and their health (D-033)',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'device.command',
    description: 'Send read_now / restart / identify / upload_logs to a gateway (D-131)',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'utility_invoice.manage',
    description: 'Enter or import the utility (MEA/PEA/MWA/PWA) invoices of a building (D-032)',
    surfaces: ['owner'],
  },
  // A2 billing & money
  { key: 'rate_plan.read', description: 'View rate plans', surfaces: ['owner'] },
  {
    key: 'rate_plan.manage',
    description: 'Edit rate plans (tariff-cap warning, D-021a)',
    surfaces: ['owner'],
  },
  {
    key: 'compliance.acknowledge',
    description: 'Acknowledge a compliance warning (D-021a)',
    surfaces: ['owner'],
  },
  { key: 'invoice.read', description: 'View invoices', surfaces: ['owner'] },
  { key: 'invoice.issue', description: 'Run billing cycles and issue invoices', surfaces: ['owner'] },
  {
    key: 'invoice.void',
    description: 'Void/credit invoices (credit and debit notes, D-040)',
    surfaces: ['owner'],
  },
  { key: 'payment.read', description: 'View payments and receipts', surfaces: ['owner'] },
  { key: 'payment.record', description: 'Record manual payments, review slips (D-043)', surfaces: ['owner'] },
  { key: 'receipt.issue', description: 'Issue receipts and tax invoices', surfaces: ['owner'] },
  {
    key: 'export.create',
    description: 'Exports (Excel, FlowAccount, PEAK, VAT report)',
    surfaces: ['owner'],
  },
  { key: 'report.read', description: 'Dashboards, arrears, utility loss', surfaces: ['owner'] },
  // A4 service & community (R2)
  { key: 'service_request.read', description: 'View repair requests', surfaces: ['owner', 'staff'] },
  {
    key: 'service_request.handle',
    description: 'Triage, assign and close repair requests',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'service_category.manage',
    description: 'Repair categories and their SLA hours (D-072)',
    surfaces: ['owner'],
  },
  {
    key: 'maintenance_plan.manage',
    description: 'Preventive maintenance plans of equipment (B5.1)',
    surfaces: ['owner'],
  },
  { key: 'parcel.manage', description: 'Record parcels and pick-ups', surfaces: ['owner', 'staff'] },
  // A3/R2 access control (B5.2)
  {
    key: 'access.read',
    description: 'Locks, credentials and the unlock log of my buildings (D-070, D-025)',
    surfaces: ['owner'],
  },
  {
    key: 'access.manage',
    description:
      'Register locks, issue visitor / staff codes, revoke credentials with a reason (D-070, D-071)',
    surfaces: ['owner'],
  },
  { key: 'announcement.manage', description: 'Post announcements', surfaces: ['owner'] },
  {
    key: 'community.read',
    description: 'Facilities and bookings, building rules and contacts (D-073)',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'community.manage',
    description: 'Facilities, booking decisions, building rule versions and contacts (D-073)',
    surfaces: ['owner'],
  },
  // platform services in the tenant (B1.3)
  {
    key: 'notification.route.manage',
    description: 'Configure which resident-facing events notify through which channels (B1.3 routing matrix)',
    surfaces: ['owner'],
  },
  {
    key: 'privacy.manage',
    description: 'Handle data subject requests as controller and record paper consents (D-025)',
    surfaces: ['owner'],
  },
  // platform (/v1/admin)
  { key: 'admin.tenant.read', description: 'List and view tenants', surfaces: ['admin'] },
  {
    key: 'admin.tenant.manage',
    description: 'Create, onboard, deactivate tenants (D-161)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.user.manage',
    description: 'Manage platform users and role assignments',
    surfaces: ['admin'],
  },
  {
    key: 'admin.setting.manage',
    description: 'Edit platform settings and per-tenant overrides',
    surfaces: ['admin'],
  },
  {
    key: 'admin.compliance.manage',
    description: 'Set compliance severities platform-wide or per tenant (D-021a)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.utility_tariff.enter',
    description: 'Enter utility tariff versions (maker)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.utility_tariff.verify',
    description: 'Verify and publish utility tariff versions (checker)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.support_grant.request',
    description: 'Request a support grant into a tenant',
    surfaces: ['admin'],
  },
  {
    key: 'admin.support_grant.approve_incident',
    description: 'Approve a support grant for an incident without the Owner',
    surfaces: ['admin'],
  },
  { key: 'admin.audit.read', description: 'Read the platform audit log', surfaces: ['admin'] },
  { key: 'admin.dsr.manage', description: 'Handle data subject requests (D-025)', surfaces: ['admin'] },
  {
    key: 'admin.device.manage',
    description: 'Device fleet, provisioning codes, OTA rings (D-033, D-131)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.subscription.manage',
    description: 'Price plans, subscriptions, pilot agreements (D-156, D-083)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.platform_invoice.issue',
    description: 'Issue platform invoices and receipts',
    surfaces: ['admin'],
  },
  {
    key: 'admin.platform_credit_note.approve',
    description: 'Approve platform credit notes (maker-checker, D-091)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.integration_event.read',
    description: 'List integration events and overdue acks (D-153)',
    surfaces: ['admin'],
  },
  { key: 'admin.ai_usage.read', description: 'AI usage cost per tenant (D-161)', surfaces: ['admin'] },
  {
    key: 'admin.outbox.manage',
    description: 'List dead letters of the outbox and its subscribers, replay them (B1.3)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.notification_template.manage',
    description: 'Edit, preview, test-send and publish notification templates (B1.3)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.feature_flag.manage',
    description: 'Change feature flag defaults and per-tenant overrides',
    surfaces: ['admin'],
  },
  {
    key: 'admin.building.manage',
    description: 'Change the operator of a building between tenants (schema-design §4.6)',
    surfaces: ['admin'],
  },
];

const tenantKeys = PERMISSIONS.filter((p) => !p.key.startsWith('admin.')).map((p) => p.key);
const MANAGER_EXCLUDED = new Set([
  'tenant.update',
  'tenant.bank_account.manage',
  'tenant.billing_settings.update',
  'tenant.subscription.manage',
  'tenant.member.manage',
  'tenant.support_grant.approve',
  'tenant.grant.manage',
  'rate_plan.manage',
  'party.link.manage',
  'privacy.manage',
]);

/** Role → permission keys (D-090). */
export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly string[]>> = {
  owner: tenantKeys,
  manager: tenantKeys.filter((k) => !MANAGER_EXCLUDED.has(k)),
  staff: [
    'tenant.read',
    'tenant.settings.read',
    'property.read',
    'unit.read',
    'party.read',
    'party.manage',
    'asset_item.read',
    'asset_item.manage',
    'document.read',
    'document.upload',
    'lease.read',
    'inspection.perform',
    'reading.read',
    'reading.capture',
    'device.install',
    'device.read',
    'device.command',
    'service_request.read',
    'service_request.handle',
    'parcel.manage',
    'community.read',
  ],
  accountant: [
    'tenant.read',
    'tenant.settings.read',
    'property.read',
    'unit.read',
    'party.read',
    'document.read',
    'lease.read',
    'deposit.read',
    'reading.read',
    'device.read',
    'utility_invoice.manage',
    'rate_plan.read',
    'invoice.read',
    'invoice.issue',
    'payment.read',
    'receipt.issue',
    'export.create',
    'report.read',
  ],
  platform_admin: PERMISSIONS.filter((p) => p.key.startsWith('admin.')).map((p) => p.key),
  support: ['admin.tenant.read', 'admin.support_grant.request', 'admin.integration_event.read'],
  field_engineer: ['admin.tenant.read', 'admin.device.manage'],
  finance: [
    'admin.tenant.read',
    'admin.subscription.manage',
    'admin.platform_invoice.issue',
    'admin.platform_credit_note.approve',
    'admin.ai_usage.read',
  ],
};

/** `resource.action` → its resource and action (the key's last dot separates them). */
export function splitPermission(key: string): { resource: string; action: string } {
  const at = key.lastIndexOf('.');
  return { resource: key.slice(0, at), action: key.slice(at + 1) };
}

/** Renders docs/rbac.md from the catalogue (deterministic). */
export function renderRbacMarkdown(): string {
  const roles = ROLES.map((r) => r.key);
  const lines = [
    '# RBAC — roles and permissions (generated)',
    '',
    '> GENERATED by `pnpm rbac:build` from `src/core/rbac/catalogue.ts` — do not edit by hand. D-090 (roles), D-091 (catalogue, maker-checker), D-151 (audiences). Residents and technicians are audiences, not roles.',
    '',
    '## Roles',
    '| Key | Scope | Name (th) | Name (en) | Description |',
    '|---|---|---|---|---|',
    ...ROLES.map((r) => `| \`${r.key}\` | ${r.scopeKind} | ${r.nameTh} | ${r.nameEn} | ${r.description} |`),
    '',
    `## Permissions (${PERMISSIONS.length})`,
    `| Permission | Surfaces | ${roles.join(' | ')} | Description |`,
    `|---|---|${roles.map(() => ':-:').join('|')}|---|`,
    ...PERMISSIONS.map((p) => {
      const cells = roles.map((r) => (ROLE_PERMISSIONS[r].includes(p.key) ? '✓' : ''));
      return `| \`${p.key}\` | ${p.surfaces.join(', ')} | ${cells.join(' | ')} | ${p.description} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
