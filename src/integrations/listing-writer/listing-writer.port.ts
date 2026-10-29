export const LISTING_WRITER = Symbol('LISTING_WRITER');

export type ListingWriterLanguage = 'th' | 'en' | 'zh';

/** The facts of a listing the assistant may use — the listing's own public fields only (no tenant, party or lease data). */
export interface ListingFacts {
  unitKind: string | null;
  sizeSqm: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorLabel: string | null;
  furnishing: string | null;
  /** Decimal string, THB per month. */
  rent: string;
  depositMonths: number;
  advanceMonths: number;
  minTermMonths: number;
  petsAllowed: boolean;
  smokingAllowed: boolean;
  facilities: string[];
  province: string | null;
  district: string | null;
  transit: { name: string; line: string | null; distanceM: number | null } | null;
  /** The owner's current title / description (Thai), so the draft keeps what they wrote. */
  currentTitleTh: string;
  currentDescriptionTh: string;
}

export interface ListingDraft {
  title: string;
  description: string;
}

export interface ListingWriterRequest {
  facts: ListingFacts;
  languages: ListingWriterLanguage[];
  /** Photos the assistant may look at (read only — the assistant answers text, never an image). */
  photos: { data: Buffer; mimeType: string }[];
  /** Tenant the call is billed to (D-161). */
  tenantId: string;
}

export interface ListingWriterResponse {
  drafts: Partial<Record<ListingWriterLanguage, ListingDraft>>;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * The AI listing assistant (G9, D-301, D-161): drafts a title and a description per language from a listing's facts
 * (and optionally a few of its photos). Text only — the assistant never edits, re-encodes or returns photos.
 */
export interface ListingWriterPort {
  readonly mode: 'fake' | 'real';
  draft(request: ListingWriterRequest): Promise<ListingWriterResponse>;
}

/** Thrown by an adapter when the AI gateway is not configured (real mode without URL / key). */
export class ListingWriterUnavailable extends Error {
  constructor(message = 'AI gateway not configured') {
    super(message);
    this.name = 'ListingWriterUnavailable';
  }
}
