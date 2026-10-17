import { type RuleCheck } from '@core/compliance/compliance-gate.service';
import Decimal from 'decimal.js';

import { ALLOWED_CLAUSE_TYPES, FORBIDDEN_CLAUSE_TYPES, type ForbiddenClauseType } from './contract-template';

/**
 * The lease rules of the สคบ. 2568 announcement as pure checks (D-020, D-023, D-041, D-141; legal-reference §1–§2).
 * Each returns a `RuleCheck` the `ComplianceGate` turns into a pass, a warning to acknowledge or a refusal, with the
 * rule's legal reference. Fixed legal periods (30-day lessee notice, 30-day remedy, 7-day warning) are the
 * announcement's own numbers, not settings; amounts that the law leaves to configuration (deposit cap, late-fee
 * switch, the utility's water minimum) come in as arguments.
 */

/** ข้อ 4 (11): a lessee may end the lease with written notice of at least 30 days. */
export const LESSEE_NOTICE_DAYS = 30;
/** ข้อ 4 (12): a lessor terminating for a breach gives 30 days to remedy; 7 days' warning when others are affected. */
export const LESSOR_REMEDY_DAYS = 30;
export const LESSOR_DISTURBANCE_DAYS = 7;

export interface LeaseLineInput {
  kind: string;
  description: string;
  amount: string;
}

export interface AddendumInput {
  type: string;
  title: string;
  text: string;
}

export interface LeaseTermsInput {
  rent: string;
  depositAmount: string;
  advanceRentAmount: string;
  months: number;
  startDate: string;
  endDate: string;
  utilityBillingMode: 'metered' | 'included';
  lines: LeaseLineInput[];
  addendum: AddendumInput[];
  rentIncreases: { effectiveFrom: string; rent: string }[];
  isRenewal: boolean;
}

export interface LeaseRuleSettings {
  /** deposit.max_months_short (⚖ O-002). */
  depositMaxMonths: string;
  /** late_fee.enabled (D-045). */
  lateFeeEnabled: boolean;
  /** The utility's own water minimum charge, when the tariff in force publishes one (D-141); null = unknown. */
  waterMinimumCap: string | null;
}

