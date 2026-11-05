import { LEASE_IN_FORCE } from '@core/identity/resident-units';
import { type Recipient } from '@core/notifications/notifiable-events';
import { type Tx } from '@database/prisma.service';

/**
 * J4.1 (D-315, D-309): the people a gate asks about a visit to a unit — every login linked to a party holding a
 * **current** ownership or occupancy of the unit, or a party of a lease in force on it as lessee, co-tenant or
 * occupant (JR roles co_owner · tenant · co_tenant · family). A payer-only party (bill-to, lease payer) and a guarantor
 * are not asked: they do not live in or own the house. Runs as gp_platform (identity lookups).
 */
export async function unitResidentUserIds(tx: Tx, unitId: string, today: string): Promise<string[]> {
  const date = new Date(today);
  const current = { unitId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gt: date } }] };
  const [ownerships, occupancies, leases] = await Promise.all([
    tx.unitOwnership.findMany({ where: current, select: { partyId: true } }),
    tx.occupancy.findMany({ where: current, select: { partyId: true } }),
    tx.lease.findMany({
      where: { unitId, status: { in: [...LEASE_IN_FORCE] }, startDate: { lte: date } },
      select: {
        parties: {
          where: { role: { in: ['lessee', 'co_tenant', 'occupant'] } },
          select: { partyId: true },
        },
      },
    }),
  ]);
  const partyIds = [
    ...new Set([
      ...ownerships.map((o) => o.partyId),
      ...occupancies.map((o) => o.partyId),
      ...leases.flatMap((l) => l.parties.map((p) => p.partyId)),
    ]),
  ];
  if (!partyIds.length) return [];
  const links = await tx.partyUserLink.findMany({
    where: { partyId: { in: partyIds }, state: 'active', user: { status: 'active' } },
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  return [...new Set(links.map((l) => l.userId))];
}

/** Those logins as resident recipients (LINE of the login, in-app always). */
export async function unitResidentRecipients(
  tx: Tx,
  unitId: string,
  tenantId: string,
  today: string,
): Promise<Recipient[]> {
  const ids = await unitResidentUserIds(tx, unitId, today);
  if (!ids.length) return [];
  const users = await tx.userAccount.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  return users.map((u) => ({
    audience: 'resident' as const,
    type: 'user' as const,
    id: u.id,
    tenantId,
    language: u.language,
    line: u.lineUserId,
    phone: null,
    email: null,
  }));
}
