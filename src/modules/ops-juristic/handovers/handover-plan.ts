import Decimal from 'decimal.js';

/**
 * Pure part of the developer handover (J3.2, D-314, D-333): the `building.handover.requested` payload as far as the
 * juristic office applies it (PII envelopes dropped — D-025 minimisation), its totals, the problems that block an
 * acceptance and the share split of a unit's money between its owners (D-323 rounding).
 */

export interface HandoverParty {
  ref: string;
  type: 'person' | 'company';
  displayName: string;
  lineUserId?: string;
  language?: string;
}

export interface HandoverUnitPayload {
  ref: string;
  floorRef?: string;
  unitNo: string;
  type: string;
  areaSqm?: string;
  ownershipRatio?: string;
  titleDeedNo?: string;
  landAreaSqwa?: string;
  plotNo?: string;
}

export interface HandoverFinanceUnit {
  unitRef: string;
  advanceCommonFees?: { amount: string; periodFrom: string; periodTo: string };
  firstFundContribution?: string;
  receivablesBroughtForward: { ref?: string; description: string; amount: string; dueOn?: string }[];
}

export interface HandoverPayload {
  developerTenantRef: string;
  requestedHandoverAt: string;
  property: { ref: string; code: string; name: string; address: Record<string, unknown>; kind?: string };
  building: {
    ref: string;
    code: string;
    name: string;
    type: string;
    floorsCount?: number;
    registrationNo?: string;
    legalForm?: string;
  };
  floors: { ref: string; level: number; name: string }[];
  units: HandoverUnitPayload[];
  parties: HandoverParty[];
  unitOwnerships: { unitRef: string; partyRef: string; sharePct: string; validFrom: string }[];
  warrantyTerms: { scope: string; ref: string; startsOn: string; endsOn: string }[];
  finance?: {
    asOf: string;
    currency: 'THB';
    receivingBankAccount: {
      bankCode: string;
      bankName?: string;
      branch?: string;
      accountName: string;
      accountNoMasked: string;
    };
    units: HandoverFinanceUnit[];
  };
}

export interface HandoverTotals {
  units: number;
  floors: number;
  parties: number;
  ownerships: number;
  unitsWithMoney: number;
  advanceCommonFees: string;
  firstFundContributions: string;
  receivablesBroughtForward: string;
  receivableItems: number;
}

export interface HandoverProblem {
  code:
    | 'owner_missing'
    | 'party_unknown'
    | 'unit_unknown'
    | 'floor_unknown'
    | 'shares_exceeded'
    | 'duplicate_unit_no'
    | 'receivable_after_as_of';
  unitRef?: string;
  ref?: string;
}

const D = (v: Decimal.Value) => new Decimal(v);
const sum = (xs: readonly Decimal.Value[]) => xs.reduce<Decimal>((s, x) => s.plus(x), new Decimal(0));

/** Drops what getproperty must not keep (shared-key PII envelopes) and normalises the defaults. */
export function minimisePayload(raw: Record<string, unknown>): HandoverPayload {
  const p = raw as unknown as HandoverPayload & { parties: (HandoverParty & Record<string, unknown>)[] };
  return {
    developerTenantRef: p.developerTenantRef,
    requestedHandoverAt: p.requestedHandoverAt,
    property: p.property,
    building: p.building,
    floors: p.floors ?? [],
    units: p.units,
    parties: (p.parties ?? []).map((x) => ({
      ref: x.ref,
      type: x.type,
      displayName: x.displayName,
      ...(x.lineUserId ? { lineUserId: x.lineUserId } : {}),
      ...(x.language ? { language: x.language } : {}),
    })),
    unitOwnerships: p.unitOwnerships ?? [],
    warrantyTerms: (p.warrantyTerms ?? []).map((w) => ({
      scope: w.scope,
      ref: w.ref,
      startsOn: w.startsOn,
      endsOn: w.endsOn,
    })),
    ...(p.finance
      ? {
          finance: {
            ...p.finance,
            units: p.finance.units.map((u) => ({
              ...u,
              receivablesBroughtForward: u.receivablesBroughtForward ?? [],
            })),
          },
        }
      : {}),
  };
}

export function unitMoney(u: HandoverFinanceUnit): { advance: Decimal; fund: Decimal; receivables: Decimal } {
  return {
    advance: D(u.advanceCommonFees?.amount ?? '0'),
    fund: D(u.firstFundContribution ?? '0'),
    receivables: sum(u.receivablesBroughtForward.map((r) => r.amount)),
  };
}