/** Text patterns of clause types the announcement forbids (ข้อ 5); a match refuses the clause whatever its type. */
const FORBIDDEN_PATTERNS: [ForbiddenClauseType, RegExp][] = [
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

/** Fixed charges that are really utilities (billed per unit only, D-022) — refused as fixed lease lines. */
const FLAT_UTILITY = /(ค่าไฟ|ค่าน้ำ|ไฟฟ้า|น้ำประปา|electric|electricity|water(?!\s*heater))/i;
const LATE_FEE = /(ค่าปรับ\s*(การ)?\s*(ชำระ)?\s*(ค่าเช่า)?\s*ล่าช้า|ค่าปรับรายวัน|late\s*(payment\s*)?fee)/i;
const RENEWAL_FEE = /(ค่าต่อ\s*สัญญา|renewal\s*fee)/i;

/** The checks run when a lease draft is created, edited or sent for signature. */
export function checkLeaseTerms(
  t: LeaseTermsInput,
  settings: LeaseRuleSettings,
  forbiddenTypes: readonly string[] = FORBIDDEN_CLAUSE_TYPES,
): RuleCheck[] {
  const checks: RuleCheck[] = [];
  const rent = new Decimal(t.rent);
  const total = new Decimal(t.depositAmount).plus(t.advanceRentAmount);
  const cap = rent.times(settings.depositMaxMonths);
  checks.push({
    ruleId: 'compliance.deposit_cap',
    violated: total.greaterThan(cap),
    context: {
      rent: rent.toFixed(2),
      deposit: new Decimal(t.depositAmount).toFixed(2),
      advanceRent: new Decimal(t.advanceRentAmount).toFixed(2),
      total: total.toFixed(2),
      capMonths: settings.depositMaxMonths,
      cap: cap.toFixed(2),
    },
    errors: total.greaterThan(cap)
      ? [
          {
            path: 'depositAmount',
            code: 'depositCap',
            message: `deposit + advance rent ${total.toFixed(2)} exceeds ${settings.depositMaxMonths} months of rent (${cap.toFixed(2)})`,
          },
        ]
      : undefined,
  });

  const clauseErrors: { path: string; code: string; message: string }[] = [];
  t.addendum.forEach((c, i) => {
    if (forbiddenTypes.includes(c.type))
      clauseErrors.push({
        path: `addendum[${i}].type`,
        code: c.type,
        message: `clause type ${c.type} is forbidden`,
      });
    else if (!(ALLOWED_CLAUSE_TYPES as readonly string[]).includes(c.type))
      clauseErrors.push({
        path: `addendum[${i}].type`,
        code: 'unknownType',
        message: `clause type ${c.type} is not allowed`,
      });
    for (const [type, re] of FORBIDDEN_PATTERNS)
      if (re.test(`${c.title} ${c.text}`))
        clauseErrors.push({
          path: `addendum[${i}].text`,
          code: type,
          message: `the clause reads as a forbidden ${type} clause`,
        });
  });
  checks.push({
    ruleId: 'compliance.forbidden_clause',
    violated: clauseErrors.length > 0,
    context: { clauses: t.addendum.length, findings: clauseErrors.map((e) => `${e.path}:${e.code}`) },
    errors: clauseErrors.length ? clauseErrors : undefined,
  });

  const renewalErrors = t.lines
    .map((l, i) =>
      RENEWAL_FEE.test(l.description)
        ? { path: `lines[${i}].description`, code: 'renewalFee', message: 'a renewal fee is not allowed' }
        : null,
    )
    .filter((e): e is NonNullable<typeof e> => e !== null);
  checks.push({
    ruleId: 'compliance.no_renewal_fee',
    violated: renewalErrors.length > 0,
    context: { isRenewal: t.isRenewal, lines: t.lines.length },
    errors: renewalErrors.length ? renewalErrors : undefined,
  });

  const flat = t.lines
    .map((l, i) =>
      l.kind !== 'water_minimum' && FLAT_UTILITY.test(l.description)
        ? {
            path: `lines[${i}].description`,
            code: 'flatUtility',
            message: 'utilities are billed per unit, never as a fixed line',
          }
        : null,
    )
    .filter((e): e is NonNullable<typeof e> => e !== null);
  checks.push({
    ruleId: 'compliance.bill_disclosure',
    violated: flat.length > 0,
    context: { utilityBillingMode: t.utilityBillingMode },
    errors: flat.length ? flat : undefined,
  });

  const increaseErrors = t.rentIncreases
    .map((r, i) => {
      if (r.effectiveFrom <= t.startDate || r.effectiveFrom > t.endDate)
        return {
          path: `rentIncreases[${i}].effectiveFrom`,
          code: 'outsideTerm',
          message: 'a recorded change must fall inside the term, after its start',
        };
      if (new Decimal(r.rent).lessThanOrEqualTo(0))
        return { path: `rentIncreases[${i}].rent`, code: 'min', message: 'rent must be positive' };
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  checks.push({
    ruleId: 'compliance.no_midterm_increase',
    violated: increaseErrors.length > 0,
    context: { recordedAtSigning: t.rentIncreases },
    errors: increaseErrors.length ? increaseErrors : undefined,
  });

  const waterMinimum = t.lines.find((l) => l.kind === 'water_minimum');
  if (waterMinimum) {
    const above =
      settings.waterMinimumCap === null ||
      new Decimal(waterMinimum.amount).greaterThan(settings.waterMinimumCap);
    checks.push({
      ruleId: 'compliance.water_minimum',
      violated: above,
      context: {
        amount: new Decimal(waterMinimum.amount).toFixed(2),
        utilityMinimum: settings.waterMinimumCap,
      },
      shown: {
        leaseMinimum: new Decimal(waterMinimum.amount).toFixed(2),
        utilityMinimum: settings.waterMinimumCap,
      },
    });
  }

  const lateFee = [
    ...t.addendum.map((c) => `${c.title} ${c.text}`),
    ...t.lines.map((l) => l.description),
  ].some((s) => LATE_FEE.test(s));
  checks.push({
    ruleId: 'compliance.late_fee_policy',
    violated: lateFee && !settings.lateFeeEnabled,
    context: { lateFeeTerms: lateFee, lateFeeEnabled: settings.lateFeeEnabled },
    errors:
      lateFee && !settings.lateFeeEnabled
        ? [{ path: 'addendum', code: 'lateFee', message: 'late fees are not enabled (D-045)' }]
        : undefined,
  });
  return checks;
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** ข้อ 4 (11): the lessee's notice takes effect at least 30 days after it is given. */
export function checkLesseeNotice(noticeDate: string, effectiveDate: string): RuleCheck {
  const days = daysBetween(noticeDate, effectiveDate);
  return {
    ruleId: 'compliance.notice_period',
    violated: days < LESSEE_NOTICE_DAYS,
    context: { noticeDate, effectiveDate, days, minimumDays: LESSEE_NOTICE_DAYS },
    shown: { noticeDate, effectiveDate, days, minimumDays: LESSEE_NOTICE_DAYS },
    errors:
      days < LESSEE_NOTICE_DAYS
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

/** Lessor grounds (ข้อ 4 (12)) and the notice each needs. */
export const LESSOR_REASONS = {
  lessee_breach: { minDays: LESSOR_REMEDY_DAYS, evidence: true },
  disturbance: { minDays: LESSOR_DISTURBANCE_DAYS, evidence: true },
  end_of_term: { minDays: LESSEE_NOTICE_DAYS, evidence: false },
  mutual_agreement: { minDays: 0, evidence: true },
  unlawful_use: { minDays: 0, evidence: true },
} as const;
export type LessorReason = keyof typeof LESSOR_REASONS;

/** A lessor's notice or termination: a ground, written notice of the required length, evidence where needed. */
export function checkLessorNotice(
  reason: LessorReason,
  noticeDate: string,
  effectiveDate: string,
  evidenceCount: number,
  endDate: string,
): RuleCheck {
  const rule = LESSOR_REASONS[reason];
  const days = daysBetween(noticeDate, effectiveDate);
  const errors: { path: string; code: string; message: string }[] = [];
  if (days < rule.minDays)
    errors.push({
      path: 'effectiveDate',
      code: 'noticeTooShort',
      message: `${reason} needs at least ${rule.minDays} days of written notice`,
    });
  if (rule.evidence && evidenceCount === 0)
    errors.push({
      path: 'evidenceDocumentIds',
      code: 'evidenceRequired',
      message: `${reason} needs the written notice / evidence on file`,
    });
  if (reason === 'end_of_term' && effectiveDate !== endDate)
    errors.push({
      path: 'effectiveDate',
      code: 'endOfTerm',
      message: 'non-renewal takes effect on the end date of the lease',
    });
  return {
    ruleId: 'compliance.termination_notice',
    violated: errors.length > 0,
    context: { reason, noticeDate, effectiveDate, days, minimumDays: rule.minDays, evidenceCount },
    shown: { reason, noticeDate, effectiveDate, days, minimumDays: rule.minDays },
    errors: errors.length ? errors : undefined,
  };
}
