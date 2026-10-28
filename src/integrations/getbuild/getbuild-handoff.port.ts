export const GETBUILD_HANDOFF = Symbol('GETBUILD_HANDOFF');

/** What getbuild knows about a transferred unit and getproperty prefills a listing draft with (D-299). */
export interface GetbuildUnitFacts {
  projectName: string;
  unitNo: string;
  address: {
    line1: string;
    subdistrict?: string;
    district?: string;
    province: string;
    postcode: string;
  };
  /** Decimal string, m². */
  areaSqm?: string;
  bedrooms?: number;
  bathrooms?: number;
  floorLabel?: string;
  lat?: number;
  lng?: number;
}

export interface GetbuildUnitRef {
  /** The developer tenant in getbuild (the envelope's `tenantId`). */
  developerRef: string;
  buildingRef: string;
  unitRef: string;
}

export interface GetbuildInvitation extends GetbuildUnitRef {
  handoffId: string;
  buyerRef: string;
  /** The single-use link the buyer opens (`<PUBLIC_WEB_APP_URL>/handoff/<token>`). */
  url: string;
  campaignTag: string;
  expiresAt: string;
}

/** The provider is switched off (`GETBUILD_MODE=off`, O-033: no getbuild API agreed yet). */
export class GetbuildUnavailableError extends Error {
  constructor() {
    super('getbuild handoff API is not available (GETBUILD_MODE=off)');
    this.name = 'GetbuildUnavailableError';
  }
}

/**
 * getbuild rental handoff port (G8, D-299, O-033). The `unit.transferred` event (asset-core contract, received on the
 * signed webhook) carries refs only; getproperty asks getbuild for the unit facts to prefill a listing draft, and hands
 * the buyer's invitation link back to getbuild, which holds the buyer relationship and shows it in its buyer portal —
 * getproperty never messages the buyer itself (it has no consent of its own, D-025). No real adapter until O-033.
 */
export interface GetbuildHandoffPort {
  readonly mode: 'off' | 'fake';
  /** Facts of a transferred unit, or null when getbuild does not know it. */
  unitFacts(ref: GetbuildUnitRef): Promise<GetbuildUnitFacts | null>;
  /** Hands the invitation to getbuild for the buyer (idempotent per handoff on getbuild's side). */
  deliverInvitation(invitation: GetbuildInvitation): Promise<void>;
}

/** `GETBUILD_MODE=off`: no facts (the draft is prefilled from the event only) and nothing can be delivered. */
export class GetbuildHandoffUnavailable implements GetbuildHandoffPort {
  readonly mode = 'off' as const;
  unitFacts(): Promise<GetbuildUnitFacts | null> {
    return Promise.resolve(null);
  }
  deliverInvitation(): Promise<void> {
    return Promise.reject(new GetbuildUnavailableError());
  }
}
