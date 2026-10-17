import { type ComplianceCode } from '@common/errors/error-codes';
import { type ProblemFieldError } from '@common/errors/problem-details.dto';
import Decimal from 'decimal.js';

import { utilityCharge } from '../utility-tariffs/tariff-math';
import { type UtilityTariffStructure } from '../utility-tariffs/tariff-structure';

/**
 * Pure evaluators of the compliance rule registry (ADR-0007, D-020–D-025, D-021a, D-141, D-158;
 * docs/compliance/legal-reference.md). One function per rule: it receives the values a module has gathered (the
 * rule's *context*), compares them with the legal limit and returns a `RuleCheck` — whether the subject breaks the
 * rule, the values compared (stored with the `platform.compliance_evaluation` as evidence), field errors for a
 * refusal and what a warning shows the Owner. Severity (`warn | block`) is not decided here: the `ComplianceGate`
 * applies the registry default or the platform admin's override. No I/O, no clock: modules pass dates in.
 */

/** One rule checked against one subject. */
export interface RuleCheck {
  ruleId: ComplianceCode;
  /** true = the rule is broken by the subject. */
  violated: boolean;
  /** Values compared (recorded with the evaluation as evidence). */
  context: Record<string, unknown>;
  /** Field errors for a refusal (problem `errors[]`). */
  errors?: ProblemFieldError[];
  /** What a warning shows the Owner (acknowledgement). */
  shown?: Record<string, unknown>;
}

type FieldError = { path: string; code: string; message: string };
const D = (v: Decimal.Value) => new Decimal(v);
const DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const some = (errors: FieldError[]) => (errors.length ? errors : undefined);

// ------------------------------------------------------------------------------------------------ scope

export interface ScopeContext {
  /** Units the tenant rents out (D-158: the announcement applies from 3 units). */
  unitsRentedOut: number;
  /** `tenant.subject_to_ocpb_2568`. */
  subjectSetting: boolean;
}

/** ข้อ 3 (D-158): a tenant renting out ≥ 3 units whose setting says "not in scope" is flagged for the platform. */
export function evaluateScope(c: ScopeContext): RuleCheck {
  const inScopeByCount = c.unitsRentedOut >= 3;
  const violated = inScopeByCount && !c.subjectSetting;
  return {
    ruleId: 'compliance.scope',
    violated,
    context: { unitsRentedOut: c.unitsRentedOut, threshold: 3, subjectSetting: c.subjectSetting },
    shown: { unitsRentedOut: c.unitsRentedOut, threshold: 3 },
  };
}

// ------------------------------------------------------------------------------------------------ tariff cap

export interface TariffCapContext {
  /** The tenant's price per unit (rate plan or computed line), excl. VAT. */
  tenantRate: Decimal.Value;
  /** Units consumed (a line) or the representative consumption (a rate plan, D-021a). */
  units: Decimal.Value;
  /** The utility tariff version in force (the cap reference, D-140). */
  tariff: {
    id: string;
    utility: 'electric' | 'water';
    provider: string;
    tariffCode: string;
    effectiveFrom: string;
    structure: UtilityTariffStructure;
  };
}

/**
 * ข้อ 5 (6), D-021a, D-140: a tenant rate above the utility's **effective average rate** for that consumption
 * ((Σ tiers + Ft × u + service charge) / u, excl. VAT) is above the cap. Zero units have no average: the rate is then
 * compared with the price of the first unit (the lowest tier + Ft), so a rate plan can still be judged.
 */
