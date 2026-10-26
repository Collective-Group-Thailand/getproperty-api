import {
  isEventBasis,
  LEGAL_HOLD_POLICY_KEY,
  packagePeriod,
  RECLAIMABLE_KINDS,
  reclaimRefusal,
  storageCategory,
} from './storage-categories';
import { emptyTotals, sumTotals } from './storage-ledger';

describe('G1 storage categories, holds and packages (D-285, D-286)', () => {
  it('a held file is system_legal; listing photos are listing media; generated vs uploaded', () => {
    expect(storageCategory({ kind: 'pdf_receipt', generated: true, held: true })).toBe('system_legal');
    expect(storageCategory({ kind: 'slip', generated: false, held: true })).toBe('system_legal');
    expect(storageCategory({ kind: 'listing_photo', generated: false, held: false })).toBe('listing_media');
    expect(storageCategory({ kind: 'other', generated: true, held: false })).toBe('system_other');
    expect(storageCategory({ kind: 'other', generated: false, held: false })).toBe('attachment');
  });

  it('every legal kind of D-286 is held under a retention policy key', () => {
    expect(LEGAL_HOLD_POLICY_KEY).toMatchObject({
      pdf_receipt: 'pdf_receipt',
      pdf_tax_invoice: 'pdf_tax_invoice',
      pdf_note: 'pdf_note',
      pdf_invoice: 'pdf_invoice',
      contract: 'contract',
      signature: 'contract',
      slip: 'slip',
      pdf_statement: 'deposit_settlement',
    });
    expect(isEventBasis('lease end; ⚖ pending legal review')).toBe(true);
    expect(isEventBasis('issued_at; ⚖ accounting retention to confirm')).toBe(false);
  });

  it('reclaim refuses holds first, then system files, evidence and photos of a live listing', () => {
    const base = {
      kind: 'listing_photo' as const,
      category: 'listing_media' as const,
      held: false,
      onLiveListing: false,
    };
    expect(reclaimRefusal(base)).toBeNull();
    expect(reclaimRefusal({ ...base, held: true })).toBe('legal_hold');
    expect(reclaimRefusal({ ...base, onLiveListing: true })).toBe('listing_in_use');
    expect(reclaimRefusal({ ...base, kind: 'meter_photo', category: 'attachment' })).toBe('evidence');
    expect(reclaimRefusal({ ...base, kind: 'pdf_report', category: 'system_other' })).toBe('system_file');
    expect(RECLAIMABLE_KINDS).not.toContain('slip');
    expect(RECLAIMABLE_KINDS).not.toContain('id_document');
  });

  it('package periods end the day before the same date next period (clamped to month end)', () => {
    expect(packagePeriod('2026-11-01', 'month')).toEqual({ startsOn: '2026-11-01', endsOn: '2026-11-30' });
    expect(packagePeriod('2026-01-31', 'month')).toEqual({ startsOn: '2026-01-31', endsOn: '2026-02-28' });
    expect(packagePeriod('2026-12-15', 'month')).toEqual({ startsOn: '2026-12-15', endsOn: '2027-01-14' });
    expect(packagePeriod('2026-11-01', 'year')).toEqual({ startsOn: '2026-11-01', endsOn: '2027-10-31' });
    expect(packagePeriod('2028-02-29', 'year')).toEqual({ startsOn: '2028-02-29', endsOn: '2029-02-28' });
  });

  it('totals add up per category', () => {
    const t = emptyTotals();
    t.attachment = { bytes: 10n, objects: 1 };
    t.system_legal = { bytes: 5n, objects: 2 };
    expect(sumTotals(t)).toEqual({ bytes: 15n, objects: 3 });
  });
});
