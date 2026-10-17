import {
  type BillDisclosureContext,
  type DeductionInput,
  type DepositCapContext,
  type DepositDeadlineContext,
  type EntryNoticeContext,
  evaluateBillDisclosure,
  evaluateDepositCap,
  evaluateDepositDeadline,
  evaluateDepositEvidence,
  evaluateDepositWear,
  evaluateEntryNotice,
  evaluateForbiddenClause,
  evaluateInvoiceLeadTime,
  evaluateLateFeePolicy,
  evaluateNoCutoff,
  evaluateNoForfeiture,
  evaluateNoMidtermIncrease,
  evaluateNoRenewalFee,
  evaluateNoticePeriod,
  evaluateScope,
  evaluateTariffCap,
  evaluateTerminationNotice,
  evaluateWaterMinimum,
  type ForbiddenClauseContext,
  type InvoiceLeadTimeContext,
  type LateFeePolicyContext,
  type MidtermIncreaseContext,
  type NoCutoffContext,
  type NoForfeitureContext,
  type NoRenewalFeeContext,
  type NoticePeriodContext,
  type RuleCheck,
  type ScopeContext,
  type TariffCapContext,
  type TerminationNoticeContext,
  type WaterMinimumContext,
} from './evaluators';

/**
 * Compliance rule registry (ADR-0007; D-020, D-021a, D-141, D-149, D-158; docs/compliance/legal-reference.md). The
 * code is the truth; `prisma/seed` mirrors it into platform.compliance_rule with status `pending_legal_verification`
 * until the legal team verifies legal-reference.md and flips each rule (D-149). Each rule has an id, a legal reference
 * (clauses of the announcement as numbered in legal-reference.md), a default severity (`block | warn`, overridable by
 * the platform admin platform-wide or per tenant — `ComplianceGate.severity`), the subjects it applies to, the
 * settings it reads and a pure `evaluate(context)` (evaluators.ts); `rules.spec.ts` proves pass, warning and refusal
 * for every rule. `pnpm compliance:report` prints the table into docs/compliance.md.
 */
export type RuleTarget = 'tenant' | 'lease' | 'rate_plan' | 'invoice' | 'deposit' | 'access' | 'notice';

/** The context each rule's evaluator takes. */
export interface RuleContexts {
  'compliance.scope': ScopeContext;
  'compliance.tariff_cap': TariffCapContext;
  'compliance.bill_disclosure': BillDisclosureContext;
  'compliance.invoice_lead_time': InvoiceLeadTimeContext;
  'compliance.water_minimum': WaterMinimumContext;
  'compliance.deposit_cap': DepositCapContext;
  'compliance.deposit_deadline': DepositDeadlineContext;
  'compliance.deposit_evidence': DeductionInput;
  'compliance.deposit_wear': DeductionInput;
  'compliance.no_forfeiture': NoForfeitureContext;
  'compliance.notice_period': NoticePeriodContext;
  'compliance.termination_notice': TerminationNoticeContext;
  'compliance.no_midterm_increase': MidtermIncreaseContext;
  'compliance.no_renewal_fee': NoRenewalFeeContext;
  'compliance.entry_notice': EntryNoticeContext;
  'compliance.no_cutoff': NoCutoffContext;
  'compliance.forbidden_clause': ForbiddenClauseContext;
  'compliance.late_fee_policy': LateFeePolicyContext;
}
export type ComplianceRuleId = keyof RuleContexts;

interface RuleDef<K extends ComplianceRuleId> {
  id: K;
  legalRef: string;
  defaultSeverity: 'block' | 'warn';
  appliesTo: RuleTarget[];
  descriptionTh: string;
  descriptionEn: string;
  settingsUsed: string[];
  evaluate: (context: RuleContexts[K]) => RuleCheck;
}

export type ComplianceRuleDef = { [K in ComplianceRuleId]: RuleDef<K> }[ComplianceRuleId];

const ANN = 'ประกาศ คกก.ว่าด้วยสัญญา 2568';