export function evaluateTariffCap(c: TariffCapContext): RuleCheck {
  const units = D(c.units);
  const reference = units.gt(0) ? units : D(1);
  const charge = utilityCharge(c.tariff.structure, { units: reference });
  const cap = D(charge.effectiveAverageRate ?? '0');
  const rate = D(c.tenantRate);
  const violated = rate.gt(cap);
  const shown = {
    utility: c.tariff.utility,
    provider: c.tariff.provider,
    tariffCode: c.tariff.tariffCode,
    utilityTariffVersionId: c.tariff.id,
    effectiveFrom: c.tariff.effectiveFrom,
    units: units.toFixed(3),
    capPerUnit: cap.toFixed(4),
    tenantRate: rate.toFixed(4),
  };
  return {
    ruleId: 'compliance.tariff_cap',
    violated,
    context: { ...shown, capBasis: 'effective_average_rate', needsCheck: charge.needsCheck },
    shown,
    errors: violated
      ? [
          {
            path: 'pricePerUnit',
            code: 'aboveCap',
            message: `${rate.toFixed(4)} THB/unit is above the utility's effective average rate ${cap.toFixed(4)} THB/unit`,
          },
        ]
      : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ disclosure

export interface DisclosedMeterLine {
  path: string;
  units: string | null;
  unitPrice: string | null;
  /** Previous and current register (or one segment per assignment when a meter was swapped). */
  segments: { registerFrom: string | null; registerTo: string | null }[];
  readingSource: string | null;
  utilityTariffVersionId: string | null;
}

export interface BillDisclosureContext {
  meterLines: DisclosedMeterLine[];
  /** Fixed lines (lease lines, one-offs): a utility may never be billed as a fixed amount (D-022). */
  fixedLines: { path: string; kind: string; description: string }[];
}

const FLAT_UTILITY = /(ค่าไฟ|ค่าน้ำ|ไฟฟ้า|น้ำประปา|electric|electricity|water(?!\s*heater))/i;

/**
 * ข้อ 4 (8), D-022: every utility line shows the previous and current reading, the reading source, the units and the
 * price per unit (and the tariff version it was compared with); utilities are never billed as a fixed amount.
 */
export function evaluateBillDisclosure(c: BillDisclosureContext): RuleCheck {
  const errors: FieldError[] = [];
  for (const l of c.meterLines) {
    if (l.units === null)
      errors.push({ path: `${l.path}.units`, code: 'unitsMissing', message: 'units missing' });
    if (l.unitPrice === null)
      errors.push({ path: `${l.path}.unitPrice`, code: 'priceMissing', message: 'price per unit missing' });
    if (!l.segments.length || l.segments.some((s) => s.registerFrom === null || s.registerTo === null))
      errors.push({
        path: `${l.path}.readings`,
        code: 'readingsMissing',
        message: 'previous and current readings must be shown',
      });
    if (!l.readingSource)
      errors.push({
        path: `${l.path}.readingSource`,
        code: 'sourceMissing',
        message: 'reading source missing',
      });
    if (!l.utilityTariffVersionId)
      errors.push({
        path: `${l.path}.utilityTariffVersionId`,
        code: 'tariffMissing',
        message: 'the utility tariff version compared must be recorded',
      });
  }
  for (const f of c.fixedLines)
    if (f.kind !== 'water_minimum' && FLAT_UTILITY.test(f.description))
      errors.push({
        path: `${f.path}.description`,
        code: 'flatUtility',
        message: 'utilities are billed per unit, never as a fixed line',
      });
  return {
    ruleId: 'compliance.bill_disclosure',
    violated: errors.length > 0,
    context: { meterLines: c.meterLines.length, fixedLines: c.fixedLines.length },
    errors: some(errors),
  };
}

// ------------------------------------------------------------------------------------------------ lead time

export interface InvoiceLeadTimeContext {
  /** Bangkok date the invoice reaches the lessee (issue date). */
  issuedOn: string;
  dueDate: string;
  /** `invoice.min_lead_days`. */
  minLeadDays: number;
}

/** ข้อ 4 (8): the invoice reaches the lessee at least `invoice.min_lead_days` (3) days before its due date. */
export function evaluateInvoiceLeadTime(c: InvoiceLeadTimeContext): RuleCheck {
  const days = daysBetween(c.issuedOn, c.dueDate);
  const violated = days < c.minLeadDays;
  return {
    ruleId: 'compliance.invoice_lead_time',
    violated,
    context: { issuedOn: c.issuedOn, dueDate: c.dueDate, days, minLeadDays: c.minLeadDays },
    errors: violated
      ? [
          {
            path: 'dueDate',
            code: 'leadTime',
            message: `the due date must be at least ${c.minLeadDays} days after the invoice is issued`,
          },
        ]
      : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ water minimum

export interface WaterMinimumContext {
  /** The lease line or rate-plan minimum charge. */
  minimumCharge: Decimal.Value;
  /** The utility's own minimum charge from the tariff in force; null = unknown (never assume one, D-141). */
  utilityMinimum: string | null;
}

/** D-141, ข้อ 5 (6): a water minimum charge is allowed only up to the utility's own minimum charge. */
export function evaluateWaterMinimum(c: WaterMinimumContext): RuleCheck {
  const amount = D(c.minimumCharge);
  const violated = amount.gt(0) && (c.utilityMinimum === null || amount.gt(D(c.utilityMinimum)));
  return {
    ruleId: 'compliance.water_minimum',
    violated,
    context: { amount: amount.toFixed(2), utilityMinimum: c.utilityMinimum },
    shown: { leaseMinimum: amount.toFixed(2), utilityMinimum: c.utilityMinimum },
    errors: violated
      ? [
          {
            path: 'minimumCharge',
            code: 'aboveUtilityMinimum',
            message:
              c.utilityMinimum === null
                ? 'the utility publishes no minimum charge for this tariff'
                : `the minimum charge may not exceed the utility's ${c.utilityMinimum}`,
          },
        ]
      : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ deposits

export interface DepositCapContext {
  rent: Decimal.Value;
  deposit: Decimal.Value;
  advanceRent: Decimal.Value;
  /** `deposit.max_months_short` (⚖ O-002). */
  capMonths: string;
  /** Request path of the deposit amount (field errors). */
  path?: string;
}

/** ข้อ 5 (2), D-023: security deposit + advance rent together ≤ `deposit.max_months_short` months of rent. */
export function evaluateDepositCap(c: DepositCapContext): RuleCheck {
  const rent = D(c.rent);
  const total = D(c.deposit).plus(c.advanceRent);
  const cap = rent.times(c.capMonths);
  const violated = total.gt(cap);
  return {
    ruleId: 'compliance.deposit_cap',
    violated,
    context: {
      rent: rent.toFixed(2),
      deposit: D(c.deposit).toFixed(2),
      advanceRent: D(c.advanceRent).toFixed(2),
      total: total.toFixed(2),
      capMonths: c.capMonths,
      cap: cap.toFixed(2),
    },
    errors: violated
      ? [
          {
            path: c.path ?? 'depositAmount',
            code: 'depositCap',
            message: `deposit + advance rent ${total.toFixed(2)} exceeds ${c.capMonths} months of rent (${cap.toFixed(2)})`,
          },
        ]
      : undefined,
  };
}

export interface DepositDeadlineContext {
  deadlineAt: Date;
  /** When the refund was paid; null = not yet. */
  refundedAt: Date | null;
  /** The instant judged (now, or the refund time). */
  at: Date;
}

/** ข้อ 4 (10), D-023: the deposit is refunded within `deposit.refund_days` (7) of the lease end and hand-back. */
export function evaluateDepositDeadline(c: DepositDeadlineContext): RuleCheck {
  const judged = c.refundedAt ?? c.at;
  const violated = judged.getTime() > c.deadlineAt.getTime();
  return {
    ruleId: 'compliance.deposit_deadline',
    violated,
    context: {
      deadlineAt: c.deadlineAt.toISOString(),
      refundedAt: c.refundedAt?.toISOString() ?? null,
      judgedAt: judged.toISOString(),
    },
    shown: { deadlineAt: c.deadlineAt.toISOString(), refundedAt: c.refundedAt?.toISOString() ?? null },
  };
}

export interface DeductionInput {
  kind: 'damage' | 'missing_item' | 'cleaning' | 'unpaid_invoice' | 'other';
  wearCategory: 'normal_wear' | 'damage';
  evidenceCount: number;
  /** The move-out inspection item this deduction is for (damage / missing items). */
  inspectionItem: { condition: string | null; photoCount: number } | null;
}

/** Damage and missing items are the deductions that need an inspection finding with photos. */
export const EVIDENCE_KINDS: readonly DeductionInput['kind'][] = ['damage', 'missing_item'];

/** ข้อ 5 (7)–(8): normal wear and tear is never deducted from the deposit. */
export function evaluateDepositWear(d: DeductionInput): RuleCheck {
  const violated = d.wearCategory === 'normal_wear';
  return {
    ruleId: 'compliance.deposit_wear',
    violated,
    context: { kind: d.kind, wearCategory: d.wearCategory },
    errors: violated
      ? [{ path: 'wearCategory', code: 'normalWear', message: 'normal wear and tear cannot be deducted' }]
      : undefined,
  };
}

/**
 * ข้อ 4 (10): deductions are itemised with evidence — damage and missing items need the move-out inspection item that
 * found them (condition damaged / missing) and at least one photo; other deductions need at least one document.
 */
export function evaluateDepositEvidence(d: DeductionInput): RuleCheck {
  const errors: FieldError[] = [];
  if (EVIDENCE_KINDS.includes(d.kind)) {
    if (!d.inspectionItem)
      errors.push({
        path: 'inspectionItemId',
        code: 'inspectionItemRequired',
        message: `a ${d.kind} deduction needs the move-out inspection item`,
      });
    else if (!['damaged', 'missing'].includes(d.inspectionItem.condition ?? ''))
      errors.push({
        path: 'inspectionItemId',
        code: 'notDamaged',
        message: 'the inspection item is not recorded as damaged or missing',
      });
    if (d.evidenceCount + (d.inspectionItem?.photoCount ?? 0) === 0)
      errors.push({
        path: 'evidenceDocumentIds',
        code: 'photoRequired',
        message: 'a photo of the damage is required',
      });
  } else if (d.evidenceCount === 0) {
    errors.push({
      path: 'evidenceDocumentIds',
      code: 'evidenceRequired',
      message: 'attach the evidence (photo, receipt, invoice)',
    });
  }
  return {
    ruleId: 'compliance.deposit_evidence',
    violated: errors.length > 0,
    context: {
      kind: d.kind,
      evidenceCount: d.evidenceCount,
      inspectionItem: d.inspectionItem
        ? { condition: d.inspectionItem.condition, photos: d.inspectionItem.photoCount }
        : null,
    },
    errors: some(errors),
  };
}

export interface NoForfeitureContext {
  /** What the itemised settlement owes the lessee. */
  owed: Decimal.Value;
  /** What the owner pays back. */
  refund: Decimal.Value;
}

/** ข้อ 5 (4): no forfeiture without a breach — the refund pays back at least what the itemised settlement owes. */
export function evaluateNoForfeiture(c: NoForfeitureContext): RuleCheck {
  const violated = D(c.refund).lt(c.owed);
  return {
    ruleId: 'compliance.no_forfeiture',
    violated,
    context: { owed: D(c.owed).toFixed(2), refund: D(c.refund).toFixed(2) },
    errors: violated
      ? [
          {
            path: 'amount',
            code: 'belowOwed',
            message: `the refund must be at least ${D(c.owed).toFixed(2)}`,
          },
        ]
      : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ notices

/** ข้อ 4 (11): a lessee may end the lease with written notice of at least 30 days. */
export const LESSEE_NOTICE_DAYS = 30;
/** ข้อ 4 (12): a lessor terminating for a breach gives 30 days to remedy; 7 days' warning when others are affected. */
export const LESSOR_REMEDY_DAYS = 30;
export const LESSOR_DISTURBANCE_DAYS = 7;

export interface NoticePeriodContext {
  noticeDate: string;
  effectiveDate: string;
}

/** ข้อ 4 (11): the lessee's notice takes effect at least 30 days after it is given. */
export function evaluateNoticePeriod(c: NoticePeriodContext): RuleCheck {
  const days = daysBetween(c.noticeDate, c.effectiveDate);
  const violated = days < LESSEE_NOTICE_DAYS;
  const values = {
    noticeDate: c.noticeDate,
    effectiveDate: c.effectiveDate,
    days,
    minimumDays: LESSEE_NOTICE_DAYS,
  };
  return {
    ruleId: 'compliance.notice_period',
    violated,
    context: values,
    shown: values,
    errors: violated
      ? [
          {
            path: 'effectiveDate',
            code: 'noticePeriod',
            message: `at least ${LESSEE_NOTICE_DAYS} days after the notice`,
          },
        ]
      : undefined,
  };
}

/** Lessor grounds (ข้อ 4 (12)) and the notice each needs (D-176). */
export const LESSOR_REASONS = {
  lessee_breach: { minDays: LESSOR_REMEDY_DAYS, evidence: true },
  disturbance: { minDays: LESSOR_DISTURBANCE_DAYS, evidence: true },
  end_of_term: { minDays: LESSEE_NOTICE_DAYS, evidence: false },
  mutual_agreement: { minDays: 0, evidence: true },
  unlawful_use: { minDays: 0, evidence: true },
} as const;
export type LessorReason = keyof typeof LESSOR_REASONS;

export interface TerminationNoticeContext {
  reason: LessorReason;
  noticeDate: string;
  effectiveDate: string;
  evidenceCount: number;
  /** The lease end date (non-renewal takes effect on it). */
  endDate: string;
}

/** A lessor's notice or termination: a ground, written notice of the required length, evidence where needed. */
export function evaluateTerminationNotice(c: TerminationNoticeContext): RuleCheck {
  const rule = LESSOR_REASONS[c.reason];
  const days = daysBetween(c.noticeDate, c.effectiveDate);
  const errors: FieldError[] = [];
  if (days < rule.minDays)
    errors.push({
      path: 'effectiveDate',
      code: 'noticeTooShort',
      message: `${c.reason} needs at least ${rule.minDays} days of written notice`,
    });
  if (rule.evidence && c.evidenceCount === 0)
    errors.push({
      path: 'evidenceDocumentIds',
      code: 'evidenceRequired',
      message: `${c.reason} needs the written notice / evidence on file`,
    });
  if (c.reason === 'end_of_term' && c.effectiveDate !== c.endDate)
    errors.push({
      path: 'effectiveDate',
      code: 'endOfTerm',
      message: 'non-renewal takes effect on the end date of the lease',
    });
  return {
    ruleId: 'compliance.termination_notice',
    violated: errors.length > 0,
    context: {
      reason: c.reason,
      noticeDate: c.noticeDate,
      effectiveDate: c.effectiveDate,
      days,
      minimumDays: rule.minDays,
      evidenceCount: c.evidenceCount,
    },
    shown: {
      reason: c.reason,
      noticeDate: c.noticeDate,
      effectiveDate: c.effectiveDate,
      days,
      minimumDays: rule.minDays,
    },
    errors: some(errors),
  };
}

// ------------------------------------------------------------------------------------------------ lease terms

export interface MidtermIncreaseContext {
  startDate: string;
  endDate: string;
  /** Rent changes recorded in the contract at signing (the only lawful ones). */
  recordedIncreases: { effectiveFrom: string; rent: string }[];
  /**
   * A change requested after signing (rent, a lease line or a rate applied to the lease) compared with the terms in
   * force: `from` → `to`; an increase during the term is refused, a decrease is allowed.
   */
  change?: { field: string; from: Decimal.Value; to: Decimal.Value; effectiveOn: string } | null;
}

/** ข้อ 5 (3): no increase of rent, utility rates or service charges before the lease ends. */
export function evaluateNoMidtermIncrease(c: MidtermIncreaseContext): RuleCheck {
  const errors: FieldError[] = c.recordedIncreases
    .map((r, i): FieldError | null => {
      if (r.effectiveFrom <= c.startDate || r.effectiveFrom > c.endDate)
        return {
          path: `rentIncreases[${i}].effectiveFrom`,
          code: 'outsideTerm',
          message: 'a recorded change must fall inside the term, after its start',
        };
      if (D(r.rent).lte(0))
        return { path: `rentIncreases[${i}].rent`, code: 'min', message: 'rent must be positive' };
      return null;
    })
    .filter((e): e is FieldError => e !== null);
  if (
    c.change &&
    D(c.change.to).gt(c.change.from) &&
    c.change.effectiveOn >= c.startDate &&
    c.change.effectiveOn <= c.endDate
  )
    errors.push({
      path: c.change.field,
      code: 'midtermIncrease',
      message: `${c.change.field} may not increase during the lease term`,
    });
  return {
    ruleId: 'compliance.no_midterm_increase',
    violated: errors.length > 0,
    context: {
      recordedAtSigning: c.recordedIncreases,
      change: c.change
        ? { ...c.change, from: D(c.change.from).toFixed(), to: D(c.change.to).toFixed() }
        : null,
    },
    errors: some(errors),
  };
}

const RENEWAL_FEE = /(ค่าต่อ\s*สัญญา|renewal\s*fee)/i;

export interface NoRenewalFeeContext {
  lines: { path: string; description: string }[];
}

/** ข้อ 5 (11): no renewal fee from an existing lessee (lease lines and one-off invoice items). */
export function evaluateNoRenewalFee(c: NoRenewalFeeContext): RuleCheck {
  const errors = c.lines
    .filter((l) => RENEWAL_FEE.test(l.description))
    .map((l) => ({
      path: `${l.path}.description`,
      code: 'renewalFee',
      message: 'a renewal fee is not allowed',
    }));
  return {
    ruleId: 'compliance.no_renewal_fee',
    violated: errors.length > 0,
    context: { lines: c.lines.length },
    errors: some(errors),
  };
}

/** Clause types the announcement forbids (ข้อ 5 (1)–(12)) and the wording that reveals them whatever the type. */
export const FORBIDDEN_PATTERNS: readonly [string, RegExp][] = [
  [
    'lockout_or_removal',
    /(ตัด\s*(น้ำ|ไฟ)|ล็อก\s*(ห้อง|ประตู)|เปลี่ยน\s*กุญแจ|ขนย้าย\s*ทรัพย์|ปิดกั้น|lock(ed|ing)?\s*out|cut\s*(off\s*)?(the\s*)?(power|water|electricity))/i,
  ],
  ['renewal_fee', /(ค่าต่อ\s*สัญญา|renewal\s*fee)/i],
  ['forfeiture_without_breach', /((?<!ไม่)ริบ\s*(เงิน)?\s*(ประกัน|ค่าเช่าล่วงหน้า)|forfeit)/i],
  [
    'entry_without_notice',
    /(เข้า\s*(ตรวจ)?\s*ห้อง[^.]*(ได้ตลอดเวลา|โดยไม่\s*(ต้อง)?\s*แจ้ง)|enter[^.]*without\s*notice)/i,
  ],
  [
    'midterm_increase',
    /((ปรับ|ขึ้น)\s*ค่า(เช่า|บริการ|น้ำ|ไฟ)[^.]*(ระหว่าง\s*(อายุ)?\s*สัญญา|ได้ตลอด|ตามที่ผู้ให้เช่าเห็นสมควร)|increase[^.]*(at any time|during the term))/i,
  ],
  ['normal_wear_liability', /((?<!ไม่)หัก\s*ค่าเสื่อม|normal\s*wear)/i],
  [
    'liability_exclusion',
    /(ไม่\s*รับผิด(ชอบ)?\s*(ใด\s*ๆ|ทุกกรณี)|not\s*(be\s*)?liable\s*(for\s*)?(any|all))/i,
  ],
  [
    'termination_without_breach',
    /(บอกเลิก\s*สัญญา\s*(ได้)?\s*(ทันที|โดยไม่ต้องมีเหตุ|ได้ทุกเมื่อ)|terminate[^.]*(at any time|without (cause|reason)))/i,
  ],
  ['utility_above_tariff', /(ค่าไฟ(ฟ้า)?\s*หน่วยละ|ค่าน้ำ(ประปา)?\s*หน่วยละ)/i],
  ['future_terms', /((ข้อกำหนด|ระเบียบ|ข้อตกลง)[^.]*(ที่จะ\s*(มี|ออก|กำหนด)\s*(ใน)?\s*(อนาคต|ภายหลัง)))/i],
];

export interface ForbiddenClauseContext {
  addendum: { type: string; title: string; text: string }[];
  allowedTypes: readonly string[];
  forbiddenTypes: readonly string[];
}

/** ข้อ 5: clause types the announcement forbids, unknown types, or wording that reads as one, are refused. */
export function evaluateForbiddenClause(c: ForbiddenClauseContext): RuleCheck {
  const errors: FieldError[] = [];
  c.addendum.forEach((clause, i) => {
    if (c.forbiddenTypes.includes(clause.type))
      errors.push({
        path: `addendum[${i}].type`,
        code: clause.type,
        message: `clause type ${clause.type} is forbidden`,
      });
    else if (!c.allowedTypes.includes(clause.type))
      errors.push({
        path: `addendum[${i}].type`,
        code: 'unknownType',
        message: `clause type ${clause.type} is not allowed`,
      });
    for (const [type, re] of FORBIDDEN_PATTERNS)
      if (re.test(`${clause.title} ${clause.text}`))
        errors.push({
          path: `addendum[${i}].text`,
          code: type,
          message: `the clause reads as a forbidden ${type} clause`,
        });
  });
  return {
    ruleId: 'compliance.forbidden_clause',
    violated: errors.length > 0,
    context: { clauses: c.addendum.length, findings: errors.map((e) => `${e.path}:${e.code}`) },
    errors: some(errors),
  };
}

// ------------------------------------------------------------------------------------------------ access

export interface EntryNoticeContext {
  emergency: boolean;
  /** When the lessee was told of the entry; null = no notice. */
  noticeGivenAt: Date | null;
  entryAt: Date;
}

/** ข้อ 5 (5): no entry without prior notice except in an emergency (fire, burst pipe, smoke, gas). */
export function evaluateEntryNotice(c: EntryNoticeContext): RuleCheck {
  const noticed = c.noticeGivenAt !== null && c.noticeGivenAt.getTime() < c.entryAt.getTime();
  const violated = !c.emergency && !noticed;
  return {
    ruleId: 'compliance.entry_notice',
    violated,
    context: {
      emergency: c.emergency,
      noticeGivenAt: c.noticeGivenAt?.toISOString() ?? null,
      entryAt: c.entryAt.toISOString(),
    },
    shown: { emergency: c.emergency, noticeGivenAt: c.noticeGivenAt?.toISOString() ?? null },
  };
}

export type AccessAction =
  | 'power_cutoff'
  | 'water_cutoff'
  | 'lock_out'
  | 'revoke_access'
  | 'remove_belongings'
  | 'reminder'
  | 'late_fee';

export interface NoCutoffContext {
  action: AccessAction;
  /** Why: `arrears` makes every coercive action unlawful (D-024, D-071, D-157). */
  reason: 'arrears' | 'lease_end' | 'owner_request' | 'safety';
}

const COERCIVE: readonly AccessAction[] = [
  'power_cutoff',
  'water_cutoff',
  'lock_out',
  'revoke_access',
  'remove_belongings',
];

/**
 * ข้อ 5 (10), D-024, D-071, D-157: no power/water cut-off, lock-out, access revocation or removal of belongings for
 * arrears; collections are reminders and (where allowed) a late fee only. The platform offers no such function; the
 * rule guards every code path that could (dunning, access) and documents the refusal.
 */
export function evaluateNoCutoff(c: NoCutoffContext): RuleCheck {
  // cut-offs, lock-outs and removal of belongings are never offered (D-157); access is revoked only at the lease end
  // or by an owner action with a reason — never for arrears (D-071)
  const violated = COERCIVE.includes(c.action) && (c.action !== 'revoke_access' || c.reason === 'arrears');
  return {
    ruleId: 'compliance.no_cutoff',
    violated,
    context: { action: c.action, reason: c.reason },
    errors: violated
      ? [{ path: 'action', code: 'coercive', message: `${c.action} is never used to collect arrears` }]
      : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ late fee

export interface LateFeePolicyContext {
  /** `late_fee.enabled` (D-045, ⚖ O-002). */
  lateFeeEnabled: boolean;
  /** The lease (contract) states a late fee (a lease line or addendum). */
  contractStatesLateFee: boolean;
  /** The late fee being charged or written into the contract (null = only terms). */
  amount?: Decimal.Value | null;
  /** The contract's stated late-fee amount (proportionality: never above what was agreed). */
  agreedAmount?: Decimal.Value | null;
}

/**
 * ข้อ 4 (5), D-045, ⚖ O-002: a late fee only when the tenant enabled it **and** the standard contract states it, never
 * above the agreed amount. Default severity `block`; the setting stays off until legal confirms (O-002).
 */
export function evaluateLateFeePolicy(c: LateFeePolicyContext): RuleCheck {
  const errors: FieldError[] = [];
  if (c.contractStatesLateFee && !c.lateFeeEnabled)
    errors.push({ path: 'addendum', code: 'lateFee', message: 'late fees are not enabled (D-045)' });
  if (c.amount !== undefined && c.amount !== null) {
    if (!c.lateFeeEnabled && !errors.length)
      errors.push({ path: 'amount', code: 'lateFeeDisabled', message: 'late fees are not enabled (D-045)' });
    if (!c.contractStatesLateFee)
      errors.push({ path: 'amount', code: 'notInContract', message: 'the contract states no late fee' });
    else if (c.agreedAmount !== undefined && c.agreedAmount !== null && D(c.amount).gt(c.agreedAmount))
      errors.push({
        path: 'amount',
        code: 'aboveAgreed',
        message: 'above the late fee agreed in the contract',
      });
  }
  return {
    ruleId: 'compliance.late_fee_policy',
    violated: errors.length > 0,
    context: {
      lateFeeTerms: c.contractStatesLateFee,
      lateFeeEnabled: c.lateFeeEnabled,
      amount: c.amount === undefined || c.amount === null ? null : D(c.amount).toFixed(2),
      agreedAmount:
        c.agreedAmount === undefined || c.agreedAmount === null ? null : D(c.agreedAmount).toFixed(2),
    },
    errors: some(errors),
  };
}
