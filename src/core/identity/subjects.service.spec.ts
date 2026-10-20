import { type Tx } from '@database/prisma.service';

import { type Clock } from '../clock/clock';
import { SubjectService } from './subjects.service';

/** Review #15: resident unit scopes follow the Bangkok business date, not the UTC date. */
describe('SubjectService.resident (Asia/Bangkok business date)', () => {
  const occupancyWhere: unknown[] = [];
  const tx = {
    partyUserLink: { findMany: () => Promise.resolve([{ partyId: 'p1' }]) },
    occupancy: {
      findMany: (args: { where: unknown }) => {
        occupancyWhere.push(args.where);
        return Promise.resolve([{ unitId: 'u1' }]);
      },
    },
    leaseParty: { findMany: () => Promise.resolve([]) },
  } as unknown as Tx;

  it('at 01:30 ICT on 2 Nov (18:30 UTC on 1 Nov) the scope day is 2 Nov', async () => {
    const clock: Clock = { now: () => new Date('2026-11-01T18:30:00Z') };
    const subject = await new SubjectService(clock).resident(tx, 'user-1');
    expect(subject.scopes).toEqual(['unit:u1']);
    const where = occupancyWhere.pop() as {
      validFrom: { lte: Date };
      OR: [unknown, { validTo: { gt: Date } }];
    };
    expect(where.validFrom.lte.toISOString().slice(0, 10)).toBe('2026-11-02');
    expect(where.OR[1].validTo.gt.toISOString().slice(0, 10)).toBe('2026-11-02');
  });
});
