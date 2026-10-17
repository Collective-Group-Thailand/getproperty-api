/**
 * Domain event types recorded in B1.3 (schema-design §4.8). The type is `<aggregate>.<past-tense verb>`; its first
 * segment is the BullMQ topic group used in metrics. Later deliverables add their types here (additive; a type is
 * never renamed because subscribers, notification routes and analytics key on it).
 */
export const DOMAIN_EVENT_TYPES = {
  'auth.otp_requested': 'An SMS OTP challenge was created (no code in the payload).',
  'tenant.created': 'A tenant was onboarded by the platform admin (D-161).',
  'tenant.updated': 'Company data of a tenant changed.',
  'tenant.member.invited': 'An operator was invited to a tenant (D-145).',
  'tenant.member.joined': 'An invitation was accepted; a membership became active.',
  'tenant.member.changed': 'A membership role, building scope or status changed.',
  'tenant.bank_account.otp_requested': 'A bank account change waits for the Owner OTP (D-091).',
  'tenant.bank_account.changed':
    'A bank account became active (OTP confirmed) and replaced the previous default.',
  'support_grant.requested': 'Support asked for time-boxed access to a tenant (D-090).',
  'support_grant.changed': 'A support grant was approved, denied, revoked or expired.',
  'setting.changed':
    'A platform, tenant or property setting got a new version (ADR-0004); invalidates caches.',
  'feature_flag.changed': 'A feature flag default or tenant override changed.',
  'utility_tariff.published': 'A verified utility tariff version was published (D-021a cap reference).',
  'compliance.acknowledged': 'An Owner acknowledged a compliance warning (D-021a).',
  'grant.changed': 'An asset access grant was created or revoked (D-152).',
  'property.changed': 'A property was created, updated or deleted (asset core primitive).',
  'building.changed': 'A building was created, updated or deleted (asset core primitive).',
  'floor.changed': 'A floor was created, updated or deleted (asset core primitive).',
  'unit.changed': 'A unit was created, updated or deleted (asset core primitive).',
  'party.changed': 'A party was created, updated or anonymised (asset core primitive).',
  'building.operator_changed': 'A building changed operator; grants re-pointed, no data copied (§4.6).',
  'workflow.started': 'A workflow instance started (D-159).',
  'workflow.transitioned': 'A workflow instance moved to another state.',
  'workflow.sla_warning': 'A workflow instance is close to its SLA due time.',
  'workflow.sla_breached': 'A workflow instance breached its SLA (emitted once).',
  'document.uploaded': 'A file finished uploading; scan and thumbnail follow.',
  'document.scanned': 'A file was scanned (clean or infected).',
  'consent.changed': 'A consent was granted or withdrawn (D-025).',
  'dsr.received': 'A data subject request was received (D-025).',
  'dsr.transitioned': 'A data subject request changed state.',
  'device.bootstrapped': 'A gateway received its certificate and device JWT (D-130).',
  'notification.route_changed': 'A tenant changed a channel of the resident routing matrix.',
  'notification.template_published': 'A notification template version was published.',
  'notification.test_requested': 'A platform admin asked for a test send of a template.',
  // B2.1 units
  'unit_profile.changed': 'A unit profile (room type) was created, updated or deleted (B2.1).',
  'utility_account.changed':
    'A building utility account (MEA/PEA/MWA/PWA) was created, updated or deleted (D-032).',
  'meter_assignment.changed':
    'A meter was bound to a unit or common area, or its assignment closed (B2.1, D-012).',
  'asset_item.changed': 'An appliance, furniture or other asset item of a unit changed (B2.1).',
  // B2.2 parties
  'party.link_changed': 'A resident login was linked to or unlinked from a party (D-061).',
} as const;
export type DomainEventType = keyof typeof DOMAIN_EVENT_TYPES;

export const isDomainEventType = (type: string): type is DomainEventType => type in DOMAIN_EVENT_TYPES;

/** Topic of an event (first segment of its type). */
export const topicOf = (type: string): string => type.split('.')[0] ?? type;
