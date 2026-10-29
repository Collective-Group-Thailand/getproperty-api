import {
  type ListingDraft,
  type ListingFacts,
  type ListingWriterLanguage,
} from '@integrations/listing-writer/listing-writer.port';

import { type ListingWithParts } from './listings.service';
import { personalDataIn } from './review-rules';

/** Pure rules of the AI listing assistant (G9, D-301): the facts it may use and the checks on its drafts. */

export const ASSISTANT_DISCLAIMER = {
  th: 'ข้อความนี้ร่างโดย AI จากข้อมูลประกาศของคุณ กรุณาตรวจทานให้ถูกต้องก่อนบันทึก',
  en: 'Drafted by AI from your listing’s details — check it before you save it.',
} as const;

export interface AssistantResult {
  drafts: Partial<Record<ListingWriterLanguage, ListingDraft>>;
  model: string;
  photosUsed: number;
  usedThisMonth: number;
  monthlyLimit: number;
}

/** The facts the assistant may use: the listing's own public fields only — no tenant, party, lease or address line. */
export function listingFacts(l: ListingWithParts): ListingFacts {
  return {
    unitKind: l.unitKind,
    sizeSqm: l.sizeSqm ? l.sizeSqm.toFixed(2) : null,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    floorLabel: l.floorLabel,
    furnishing: l.furnishing,
    rent: l.rent.toFixed(2),
    depositMonths: l.depositMonths,
    advanceMonths: l.advanceMonths,
    minTermMonths: l.minTermMonths,
    petsAllowed: l.petsAllowed,
    smokingAllowed: l.smokingAllowed,
    facilities: l.facilities,
    province: l.province,
    district: l.district,
    transit: l.transitName
      ? { name: l.transitName, line: l.transitLine, distanceM: l.transitDistanceM }
      : null,
    currentTitleTh: l.titleTh,
    currentDescriptionTh: l.descriptionTh,
  };
}

/**
 * Checks the model's drafts before they reach the owner: every requested language present, within the listing field
 * limits (title ≤ 120, description ≤ 5000) and free of contact / account / ID data (a listing never carries them,
 * D-267). Returns the cleaned drafts or null when unusable.
 */
export function checkDrafts(
  drafts: Partial<Record<ListingWriterLanguage, ListingDraft>>,
  languages: ListingWriterLanguage[],
): Partial<Record<ListingWriterLanguage, ListingDraft>> | null {
  const out: Partial<Record<ListingWriterLanguage, ListingDraft>> = {};
  for (const l of languages) {
    const d = drafts[l];
    const title = d?.title?.trim() ?? '';
    const description = d?.description?.trim() ?? '';
    if (!title || !description || title.length > 120 || description.length > 5000) return null;
    if (personalDataIn(`${title}\n${description}`).length) return null;
    out[l] = { title, description };
  }
  return out;
}
