import {
  evaluateBillDisclosure,
  evaluateDepositCap,
  evaluateForbiddenClause,
  evaluateLateFeePolicy,
  evaluateNoMidtermIncrease,
  evaluateNoRenewalFee,
  evaluateNoticePeriod,
  evaluateTerminationNotice,
  evaluateWaterMinimum,
  LESSEE_NOTICE_DAYS,
  LESSOR_DISTURBANCE_DAYS,
  LESSOR_REASONS,
  LESSOR_REMEDY_DAYS,
  type LessorReason,
  type RuleCheck,
} from '@core/compliance/evaluators';

import { ALLOWED_CLAUSE_TYPES, FORBIDDEN_CLAUSE_TYPES } from './contract-template';

/**
 * The lease rules of the สคบ. 2568 announcement (D-020, D-023, D-041, D-141; legal-reference §1–§2), composed from
 * the compliance registry's pure evaluators (core/compliance/evaluators.ts, ADR-0007). Each returns a `RuleCheck` the
 * `ComplianceGate` turns into a pass, a warning to acknowledge or a refusal, with the rule's legal reference. Fixed
 * legal periods (30-day lessee notice, 30-day remedy, 7-day warning) are the announcement's own numbers, not
 * settings; amounts that the law leaves to configuration (deposit cap, late-fee switch, the utility's water minimum)
 * come in as arguments.
 */
export { LESSEE_NOTICE_DAYS, LESSOR_DISTURBANCE_DAYS, LESSOR_REASONS, LESSOR_REMEDY_DAYS, type LessorReason };

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

const LATE_FEE = /(ค่าปรับ\s*(การ)?\s*(ชำระ)?\s*(ค่าเช่า)?\s*ล่าช้า|ค่าปรับรายวัน|late\s*(payment\s*)?fee)/i;

/** The checks run when a lease draft is created, edited or sent for signature. */
export function checkLeaseTerms(
  t: LeaseTermsInput,
  settings: LeaseRuleSettings,
  forbiddenTypes: readonly string[] = FORBIDDEN_CLAUSE_TYPES,
): RuleCheck[] {
  const checks: RuleCheck[] = [
    evaluateDepositCap({
      rent: t.rent,
      deposit: t.depositAmount,
      advanceRent: t.advanceRentAmount,
      capMonths: settings.depositMaxMonths,
    }),
    evaluateForbiddenClause({ addendum: t.addendum, allowedTypes: ALLOWED_CLAUSE_TYPES, forbiddenTypes }),
  ];
  const renewal = evaluateNoRenewalFee({
    lines: t.lines.map((l, i) => ({ path: `lines[${i}]`, description: l.description })),
  });
  checks.push({ ...renewal, context: { isRenewal: t.isRenewal, lines: t.lines.length } });
  const disclosure = evaluateBillDisclosure({
    meterLines: [],
    fixedLines: t.lines.map((l, i) => ({ path: `lines[${i}]`, kind: l.kind, description: l.description })),
  });
  checks.push({ ...disclosure, context: { utilityBillingMode: t.utilityBillingMode } });
  checks.push(
    evaluateNoMidtermIncrease({
      startDate: t.startDate,
      endDate: t.endDate,
      recordedIncreases: t.rentIncreases,
    }),
  );
  const waterMinimum = t.lines.find((l) => l.kind === 'water_minimum');
  if (waterMinimum) {
    const w = evaluateWaterMinimum({
      minimumCharge: waterMinimum.amount,
      utilityMinimum: settings.waterMinimumCap,
    });
    checks.push({ ...w, errors: undefined });
  }
  const lateFee = [
    ...t.addendum.map((c) => `${c.title} ${c.text}`),
    ...t.lines.map((l) => l.description),
  ].some((s) => LATE_FEE.test(s));
  const late = evaluateLateFeePolicy({
    lateFeeEnabled: settings.lateFeeEnabled,
    contractStatesLateFee: lateFee,
  });
  checks.push({ ...late, context: { lateFeeTerms: lateFee, lateFeeEnabled: settings.lateFeeEnabled } });
  return checks;
}

/** ข้อ 4 (11): the lessee's notice takes effect at least 30 days after it is given. */
export function checkLesseeNotice(noticeDate: string, effectiveDate: string): RuleCheck {
  return evaluateNoticePeriod({ noticeDate, effectiveDate });
}

/** A lessor's notice or termination: a ground, written notice of the required length, evidence where needed. */
export function checkLessorNotice(
  reason: LessorReason,
  noticeDate: string,
  effectiveDate: string,
  evidenceCount: number,
  endDate: string,
): RuleCheck {
  return evaluateTerminationNotice({ reason, noticeDate, effectiveDate, evidenceCount, endDate });
}
