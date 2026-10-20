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
  'workflow.step_due': 'A host-scheduled step of a workflow instance is due (e.g. a dunning reminder, B4.5).',
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
  'lease.rules_acknowledged':
    'A resident confirmed reading the building rules of the lease addendum in the LIFF (D-203).',
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
  'reading.requested':
    'The owner asked staff to read meters of a billing cycle, optionally assigned to one login (web F2, D-208).',
  // B3.4 health and loss
  'meter.stale': 'A meter has no reading for longer than health.stale_after (D-034).',
  'meter.silent': 'A meter has no reading for longer than the silent threshold (D-034).',
  'meter.recovered': 'A stale or silent meter reads again (D-034).',
  'service.auto_request_requested':
    'A maintenance request should be opened automatically (D-034; consumed by B5).',
  'utility_invoice.changed':
    'A utility (MEA/PEA/MWA/PWA) invoice of a building was entered or changed (D-032).',
  'loss_report.computed': 'A utility loss report was computed for a building and period (D-032).',
  // B4.2 rate plans, cycles, invoices
  'rate_plan.changed': 'A rate plan or one of its versions was created, changed or deleted (D-021a, D-151).',
  'billing_cycle.opened': 'A billing cycle of a property was opened for a period (D-031).',
  'billing_cycle.readings_requested':
    'The cut-off passed with meters still unread: staff are asked for the reading round (D-031).',
  'billing_cycle.computed': 'Draft invoices of a billing cycle were computed (D-031, D-041).',
  'billing_cycle.issued': 'The draft invoices of a billing cycle were issued (D-011).',
  'billing_cycle.closed': 'A billing cycle was closed.',
  'invoice.issued': 'An invoice was numbered, snapshotted and issued; it is immutable from now on (D-040).',
  'invoice.voided': 'An unpaid invoice was voided (a replacement may be issued for the same period, D-040).',
  'invoice.balance_changed':
    'The balance of an issued invoice changed (payment, credit or debit note, D-044).',
  'invoice.paid': 'An invoice was paid in full (D-044): the receipt follows.',
  'invoice.partially_paid': 'A partial payment was applied to an invoice (payments.allow_partial, D-044).',
  'invoice.overdue': 'An invoice passed its due date with a balance (D-045).',
  'invoice_charge.queued': 'A one-off item was queued for the next invoice of a billed party × unit (D-041).',
  'credit_note.issued': 'A credit note was issued against an invoice (D-040).',
  'debit_note.issued': 'A debit note was issued against an invoice (D-040).',
  // B4.3 documents
  'document.generated':
    'A financial document PDF (invoice, receipt, note, tax invoice) was rendered and stored (D-050).',
  'invoice.resent': 'The owner sent an issued invoice to the payer again (LINE Flex, D-011).',
  'export.requested': 'An operator requested an export (document archive, Excel, accounting formats, D-051).',
  // B4.4 payments
  'invoice.payment_ready':
    'An issued invoice is ready to send: credit applied and its Thai QR created when the tenant has a provider (D-042).',
  'payment.webhook_received':
    'A signed payment provider callback was stored; the worker processes it (D-042).',
  'receipt.voided': 'A receipt was voided because its payment was reversed (D-044).',
  'payment.confirmed':
    'A payment was confirmed (webhook, settlement file, slip or manual) and allocated (D-042).',
  'payment.failed': 'A provider reported a failed payment.',
  'payment.reversed': 'A confirmed payment was reversed (chargeback or owner correction).',
  'payment.refunded': 'An overpayment or credit was refunded to the payer with evidence (D-044).',
  'receipt.issued': 'A receipt (payment, deposit or advance) was numbered and issued (D-044).',
  'receipt.resent': 'The owner sent an issued receipt to the payer again (LINE Flex, D-208).',
  'tax_invoice.issued':
    'A tax invoice / receipt-tax invoice was issued for a VAT-registered tenant (D-050, O-004).',
  'slip.uploaded': 'A resident uploaded a transfer slip for an invoice (D-043).',
  'slip.review_requested': 'A slip could not be auto-confirmed and waits in the owner review queue (D-043).',
  'slip.reviewed': 'The owner approved or rejected a slip (D-043).',
  'settlement_file.processed':
    'A provider settlement file was reconciled: payments created for missed webhooks, discrepancies flagged (D-042).',
  // B4.5 receivables, dunning, exports
  'receivable.changed': 'The receivable balance of a billed party × unit changed (B4.5).',
  'invoice.reminder_due': 'A dunning reminder of an overdue invoice is due (D-045, workflow timer).',
  'invoice.reminder_sent': 'A payment reminder was sent to the payer (D-045).',
  'penalty.assessed': 'A late fee was assessed for the next invoice (D-045, ⚖ O-002).',
  'export.completed': 'An export file (Excel, FlowAccount, PEAK, VAT working figures) is ready (D-051).',
  // B6 platform business (D-081, D-082, D-083, D-156, D-204)
  'price_plan.published': 'A price plan version was published from its effective date (D-156).',
  'subscription.created': 'A tenant was subscribed to a plan; the trial started (D-082).',
  'subscription.plan_changed': 'The plan or add-ons of a subscription changed (D-082, D-156).',
  'subscription.state_changed':
    'A subscription moved (trial / active / past_due / suspended / cancelled); suspended and cancelled tenants are read-only (D-082).',
  'platform_invoice.issued': 'Collective Group issued a platform invoice to a tenant (D-146, D-156).',
  'platform_invoice.ready': 'The PDF (and Thai QR) of a platform invoice is ready for the owner (D-146).',
  'platform_invoice.overdue': 'A platform invoice is unpaid after its due date and the grace days (D-082).',
  'platform_payment.confirmed':
    'A payment of a platform invoice was confirmed and its receipt issued (D-146).',
  'platform_credit_note.issued': 'A credit note on a platform invoice was approved by a second user (D-091).',
  'pilot_agreement.saved': 'The pilot agreement of a tenant was recorded or changed (D-083).',
  'install_order.created': 'A platform install / de-install order was opened for a building (D-081).',
  'install_order.changed': 'A platform install order changed state (D-081).',
  'site_survey.requested': 'An owner asked for a site survey to upgrade to Smart (D-156).',
  'haas_asset.changed': 'A platform-owned device at a tenant changed state in the HaaS register (D-081).',
  // B5.1 service requests & work orders (D-072, D-034, D-153)
  'service_request.created':
    'A repair request was reported (resident, staff, owner or system); its SLA clock started (D-072, D-159).',
  'service_request.changed':
    'A repair request changed state (triaged, assigned, in progress, done, closed …).',
  'service_request.rated': 'The resident rated a done repair request; the rating closed it (D-072).',
  'service_request.warranty_referred':
    'A request inside a getbuild warranty was referred to the developer instead of the building technician (D-153).',
  'work_order.created': 'A work order was opened (repair, preventive, install, de-install, inspection).',
  'work_order.assigned': 'A work order was assigned to a staff member or an external technician.',
  'work_order.changed':
    'A work order changed state (accepted, in progress, waiting for parts, verified, cancelled).',
  'work_order.completed': 'The assignee completed a work order with after photos (D-072).',
  'work_order.cost_changed': 'Parts / labour of a work order changed (B4.5 expenses).',
  // B5.2 access control (D-070, D-071)
  'lock.registered': 'A smart lock / door controller was registered on a unit, building door or common area.',
  'access.credential_issued':
    'An access credential was issued (resident at lease activation, visitor / staff / technician time-boxed).',
  'access.credential_revoked':
    'An access credential was revoked (lease end or termination, owner with a reason, work order end) — never for arrears (D-071).',
} as const;
export type DomainEventType = keyof typeof DOMAIN_EVENT_TYPES;

export const isDomainEventType = (type: string): type is DomainEventType => type in DOMAIN_EVENT_TYPES;

/** Topic of an event (first segment of its type). */
export const topicOf = (type: string): string => type.split('.')[0] ?? type;
