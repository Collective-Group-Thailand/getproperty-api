import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';

/**
 * Review #9 (D-025, D-224): what a resident sees of a unit starts with their own current occupancy of it. Returns,
 * per unit, the instant (00:00 Asia/Bangkok of the occupancy's first day) from which the unit's requests, parcels and
 * bookings are theirs to see; units without a current role of the login's parties are absent.
 *
 * JR (D-322): a co-owner who does not live in the unit (current ownership, no occupancy of theirs) sees the unit from
 * `max(ownership start, end of the last occupancy of another party)` — and **not at all while another party occupies
 * it**: an occupant's parcels, requests and bookings stay theirs (PDPA, D-025).
 */
export async function occupancyWindows(
  tx: Tx,
  input: { userId: string; unitIds: string[]; now: Date },
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!input.unitIds.length) return out;
  const links = await tx.partyUserLink.findMany({
    where: { userId: input.userId, state: 'active' },
    select: { partyId: true },
  });
  if (!links.length) return out;
  const partyIds = links.map((l) => l.partyId);
  const today = new Date(bangkokDate(input.now));
  const currentOf = (units: string[]) => ({
    partyId: { in: partyIds },
    unitId: { in: units },
    validFrom: { lte: today },
    OR: [{ validTo: null }, { validTo: { gt: today } }],
  });
  const current = await tx.occupancy.findMany({
    where: currentOf(input.unitIds),
    select: { unitId: true, validFrom: true },
  });
  for (const o of current) {
    const since = startOfBangkokDay(o.validFrom.toISOString().slice(0, 10));
    const prev = out.get(o.unitId);
    if (!prev || since < prev) out.set(o.unitId, since);
  }
  const ownedOnly = input.unitIds.filter((u) => !out.has(u));
  if (!ownedOnly.length) return out;
  const owned = await tx.unitOwnership.findMany({
    where: currentOf(ownedOnly),
    select: { unitId: true, validFrom: true },
  });
  if (!owned.length) return out;
  const others = await tx.occupancy.findMany({
    where: {
      unitId: { in: [...new Set(owned.map((o) => o.unitId))] },
      partyId: { notIn: partyIds },
      validFrom: { lte: today },
    },
    select: { unitId: true, validTo: true },
  });
  for (const o of owned) {
    const theirs = others.filter((x) => x.unitId === o.unitId);
    // another party lives there now → nothing of the unit's own data for the non-resident owner
    if (theirs.some((x) => !x.validTo || x.validTo.getTime() > today.getTime())) continue;
    let from = o.validFrom;
    for (const x of theirs) if (x.validTo && x.validTo.getTime() > from.getTime()) from = x.validTo;
    const since = startOfBangkokDay(from.toISOString().slice(0, 10));
    const prev = out.get(o.unitId);
    if (!prev || since < prev) out.set(o.unitId, since);
  }
  return out;
}
