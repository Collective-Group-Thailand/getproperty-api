/**
 * Setting catalogue (ADR-0004, D-144): every business value a decision marks as configurable, with its type,
 * where overrides may exist, who may edit it and the platform default. `prisma/seed` mirrors it into
 * platform.setting + an initial platform.setting_version (effective from the seed run; versions are never
 * backdated). Descriptions MUST cite the decision (the database CHECKs for a D-/O- id).
 * ⚖ = value waits for legal confirmation (O-002); "Proposed" = business value not yet confirmed (D-156, D-161).
 */
import { DEFAULT_PLATFORM_BRAND, platformBrandProblems } from '../brand/brand-setting';
import {
  DEFAULT_RECORD_BYTES,
  FREE_GB_PER_TYPE,
  NOT_SET_PER_TYPE,
  noticeProblems,
  packsProblems,
  perTenantTypeProblems,
  recordBytesProblems,
  TENANT_TYPES,
} from '../storage/storage-settings';

export type SettingValueType =
  'string' | 'int' | 'decimal' | 'bool' | 'json' | 'duration' | 'money' | 'date' | 'time';
export type SettingScope = 'platform' | 'tenant' | 'property';

export interface SettingDef {
  key: string;
  valueType: SettingValueType;
  scopeAllowed: SettingScope[];
  description: string;
  editableBy: string[];
  /** Platform default (jsonb). */
  value: unknown;
  /** Reason recorded on the seeded version. */
  reason: string;
  /** Closed set of allowed values (validated on every write). */
  allowedValues?: readonly unknown[];
  /** Structural problems of a value beyond its type (a json setting's shape); empty = valid. */
  check?: (value: unknown) => string[];
}

const OWNER_SETTINGS = ['tenant.settings.update'];
const OWNER_BILLING = ['tenant.billing_settings.update'];
const ADMIN = ['admin.setting.manage'];
const ADMIN_COMPLIANCE = ['admin.compliance.manage'];

