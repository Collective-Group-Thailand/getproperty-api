import { COMPLIANCE_RULES } from '@core/compliance/rules';

import { checkDeductionEvidence, checkDeductionWear, checkRefund, proposedRefund } from './deposit-rules';

const damaged = { condition: 'damaged', photoCount: 1 };

describe('deposit rules (D-023, สคบ. 2568)', () => {
  it.each([
    'compliance.deposit_wear',
    'compliance.deposit_evidence',
    'compliance.no_forfeiture',
    'compliance.deposit_deadline',
  ])('%s is registered with a legal reference to the announcement', (id) => {
    const rule = COMPLIANCE_RULES.find((r) => r.id === id);
    expect(rule?.legalRef).toMatch(/2568.*ข้อ/);
  });

  it('deposit_wear: normal wear is never deducted', () => {
    expect(
      checkDeductionWear({
        kind: 'damage',
        wearCategory: 'normal_wear',
        evidenceCount: 1,
        inspectionItem: damaged,
      }).violated,
    ).toBe(true);
    expect(
      checkDeductionWear({
        kind: 'damage',
        wearCategory: 'damage',
        evidenceCount: 1,
        inspectionItem: damaged,
      }).violated,
    ).toBe(false);
  });

  it('deposit_evidence: damage needs a damaged inspection item and a photo', () => {
    const ok = checkDeductionEvidence({
      kind: 'damage',
      wearCategory: 'damage',
      evidenceCount: 1,
      inspectionItem: damaged,
    });
    expect(ok.violated).toBe(false);
    // the inspection photo is evidence too
    expect(
      checkDeductionEvidence({
        kind: 'damage',
        wearCategory: 'damage',
        evidenceCount: 0,
        inspectionItem: damaged,
      }).violated,
    ).toBe(false);
    const noItem = checkDeductionEvidence({
      kind: 'damage',
      wearCategory: 'damage',
      evidenceCount: 1,
      inspectionItem: null,
    });
    expect(noItem.errors!.map((e) => e.code)).toEqual(['inspectionItemRequired']);
    const good = checkDeductionEvidence({
      kind: 'missing_item',
      wearCategory: 'damage',
      evidenceCount: 1,
      inspectionItem: { condition: 'good', photoCount: 0 },
    });
    expect(good.errors!.map((e) => e.code)).toEqual(['notDamaged']);
    const noPhoto = checkDeductionEvidence({
      kind: 'damage',
      wearCategory: 'damage',
      evidenceCount: 0,
      inspectionItem: { condition: 'damaged', photoCount: 0 },
    });
    expect(noPhoto.errors!.map((e) => e.code)).toEqual(['photoRequired']);
    expect(
      checkDeductionEvidence({
        kind: 'cleaning',
        wearCategory: 'damage',
        evidenceCount: 0,
        inspectionItem: null,
      }).violated,
    ).toBe(true);
    expect(
      checkDeductionEvidence({
        kind: 'cleaning',
        wearCategory: 'damage',
        evidenceCount: 1,
        inspectionItem: null,
      }).violated,
    ).toBe(false);
  });

  it('proposedRefund: deposit − deductions − utilities, never negative', () => {
    expect(proposedRefund('4500.00', '800.00', '350.50')).toBe('3349.50');
    expect(proposedRefund('1000', '800', '350')).toBe('0.00');
  });

  it('no_forfeiture: the refund pays back at least what is owed', () => {
    expect(checkRefund('3349.50', '3349.50').violated).toBe(false);
    expect(checkRefund('3349.50', '3000.00').violated).toBe(true);
  });
});
