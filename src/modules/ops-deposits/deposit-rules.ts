import {
  type DeductionInput,
  evaluateDepositEvidence,
  evaluateDepositWear,
  evaluateNoForfeiture,
  EVIDENCE_KINDS,
  type RuleCheck,
} from '@core/compliance/evaluators';
import Decimal from 'decimal.js';

/**
 * The deposit rules of the สคบ. 2568 announcement as pure checks (D-023; legal-reference §1 เงินประกัน). The refund
 * deadline itself (`compliance.deposit_deadline`) is a clock on the workflow engine, not a check here.
 */

export type { DeductionInput };
export { EVIDENCE_KINDS };

/** ข้อ 5 (7)–(8): normal wear and tear is never deducted from the deposit (registry evaluator). */
export const checkDeductionWear = (d: DeductionInput): RuleCheck => evaluateDepositWear(d);

/** ข้อ 4 (10): deductions are itemised with evidence (registry evaluator). */
export const checkDeductionEvidence = (d: DeductionInput): RuleCheck => evaluateDepositEvidence(d);

/**
 * The refund the settlement owes: deposit + advance rent the final invoice did not use (D-177, never forfeited) −
 * itemised deductions − final utilities, never below zero.
 */
export function proposedRefund(
  depositHeld: string,
  deductionsTotal: string,
  utilitiesFinal: string,
  advanceRentUnused = '0',
): string {
  return Decimal.max(
    0,
    new Decimal(depositHeld).plus(advanceRentUnused).minus(deductionsTotal).minus(utilitiesFinal),
  ).toFixed(2);
}

/** ข้อ 5 (4): no forfeiture without a breach — the refund pays back at least what the itemised settlement owes. */
export function checkRefund(owed: string, refund: string): RuleCheck {
  return evaluateNoForfeiture({ owed, refund });
}
