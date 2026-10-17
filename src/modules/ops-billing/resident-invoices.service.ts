import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { type InvoiceStatus, type Prisma } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { INVOICE_INCLUDE, type InvoiceRow } from './invoices.service';

/**
 * The resident side of invoices (`/v1/resident/invoices*`, D-011, D-022, D-061): the issued invoices (never drafts)
 * billed to a party linked to my login — or of a lease I am a party of (co-tenants see the room's invoices) — across
 * tenants (one LINE account, several leases). Rendered from the issue snapshot, so what I see is what was issued.
 */
@Injectable()
export class ResidentInvoicesService {
  constructor(private readonly db: TenantTx) {}

  private userId(): string {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return actor.publicId;
  }

  private async visible(): Promise<Prisma.InvoiceWhereInput | null> {
    const userId = this.userId();
    const links = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({ where: { userId, state: 'active' }, select: { partyId: true } }),
    );
    const partyIds = links.map((l) => l.partyId);
    if (!partyIds.length) return null;
    return {
      status: { not: 'draft' },
      issuedAt: { not: null },
      OR: [
        { billedPartyId: { in: partyIds } },
        { lease: { parties: { some: { partyId: { in: partyIds } } } } },
      ],
    };
  }

  async list(q: { status?: InvoiceStatus; unpaid?: boolean; skip: number; take: number }) {
    const base = await this.visible();
    if (!base) return { rows: [] as InvoiceRow[], total: 0 };
    const where: Prisma.InvoiceWhereInput = {
      AND: [
        base,
        q.status ? { status: q.status } : {},
        q.unpaid === true ? { balance: { gt: 0 }, status: { not: 'void' } } : {},
        q.unpaid === false ? { OR: [{ balance: { lte: 0 } }, { status: 'void' }] } : {},
      ],
    };
    return this.db.platform(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.invoice.findMany({
          where,
          include: INVOICE_INCLUDE,
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.invoice.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async get(where: { id: string } | { number: string }): Promise<InvoiceRow> {
    const base = await this.visible();
    if (!base) throw new DomainException('http.not_found');
    const found = await this.db.platform((tx) =>
      tx.invoice.findFirst({ where: { AND: [base, where] }, include: INVOICE_INCLUDE }),
    );
    if (!found) throw new DomainException('http.not_found');
    return found;
  }
}
