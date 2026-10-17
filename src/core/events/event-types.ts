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
  'workflow.sla_reminder': 'A reminder before a workflow SLA due time (e.g. T-3 / T-1 of a deposit refund).',
  'document.uploaded': 'A file finished uploading; scan and thumbnail follow.',
  'document.scanned': 'A file was scanned (clean or infected).',
  'consent.changed': 'A consent was granted or withdrawn (D-025).',
  'dsr.received': 'A data subject request was received (D-025).',
  'dsr.transitioned': 'A data subject request changed state.',
  'device.bootstrapped': 'A gateway received its certificate and device JWT (D-130).',
  'device.certificate_renewed': 'A gateway renewed its client certificate (device protocol §1, CR-003).',
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
  // B2.3 leases
  'lease.drafted': 'A lease draft was created (or renewed into a new draft).',
  'lease.updated': 'A lease draft changed.',
  'lease.sent_for_signature': 'A lease got its number and contract PDF and waits for signatures (D-062).',
  'lease.signed': 'A lessee or co-tenant e-signed the lease (OTP + LINE, D-062).',
  'lease.activated':
    'The lessor countersigned; the lease is in force, occupancy created, unit occupied/reserved.',
  'lease.moved_in': 'The start date of an activated lease arrived: the reserved unit is occupied.',
  'lease.notice_given': 'A 30-day notice (lessee) or a lessor notice was recorded (D-020).',
  'lease.move_out_started': 'The lease entered its move-out phase (ending).',
  'lease.ended': 'Move-out completed; occupancy closed, unit vacant.',
  'lease.terminated': 'The lease was terminated with a reason and evidence.',
  'lease.cancelled': 'A draft or unsigned lease was cancelled.',
  'lease.invitation_created': 'A resident was invited to a lease (LINE QR / SMS / link, D-061).',
  'lease.invitation_accepted': 'A resident accepted a lease invitation and linked their login (D-061).',
  // B2.4 deposits and inspections
  'deposit.opened': 'A lease was activated: its deposit is expected (D-023).',
  'deposit.received': 'The deposit and advance rent were received; receipt numbered.',
  'deposit.settlement_opened':
    'The lease ended: the deposit settlement and its refund clock started (D-023).',
  'deposit.settlement_proposed': 'The owner proposed the deposit settlement (deductions with evidence).',
  'deposit.settlement_accepted': 'The resident accepted the proposed settlement.',
  'deposit.settlement_disputed': 'The resident disputed the proposed settlement.',
  'deposit.refunded': 'The refund was paid; statement numbered and stored.',
  'deposit.settlement_late': 'The refund deadline passed before the refund (compliance.deposit_deadline).',
  'inspection.created': 'A move-in / move-out inspection was created.',
  'inspection.completed': 'An inspection was completed and signed; report numbered.',
  // B3.1 devices
  'device.assigned': 'A device left the platform inventory for a tenant building (D-033).',
  'device.retired': 'A device was retired; certificates and broker ACL revoked (D-033).',
  'device.certificate_revoked': 'A gateway certificate was revoked by the platform admin (D-130).',
  'device.installed': 'A meter device was installed on a meter position with its install reading (D-033).',
  'device.unbound':
    'A meter device was removed from its meter position; the meter reads manually again (D-012).',
  'meter.swapped': 'A meter was replaced: old assignment closed, new one opened at the same instant (D-033).',
  'meter_channel.changed':
    'A meter channel opened or closed: the gateway configs listed are recompiled (D-131).',
  'gateway_config.compiled': 'A new GatewayConfig version was compiled for a gateway (D-131).',
  'gateway_config.applied': 'A gateway reported config_applied for a version (D-131).',
  'gateway_config.rejected': 'A gateway rejected a config version and kept the previous one (D-131).',
  'device.command_issued': 'A command was issued to a gateway (device protocol §4).',
  'device.command_finished': 'A gateway acknowledged a command as done or failed, or it expired.',
  'ota.release_created': 'A signed agent release was registered (D-131).',
  'ota.rollout_changed':
    'An OTA rollout was created, started, paused, resumed, completed or aborted (D-131).',
  // B3.2 ingest
  'device.online': 'A gateway is online again (heartbeat after offline or LWT, D-034).',
  'device.offline': 'A gateway went offline: LWT or 5 missed heartbeats (D-034).',
  'device.degraded': 'A gateway reports meters that do not answer (D-034).',
  'device.event_received':
    'A gateway or the cloud recorded an operational device event (device protocol §2).',
  'reading.candidate':
    'An IoT reading is a candidate billing reading (first of its promotion interval, D-030).',
  // B3.3 readings
  'reading.accepted': 'A meter reading was accepted into smart.meter_reading (D-012, D-030).',
  'reading.review_requested': 'A reading waits in the owner review queue (D-035).',
  'reading.reviewed': 'The owner accepted, corrected (superseding row, D-142) or rejected a reading.',
  // B3.4 health and loss
  'meter.stale': 'A meter has no reading for longer than health.stale_after (D-034).',
  'meter.silent': 'A meter has no reading for longer than the silent threshold (D-034).',
  'meter.recovered': 'A stale or silent meter reads again (D-034).',
  'service.auto_request_requested':
    'A maintenance request should be opened automatically (D-034; consumed by B5).',
  'utility_invoice.changed':
    'A utility (MEA/PEA/MWA/PWA) invoice of a building was entered or changed (D-032).',
  'loss_report.computed': 'A utility loss report was computed for a building and period (D-032).',
} as const;
export type DomainEventType = keyof typeof DOMAIN_EVENT_TYPES;

export const isDomainEventType = (type: string): type is DomainEventType => type in DOMAIN_EVENT_TYPES;

/** Topic of an event (first segment of its type). */
export const topicOf = (type: string): string => type.split('.')[0] ?? type;
