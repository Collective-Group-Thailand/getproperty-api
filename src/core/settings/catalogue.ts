/**
 * Setting catalogue (ADR-0004, D-144): every business value a decision marks as configurable, with its type,
 * where overrides may exist, who may edit it and the platform default. `prisma/seed` mirrors it into
 * platform.setting + an initial platform.setting_version (effective from the seed run; versions are never
 * backdated). Descriptions MUST cite the decision (the database CHECKs for a D-/O- id).
 * ⚖ = value waits for legal confirmation (O-002); "Proposed" = business value not yet confirmed (D-156, D-161).
 */
import { DEFAULT_PLATFORM_BRAND, platformBrandProblems } from '../brand/brand-setting';

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
