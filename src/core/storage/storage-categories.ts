import { type DocumentKind, type StorageCategory } from '@generated/prisma/client';

/**
 * Quota categories and legal holds of stored files (G1, D-285 / D-286). Every file counts to the tenant's quota; the
 * category only explains where the space goes and which files the owner may reclaim.
 */

/**
 * Kinds the platform issues that the law requires to keep (D-286) → the `platform.retention_policy` target key whose
 * period applies (⚖ periods under O-025). Generated files of these kinds are held from the moment they are stored.
 */
export const LEGAL_HOLD_POLICY_KEY: Partial<Record<DocumentKind, string>> = {
  pdf_invoice: 'pdf_invoice',
  pdf_receipt: 'pdf_receipt',
  pdf_tax_invoice: 'pdf_tax_invoice',
  pdf_note: 'pdf_note',
  contract: 'contract',
  signature: 'contract',
  slip: 'slip',
  pdf_statement: 'deposit_settlement',
};

/** Uploaded kinds that are held at upload (residents' payment slips — a payment flow needs them, D-286). */
export const HELD_UPLOAD_KINDS: readonly DocumentKind[] = ['slip'];

/**
 * Kinds an owner may delete to reclaim space (D-285): optional uploads only. Evidence (meter / inspection / service
 * photos), identity documents, logos, legal and system files are never reclaimable here (they follow retention).
 */
export const RECLAIMABLE_KINDS: readonly DocumentKind[] = [
  'listing_photo',
  'other',
  'floor_plan',
  'as_built',
  'certificate',
  'warranty',
];

export interface CategoryInput {
  kind: DocumentKind;
  /** Written by the platform (`recordGenerated`), not uploaded by a person. */
  generated: boolean;
  /** Under a legal hold. */
  held: boolean;
}

/** The quota category of a stored file. */
export function storageCategory(input: CategoryInput): StorageCategory {
  if (input.held) return 'system_legal';
  if (input.kind === 'listing_photo') return 'listing_media';
  return input.generated ? 'system_other' : 'attachment';
}

/** Basis of a retention policy that starts at a later event (the hold stays open-ended until it is known). */
export const isEventBasis = (basis: string) => /lease end/i.test(basis);

export type ReclaimRefusal = 'legal_hold' | 'system_file' | 'evidence' | 'listing_in_use';

/**
 * Why a file may not be reclaimed by its owner (null = deletable): legal holds first, then files the platform wrote,
 * then kinds that are evidence or identity, then photos of a listing that is still live.
 */
export function reclaimRefusal(input: {
  kind: DocumentKind;
  category: StorageCategory;
  held: boolean;
  onLiveListing: boolean;
}): ReclaimRefusal | null {
  if (input.held) return 'legal_hold';
  if (input.category === 'system_legal' || input.category === 'system_other') return 'system_file';
  if (!RECLAIMABLE_KINDS.includes(input.kind)) return 'evidence';
  if (input.onLiveListing) return 'listing_in_use';
  return null;
}

/** First and last day of a package period that starts on `start` (YYYY-MM-DD, Bangkok calendar). */
export function packagePeriod(start: string, period: 'month' | 'year'): { startsOn: string; endsOn: string } {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const months = period === 'month' ? 1 : 12;
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = targetMonth % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  // the day before the same date next period; a date the target month lacks ends on that month's last day
  const end = d > lastDay ? new Date(Date.UTC(ty, tm, lastDay)) : new Date(Date.UTC(ty, tm, d) - 86_400_000);
  return { startsOn: start, endsOn: end.toISOString().slice(0, 10) };
}
