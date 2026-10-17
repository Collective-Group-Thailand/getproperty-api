import { type RuleCheck } from '@core/compliance/compliance-gate.service';
import Decimal from 'decimal.js';

/**
 * The deposit rules of the สคบ. 2568 announcement as pure checks (D-023; legal-reference §1 เงินประกัน). The refund
 * deadline itself (`compliance.deposit_deadline`) is a clock on the workflow engine, not a check here.
 */

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
export function checkDeductionWear(d: DeductionInput): RuleCheck {
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
export function checkDeductionEvidence(d: DeductionInput): RuleCheck {
  const errors: { path: string; code: string; message: string }[] = [];
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
    errors: errors.length ? errors : undefined,
  };
}

/** The refund the settlement owes: deposit − itemised deductions − final utilities, never below zero. */
export function proposedRefund(depositHeld: string, deductionsTotal: string, utilitiesFinal: string): string {
  return Decimal.max(0, new Decimal(depositHeld).minus(deductionsTotal).minus(utilitiesFinal)).toFixed(2);
}

/** ข้อ 5 (4): no forfeiture without a breach — the refund pays back at least what the itemised settlement owes. */
export function checkRefund(owed: string, refund: string): RuleCheck {
  const violated = new Decimal(refund).lessThan(owed);
  return {
    ruleId: 'compliance.no_forfeiture',
    violated,
    context: { owed: new Decimal(owed).toFixed(2), refund: new Decimal(refund).toFixed(2) },
    errors: violated
      ? [
          {
            path: 'amount',
            code: 'belowOwed',
            message: `the refund must be at least ${new Decimal(owed).toFixed(2)}`,
          },
        ]
      : undefined,
  };
}
