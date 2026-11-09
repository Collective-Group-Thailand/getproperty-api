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
  | 'owner'
  | 'manager'
  | 'staff'
  | 'accountant'
  | 'committee'
  | 'auditor'
  | 'guard'
  | 'platform_admin'
  | 'support'
  | 'field_engineer'
  | 'finance';

export type Surface = 'owner' | 'staff' | 'admin' | 'guard';

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
    key: 'committee',
    scopeKind: 'tenant',
    nameTh: 'กรรมการ',
    nameEn: 'Committee',
    description:
      'Juristic committee member: approves budgets and adopts resolutions, reads the register, billing and reports; never moves money (D-320). Juristic tenants only.',
  },
  {
    key: 'auditor',
    scopeKind: 'tenant',
    nameTh: 'ผู้สอบบัญชี',
    nameEn: 'Auditor',
    description:
      'Read-only access to the books, register and reports, time-boxed (`accessUntil`, D-320). Juristic tenants only.',
  },
  {
    key: 'guard',
    scopeKind: 'tenant',
    nameTh: 'เจ้าหน้าที่รักษาความปลอดภัย',
    nameEn: 'Guard',
    description:
      'Gate only (D-320, D-327): records visits on an enrolled gate tablet of the property after a PIN sign-in; created with the guard profile, never invited, no other surface.',
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
    key: 'listing.read',
    description: "See the tenant's rental listings and verifications (D-252)",
    surfaces: ['owner'],
  },
  {
    key: 'listing.manage',
    description: 'Create, edit, publish, pause and close rental listings; ask for owner verification (D-252)',
    surfaces: ['owner'],
  },
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
    key: 'staff_task.read',
    description: 'My day of tasks: readings, inspections, work orders, parcels, install orders (B5.4)',
    surfaces: ['staff'],
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
  {
    key: 'tm30.manage',
    description:
      'TM30 notifications: generate the Immigration upload file (passport data), record submissions (D-052)',
    surfaces: ['owner'],
  },
  // juristic (pack J, D-302–D-324)
  {
    key: 'juristic.register.read',
    description: 'Read the co-owner register: owners, shares, bill-to, transfers (D-307)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.register.manage',
    description: 'Add co-owners, record transfers, set bill-to parties, edit plot fields (D-303, D-307)',
    surfaces: ['owner'],
  },
  { key: 'juristic.budget.read', description: 'Read budgets and their lines (D-304)', surfaces: ['owner'] },
  {
    key: 'juristic.budget.manage',
    description: 'Draft budgets, preview and draft common-fee rates from a budget (D-304)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.budget.approve',
    description: 'Approve a budget with an adopted resolution (committee, D-320)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.resolution.read',
    description: 'Read meeting resolutions and their documents (D-304)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.resolution.manage',
    description: 'Record and edit draft resolutions, attach minutes (D-304)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.resolution.adopt',
    description: 'Adopt or void a resolution (committee, D-320)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.collections.read',
    description:
      'Read payment plans, debt clearance certificates and automatic-payment mandates (D-306, D-308)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.collections.manage',
    description:
      'Propose, reject and cancel payment plans; issue or refuse debt clearance certificates (D-306, D-308, D-325)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.payment_plan.approve',
    description: 'Approve a payment plan (owner, manager or committee, D-308, D-325)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.collections.approve',
    description:
      'Approve or refuse a collections ladder step that needs approval (suspension of common services, lawyer letter, legal action; owner, manager or committee, D-305, D-326)',
    surfaces: ['owner'],
  },
  // J2.1 light GL, expenses, funds, petty cash, bank statements (D-311, D-312, D-320, D-329)
  {
    key: 'juristic.accounting.read',
    description:
      'Read the chart of accounts, journals, funds, petty cash, expense requests, WHT certificates, bank statements and the financial statements (D-312, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.accounting.manage',
    description:
      'Edit the chart of accounts, post / reverse manual journals, back-post the ledger, import and match bank statements, export journals (D-312, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.expense.read',
    description:
      'Read expense requests, their approvals and certificates, and petty cash floats (D-311, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.expense.request',
    description: 'Draft, edit, submit and cancel expense requests and attach their documents (D-311, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.expense.approve',
    description:
      'Approve or reject an expense request when the role is in its approval band; never one’s own request (maker-checker, D-091, D-311, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.expense.pay',
    description:
      'Record the payment of an approved expense request (money leaves; never the committee, D-320, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.petty_cash.spend',
    description: 'Record a petty cash spend with its receipt (the custodian, or an owner / manager, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.fund.manage',
    description:
      'Create funds and petty cash floats, request fund transfers, count petty cash (D-311, D-329)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.fund.approve',
    description:
      'Approve or reject a fund transfer requested by another user (out of a fund only with a resolution, D-311, D-329)',
    surfaces: ['owner'],
  },
  // J2.2 vendors, contracts, quotation rounds, evaluations (D-310, D-331)
  {
    key: 'juristic.vendor.read',
    description:
      'Read vendors, service contracts (SLA, instalments, documents, evaluations, preventive plans) and quotation rounds (D-310, D-331)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.vendor.manage',
    description:
      'Register and block vendors; draft, activate, renew and terminate service contracts; run quotation rounds and ask for an award (D-310, D-331)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.vendor.evaluate',
    description: 'Record the monthly evaluation of a vendor contract (D-310, D-331)',
    surfaces: ['owner'],
  },
  // J3.1 import wizard (D-313, D-332)
  {
    key: 'juristic.import.read',
    description:
      'See legacy-system import jobs, their rows, reconciliation and parallel cycle (D-313, D-332)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.import.manage',
    description:
      'Run a legacy-system import: upload, validate, reconcile, commit, roll back, compare the parallel cycle, go live (D-313, D-332)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.export.run',
    description: 'Export every juristic table of the tenant as a CSV ZIP (D-332)',
    surfaces: ['owner'],
  },
  // J3.2 developer handover (D-314, D-333)
  {
    key: 'juristic.handover.read',
    description: 'See the developer handovers sent to the juristic office and their totals (D-314, D-333)',
    surfaces: ['owner'],
  },
  {
    key: 'juristic.handover.manage',
    description:
      "Accept or reject a developer handover and record the juristic person's formation (D-314, D-333)",
    surfaces: ['owner'],
  },
  // platform (/v1/admin)
  { key: 'admin.tenant.read', description: 'List and view tenants', surfaces: ['admin'] },
  // J4.1 gate & visitor (D-315, D-320, D-327)
  {
    key: 'gate.read',
    description: 'See gates, devices, guards, house policies, the blacklist and invites (not the visit log)',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'gate.manage',
    description: 'Create and edit gates, enrol / revoke gate tablets, house policies, the blacklist (D-327)',
    surfaces: ['owner'],
  },
  {
    key: 'gate.guard.manage',
    description: 'Create guards, reset their PINs, revoke them (D-320)',
    surfaces: ['owner'],
  },
  {
    key: 'gate.log.read',
    description: 'Read the visit log of the estate — every read needs a reason and is audited (D-315 PDPA)',
    surfaces: ['owner'],
  },
  {
    key: 'gate.invite.approve',
    description: 'Approve or reject contractor invites of residents (D-315)',
    surfaces: ['owner'],
  },
  {
    key: 'gate.visit.record',
    description: 'Record visits, scan invites, stamp entries and exits on a gate tablet (guard, D-320)',
    surfaces: ['guard'],
  },
  // J4.2 barrier, LPR, SOS (D-316, D-317, D-328)
  {
    key: 'gate.open',
    description: 'Open the barrier of the gate of the shift, claim LPR reads (guard, D-316, D-328)',
    surfaces: ['guard'],
  },
  {
    key: 'gate.incident.respond',
    description:
      'See SOS / incidents of the estate on the gate tablet, raise, acknowledge and resolve them (guard, D-317)',
    surfaces: ['guard'],
  },
  {
    key: 'gate.incident.read',
    description:
      'Read the incident log of the estate — every read needs a reason and is audited (D-317, D-328)',
    surfaces: ['owner', 'staff'],
  },
  {
    key: 'gate.incident.manage',
    description: 'Acknowledge and resolve SOS / incidents from the console (D-317, D-328)',
    surfaces: ['owner', 'staff'],
  },
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
    key: 'admin.provider_credential.manage',
    description:
      'Set, replace and revoke per-merchant provider credentials (payments, locks, e-Tax); values write-only (D-240)',
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
    key: 'admin.listing.moderate',
    description: 'Review queue of listings: approve, reject, hide, restore; decide reports (D-252)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.listing.verify',
    description: 'Decide owner verifications from ownership evidence (D-252)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.guide.manage',
    description: 'Write, edit, review and publish the guides of the public site (D-271)',
    surfaces: ['admin'],
  },
  {
    key: 'admin.building.manage',
    description: 'Change the operator of a building between tenants (schema-design §4.6)',
    surfaces: ['admin'],
  },
];

