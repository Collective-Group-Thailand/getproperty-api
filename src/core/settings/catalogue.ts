/**
 * Setting catalogue (ADR-0004, D-144): every business value a decision marks as configurable, with its type,
 * where overrides may exist, who may edit it and the platform default. `prisma/seed` mirrors it into
 * platform.setting + an initial platform.setting_version (effective from the seed run; versions are never
 * backdated). Descriptions MUST cite the decision (the database CHECKs for a D-/O- id).
 * ⚖ = value waits for legal confirmation (O-002); "Proposed" = business value not yet confirmed (D-156, D-161).
 */
import { DEFAULT_PLATFORM_BRAND, platformBrandProblems } from '../brand/brand-setting';
import { NEVER_SUSPENDED } from '../compliance/evaluators';
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
import {
  alertDaysProblems,
  approvalBandsProblems,
  DEFAULT_APPROVAL_BANDS,
  DEFAULT_EVALUATION_CRITERIA,
  DEFAULT_WHT_RATES,
  evaluationCriteriaProblems,
  whtRatesProblems,
} from './juristic-accounting-settings';

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
/** D-326: a nullable percent (decimal string 0–100, at most 4 decimals). */
const nullablePercent = (v: unknown): string[] =>
  v === null || (typeof v === 'string' && /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100)
    ? []
    : ['null or a percent 0–100 as a decimal string'];
