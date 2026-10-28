import { createHash } from 'node:crypto';

import {
  type GetbuildHandoffPort,
  type GetbuildInvitation,
  type GetbuildUnitFacts,
  type GetbuildUnitRef,
} from './getbuild-handoff.port';

/**
 * In-memory getbuild (tests, demos): deterministic facts derived from the refs (a condo in Bangkok) unless a test set
 * them, and every delivered invitation kept so a test can open the buyer's link. `failNext` makes the next delivery
 * throw (retry path).
 */
export class FakeGetbuildHandoff implements GetbuildHandoffPort {
  readonly mode = 'fake' as const;
  readonly delivered: GetbuildInvitation[] = [];
  private readonly facts = new Map<string, GetbuildUnitFacts | null>();
  failNext = false;

  private key(ref: GetbuildUnitRef): string {
    return `${ref.developerRef}|${ref.buildingRef}|${ref.unitRef}`;
  }

  /** A test fixes the facts of one unit (null = getbuild does not know it). */
  setFacts(ref: GetbuildUnitRef, facts: GetbuildUnitFacts | null): void {
    this.facts.set(this.key(ref), facts);
  }

  unitFacts(ref: GetbuildUnitRef): Promise<GetbuildUnitFacts | null> {
    const set = this.facts.get(this.key(ref));
    if (set !== undefined) return Promise.resolve(set);
    const n = createHash('sha256').update(this.key(ref)).digest().readUInt8(0);
    return Promise.resolve({
      projectName: `โครงการ ${ref.buildingRef}`,
      unitNo: ref.unitRef,
      address: {
        line1: 'ถนนพหลโยธิน',
        district: 'จตุจักร',
        province: 'กรุงเทพมหานคร',
        postcode: '10900',
      },
      areaSqm: (28 + (n % 20)).toFixed(2),
      bedrooms: 1 + (n % 2),
      bathrooms: 1,
      floorLabel: String(5 + (n % 20)),
    });
  }

  deliverInvitation(invitation: GetbuildInvitation): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fake getbuild: delivery refused'));
    }
    this.delivered.push(invitation);
    return Promise.resolve();
  }

  /** The last link delivered for a handoff (the buyer's token is its last path segment). */
  lastFor(handoffId: string): GetbuildInvitation | undefined {
    return [...this.delivered].reverse().find((d) => d.handoffId === handoffId);
  }
}