export const SETTINGS: readonly SettingDef[] = [
  // --- compliance (สคบ. 2568) -------------------------------------------------------------------------
  {
    key: 'compliance.tariff_cap.severity',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-021a: severity of compliance.tariff_cap — "warn" (warning + Owner acknowledgement, default) or "block"; set by the platform admin platform-wide or per tenant.',
    editableBy: ADMIN_COMPLIANCE,
    value: 'warn',
    reason: 'seed: D-021a founder decision 2026-10-16',
    allowedValues: ['warn', 'block'],
  },
  {
    key: 'compliance.severity_overrides',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-021a / ADR-0007: the platform admin\'s per-rule severity overrides of the compliance registry ({"compliance.<rule>": "warn" | "block"}), platform-wide or per tenant; rules not listed keep their registry default.',
    editableBy: ADMIN_COMPLIANCE,
    value: {},
    reason: 'seed: ADR-0007 (no overrides)',
  },
  {
    key: 'tenant.subject_to_ocpb_2568',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-158 / D-020: the tenant is in scope of the สคบ. 2568 residential rental announcement (≥ 3 units); compliance rules apply when true.',
    editableBy: ADMIN_COMPLIANCE,
    value: true,
    reason: 'seed: D-158',
  },
  {
    key: 'deposit.max_months_short',
    valueType: 'decimal',
    scopeAllowed: ['platform'],
    description:
      'D-023 ⚖ O-002: security deposit + advance rent together may not exceed this many months of rent for short-term (monthly) leases (legal-reference §1: 3 months, pending legal verification).',
    editableBy: ADMIN_COMPLIANCE,
    value: '3',
    reason: 'seed: legal-reference §1 (pending legal verification, D-149)',
  },
  {
    key: 'deposit.max_years_long',
    valueType: 'decimal',
    scopeAllowed: ['platform'],
    description:
      'D-023 ⚖ O-002: for long-term leases with annual rent, deposit + advance rent may not exceed this many years of rent (legal-reference §1: 1 year, pending legal verification).',
    editableBy: ADMIN_COMPLIANCE,
    value: '1',
    reason: 'seed: legal-reference §1 (pending legal verification, D-149)',
  },
  {
    key: 'deposit.refund_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-023 ⚖: days after lease end and hand-back within which the deposit (less evidenced damage) must be refunded (legal-reference ข้อ 4 (10): 7 days).',
    editableBy: ADMIN_COMPLIANCE,
    value: 7,
    reason: 'seed: D-023 / legal-reference §1',
  },
  {
    key: 'rent_record.letter.valid_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-256 (B7.11): days a rent record letter (verification code) can be checked; the resident can revoke it sooner.',
    editableBy: ADMIN,
    value: 90,
    reason: 'seed: B7.11 (a rental search rarely lasts longer than three months)',
  },
  {
    key: 'identity.verification.session_minutes',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-267 (B7.10): minutes an e-KYC session stays open; an attempt not finished by then expires and a new one can start.',
    editableBy: ADMIN,
    value: 60,
    reason: 'seed: B7.10 (an hour to finish the ID card and selfie)',
  },
  {
    key: 'deposit.deduction.item_required_for',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-266 (B7.10): tenant types whose deposit deductions (all but unpaid invoices) must point at a move-out report item with photos — the condition-report evidence that ends the deposit argument. Damage and missing items always need it (D-023, compliance.deposit_evidence).',
    editableBy: ADMIN,
    value: ['landlord', 'pm_company'],
    reason: 'seed: D-266 (landlords and PM companies)',
    check: (value: unknown) =>
      Array.isArray(value) && value.every((v) => (TENANT_TYPES as readonly unknown[]).includes(v))
        ? []
        : ['an array of tenant types'],
  },
  {
    key: 'invoice.min_lead_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-020 / legal-reference ข้อ 4 (8): an invoice reaches the lessee at least this many days before its due date (compliance.invoice_lead_time).',
    editableBy: ADMIN_COMPLIANCE,
    value: 3,
    reason: 'seed: legal-reference §1',
  },
  {
    key: 'late_fee.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-045 / D-024 ⚖ O-002: a late-fee line may be added only when enabled and allowed by the standard contract; off until legal confirms (compliance.late_fee_policy).',
    editableBy: OWNER_BILLING,
    value: false,
    reason: 'seed: D-045 conservative default (⚖ O-002)',
  },
  {
    key: 'late_fee.amount',
    valueType: 'money',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-045 ⚖ O-002 (B4.5): the flat late fee assessed once per overdue invoice for the next invoice — only when `late_fee.enabled`, the lease states a late fee and compliance.late_fee_policy allows; 0 = none.',
    editableBy: OWNER_BILLING,
    value: '0.00',
    reason: 'seed: D-045 conservative default (no amount until the owner sets the contract amount, ⚖ O-002)',
  },
  // --- billing & collections ------------------------------------------------------------------------
  {
    key: 'billing.cutoff',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description: 'D-031: billing cut-off per property — default end of month at 23:59 Asia/Bangkok.',
    editableBy: OWNER_BILLING,
    value: { day: 'end_of_month', time: '23:59', timezone: 'Asia/Bangkok' },
    reason: 'seed: D-031',
  },
  {
    key: 'billing.estimate_policy',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-031 / D-012: "block" (default for the first 2 cycles of a new building) or "allow" estimated readings on invoices.',
    editableBy: OWNER_BILLING,
    value: 'block',
    reason: 'seed: D-031',
    allowedValues: ['allow', 'block'],
  },
  {
    key: 'billing.reading_grace_hours',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-031 / D-191: hours after the cut-off during which staff/OCR readings still close the period; after it the cycle bills an estimate (estimate_policy allow) or waits for a reading (block).',
    editableBy: OWNER_BILLING,
    value: 24,
    reason: 'seed: D-191 founder pre-approved recommendation',
  },
  {
    key: 'billing.default_due_day',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-191: day of the month invoices fall due when the lease names none (the standard contract default "ภายในวันที่ 5"); never inside invoice.min_lead_days of the issue.',
    editableBy: OWNER_BILLING,
    value: 5,
    reason: 'seed: B2.3 standard contract default due day (D-191)',
  },
  {
    key: 'billing.auto_issue',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-011 / B4.2: issue a computed billing cycle automatically after `afterHours` hours without owner action ({"enabled": false, "afterHours": 24}); off by default.',
    editableBy: OWNER_BILLING,
    value: { enabled: false, afterHours: 24 },
    reason: 'seed: B4.2 prompt default off',
  },
  {
    key: 'compliance.tariff_cap.representative_units',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-021a / D-194 (schema-design §4.2.2): the monthly consumption a new power/water rate plan version is compared at with the utility effective average rate ({"electric": "150", "water": "10"}).',
    editableBy: ADMIN_COMPLIANCE,
    value: { electric: '150', water: '10' },
    reason: 'seed: D-194 founder pre-approved recommendation',
  },
  {
    key: 'tax.vat',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-050 / O-004 / O-007 ⚖: VAT on invoices of VAT-registered tenants — the rate and the invoice line kinds it applies to ({"rate": "0.07", "applicableLineKinds": []}); empty until tax counsel confirms which charges are taxable.',
    editableBy: OWNER_BILLING,
    value: { rate: '0.07', applicableLineKinds: [] },
    reason: 'seed: O-007 conservative default (no line kind taxed until confirmed)',
  },
  {
    key: 'reminders.schedule',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description: 'D-045: LINE reminders after due date + grace, on these days (default day 1, 3, 7).',
    editableBy: OWNER_SETTINGS,
    value: [1, 3, 7],
    reason: 'seed: D-045',
  },
  {
    key: 'payments.allow_slip',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description: 'D-043: residents may upload a transfer slip as the fallback to Thai QR (default on).',
    editableBy: OWNER_BILLING,
    value: true,
    reason: 'seed: D-043',
  },
  {
    key: 'payments.allow_partial',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description: 'D-044: partial payments are accepted only when enabled (conservative default off).',
    editableBy: OWNER_BILLING,
    value: false,
    reason: 'seed: D-044 (enabled per tenant)',
  },
  {
    key: 'payments.duplicate_window_hours',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-220: a QR callback or settlement row of the same amount as a slip or hand-recorded transfer of the same payer × unit within this many hours is held for the owner as a possible duplicate (never booked twice).',
    editableBy: OWNER_BILLING,
    value: 72,
    reason: 'seed: D-220 (review #2)',
  },
  // --- readings ---------------------------------------------------------------------------------------
  {
    key: 'readings.require_photo',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description: 'D-035: every manual reading needs photo evidence (Owner may relax it).',
    editableBy: OWNER_SETTINGS,
    value: true,
    reason: 'seed: D-035',
  },
  {
    key: 'readings.plausibility_pct',
    valueType: 'decimal',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-035: an OCR/manual reading whose consumption deviates more than this percentage from the trailing average goes to the review queue.',
    editableBy: OWNER_SETTINGS,
    value: '60',
    reason: 'seed: D-035 plausibility band',
  },
  {
    key: 'readings.iot_window_minutes',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-031: the cycle job picks the IoT reading closest to the cut-off within ± this many minutes (±2 h).',
    editableBy: OWNER_BILLING,
    value: 120,
    reason: 'seed: D-031',
  },
  {
    key: 'health.stale_after',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-034: a meter is stale without a reading for this long (electric 2 h, water 6 h) and silent after 24 h.',
    editableBy: OWNER_SETTINGS,
    value: { electric: 'PT2H', water: 'PT6H', silent: 'PT24H' },
    reason: 'seed: D-034',
  },
  {
    key: 'access.work_order_window_hours',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'B5.2 (D-070): length of the time-boxed door code of a staff member / technician when the work order has no visit window (from the visit start, or from the assignment).',
    editableBy: OWNER_SETTINGS,
    value: 4,
    reason: 'seed: B5.2 founder pre-approved recommendation (D-211)',
  },
  {
    key: 'access.resident_visitor_codes',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-070 / D-218 (LIFF #26): residents may create time-boxed visitor codes for their own unit’s lock in the app. Off by default — the operator opts in (the owner surface always may issue them).',
    editableBy: OWNER_SETTINGS,
    value: false,
    reason: 'seed: D-218 founder pre-approved recommendation (opt-in, most conservative)',
  },
  {
    key: 'access.resident_visitor_max_hours',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-070 / D-218 (LIFF #26): the longest visitor code a resident may create (hours, 1–744); longer windows are refused (422).',
    editableBy: OWNER_SETTINGS,
    value: 24,
    reason: 'seed: D-218 founder pre-approved recommendation',
  },
  {
    key: 'access.battery_low_pct',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'B5.2 (D-070, D-034): a lock at or below this battery % opens an automatic repair request (once per 24 h per lock).',
    editableBy: OWNER_SETTINGS,
    value: 20,
    reason: 'seed: B5.2 founder pre-approved recommendation (D-211)',
  },
  {
    key: 'health.gateway_missed_heartbeats',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-034: a gateway is offline after this many missed heartbeats (heartbeat every 60 s).',
    editableBy: ADMIN,
    value: 5,
    reason: 'seed: D-034',
  },
  {
    key: 'health.config_drift_minutes',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-131 (B3.1): a gateway whose health reports an older config version than the published one for longer than this is flagged config_drift.',
    editableBy: ADMIN,
    value: 15,
    reason: 'seed: D-131 drift detector (B3.1 prompt)',
  },
  // --- devices, telemetry, readings (B3) --------------------------------------------------------------
  {
    key: 'mqtt.authn.require_device_jwt',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-235 / D-239 (device protocol 1.2): a gateway connecting to EMQX on 8883 must send a valid device JWT of its own as the MQTT password besides its client certificate (a retired gateway cannot reconnect with a still-valid certificate); off = the certificate alone is accepted while older agents run. The WebSocket fallback always requires the JWT.',
    editableBy: ADMIN,
    value: true,
    reason: 'seed: founder decision 2026-10-22 (on by default in production, D-239)',
  },
  {
    key: 'devices.gateway_defaults',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-131 / D-034: polling interval (default 15 min) and heartbeat interval (60 s) compiled into every GatewayConfig.',
    editableBy: ADMIN,
    value: { pollIntervalS: 900, heartbeatS: 60 },
    reason: 'seed: D-131 defaults',
  },
  {
    key: 'readings.confidence',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-012 / D-035 (Proposed): confidence recorded on each reading by source and IoT quality; the billing cut-off selector prefers the highest-confidence reading (B4.2).',
    editableBy: ADMIN,
    value: {
      iot: '1.000',
      iotEstimatedByGateway: '0.700',
      iotClockSuspect: '0.600',
      iotOverflowCorrected: '0.900',
      ocr: '0.900',
      manual: '0.950',
      inspection: '0.950',
      estimated: '0.300',
    },
    reason: 'seed: D-012 proposed confidence scale',
  },
  {
    key: 'readings.iot_promotion_minutes',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-030 / D-031 (Proposed): the first IoT reading of each interval of this length (Asia/Bangkok) becomes a billing reading (`smart.meter_reading`); the ±2 h cut-off window always finds one.',
    editableBy: OWNER_BILLING,
    value: 60,
    reason: 'seed: D-031 window ±120 min',
  },
  {
    key: 'readings.ocr_min_confidence',
    valueType: 'decimal',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-035: an OCR reading below this confidence (or disagreeing with the typed value) goes to the review queue with its photo.',
    editableBy: OWNER_SETTINGS,
    value: '0.80',
    reason: 'seed: D-035',
  },
  {
    key: 'readings.round_window_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-031 / D-035 (Proposed): a staff reading round asks for every manual (or stale IoT) meter without a reading in the last N days before the billing cut-off.',
    editableBy: OWNER_BILLING,
    value: 7,
    reason: 'seed: D-031 reading round window',
  },
  {
    key: 'telemetry.retention',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-162 / D-147 / D-241 (O-014): raw telemetry 24 months (15-minute series are computed from raw points, so they live exactly as long — T-14), gateway health samples 6 months, hourly / daily rollups 5 years, dedup marks 90 days — retention by partition drop / purge (TimescaleDB retention policies on hypertables, D-234).',
    editableBy: ADMIN,
    value: { raw: 'P24M', health: 'P6M', rollups: 'P5Y', seqMarks: 'P90D', deviceEvents: 'P24M' },
    reason: 'seed: D-162',
  },
  {
    key: 'ingest.invalid_payload_alert',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-130 (device protocol §5): a gateway with this many invalid payloads within the window raises `device.invalid_payload`.',
    editableBy: ADMIN,
    value: { count: 10, window: 'PT1H' },
    reason: 'seed: device protocol §5 threshold',
  },
  {
    key: 'loss.suspect_rules',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-032 (Proposed): loss suspects — night window and minimum night water flow per 15 minutes, the anomaly threshold in standard deviations of the trailing consumption.',
    editableBy: OWNER_SETTINGS,
    value: {
      nightFrom: '01:00',
      nightTo: '05:00',
      nightFlowM3Per15m: '0.010',
      anomalySigma: '2',
      trailingPeriods: 6,
    },
    reason: 'seed: D-032 suspects',
  },
  // --- notifications & privacy ------------------------------------------------------------------------
  {
    key: 'notifications.quiet_hours',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-063 / D-025: non-urgent resident messages are held between these local times (B1 prompt default 21:00–08:00 Asia/Bangkok).',
    editableBy: OWNER_SETTINGS,
    value: { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' },
    reason: 'seed: B1.3 notifications default',
  },
  {
    key: 'privacy.dsr_due_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-025: a data subject request is due this many days after receipt (schema-design §3.2.7: 30).',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-025',
  },
  {
    key: 'support.grant_max_hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-090: longest validity of a Support grant into a tenant (time-boxed, logged). B1.3 assumption: 24 hours until the support process is agreed.',
    editableBy: ADMIN,
    value: 24,
    reason: 'seed: D-090 time-boxed support grant (B1.3 assumption)',
  },
  {
    key: 'invitation.expiry_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-145 / D-061: days an invitation (tenant member or lease resident) stays valid. B1.3 assumption: 7 days.',
    editableBy: ADMIN,
    value: 7,
    reason: 'seed: D-145 (B1.3 assumption)',
  },
  // --- storage metering (D-276; amounts pending the founder) ------------------------------------------------
  {
    key: 'storage.free_gb',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-276 / D-279: free storage allowance in GB per tenant type ({"apartment": "5", …}; founder 2026-10-25: 5 GB for every type) and per tenant for a custom deal. null = metering not active for that type: usage is snapshotted, nothing is held and no notice is sent.',
    editableBy: ADMIN,
    value: FREE_GB_PER_TYPE,
    reason: 'seed: D-279 (5 GB free per tenant type)',
    check: perTenantTypeProblems,
  },
  {
    key: 'storage.price_per_gb_month',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-276 / D-279: price in THB per GB-month above the allowance, per tenant type (and per tenant); null = overage not sold (only optional uploads are then held — legal and operational files are always stored). Billed on the monthly platform invoice next to the payment fee (D-250). Set by the platform admin.',
    editableBy: ADMIN,
    value: NOT_SET_PER_TYPE,
    reason: 'seed: D-276 (amounts pending)',
    check: perTenantTypeProblems,
  },
  {
    key: 'storage.packs',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-276 / D-279: add-on storage packs ([{"key": "plus-20", "gb": "20", "monthlyPrice": "49.00"}]), kept for the B7 overage maths; since D-285 the packages a tenant buys are price-plan add-ons (admin → storage packages), so this stays empty.',
    editableBy: ADMIN,
    value: [],
    reason: 'seed: D-276 (no packs yet)',
    check: packsProblems,
  },
  {
    key: 'storage.record_bytes',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-276: counted size in bytes of one stored record per record type (invoice, receipt, payment, lease, meter_reading, service_request; `_default` for any other), so the storage bill is predictable and auditable without measuring the database. Founder pre-approved recommendation.',
    editableBy: ADMIN,
    value: DEFAULT_RECORD_BYTES,
    reason: 'seed: D-276 (recommended sizes)',
    check: recordBytesProblems,
  },
  {
    key: 'storage.notice_at_percent',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-276: usage of the allowance (percent) at which the owner is told in LINE and in the console — each once per crossing.',
    editableBy: ADMIN,
    value: [80, 100],
    reason: 'seed: D-276',
    check: noticeProblems,
  },
  // --- storage quota, reclaim, packages (G1: D-285, D-286) --------------------------------------------------
  {
    key: 'storage.images.max_edge_px',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-285 (G1): longer edge in pixels of a stored listing photo after it is re-encoded without metadata, before it counts to the quota (WebP renditions as D-252). Evidence photos and slips are never re-encoded.',
    editableBy: ADMIN,
    value: 2560,
    reason: 'seed: D-285 (G1 recommendation)',
  },
  {
    key: 'storage.reclaim.purge_after_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-285 (G1): days a file the owner deleted to reclaim space can still be restored; then its objects are removed and the quota drops (pack G default 7).',
    editableBy: ADMIN,
    value: 7,
    reason: 'seed: D-285 (pack G1: 7 days)',
  },
  {
    key: 'storage.package.renew_days_before',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-285 (G1): days before a storage package with auto-renew ends that the next period is invoiced; the package expires (nothing deleted) when that invoice is not paid in time.',
    editableBy: ADMIN,
    value: 7,
    reason: 'seed: D-285 (G1 recommendation)',
  },
  {
    key: 'storage.reconciliation.auto_correct',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      "D-286 (G1): whether the nightly reconciliation against object storage corrects a tenant's counters to what is stored (true) or only reports the drift (false).",
    editableBy: ADMIN,
    value: true,
    reason: 'seed: D-286 (G1)',
  },
  // --- listings (D-252, B7.2) — rules of the review queue are data, not code ------------------------------
  {
    key: 'listing.photos.min',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-252: photos a listing needs before it can be submitted (founder: at least 5).',
    editableBy: ['admin.listing.moderate'],
    value: 5,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.photos.max',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-252: most photos one listing may carry (founder: at most 30).',
    editableBy: ['admin.listing.moderate'],
    value: 30,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.review.first_listing',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-252: the first listing of an owner whose unit is not verified goes to the review queue instead of straight to published.',
    editableBy: ['admin.listing.moderate'],
    value: true,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.review.price_outlier_percent',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252: a rent more than this percent below or above the median of published listings of the same kind in the district goes to review (only when listing.review.comparables_min listings exist). 0 = off.',
    editableBy: ['admin.listing.moderate'],
    value: 50,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.review.comparables_min',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252: published listings of the same kind in a district needed before the price-outlier rule applies.',
    editableBy: ['admin.listing.moderate'],
    value: 5,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.review.flagged_words',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-252: words and phrases (any case) that send a listing to review — scam patterns such as paying before a viewing or moving the chat off the platform. A JSON array of strings.',
    editableBy: ['admin.listing.moderate'],
    value: [
      'โอนก่อนดูห้อง',
      'โอนมัดจำก่อนดู',
      'จองก่อนดูห้อง',
      'ไม่ต้องดูห้อง',
      'ทักไลน์ส่วนตัว',
      'western union',
      'pay before viewing',
      'deposit before viewing',
    ],
    reason: 'seed: D-252',
    check: (value) =>
      Array.isArray(value) && value.every((word) => typeof word === 'string' && word.trim().length > 0)
        ? []
        : ['an array of non-empty strings'],
  },
  {
    key: 'listing.report.hide_after',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252: open reports from different viewers after which a published listing is hidden until a moderator decides.',
    editableBy: ['admin.listing.moderate'],
    value: 3,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.verification.maker_checker',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      "D-252: an owner verification needs a second platform user to confirm the first reviewer's approval.",
    editableBy: ['admin.listing.verify'],
    value: false,
    reason: 'seed: D-252',
  },
  {
    key: 'listing.verification.evidence_retention_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252 / O-018: days after the decision when the ownership evidence (title deed, contract) is deleted; the decision itself stays. Conservative default until counsel answers O-018.',
    editableBy: ['admin.listing.verify'],
    value: 90,
    reason: 'seed: O-018 (conservative default)',
  },
  // --- enquiries and viewings (D-252, B7.3) ----------------------------------------------------------------
  {
    key: 'listing.lead.nudge_after_hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252 (B7.3): hours after which an enquiry the owner has not answered yet reminds the owner once (LINE and console). 0 = off.',
    editableBy: ['admin.listing.moderate'],
    value: 12,
    reason: 'seed: B7.3',
  },
  {
    key: 'listing.lead.daily_limit',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252 (B7.3): new enquiries one prospect may start in a Bangkok day across all listings — a brake on spam; follow-up messages in an open enquiry do not count.',
    editableBy: ['admin.listing.moderate'],
    value: 20,
    reason: 'seed: B7.3',
  },
  {
    key: 'listing.viewing.min_notice_hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-252 (B7.3): the earliest a viewing can start, in hours from the moment it is booked.',
    editableBy: ['admin.listing.moderate'],
    value: 2,
    reason: 'seed: B7.3',
  },
  {
    key: 'listing.viewing.horizon_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-252 (B7.3): how many days ahead a viewing can be booked.',
    editableBy: ['admin.listing.moderate'],
    value: 30,
    reason: 'seed: B7.3',
  },
  {
    key: 'listing.viewing.reminder_hours_before',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-252 (B7.3): hours before a confirmed viewing when the prospect and the owner are both reminded (once). 0 = off.',
    editableBy: ['admin.listing.moderate'],
    value: 3,
    reason: 'seed: B7.3',
  },
  // --- G7 self-viewing (D-289 (1), D-295; O-024 insurance + visitor terms, O-031) ----------------------------
  {
    key: 'viewing.self.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-295 / O-024: self-viewing with a time-boxed door code is offered at all (platform) or for one tenant. Off until the insurance partner and the visitor terms are settled (O-024).',
    editableBy: ADMIN,
    value: false,
    reason: 'seed: O-024 (no insurance partner yet — off)',
  },
  {
    key: 'viewing.self.code_minutes',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-295 (G7): how long a self-viewing door code opens the door after the slot starts, in minutes (D-289 (1): 30).',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: G-README item 6 (30 minutes)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 10 && (value as number) <= 120
        ? []
        : ['10–120 minutes'],
  },
  {
    key: 'viewing.self.code_early_minutes',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-295 (G7): minutes before the slot start from which the door code is shown and opens the door.',
    editableBy: ADMIN,
    value: 5,
    reason: 'seed: D-295',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 30 ? [] : ['0–30 minutes'],
  },
  {
    key: 'viewing.self.overstay_minutes',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-295 (G7): minutes after the code window ends when a visitor who entered and did not confirm leaving is reported to the owner and staff (once).',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-295',
  },
  {
    key: 'viewing.self.log_retention_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-295 / O-031: days a closed self-viewing access record (entry / exit times, incident) is kept before it is deleted (PDPA minimisation; ⚖ pending legal confirmation).',
    editableBy: ADMIN_COMPLIANCE,
    value: 365,
    reason: 'seed: schema-design G7-b (log kept 1 year)',
  },
  {
    key: 'viewing.self.visitor_terms',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-295 / O-024: the visitor terms a prospect accepts before booking a self viewing ({"version": n, "th": …, "en": …}); draft wording pending legal review and the insurance partner (O-024). A new version needs a new acceptance.',
    editableBy: ADMIN_COMPLIANCE,
    value: {
      version: 1,
      th: 'ร่างเงื่อนไขผู้เข้าชม (รอตรวจทางกฎหมาย): ฉันจะเข้าชมห้องเฉพาะช่วงเวลาที่นัดไว้ ไม่ให้รหัสประตูกับผู้อื่น ไม่นำทรัพย์สินออกจากห้อง ปิดประตูเมื่อออก และแจ้งปัญหาในแอปทันทีหากพบความเสียหาย ระบบบันทึกเวลาเข้าและออกจากห้อง',
      en: 'Draft visitor terms (pending legal review): I will view the unit only during my booked time, never share the door code, take nothing out of the unit, close the door when I leave and report any damage in the app at once. Entry and exit times are recorded.',
    },
    reason: 'seed: D-295 draft (O-024)',
    check: (value: unknown) => {
      const v = value as Record<string, unknown> | null;
      return v &&
        typeof v === 'object' &&
        Number.isInteger(v.version) &&
        (v.version as number) > 0 &&
        (v.version as number) < 32_000 &&
        ['th', 'en'].every((k) => typeof v[k] === 'string' && v[k].trim().length > 0)
        ? []
        : ['{"version": positive integer, "th": text, "en": text}'];
    },
  },
  {
    key: 'lease.end.remind_days_before',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-261 (B7.11): days before a landlord’s lease in force ends when the resident (and the owner, unless B7.4 already reminds them) is reminded once to talk about a renewal. 0 = off.',
    editableBy: ['admin.listing.moderate'],
    value: 60,
    reason: 'seed: B7.11 (D-261: same lead time as the re-list reminder)',
  },
  {
    key: 'listing.relist.remind_days_before',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-253 (B7.4): days before a lease that came from a listing ends when the owner is reminded once to re-open the listing (or offer a renewal). 0 = off.',
    editableBy: ['admin.listing.moderate'],
    value: 60,
    reason: 'seed: B7.4 (D-253: default 60)',
  },
  {
    key: 'listing.utility_history.min_bills',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-265 (B7.9): confirmed utility bills a unit needs before its listing shows their average (the rates are shown without history).',
    editableBy: ['admin.listing.moderate'],
    value: 3,
    reason: 'seed: B7.9 (D-265: three bills)',
  },
  // --- G4 distribution (D-288, D-296) ----------------------------------------------------------------------
  {
    key: 'listing.verified_vacant.require_history',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-296 (G4): the "verified vacant" badge needs lease history on getproperty (a lease of the unit that ended or was terminated, and nothing in force since). Off = a unit with no lease record and no occupancy also counts as verified vacant.',
    editableBy: ['admin.listing.moderate'],
    value: true,
    reason: 'seed: D-296 (badge only from real data)',
  },
  {
    key: 'social.post.max_attempts',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-296 (G4): attempts at a Facebook Page post (publish / update / delete) before it is marked failed (rate limits and provider errors are retried; a refused token is not).',
    editableBy: ADMIN,
    value: 5,
    reason: 'seed: D-296',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20 ? [] : ['1–20'],
  },
  {
    key: 'social.post.retry_minutes',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-296 (G4): minutes before a Facebook Page post is tried again, doubled per attempt.',
    editableBy: ADMIN,
    value: 10,
    reason: 'seed: D-296',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1440
        ? []
        : ['1–1440 minutes'],
  },
  // --- G5 boost & growth billing (D-287, D-291, D-297) --------------------------------------------------------
  {
    key: 'boost.search.max_per_page',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-297 (G5): at most this many boosted listings in the sponsored slots on top of each public search page (always labelled as ads; ranked by verified vacancy, then freshness). 0 = no sponsored slots. The default 3 is an assumption (O-027).',
    editableBy: ADMIN,
    value: 3,
    reason: 'seed: D-297 (assumption, O-027)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10 ? [] : ['0–10'],
  },
  {
    key: 'boost.building.free',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-297 (G5): the building boost is free for this tenant (e.g. Apartment Smart customers — which tenants qualify is open, O-027); set by the platform admin platform-wide or per tenant. One free building boost in force at a time.',
    editableBy: ADMIN,
    value: false,
    reason: 'seed: D-297 (no free boost until decided, O-027)',
  },
  // --- G8 getbuild handoff, relocation network (D-289, D-299; O-033) ----------------------------------------------
  {
    key: 'getbuild.handoff.valid_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-299 (G8): days a getbuild rental handoff invitation stays open for the buyer before it expires (counted from the transfer event).',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-299',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 365 ? [] : ['1–365 days'],
  },
  {
    key: 'getbuild.handoff.campaign_tags',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-299 / O-033 (G8): campaign tag per getbuild developer ({"<developer tenant id>": "<tag>"}) put on the listing drafted from a rental handoff; a developer not listed gets "getbuild:<developer tenant id>".',
    editableBy: ADMIN,
    value: {},
    reason: 'seed: D-299 (no developer campaign yet, O-033)',
    check: (value: unknown) =>
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every(
        (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 100,
      )
        ? []
        : ['an object of developer id → tag (1–100 characters)'],
  },
  {
    key: 'relocation.offer.max_listings',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-299 (G8): how many public listings in the destination a relocation offer shows to a resident who consented (resident.relocation).',
    editableBy: ADMIN,
    value: 10,
    reason: 'seed: D-299',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 50 ? [] : ['1–50 listings'],
  },
  {
    key: 'relocation.offer.keep_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-299 (G8): days after the lease ended until an open relocation offer closes (its destination is then erased, PDPA minimisation).',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-299',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 180 ? [] : ['0–180 days'],
  },
  // --- G6 audience, marketing consent, sponsored broadcast (D-287, D-300; O-023, O-027) ---------------------------
  {
    key: 'broadcast.sponsored.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-300 / O-023 (G6): sponsored broadcasts through getproperty’s LINE OA may be scheduled and sent. Stays false until LINE Thailand confirms in writing that sponsored listings through the getproperty OA are allowed (O-023); internal (non-sponsored) recommendations do not need it.',
    editableBy: ADMIN,
    value: false,
    reason: 'seed: O-023 open (LINE Thailand has not confirmed)',
  },
  {
    key: 'broadcast.sponsored.max_per_week',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 (G6): frequency cap — at most this many sponsored messages per person in any rolling 7 days, over all campaigns (G-growth-api G6: ≤ 2). 0 = none are sent.',
    editableBy: ADMIN,
    value: 2,
    reason: 'seed: D-300 (G-growth-api G6)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 7 ? [] : ['0–7 per week'],
  },
  {
    key: 'broadcast.sponsored.quiet_hours',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-300 / D-025 (G6): no sponsored message is sent between these local times unless the person set their own quiet hours (default as notifications.quiet_hours, 21:00–08:00 Asia/Bangkok); a person in quiet hours gets it after the window, within the campaign’s send window.',
    editableBy: ADMIN,
    value: { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' },
    reason: 'seed: D-300 (same default as notifications.quiet_hours)',
    check: (value: unknown) => {
      const v = value as { start?: unknown; end?: unknown; timezone?: unknown } | null;
      const hhmm = (x: unknown) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
      return v && typeof v === 'object' && hhmm(v.start) && hhmm(v.end) && typeof v.timezone === 'string'
        ? []
        : ['{start: "HH:MM", end: "HH:MM", timezone}'];
    },
  },
  {
    key: 'broadcast.sponsored.max_listings',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 (G6): how many of the buyer’s own published listings one sponsored campaign may carry (one Flex bubble each).',
    editableBy: ADMIN,
    value: 5,
    reason: 'seed: D-300',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10 ? [] : ['1–10 listings'],
  },
  {
    key: 'broadcast.sponsored.send_window_hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 (G6): a sending campaign completes this many hours after it started even when not everyone was reached (people in quiet hours or at the frequency cap are not waited for longer).',
    editableBy: ADMIN,
    value: 24,
    reason: 'seed: D-300',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 168 ? [] : ['1–168 hours'],
  },
  {
    key: 'broadcast.sponsored.attribution_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 (G6): an enquiry on a campaign listing by someone who got the campaign counts as a campaign lead in the buyer’s aggregate report when it is made within this many days of the message.',
    editableBy: ADMIN,
    value: 7,
    reason: 'seed: D-300',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 60 ? [] : ['1–60 days'],
  },
  {
    key: 'broadcast.sponsored.delivery_keep_months',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 / D-025 (G6): months a per-person delivery row (who got which campaign) is kept for the frequency cap, the person’s history and disputes; afterwards it is deleted and only the campaign’s aggregate counters remain.',
    editableBy: ADMIN,
    value: 12,
    reason: 'seed: D-300 (schema-design G6-d)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 36 ? [] : ['1–36 months'],
  },
  {
    key: 'audience.preferences.keep_days_after_withdrawal',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-300 / D-025 (G6): days a person’s recommendation preferences are kept after they withdraw consent platform.recommendations (never used meanwhile; 0 = deleted at once); DSR erasure deletes them immediately.',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-300 (schema-design G6-b)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 90 ? [] : ['0–90 days'],
  },
  {
    key: 'listing.comparables.min',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-269 (B7.9): comparable listings needed before the rent band and median days-to-let are shown (to the owner, and on area pages); below it nothing is shown.',
    editableBy: ['admin.listing.moderate'],
    value: 8,
    reason: 'seed: B7.9 (D-269: default 8)',
  },
  {
    key: 'listing.area.index_min',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-272 (B7.9): published listings an area or station page needs to be indexable by search engines.',
    editableBy: ['admin.listing.moderate'],
    value: 3,
    reason: 'seed: B7.9 (D-272: default 3)',
  },
  {
    key: 'listing.public_profile.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-274 (B7.9): the public owner page `/owners/{slug}` of a verified owner (display name, verification, member since, median reply time, published listings). On by default; the owner switches it off for their organisation.',
    editableBy: OWNER_SETTINGS,
    value: true,
    reason: 'seed: B7.9 (D-274: default on when verified)',
  },
  {
    key: 'lease.stamp_duty.baht_per_thousand',
    valueType: 'decimal',
    scopeAllowed: ['platform'],
    description:
      'D-253 / O-019 ⚖: stamp duty on a lease of land or buildings, in baht per 1,000 baht (or fraction) of the rent over the whole term (Revenue Code, schedule of stamp duties, instrument 1: 1 baht). Fixed on the lease when it is sent for signature.',
    editableBy: ADMIN_COMPLIANCE,
    value: '1',
    reason: 'seed: B7.5 (Revenue Code instrument 1, pending tax counsel O-019)',
  },
  {
    key: 'lease.stamp_duty.due_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-253 / O-019 ⚖: days after the lease is signed by both parties within which the stamp duty is paid in cash or through e-Stamp (shown as the due date; the owner is reminded on the lease).',
    editableBy: ADMIN_COMPLIANCE,
    value: 15,
    reason: 'seed: B7.5 (e-Stamp Duty: within 15 days of signing, pending tax counsel O-019)',
  },
  {
    key: 'lease.notice.rent_increase_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-253 / D-020 ⚖: minimum days between a rent-increase notice and the date the new rent applies; the new rent may only apply after the current lease ends (no mid-term increase).',
    editableBy: ADMIN_COMPLIANCE,
    value: 30,
    reason: 'seed: B7.5 (same period as the lessee notice of ข้อ 4 (11), pending counsel O-017)',
  },
  {
    key: 'lease.notice.renewal_response_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-253: days the lessee has to answer a renewal offer (never later than the end of the current lease).',
    editableBy: ADMIN_COMPLIANCE,
    value: 15,
    reason: 'seed: B7.5',
  },
  {
    key: 'contract.library.disclaimer',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-290 / D-294 (G3): the disclaimer shown with every contract-library draft and every document made from one ({"th": …, "en": …}); drafts stay pending legal verification (O-025).',
    editableBy: ADMIN_COMPLIANCE,
    value: {
      th: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย',
      en: 'A sample contract provided for convenience; not legal advice.',
    },
    reason: 'seed: D-290 (founder text)',
    check: (value: unknown) =>
      value &&
      typeof value === 'object' &&
      ['th', 'en'].every((k) => {
        const v = (value as Record<string, unknown>)[k];
        return typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
      })
        ? []
        : ['{"th": text, "en": text} (each 1–500 characters)'],
  },
  {
    key: 'lease.renewal.remind_days',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-294 (G3): days before a lease in force ends when the owner is reminded to offer a renewal (once per threshold, while no offer is open or accepted); [] = off. A landlord already reminded by B7.11 (lease.end.remind_days_before) is not reminded again at that threshold or earlier.',
    editableBy: OWNER_SETTINGS,
    value: [60, 30],
    reason: 'seed: D-294 (pack G3: 60 / 30 days)',
    check: (value: unknown) =>
      Array.isArray(value) &&
      value.length <= 6 &&
      value.every((v) => Number.isInteger(v) && v >= 1 && v <= 365)
        ? []
        : ['an array of up to 6 whole days between 1 and 365'],
  },
  {
    key: 'lease.notice.late_payment_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-253 / D-024: days a late-payment notice gives the lessee to pay; the notice never terminates the lease nor cuts a service.',
    editableBy: ADMIN_COMPLIANCE,
    value: 7,
    reason: 'seed: B7.5',
  },
  {
    key: 'tax.income_40_5.flat_deduction_percent',
    valueType: 'decimal',
    scopeAllowed: ['platform'],
    description:
      'D-253 ⚖ O-017: flat-rate expense deduction for rent of buildings under section 40(5) of the Revenue Code (Royal Decree No. 11: 30 %), shown as an estimate in the annual rental income summary.',
    editableBy: ADMIN_COMPLIANCE,
    value: '30',
    reason: 'seed: B7.5 (Royal Decree No. 11, pending tax counsel)',
  },
  {
    key: 'messaging.link_token.ttl_minutes',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      "D-254 (B7 deliverable 7.7): how long the account-linking link an operator's own LINE OA replies with stays valid, in minutes.",
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: B7 deliverable 7.7',
  },
  {
    key: 'messaging.health_check.hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      "D-254 (B7 deliverable 7.7): how often each operator's own LINE OA is checked with LINE, in hours; one that stopped working is marked failing and its owner told once.",
    editableBy: ADMIN,
    value: 6,
    reason: 'seed: B7 deliverable 7.7',
  },
  // --- platform business (Proposed until the pilot) ------------------------------------------------------
  {
    key: 'platform.subscriptions.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-250 (founder 2026-10-24): getproperty is free for operators — the D-204 subscriptions (trial, unit counting, subscription invoices, suspension) run only while this is true. Off: the hourly job does nothing and no subscription can be created; HaaS and platform fee invoices are unaffected.',
    editableBy: ['admin.subscription.manage'],
    value: false,
    reason: 'seed: D-250',
  },
  {
    key: 'subscription.trial_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-082: length of the trial before a subscription becomes active.',
    editableBy: ['admin.subscription.manage'],
    value: 30,
    reason: 'seed: D-082',
  },
  {
    key: 'subscription.invoice_due_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-082 / D-204: days from the issue of a platform invoice to its due date. B6.1 assumption: 15 days.',
    editableBy: ['admin.subscription.manage'],
    value: 15,
    reason: 'seed: D-204 (B6.1 assumption)',
  },
  {
    key: 'subscription.grace_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-082 / D-204: days after the due date before an unpaid platform invoice is overdue and the subscription past due. B6.1 assumption: 7 days.',
    editableBy: ['admin.subscription.manage'],
    value: 7,
    reason: 'seed: D-204 (B6.1 assumption)',
  },
  {
    key: 'subscription.suspend_after_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-082 / D-204: days a subscription stays past due before it is suspended (tenant read-only, never data loss). B6.1 assumption: 30 days.',
    editableBy: ['admin.subscription.manage'],
    value: 30,
    reason: 'seed: D-204 (B6.1 assumption)',
  },
  {
    key: 'platform.company',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-146 / D-204 (⚖ O-008): the issuer printed on platform invoices, receipts and credit notes — Collective Group (Thailand). Tax id, branch and address are placeholders until Finance confirms them.',
    editableBy: ADMIN,
    value: {
      legalName: 'Collective Group (Thailand) Co., Ltd.',
      displayName: 'getproperty',
      taxId: null,
      branch: null,
      address: null,
      email: 'billing@getproperty.co',
      vatRegistered: true,
    },
    reason: 'seed: D-204 placeholder (O-008)',
  },
  {
    key: 'platform.brand',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-001 / D-232: the getproperty brand where the platform itself appears — the "issued via getproperty" line of tenant documents, platform invoices/receipts/credit notes, emails sent by the platform and the header of LINE messages from the getproperty Official Account (tenant documents keep the tenant\'s own name and logo). Images are asset:<file> (bundled assets/brand, public at <PUBLIC_API_BASE_URL>/brand/<file>) or https URLs the platform admin hosts; colours #RRGGBB.',
    editableBy: ADMIN,
    value: DEFAULT_PLATFORM_BRAND,
    reason: 'seed: D-232 official getproperty logo (founder supplied 2026-10-21)',
    check: platformBrandProblems,
  },
  {
    key: 'platform.payments.merchant',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      "D-204 (⚖ O-008, O-001): the platform's own merchant account for the Thai QR of platform invoices (provider, merchant reference, account name); credentials in platform.provider_credential (tenant_id NULL, D-240). Disabled until the account exists (O-001: provider not chosen; with fake integrations the fake adapter of that provider answers).",
    editableBy: ['admin.subscription.manage'],
    value: {
      enabled: false,
      provider: 'kbank',
      merchantRef: 'GP-PLATFORM',
      accountName: 'Collective Group (Thailand)',
    },
    reason: 'seed: D-204 placeholder (O-008)',
  },
  {
    key: 'ai.unit_costs',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-161 / D-204 (O-009): cost to the platform per unit of each AI feature (THB) to track AI cost per tenant; 0 until the provider prices are entered.',
    editableBy: ['admin.subscription.manage'],
    value: {
      meter_ocr: { unitKind: 'images', costPerUnitThb: '0' },
      invoice_ocr: { unitKind: 'images', costPerUnitThb: '0' },
    },
    reason: 'seed: D-204 placeholder (O-009)',
  },
  {
    key: 'pricing.price_plans',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-156 (Proposed until the pilot, supersedes D-080): blueprint price plans in THB excl. VAT; becomes platform.price_plan(+version) in B6.1. Ranges are proposals, not prices.',
    editableBy: ['admin.subscription.manage'],
    value: {
      status: 'proposed',
      decision: 'D-156',
      currency: 'THB',
      vatIncluded: false,
      plans: {
        apartment_starter: {
          billingUnit: 'per_unit',
          pricePerUnit: '25.00',
          minUnits: 20,
          modules: ['A1', 'A2', 'A4', 'resident_liff', 'promptpay'],
        },
        apartment_smart: {
          billingUnit: 'per_unit',
          pricePerUnit: '40.00',
          modules: ['A1', 'A2', 'A3', 'A4', 'C2'],
          meterSale: { fromPerPoint: '1500.00', toPerPoint: '2500.00' },
          meterRentalPerPointMonthly: '60.00',
        },
        condo_juristic: {
          billingUnit: 'per_unit',
          tiers: ['15.00', '12.00', '10.00'],
          tierBreakpoints: null,
          minUnits: 100,
          note: 'tier breakpoints not specified by the blueprint',
        },
        juristic_pro: {
          billingUnit: 'per_unit',
          pricePerUnit: '20.00',
          agmModulePerBuildingYear: { from: '6000.00', to: '15000.00' },
        },
        access_addon: { billingUnit: 'per_building', monthly: { from: '3000.00', to: '8000.00' } },
        pm_portfolio: { billingUnit: 'per_tenant', monthlyFrom: '50000.00', buildingsIncluded: 10 },
        landlord: {
          billingUnit: 'per_tenant',
          steps: [
            { upToUnits: 3, monthly: '0.00' },
            { upToUnits: 10, monthly: '99.00' },
            { upToUnits: 20, monthly: '299.00' },
          ],
        },
        inspection_report: { billingUnit: 'per_report', price: { from: '3000.00', to: '5000.00' } },
      },
      free: ['residents', 'technicians', 'committee_members'],
      unitCounting: 'units with status <> inactive on the 1st of the month (D-082/D-156)',
    },
    reason: 'seed: D-156 proposed pricing',
  },
  // --- e-Tax, TM30 (B6.2) ------------------------------------------------------------------------------
  {
    key: 'etax.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-050 / D-215 (B6.2): receipts and receipt-tax invoices of a VAT-registered tenant are submitted to its e-Tax Invoice & e-Receipt service provider (the provider holds the certificate; off until the tenant has signed up with one).',
    editableBy: OWNER_BILLING,
    value: false,
    reason: 'seed: D-215 (opt-in per tenant)',
  },
  {
    key: 'etax.provider',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-050 / D-215 (B6.2): the Revenue-Department-approved e-Tax service provider of the tenant (adapter key); the account secrets live in the secret store, never in settings.',
    editableBy: OWNER_BILLING,
    value: 'inet',
    reason: 'seed: D-215 first adapter',
    allowedValues: ['inet'],
  },
  {
    key: 'etax.seller_branch',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-050 / D-215 (B6.2): the 5-digit branch code of the tenant as registered with the Revenue Department (00000 = head office), sent with every e-Tax document.',
    editableBy: OWNER_BILLING,
    value: '00000',
    reason: 'seed: D-215 head office default',
  },
  {
    key: 'tm30.notify_within_hours',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-052 / D-216 ⚖ (Immigration Act B.E. 2522 s.38): the house master notifies the Immigration Bureau of a foreigner staying at the premises within this many hours of arrival (24); the TM30 workflow SLA.',
    editableBy: ADMIN_COMPLIANCE,
    value: 24,
    reason: 'seed: D-052 (24-hour rule, legal reference to be confirmed by counsel)',
  },
  // --- analytics (B6.3) --------------------------------------------------------------------------------
  {
    key: 'analytics.csat_survey_interval_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-083 / D-217 (B6.3): the resident app offers the 1-question satisfaction survey when the resident has not answered it for this many days (90).',
    editableBy: OWNER_SETTINGS,
    value: 90,
    reason: 'seed: D-217 founder pre-approved recommendation',
  },
  {
    key: 'analytics.reminder_effective_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-045 / D-217 (B6.3): a payment reminder counts as effective when the invoice is paid within this many days after it (7).',
    editableBy: ADMIN,
    value: 7,
    reason: 'seed: D-217 founder pre-approved recommendation',
  },
  {
    key: 'ai.usage_metering',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-161 (placeholder, Proposed): AI usage metering per tenant — off until the AI gateway lands (B6.4); allowance/overage values are the schema-design §3.2.10 example, not prices.',
    editableBy: ['admin.subscription.manage'],
    value: { enabled: false, ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50', status: 'proposed' },
    reason: 'seed: D-161 placeholder',
  },
];
