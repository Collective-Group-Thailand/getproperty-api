import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';

/**
 * Review #9 (D-025, D-224): what a resident sees of a unit starts with their own current occupancy of it. Returns,
 * per unit, the instant (00:00 Asia/Bangkok of the occupancy's first day) from which the unit's requests, parcels and
 * bookings are theirs to see; units without a current occupancy of the login's parties are absent.
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
  const today = new Date(bangkokDate(input.now));
  const current = await tx.occupancy.findMany({
    where: {
      partyId: { in: links.map((l) => l.partyId) },
      unitId: { in: input.unitIds },
      validFrom: { lte: today },
      OR: [{ validTo: null }, { validTo: { gt: today } }],
    },
    select: { unitId: true, validFrom: true },
  });
  for (const o of current) {
    const since = startOfBangkokDay(o.validFrom.toISOString().slice(0, 10));
    const prev = out.get(o.unitId);
    if (!prev || since < prev) out.set(o.unitId, since);
  }
  return out;
}