/** D-326: nullable whole days 0–3650. */
const nullableDays = (v: unknown): string[] =>
  v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3650)
    ? []
    : ['null or whole days 0–3650'];
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
    key: 'juristic.rate_requires_resolution',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-304 / D-324 (J1.1b, compliance.condo_act.resolution_required ⚖ O-038): a common-fee / fund rate version of a building operated by a juristic tenant must name an adopted resolution of that building; set by the platform admin.',
    editableBy: ADMIN_COMPLIANCE,
    value: true,
    reason: 'seed: D-304 (pack J, J1.1b)',
  },
  {
    key: 'juristic.transfer_proration',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-303 / D-324 (J1.1b): an ownership transfer after an advance invoice was issued — "carry_to_buyer" (default: credit note to the seller for the days from the transfer date and the same amount charged to the buyer on the next monthly cycle) or "refund_seller" (credit note to the seller only; the buyer is billed from the next cycle).',
    editableBy: OWNER_BILLING,
    value: 'carry_to_buyer',
    reason: 'seed: D-303 (pack J, J1.1b)',
    allowedValues: ['carry_to_buyer', 'refund_seller'],
  },
  {
    key: 'juristic.plan_default_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      "D-308 / D-325 (J1.2a): a payment plan defaults when a billed instalment is still unpaid this many days after its invoice's due date — future instalments are cancelled, the rest of the principal is billed at once and the collections ladder resumes (J1.2b). Snapshot on the plan at approval.",
    editableBy: OWNER_BILLING,
    value: 30,
    reason: 'seed: D-308 (pack J, J1.2a)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 180 ? [] : ['an integer 1–180'],
  },
  {
    key: 'juristic.plan_max_instalments',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description: 'D-325 (J1.2a): the most monthly instalments a payment plan may have (2 at least).',
    editableBy: OWNER_BILLING,
    value: 12,
    reason: 'seed: D-308 (pack J, J1.2a)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 60 ? [] : ['an integer 2–60'],
  },
  {
    key: 'juristic.debt_clearance.fee',
    valueType: 'money',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-306 / D-325 (J1.2a, compliance.condo_act.debt_clearance ⚖ O-038): fee of a debt clearance certificate; 0.00 (default) = issued at once when nothing is outstanding, otherwise the fee is charged and the owner issues the certificate once it is paid.',
    editableBy: OWNER_BILLING,
    value: '0.00',
    reason: 'seed: D-306 (pack J, J1.2a; conservative: no fee until set)',
  },
  {
    key: 'juristic.debt_clearance.validity_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-306 / D-325 (J1.2a): days a debt clearance certificate stays valid from its issue (shown on the PDF and the public verification page).',
    editableBy: OWNER_BILLING,
    value: 30,
    reason: 'seed: D-306 (pack J, J1.2a)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365 ? [] : ['an integer 1–365'],
  },
  // --- J1.2b collections ladder (D-305, D-326, ⚖ O-038): every legal measure off / unset until counsel confirms ---
  {
    key: 'juristic.surcharge.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-305 / D-326 (J1.2b, compliance.condo_act_surcharge_cap / land_allocation_surcharge_cap ⚖ O-038): ladder surcharge steps may be enabled and run only while this is on; off until counsel confirms the caps per legal form.',
    editableBy: ADMIN_COMPLIANCE,
    value: false,
    reason: 'seed: D-305 (pack J, J1.2b; off until O-038)',
  },
  ...(['rate_pct_per_year', 'escalated_rate_pct_per_year'] as const).map((k): SettingDef => ({
    key: `juristic.surcharge.${k}`,
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description: `D-305 / D-326 (J1.2b): the juristic person's own ${k === 'rate_pct_per_year' ? '' : 'escalated '}surcharge rate in percent per year (decimal string, null = none); never above the legal form's cap (compliance rule).`,
    editableBy: OWNER_BILLING,
    value: null,
    reason: 'seed: D-305 (pack J, J1.2b; unset)',
    check: nullablePercent,
  })),
  ...(['condo_act', 'land_allocation_act'] as const).flatMap((form): SettingDef[] => [
    {
      key: `juristic.surcharge.${form}.rate_cap`,
      valueType: 'json',
      scopeAllowed: ['platform'],
      description: `D-305 / D-326 (J1.2b, ⚖ O-038): the highest surcharge rate (percent per year) for ${form} buildings; null until counsel confirms it — no surcharge runs without it.`,
      editableBy: ADMIN_COMPLIANCE,
      value: null,
      reason: 'seed: D-305 (pack J, J1.2b; unset until O-038)',
      check: nullablePercent,
    },
    {
      key: `juristic.surcharge.${form}.escalated_rate_cap`,
      valueType: 'json',
      scopeAllowed: ['platform'],
      description: `D-305 / D-326 (J1.2b, ⚖ O-038): the highest escalated surcharge rate (percent per year) for ${form} buildings after escalate_after_days; null = the plain cap applies throughout.`,
      editableBy: ADMIN_COMPLIANCE,
      value: null,
      reason: 'seed: D-305 (pack J, J1.2b; unset until O-038)',
      check: nullablePercent,
    },
    {
      key: `juristic.surcharge.${form}.escalate_after_days`,
      valueType: 'json',
      scopeAllowed: ['platform'],
      description: `D-305 / D-326 (J1.2b, ⚖ O-038): days past the due date after which the escalated surcharge rate applies to ${form} buildings; null = never.`,
      editableBy: ADMIN_COMPLIANCE,
      value: null,
      reason: 'seed: D-305 (pack J, J1.2b; unset until O-038)',
      check: nullableDays,
    },
    {
      key: `juristic.suspend_services.${form}.min_overdue_days`,
      valueType: 'json',
      scopeAllowed: ['platform'],
      description: `D-305 / D-326 (J1.2b, compliance suspend_services ⚖ O-038): the minimum overdue period (days) before common services of a ${form} building may be suspended; null until counsel confirms it.`,
      editableBy: ADMIN_COMPLIANCE,
      value: null,
      reason: 'seed: D-305 (pack J, J1.2b; unset until O-038)',
      check: nullableDays,
    },
  ]),
  {
    key: 'juristic.suspend_services.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-305 / D-326 (J1.2b, ⚖ O-038): ladder suspend_services steps (common services only — never utilities or entry, D-024 / D-157) may be enabled and run only while this is on.',
    editableBy: ADMIN_COMPLIANCE,
    value: false,
    reason: 'seed: D-305 (pack J, J1.2b; off until O-038)',
  },
  {
    key: 'juristic.suspend_services.services',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-305 / D-326 (J1.2b): the common services a suspend_services step names (e.g. "pool_key_card", "fitness", "clubhouse"); utilities and entry to the unit are refused (compliance.juristic_no_utility_cutoff).',
    editableBy: OWNER_BILLING,
    value: [],
    reason: 'seed: D-305 (pack J, J1.2b; none)',
    check: (v) =>
      Array.isArray(v) &&
      v.length <= 20 &&
      v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(x)) &&
      !v.some((x) => NEVER_SUSPENDED.includes(x as string))
        ? []
        : ['an array of service keys (never electricity, water or access)'],
  },
  {
    key: 'juristic.legal_action.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-305 / D-326 (J1.2b, ⚖ O-038): ladder legal_action steps (recording the start of a lawsuit, with approval) may be enabled only while this is on.',
    editableBy: ADMIN_COMPLIANCE,
    value: false,
    reason: 'seed: D-305 (pack J, J1.2b; off until O-038)',
  },
  ...(['condo_act', 'land_allocation_act', 'voluntary', 'lease_contract'] as const).map(
    (form): SettingDef => ({
      key: `juristic.letters.${form}.template_version`,
      valueType: 'json',
      scopeAllowed: ['platform'],
      description: `D-305 / D-326 (J1.2b, compliance letter wording ⚖ O-038): the counsel-approved version of the notice / lawyer letter wording for ${form} buildings; null = no letter may be sent.`,
      editableBy: ADMIN_COMPLIANCE,
      value: null,
      reason: 'seed: D-305 (pack J, J1.2b; unset until O-038)',
      check: (v) =>
        v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 60)
          ? []
          : ['null or a version label'],
    }),
  ),
  {
    key: 'juristic.aging_buckets',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-326 (J1.2b): upper bounds in days past due of the juristic aging buckets — [30, 90, 365] = 0–30 · 31–90 · 91–365 · > 365 (D-045 buckets unchanged).',
    editableBy: OWNER_BILLING,
    value: [30, 90, 365],
    reason: 'seed: D-326 (pack J, J1.2b)',
    check: (v) =>
      Array.isArray(v) &&
      v.length >= 1 &&
      v.length <= 8 &&
      v.every(
        (x, i) =>
          Number.isInteger(x) && (x as number) > 0 && (i === 0 || (x as number) > (v[i - 1] as number)),
      )
        ? []
        : ['ascending positive whole days'],
  },
  {
    key: 'juristic.approval_bands',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-311 / D-329 (J2.1): expense approval bands — ascending `upTo` amounts (THB, the last null) → `roles` (owner · manager · committee) and the number of distinct `approvals` (1–5) needed; the requester never approves (maker-checker, D-091). Defaults are an assumption until the juristic sets its own (regulations / AGM).',
    editableBy: OWNER_SETTINGS,
    value: DEFAULT_APPROVAL_BANDS,
    reason: 'seed: D-329 (pack J, J2.1) — assumed defaults, editable',
    check: approvalBandsProblems,
  },
  {
    key: 'juristic.wht_rates',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-311 / D-329 (J2.1, ⚖ O-041): withholding-tax rates a juristic person applies when paying vendors — data (key, th / en label, income type printed on the 50 ทวิ, rate %, verified). Seeded with the common 1 / 2 / 3 / 5 % rates marked `verified: false` until a tax adviser confirms them for condominium / housing-estate juristic persons.',
    editableBy: OWNER_BILLING,
    value: DEFAULT_WHT_RATES,
    reason: 'seed: D-329 (pack J, J2.1) — pending verification O-041',
    check: whtRatesProblems,
  },
  {
    key: 'juristic.bank_match_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-329 (J2.1): bank statement matching window — a statement line matches a payment / paid expense / fund transfer of the same amount booked within this many days.',
    editableBy: OWNER_BILLING,
    value: 3,
    reason: 'seed: D-329 (pack J, J2.1)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 31 ? [] : ['an integer 0–31'],
  },
  {
    key: 'juristic.quotation_threshold',
    valueType: 'decimal',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-310 / D-331 (J2.2): a vendor purchase or service contract above this amount (THB) needs at least 3 quotations, or a recorded reason for fewer approved by resolution or the approval band.',
    editableBy: OWNER_SETTINGS,
    value: '50000.00',
    reason: 'seed: D-310 (pack J, J2.2)',
    check: (v) => (typeof v === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(v) ? [] : ['a money string ≥ 0']),
  },
  {
    key: 'juristic.import.parallel_cycle_required',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-313 / D-332 (J3.1): an import goes live only after one billing cycle was compared with the legacy bills (the parallel cycle).',
    editableBy: OWNER_SETTINGS,
    value: true,
    reason: 'seed: D-313 (pack J, J3.1)',
    check: (v) => (typeof v === 'boolean' ? [] : ['true or false']),
  },
  {
    key: 'juristic.import.allow_unexplained_differences',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-332 (J3.1): when true, an import may go live with unexplained per-unit differences of the parallel cycle if the request acknowledges them (recorded); false (default) blocks go-live until each is explained.',
    editableBy: OWNER_SETTINGS,
    value: false,
    reason: 'seed: D-332 (pack J, J3.1) — conservative',
    check: (v) => (typeof v === 'boolean' ? [] : ['true or false']),
  },
  {
    key: 'juristic.contract_expiry_alert_days',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-310 / D-331 (J2.2): days before a vendor contract ends at which the owner, managers and committee are alerted (once each; a late first run sends only the nearest).',
    editableBy: OWNER_SETTINGS,
    value: [90, 60, 30],
    reason: 'seed: D-310 (pack J, J2.2)',
    check: alertDaysProblems,
  },
  {
    key: 'juristic.contract_instalment_lead_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-331 (J2.2): days before an instalment of a vendor contract falls due that the vendor-contracts job submits its expense request for approval.',
    editableBy: OWNER_SETTINGS,
    value: 7,
    reason: 'seed: D-331 (pack J, J2.2) — assumption',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 60 ? [] : ['an integer 0–60'],
  },
  {
    key: 'juristic.vendor_evaluation_criteria',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-310 / D-331 (J2.2): the criteria (key, th / en label) a vendor contract is scored on each month, 1–5 each; the evaluation score is their average.',
    editableBy: OWNER_SETTINGS,
    value: DEFAULT_EVALUATION_CRITERIA,
    reason: 'seed: D-331 (pack J, J2.2) — assumption, editable',
    check: evaluationCriteriaProblems,
  },
  {
    key: 'juristic.kpi_collection_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-326 (J1.2b): the collection-rate KPI counts what was paid within this many days after the due date.',
    editableBy: OWNER_BILLING,
    value: 30,
    reason: 'seed: D-326 (pack J, J1.2b)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 365 ? [] : ['an integer 0–365'],
  },
  {
    key: 'juristic.workspace_invite_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      "D-270 / D-326 (J1.2b): days a landlord's invitation of its condo's juristic office stays open.",
    editableBy: ADMIN,
    value: 14,
    reason: 'seed: D-270 (pack J, J1.2b)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 90 ? [] : ['an integer 1–90'],
  },
  {
    key: 'juristic.auditor_max_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-320 / D-324 (J1.1b): longest time-box of an auditor membership (days from the invitation); the auditor loses access at `accessUntil`.',
    editableBy: ADMIN,
    value: 366,
    reason: 'seed: D-320 (pack J, J1.1b)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 731 ? [] : ['an integer 1–731'],
  },
  {
    key: 'billing.advance_open_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-303 / D-323 (J1.1a): quarterly, semiannual and annual cycles (common fees and funds billed in advance) open and compute this many days before their calendar start (0 = on the first day); monthly cycles keep the cut-off of billing.cutoff.',
    editableBy: OWNER_BILLING,
    value: 0,
    reason: 'seed: D-323 (pack J, J1.1a)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 60 ? [] : ['an integer 0–60'],
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
  {
    key: 'payments.allocation_policy',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-308 / D-325 (J1.2a): how a payment is spread over the payer\'s open invoices — "oldest_first" (default: invoice by invoice by issue date, each one\'s surcharge first) or "surcharge_first" (every open late fee / surcharge first, then the principal, oldest first). What exceeds them is the payer\'s credit.',
    editableBy: OWNER_BILLING,
    value: 'oldest_first',
    reason: 'seed: D-308 (pack J, J1.2a)',
    allowedValues: ['oldest_first', 'surcharge_first'],
  },
  {
    key: 'payments.slip_max_age_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      "D-325 (J1.2a): date window of a transfer slip — a slip dated more than this many days before its upload (or more than a day after it) is not confirmed automatically; it waits in the owner's review queue (reason date_out_of_window).",
    editableBy: OWNER_BILLING,
    value: 30,
    reason: 'seed: D-325 (pack J, J1.2a)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 366 ? [] : ['an integer 1–366'],
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
  // --- J4.2 barrier, LPR, resident open, SOS (D-316, D-317, D-328) -----------------------------------------
  ...(
    [
      [
        'gate.lpr.repeat_seconds',
        60,
        10,
        600,
        'seconds the same plate read again at the same gate is ignored (one car, one entry)',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.lpr.pending_minutes',
        10,
        1,
        60,
        'minutes an unknown-plate read waits on the gate tablet to pre-fill the visit form before it expires',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.open.min_interval_seconds',
        3,
        1,
        60,
        'shortest interval between two barrier opens of one gate (guard, resident or LPR) — a faster request is refused with 429',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.resident_open.max_per_hour',
        12,
        1,
        60,
        'barrier opens one resident login may request in an hour',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.resident_open.radius_m',
        300,
        50,
        5000,
        'metres around the estate location a resident must be within to open the barrier while gate.resident_open.require_geofence is on (+ the reported GPS accuracy, at most 100 m)',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.barrier.pulse_ms',
        800,
        200,
        10000,
        'relay pulse of a barrier in milliseconds when its device has none of its own',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.sos.cancel_seconds',
        30,
        10,
        120,
        'seconds a resident may cancel an SOS sent by mistake',
        ['platform', 'tenant'],
      ],
      [
        'gate.sos.max_per_hour',
        5,
        1,
        20,
        'SOS one resident login may send in an hour (abuse guard; an open SOS of the same unit is returned instead of a second one)',
        ['platform', 'tenant'],
      ],
      [
        'gate.incident.visit_window_minutes',
        30,
        0,
        240,
        'minutes before an SOS a visit that already exited is still linked to the incident',
        ['platform', 'tenant'],
      ],
    ] as const
  ).map(([key, value, min, max, what, scopes]): SettingDef => ({
    key,
    valueType: 'int',
    scopeAllowed: [...scopes],
    description: `D-316 / D-317 / D-328 (J4.2): ${what}.`,
    editableBy: OWNER_SETTINGS,
    value,
    reason: 'seed: D-328 (pack J, J4.2)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? [] : [`an integer ${min}–${max}`],
  })),
  {
    key: 'gate.lpr.max_event_age_seconds',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-330 (edge CR-017): a plate read that reaches the cloud more than this many seconds after the camera read it (`plate.detected` `data.at`, queued on the edge during an outage) is kept as a past read only — no automatic entry, no automatic barrier open, nothing for the guard to claim.',
    editableBy: OWNER_SETTINGS,
    value: 20,
    reason: 'seed: D-330 (conservative: a late read never opens the gate)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 300 ? [] : ['an integer 5–300'],
  },
  {
    key: 'gate.lpr.min_confidence',
    valueType: 'decimal',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-316 / D-328 (J4.2): lowest LPR confidence (0–1) at which a known plate enters on its own; below it the read only pre-fills the guard form.',
    editableBy: OWNER_SETTINGS,
    value: '0.90',
    reason: 'seed: D-328 (conservative: a misread never opens the gate)',
    check: (v) =>
      typeof v === 'string' && /^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(v)
        ? []
        : ['a decimal string 0–1 (≤ 3 decimals)'],
  },
  {
    key: 'gate.auto_open_known_plates',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-316 / D-328 (J4.2): the barrier opens by itself for a known plate (resident or remembered car) read with enough confidence. Off: the guard opens.',
    editableBy: OWNER_SETTINGS,
    value: false,
    reason: 'seed: D-328 (conservative: the guard opens until the estate decides)',
  },
  {
    key: 'gate.resident_open.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description: 'D-316 / D-328 (J4.2): residents may open the barrier from LINE for their registered cars.',
    editableBy: OWNER_SETTINGS,
    value: true,
    reason: 'seed: D-J15 (residents open from LINE)',
  },
  {
    key: 'gate.resident_open.require_geofence',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-316 / D-328 (J4.2): a resident open needs the phone location within gate.resident_open.radius_m of the estate (the location is checked, never stored).',
    editableBy: OWNER_SETTINGS,
    value: false,
    reason: 'seed: D-328 (brief: off by default)',
  },
  // --- J4.1 gate & visitor (D-315, D-327; PDPA: minimal data, retention that really deletes) ---------------
  ...(
    [
      [
        'gate.retention_days',
        90,
        1,
        90,
        'days visits, their photos and plates, ended invites and expired remembered vehicles are kept before the gate-retention job deletes them (D-315: 90; a tenant may only shorten it)',
        ['platform', 'tenant'],
      ],
      [
        'gate.policy.timeout_seconds',
        180,
        60,
        900,
        'seconds the gate waits for an answer of the unit before the house policy applies — the estate default of units without their own policy (D-315: 3 minutes)',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.remember_days',
        30,
        1,
        90,
        'days a "remember this car" entry of a unit stays valid; entries of a remembered car are notify-only (D-315: 30)',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.invite_max_days',
        30,
        1,
        90,
        'longest window of a resident visitor invite (single or multi use)',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.open_visit_alert_hours',
        24,
        1,
        168,
        'hours after its entry an open visit (no exit stamp) is reported once to the owner, manager and committee',
        ['platform', 'tenant', 'property'],
      ],
      [
        'gate.offline_max_hours',
        24,
        1,
        72,
        'oldest offline-recorded visit a gate tablet may still sync (recordedAt)',
        ['platform', 'tenant'],
      ],
      [
        'gate.device_enrol_hours',
        24,
        1,
        168,
        'hours a gate tablet enrolment code stays valid (single use)',
        ['platform', 'tenant'],
      ],
      [
        'gate.pin_max_attempts',
        5,
        3,
        10,
        'wrong guard PINs in a row before the guard is locked out for gate.pin_lock_minutes',
        ['platform', 'tenant'],
      ],
      [
        'gate.pin_lock_minutes',
        15,
        1,
        1440,
        'minutes a guard stays locked out after too many wrong PINs',
        ['platform', 'tenant'],
      ],
    ] as const
  ).map(([key, value, min, max, what, scopes]): SettingDef => ({
    key,
    valueType: 'int',
    scopeAllowed: [...scopes],
    description: `D-315 / D-327 (J4.1): ${what}.`,
    editableBy: OWNER_SETTINGS,
    value,
    reason: 'seed: D-327 (pack J, J4.1)',
    check: (v) =>
      Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? [] : [`an integer ${min}–${max}`],
  })),
  {
    key: 'gate.policy.action',
    valueType: 'string',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-315 / D-327 (J4.1): what the gate does when nobody of a unit answers in time — allow_and_log (let in, residents see the log), deny, or guard_calls (the guard phones the unit; default). Estate default of units without their own policy.',
    editableBy: OWNER_SETTINGS,
    value: 'guard_calls',
    reason: 'seed: D-315 (default guard_calls after 3 minutes)',
    allowedValues: ['allow_and_log', 'deny', 'guard_calls'],
  },
  {
    key: 'gate.delivery_drop_point',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant', 'property'],
    description:
      'D-315 / D-327 (J4.1): the estate has a delivery drop point — delivery visits enter without waiting for the unit (notify-only) unless the house policy says otherwise.',
    editableBy: OWNER_SETTINGS,
    value: false,
    reason: 'seed: D-327 (conservative: every delivery asks the unit until the estate sets a drop point)',
  },
  {
    key: 'gate.show_arrears',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-315 / D-327 (J4.1, ⚖ O-038): show a yes/no arrears flag of a unit on the gate tablet. Off until counsel confirms it may be shown at all; while off no arrears data is in any guard response.',
    editableBy: ADMIN_COMPLIANCE,
    value: false,
    reason: 'seed: O-038 (off until counsel confirms)',
  },
  {
    key: 'gate.privacy_notice',
    valueType: 'json',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-315 / D-327 (J4.1, PDPA D-025, ⚖ draft wording): the purpose notice shown on the gate tablet next to the visitor fields and in the resident gate view — {"version": n, "th": "…", "en": "…"}.',
    editableBy: OWNER_SETTINGS,
    value: {
      version: 1,
      th: 'นิติบุคคลเก็บทะเบียนรถ ชื่อ (ถ้าให้) เลขบัตร 4 ตัวท้าย (ถ้าให้) และรูปถ่าย (ถ้ามี) ของผู้มาติดต่อ เพื่อความปลอดภัยของผู้อยู่อาศัยและเพื่อแจ้งเจ้าของบ้านที่ท่านมาพบ ไม่เก็บสำเนาหรือรูปบัตรประชาชน ข้อมูลถูกลบอัตโนมัติเมื่อครบ 90 วัน',
      en: 'The juristic person records the plate, your name (optional), the last 4 digits of your ID (optional) and a photo (if taken) for the safety of residents and to inform the household you visit. No ID card copy or image is kept. The data is deleted automatically after 90 days.',
    },
    reason: 'seed: D-315 (⚖ draft wording, to be confirmed with the PDPA notice of O-002)',
    check: (v) => {
      const n = v as { version?: unknown; th?: unknown; en?: unknown } | null;
      return n &&
        Number.isInteger(n.version) &&
        typeof n.th === 'string' &&
        n.th.length > 0 &&
        n.th.length <= 2000 &&
        typeof n.en === 'string' &&
        n.en.length > 0 &&
        n.en.length <= 2000
        ? []
        : ['{"version": int, "th": "1–2000 chars", "en": "1–2000 chars"}'];
    },
  },
  {
    key: 'juristic.resident_invite_days',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-309 / D-322 (JR): days a unit invitation for a co-owner (single use, redeemed with an OTP to the phone of the ownership party) stays valid (14).',
    editableBy: OWNER_SETTINGS,
    value: 14,
    reason: 'seed: D-322 (pack J, JR)',
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
  // --- G9 verified reviews, listing assistant, energy insight (D-301, D-289 (6), D-161; O-035, O-036, O-028) -------
  {
    key: 'review.min_tenure_months',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 (G9): a person still living under a lease may review the building after this many months of tenure (from move-in, else the lease start); after move-out they may review at once (LIFF GL4: after move-out or after 3 months).',
    editableBy: ADMIN,
    value: 3,
    reason: 'seed: D-301 (G-growth-liff GL4)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 24 ? [] : ['1–24 months'],
  },
  {
    key: 'review.window_after_end_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 (G9): a former resident may review the building up to this many days after their tenure ended (move-out, else the lease end).',
    editableBy: ADMIN,
    value: 365,
    reason: 'seed: D-301',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 30 && (value as number) <= 1095 ? [] : ['30–1095 days'],
  },
  {
    key: 'review.moderation.premoderate',
    valueType: 'bool',
    scopeAllowed: ['platform'],
    description:
      'D-301 / O-035 (G9): true = every review waits for a platform moderator before it is public (conservative while the defamation / notice-and-takedown policy is open, O-035); false = published at once after the automatic screening and moderated afterwards.',
    editableBy: ADMIN,
    value: true,
    reason: 'seed: D-301 (O-035 open — conservative)',
  },
  {
    key: 'listing.assistant.enabled',
    valueType: 'bool',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-301 / D-161 (G9): the AI listing assistant (title and description drafts in th / en / zh from the listing’s facts) is offered.',
    editableBy: ADMIN,
    value: true,
    reason: 'seed: D-301',
  },
  {
    key: 'listing.assistant.monthly_limit',
    valueType: 'int',
    scopeAllowed: ['platform', 'tenant'],
    description:
      'D-301 / D-161 (G9): AI listing-assistant calls per tenant per Bangkok month (cost guard until the AI unit costs and any price are set, O-009); 0 = none.',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-301 (O-009 open)',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10000
        ? []
        : ['0–10000 calls'],
  },
  {
    key: 'listing.assistant.max_photos',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 (G9): how many of the listing’s first photos the assistant may read (sent to the AI gateway, never changed or stored again); 0 = text facts only.',
    editableBy: ADMIN,
    value: 3,
    reason: 'seed: D-301',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10 ? [] : ['0–10 photos'],
  },
  {
    key: 'energy.insight.window_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 (G9): the energy score reads the building’s hourly electricity rollups of this many full Bangkok days before today.',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-301',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 7 && (value as number) <= 90 ? [] : ['7–90 days'],
  },
  {
    key: 'energy.insight.min_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 (G9): fewer days with electricity data than this in the window → no score (`insufficient_data`) and nothing is shared with getenergy.',
    editableBy: ADMIN,
    value: 14,
    reason: 'seed: D-301',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 90 ? [] : ['1–90 days'],
  },
  {
    key: 'energy.insight.share_every_days',
    valueType: 'int',
    scopeAllowed: ['platform'],
    description:
      'D-301 / D-289 (6) (G9): while a building owner is opted in, a fresh energy snapshot is shared with getenergy at most this often.',
    editableBy: ADMIN,
    value: 30,
    reason: 'seed: D-301',
    check: (value: unknown) =>
      Number.isInteger(value) && (value as number) >= 7 && (value as number) <= 365 ? [] : ['7–365 days'],
  },
  {
    key: 'energy.insight.score_model',
    valueType: 'json',
    scopeAllowed: ['platform'],
    description:
      'D-301 / O-036 (G9): the energy score = 100 − penalties; each penalty grows linearly from 0 at `from` to `points` at `to` — common-area share of the building’s electricity, 1 − load factor (average ÷ peak hourly demand), pump running hours per day (common-area meters whose label matches `pumpLabelPattern`, an hour counts when it used ≥ `pumpOnKwhPerHour`). Assumed values until getenergy confirms its model (O-036).',
    editableBy: ADMIN,
    value: {
      version: 'v1',
      commonShare: { from: 0.2, to: 0.5, points: 40 },
      lowLoadFactor: { from: 0.5, to: 0.85, points: 30 },
      pumpHoursPerDay: { from: 8, to: 20, points: 30 },
      pumpLabelPattern: 'pump|ปั๊ม|ปั้ม',
      pumpOnKwhPerHour: 0.1,
    },
    reason: 'seed: D-301 (O-036 open)',
    check: (value: unknown) => {
      const v = value as Record<string, unknown> | null;
      const band = (b: unknown) => {
        const x = b as { from?: unknown; to?: unknown; points?: unknown } | null;
        return (
          !!x &&
          typeof x.from === 'number' &&
          typeof x.to === 'number' &&
          typeof x.points === 'number' &&
          x.to > x.from &&
          x.points >= 0 &&
          x.points <= 100
        );
      };
      return v &&
        typeof v === 'object' &&
        band(v.commonShare) &&
        band(v.lowLoadFactor) &&
        band(v.pumpHoursPerDay) &&
        typeof v.pumpLabelPattern === 'string' &&
        typeof v.pumpOnKwhPerHour === 'number' &&
        v.pumpOnKwhPerHour >= 0
        ? []
        : [
            '{commonShare, lowLoadFactor, pumpHoursPerDay: {from, to, points}, pumpLabelPattern, pumpOnKwhPerHour}',
          ];
    },
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
