/**
 * Setting catalogue (ADR-0004, D-144): every business value a decision marks as configurable, with its type,
 * where overrides may exist, who may edit it and the platform default. `prisma/seed` mirrors it into
 * platform.setting + an initial platform.setting_version (effective from the seed run; versions are never
 * backdated). Descriptions MUST cite the decision (the database CHECKs for a D-/O- id).
 * ⚖ = value waits for legal confirmation (O-002); "Proposed" = business value not yet confirmed (D-156, D-161).
 */
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
    key: 'subscription.trial_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description: 'D-082: length of the trial before a subscription becomes active.',
    editableBy: ['admin.subscription.manage'],
    value: 30,
    reason: 'seed: D-082',
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