// guard-surface keys belong to the guard role only (D-320): an owner or manager records visits through a guard profile
const tenantKeys = PERMISSIONS.filter(
  (p) => !p.key.startsWith('admin.') && !(p.surfaces.length === 1 && p.surfaces[0] === 'guard'),
).map((p) => p.key);
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
  // D-320: budgets are approved and resolutions adopted by the committee (and the tenant's Owner), not the manager
  'juristic.budget.approve',
  'juristic.resolution.adopt',
]);

/** Read-only keys shared by the committee and the auditor (D-320). */
const JURISTIC_READ = [
  'tenant.read',
  'tenant.settings.read',
  'property.read',
  'unit.read',
  'party.read',
  'document.read',
  'lease.read',
  'rate_plan.read',
  'invoice.read',
  'payment.read',
  'report.read',
  'service_request.read',
  'juristic.register.read',
  'juristic.budget.read',
  'juristic.resolution.read',
  'juristic.collections.read',
  'juristic.accounting.read',
  'juristic.expense.read',
  'juristic.vendor.read',
  'juristic.import.read',
  'juristic.handover.read',
];

/** D-320 (J4.1): the guard records visits at the gate — nothing else. */
const GUARD = ['gate.visit.record', 'gate.open', 'gate.incident.respond'];

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
    'staff_task.read',
    'juristic.register.read',
    'juristic.collections.read',
    'juristic.expense.read',
    'juristic.expense.request',
    'juristic.petty_cash.spend',
    'juristic.vendor.read',
    'gate.read',
    'gate.incident.read',
    'gate.incident.manage',
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
    'juristic.register.read',
    'juristic.budget.read',
    'juristic.resolution.read',
    'juristic.collections.read',
    'juristic.accounting.read',
    'juristic.accounting.manage',
    'juristic.expense.read',
    'juristic.expense.request',
    'juristic.expense.pay',
    'juristic.vendor.read',
    'juristic.vendor.manage',
  ],
  committee: [
    ...JURISTIC_READ,
    'juristic.budget.approve',
    'juristic.resolution.adopt',
    'juristic.payment_plan.approve',
    'juristic.collections.approve',
    'juristic.expense.approve',
    'juristic.fund.approve',
    'juristic.vendor.evaluate',
    'gate.read',
    'gate.log.read',
    'gate.invite.approve',
    'gate.incident.read',
  ],
  guard: GUARD,
  auditor: [...JURISTIC_READ, 'deposit.read', 'reading.read', 'tenant.audit.read'],
  platform_admin: PERMISSIONS.filter((p) => p.key.startsWith('admin.')).map((p) => p.key),
  support: [
    'admin.tenant.read',
    'admin.support_grant.request',
    'admin.integration_event.read',
    'admin.listing.moderate',
    'admin.listing.verify',
    'admin.guide.manage',
  ],
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