export const COMPLIANCE_RULES: readonly ComplianceRuleDef[] = [
  {
    id: 'compliance.scope',
    legalRef: `${ANN} ข้อ 3 (≥ 3 หน่วย); legal-reference §1 ขอบเขต; D-158`,
    defaultSeverity: 'warn',
    appliesTo: ['tenant'],
    descriptionTh: 'ผู้ประกอบธุรกิจที่มีสถานที่ให้เช่าตั้งแต่ 3 หน่วยขึ้นไปอยู่ในบังคับของประกาศ',
    descriptionEn: 'Tenants renting out 3 or more units are in scope of the announcement.',
    settingsUsed: ['tenant.subject_to_ocpb_2568'],
    evaluate: evaluateScope,
  },
  {
    id: 'compliance.tariff_cap',
    legalRef: `${ANN} ข้อ 5 (6); legal-reference §1 ค่าน้ำ/ค่าไฟ, §4; D-021a, D-140`,
    defaultSeverity: 'warn',
    appliesTo: ['rate_plan', 'invoice'],
    descriptionTh:
      'อัตราค่าไฟฟ้า/ค่าน้ำต้องไม่เกินอัตราที่ผู้ให้บริการเรียกเก็บ (เฉลี่ยตามหน่วยที่ใช้) — แจ้งเตือนและให้เจ้าของรับทราบ',
    descriptionEn:
      'Electricity/water rates above the utility’s effective average rate trigger the legal warning and an Owner acknowledgement.',
    settingsUsed: ['compliance.tariff_cap.severity'],
    evaluate: evaluateTariffCap,
  },
  {
    id: 'compliance.bill_disclosure',
    legalRef: `${ANN} ข้อ 4 (8); legal-reference §1 ใบแจ้งหนี้; D-022`,
    defaultSeverity: 'block',
    appliesTo: ['invoice'],
    descriptionTh: 'ใบแจ้งหนี้ต้องแสดงจำนวนหน่วยที่ใช้และอัตราต่อหน่วย',
    descriptionEn: 'Invoices must show units consumed and the price per unit.',
    settingsUsed: [],
    evaluate: evaluateBillDisclosure,
  },
  {
    id: 'compliance.invoice_lead_time',
    legalRef: `${ANN} ข้อ 4 (8); legal-reference §1 ใบแจ้งหนี้`,
    defaultSeverity: 'block',
    appliesTo: ['invoice'],
    descriptionTh: 'ส่งใบแจ้งหนี้ล่วงหน้าไม่น้อยกว่า 3 วันก่อนวันครบกำหนดชำระ',
    descriptionEn: 'Due date at least 3 days after the invoice is issued.',
    settingsUsed: ['invoice.min_lead_days'],
    evaluate: evaluateInvoiceLeadTime,
  },
  {
    id: 'compliance.water_minimum',
    legalRef: `${ANN} ข้อ 5 (6); D-141`,
    defaultSeverity: 'warn',
    appliesTo: ['lease', 'rate_plan'],
    descriptionTh: 'ค่าน้ำขั้นต่ำในสัญญาต้องไม่เกินค่าน้ำขั้นต่ำของการประปา',
    descriptionEn: 'A water minimum charge may not exceed the utility’s own minimum charge.',
    settingsUsed: ['compliance.tariff_cap.severity'],
    evaluate: evaluateWaterMinimum,
  },
  {
    id: 'compliance.deposit_cap',
    legalRef: `${ANN} ข้อ 5 (2); legal-reference §1 เงินประกัน + ค่าเช่าล่วงหน้า; D-023`,
    defaultSeverity: 'block',
    appliesTo: ['lease', 'deposit'],
    descriptionTh: 'เงินประกันรวมค่าเช่าล่วงหน้าไม่เกิน 3 เดือน (ระยะยาวรายปี ไม่เกิน 1 ปี) ⚖',
    descriptionEn: 'Deposit plus advance rent ≤ 3 months (long-term annual rent: ≤ 1 year) ⚖.',
    settingsUsed: ['deposit.max_months_short', 'deposit.max_years_long'],
    evaluate: evaluateDepositCap,
  },
  {
    id: 'compliance.deposit_deadline',
    legalRef: `${ANN} ข้อ 4 (10); legal-reference §1 คืนเงินประกัน; D-023`,
    defaultSeverity: 'warn',
    appliesTo: ['deposit'],
    descriptionTh: 'คืนเงินประกันภายใน 7 วันนับแต่สัญญาสิ้นสุดและส่งมอบคืน',
    descriptionEn: 'Refund the deposit within 7 days of lease end and hand-back.',
    settingsUsed: ['deposit.refund_days'],
    evaluate: evaluateDepositDeadline,
  },
  {
    id: 'compliance.deposit_evidence',
    legalRef: `${ANN} ข้อ 4 (10); legal-reference §1 คืนเงินประกัน; D-023`,
    defaultSeverity: 'block',
    appliesTo: ['deposit'],
    descriptionTh: 'หักเงินประกันได้เฉพาะความเสียหายที่ผู้เช่าก่อ โดยแจ้งรายการและมีหลักฐาน',
    descriptionEn: 'Deductions only for damage caused by the lessee, itemised with evidence.',
    settingsUsed: [],
    evaluate: evaluateDepositEvidence,
  },
  {
    id: 'compliance.deposit_wear',
    legalRef: `${ANN} ข้อ 5 (7)–(8); legal-reference §1 หักค่าเสื่อม`,
    defaultSeverity: 'block',
    appliesTo: ['deposit'],
    descriptionTh: 'ห้ามหักค่าเสื่อมสภาพจากการใช้งานตามปกติ',
    descriptionEn: 'No deduction for normal wear and tear.',
    settingsUsed: [],
    evaluate: evaluateDepositWear,
  },
  {
    id: 'compliance.no_forfeiture',
    legalRef: `${ANN} ข้อ 5 (4); legal-reference §1 ริบเงินประกัน`,
    defaultSeverity: 'block',
    appliesTo: ['deposit', 'lease'],
    descriptionTh: 'ห้ามริบเงินประกันหรือค่าเช่าล่วงหน้าโดยผู้เช่าไม่ได้ผิดสัญญา',
    descriptionEn: 'No forfeiture of deposit or advance rent without a breach by the lessee.',
    settingsUsed: [],
    evaluate: evaluateNoForfeiture,
  },
  {
    id: 'compliance.notice_period',
    legalRef: `${ANN} ข้อ 4 (11); legal-reference §1 ผู้เช่าบอกเลิก`,
    defaultSeverity: 'warn',
    appliesTo: ['lease', 'notice'],
    descriptionTh: 'ผู้เช่าบอกเลิกสัญญาได้โดยแจ้งเป็นหนังสือล่วงหน้าไม่น้อยกว่า 30 วัน ⚖',
    descriptionEn: 'The lessee may terminate with 30 days’ written notice ⚖.',
    settingsUsed: [],
    evaluate: evaluateNoticePeriod,
  },
  {
    id: 'compliance.termination_notice',
    legalRef: `${ANN} ข้อ 4 (12); legal-reference §1 ผู้ให้เช่าบอกเลิก`,
    defaultSeverity: 'warn',
    appliesTo: ['lease', 'notice'],
    descriptionTh: 'ผู้ให้เช่าบอกเลิกต้องแจ้งให้แก้ไขภายใน 30 วัน (กระทบผู้อื่น 7 วัน)',
    descriptionEn:
      'Lessor termination: written notice to remedy within 30 days (7 days when others are affected).',
    settingsUsed: [],
    evaluate: evaluateTerminationNotice,
  },
  {
    id: 'compliance.no_midterm_increase',
    legalRef: `${ANN} ข้อ 5 (3); legal-reference §1 ขึ้นค่าเช่า`,
    defaultSeverity: 'block',
    appliesTo: ['lease', 'rate_plan'],
    descriptionTh: 'ห้ามขึ้นค่าเช่า ค่าสาธารณูปโภค ค่าบริการ ระหว่างอายุสัญญา',
    descriptionEn: 'No increase of rent, utility rates or service charges during the lease term.',
    settingsUsed: [],
    evaluate: evaluateNoMidtermIncrease,
  },
  {
    id: 'compliance.no_renewal_fee',
    legalRef: `${ANN} ข้อ 5 (11); legal-reference §1 ค่าต่อสัญญา`,
    defaultSeverity: 'block',
    appliesTo: ['lease', 'invoice'],
    descriptionTh: 'ห้ามเรียกเก็บค่าต่อสัญญาจากผู้เช่ารายเดิม',
    descriptionEn: 'No renewal fee for an existing lessee.',
    settingsUsed: [],
    evaluate: evaluateNoRenewalFee,
  },
  {
    id: 'compliance.entry_notice',
    legalRef: `${ANN} ข้อ 5 (5); legal-reference §1 เข้าห้อง`,
    defaultSeverity: 'warn',
    appliesTo: ['access'],
    descriptionTh: 'ห้ามเข้าตรวจห้องโดยไม่แจ้งล่วงหน้า เว้นเหตุฉุกเฉิน',
    descriptionEn: 'No entry without prior notice except emergencies.',
    settingsUsed: [],
    evaluate: evaluateEntryNotice,
  },
  {
    id: 'compliance.no_cutoff',
    legalRef: `${ANN} ข้อ 5 (10); legal-reference §1 ตัดน้ำ/ไฟ; D-024, D-157`,
    defaultSeverity: 'block',
    appliesTo: ['access', 'invoice'],
    descriptionTh: 'ห้ามตัดน้ำไฟ ล็อกห้อง หรือขนย้ายทรัพย์สินเพราะค้างชำระ — ระบบไม่มีฟังก์ชันนี้',
    descriptionEn:
      'No power/water cut-off, lock-out or removal of belongings for arrears — the platform has no such function.',
    settingsUsed: [],
    evaluate: evaluateNoCutoff,
  },
  {
    id: 'compliance.forbidden_clause',
    legalRef: `${ANN} ข้อ 5 (1)–(12); legal-reference §1 ข้อสัญญาที่ขัดประกาศ`,
    defaultSeverity: 'block',
    appliesTo: ['lease'],
    descriptionTh: 'ห้ามใช้ข้อสัญญาที่ประกาศห้ามในสัญญาหรือเอกสารแนบท้าย',
    descriptionEn: 'Clauses forbidden by the announcement are refused in lease addenda.',
    settingsUsed: [],
    evaluate: evaluateForbiddenClause,
  },
  {
    id: 'compliance.late_fee_policy',
    legalRef: `${ANN} ข้อ 4 (5); legal-reference §1 ค่าปรับล่าช้า; D-045, O-002`,
    defaultSeverity: 'block',
    appliesTo: ['invoice', 'lease'],
    descriptionTh: 'ค่าปรับล่าช้าเฉพาะเมื่อเปิดใช้และระบุในสัญญา (ได้สัดส่วน) ⚖',
    descriptionEn: 'Late fees only when enabled and stated in the contract (proportionate) ⚖.',
    settingsUsed: ['late_fee.enabled'],
    evaluate: evaluateLateFeePolicy,
  },
];

/** The registry entry of a rule. */
export function ruleOf<K extends ComplianceRuleId>(id: K): RuleDef<K> {
  const rule = COMPLIANCE_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown compliance rule ${id}`);
  return rule as unknown as RuleDef<K>;
}

/** Evaluates one rule of the registry against its context (pure). */
export function evaluateRule<K extends ComplianceRuleId>(id: K, context: RuleContexts[K]): RuleCheck {
  return ruleOf(id).evaluate(context);
}

export const isComplianceRuleId = (id: string): id is ComplianceRuleId =>
  COMPLIANCE_RULES.some((r) => r.id === id);