export function handoverTotals(p: HandoverPayload): HandoverTotals {
  const fin = p.finance?.units ?? [];
  const money = fin.map(unitMoney);
  return {
    units: p.units.length,
    floors: p.floors.length,
    parties: p.parties.length,
    ownerships: p.unitOwnerships.length,
    unitsWithMoney: money.filter((m) => m.advance.gt(0) || m.fund.gt(0) || m.receivables.gt(0)).length,
    advanceCommonFees: sum(money.map((m) => m.advance)).toFixed(2),
    firstFundContributions: sum(money.map((m) => m.fund)).toFixed(2),
    receivablesBroughtForward: sum(money.map((m) => m.receivables)).toFixed(2),
    receivableItems: fin.reduce((n, u) => n + u.receivablesBroughtForward.length, 0),
  };
}

/** The owners of a unit on a day (`validFrom` ≤ day), by party ref. */
export function ownersOn(
  p: HandoverPayload,
  unitRef: string,
  day: string,
): { partyRef: string; sharePct: string }[] {
  return p.unitOwnerships
    .filter((o) => o.unitRef === unitRef && o.validFrom <= day && D(o.sharePct).gt(0))
    .map((o) => ({ partyRef: o.partyRef, sharePct: o.sharePct }));
}

/** The day the balances are stated at (v2), else the handover's Bangkok date. */
export function asOfOf(p: HandoverPayload): string {
  if (p.finance?.asOf) return p.finance.asOf;
  return new Date(new Date(p.requestedHandoverAt).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** Everything that blocks an acceptance (shown in the review; 422 `handover.invalid` on accept). */
export function handoverProblems(p: HandoverPayload): HandoverProblem[] {
  const out: HandoverProblem[] = [];
  const units = new Set(p.units.map((u) => u.ref));
  const parties = new Set(p.parties.map((x) => x.ref));
  const floors = new Set(p.floors.map((f) => f.ref));
  const numbers = new Set<string>();
  for (const u of p.units) {
    const key = u.unitNo.trim().toLowerCase();
    if (numbers.has(key)) out.push({ code: 'duplicate_unit_no', unitRef: u.ref });
    numbers.add(key);
    if (u.floorRef && !floors.has(u.floorRef))
      out.push({ code: 'floor_unknown', unitRef: u.ref, ref: u.floorRef });
  }
  const shares = new Map<string, Decimal>();
  for (const o of p.unitOwnerships) {
    if (!units.has(o.unitRef)) out.push({ code: 'unit_unknown', ref: o.unitRef });
    if (!parties.has(o.partyRef)) out.push({ code: 'party_unknown', unitRef: o.unitRef, ref: o.partyRef });
    shares.set(o.unitRef, (shares.get(o.unitRef) ?? new Decimal(0)).plus(o.sharePct));
  }
  for (const [unitRef, s] of shares) if (s.gt(100)) out.push({ code: 'shares_exceeded', unitRef });
  const asOf = asOfOf(p);
  for (const u of p.finance?.units ?? []) {
    const m = unitMoney(u);
    if ((m.advance.gt(0) || m.receivables.gt(0)) && !ownersOn(p, u.unitRef, asOf).length)
      out.push({ code: 'owner_missing', unitRef: u.unitRef });
    for (const r of u.receivablesBroughtForward)
      if (r.dueOn && r.dueOn > asOf)
        out.push({ code: 'receivable_after_as_of', unitRef: u.unitRef, ref: r.ref });
  }
  return out;
}

/**
 * Splits an amount between owners by share (D-323): each half-up to the satang on its share of 100 %, the remainder
 * to the largest share (ties: the first party key). Shares under 100 % in total still split the **whole** amount in
 * their proportion — the developer collected the amount for the unit, so it all belongs to its owners.
 */
export function splitByShares(
  amount: Decimal.Value,
  owners: readonly { key: string; sharePct: Decimal.Value }[],
): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  const total = D(amount);
  if (!owners.length) return out;
  const weight = sum(owners.map((o) => o.sharePct));
  const sorted = [...owners].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let given = new Decimal(0);
  for (const o of sorted) {
    const part = total.times(o.sharePct).div(weight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    out.set(o.key, part);
    given = given.plus(part);
  }
  const rest = total.minus(given);
  if (!rest.isZero()) {
    const largest = sorted.reduce((best, o) => (D(o.sharePct).gt(best.sharePct) ? o : best), sorted[0]!);
    out.set(largest.key, out.get(largest.key)!.plus(rest));
  }
  return out;
}

/** The property kind a building type implies when getbuild does not send one (D-302). */
export function kindOfBuildingType(type: string): string {
  switch (type) {
    case 'condo':
      return 'condo';
    case 'house_cluster':
      return 'village';
    case 'apartment':
      return 'apartment';
    default:
      return 'mixed';
  }
}

/** The unit type of the payload in this repo's enum (`room` is an apartment room). */
export function unitTypeOf(type: string): string {
  return ['room', 'condo_unit', 'house', 'shop', 'parking', 'plot'].includes(type) ? type : 'condo_unit';
}
