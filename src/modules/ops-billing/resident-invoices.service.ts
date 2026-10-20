import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { type InvoiceStatus, type Prisma } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { type MeterSegment } from './engine/readings';
import { INVOICE_INCLUDE, type InvoiceRow } from './invoices.service';

/**
 * The resident side of invoices (`/v1/resident/invoices*`, D-011, D-022, D-061): the issued invoices (never drafts)
 * billed to a party linked to my login — or of a lease I am a party of (co-tenants see the room's invoices) — across
 * tenants (one LINE account, several leases). Rendered from the issue snapshot, so what I see is what was issued.
 */
@Injectable()
export class ResidentInvoicesService {
  constructor(
    private readonly db: TenantTx,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * LIFF #15 / #19 (D-208): per invoice, 5-minute links to the photos of the closing readings of its meter lines
   * (clean files only) and the receipts (not voided) of the payments allocated to it.
   */
  async extras(
    rows: InvoiceRow[],
  ): Promise<Map<string, { photoUrls: Map<string, string>; receipts: { id: string; number: string }[] }>> {
    const out = new Map<
      string,
      { photoUrls: Map<string, string>; receipts: { id: string; number: string }[] }
    >();
    if (!rows.length) return out;
    const photoIds = new Set<string>();
    for (const r of rows)
      for (const l of r.lines) {
        const segments = (l.meterSegments ?? []) as unknown as MeterSegment[];
        const last = [...segments].reverse().find((s) => s.to);
        if (last?.to?.evidenceDocumentId) photoIds.add(last.to.evidenceDocumentId);
      }
    const { docs, receipts } = await this.db.platform(async (tx) => ({
      docs: photoIds.size
        ? await tx.document.findMany({
            where: { id: { in: [...photoIds] }, deletedAt: null, scanStatus: { in: ['clean', 'skipped'] } },
          })
        : [],
      receipts: await tx.receipt.findMany({
        where: {
          voidedAt: null,
          payment: { allocations: { some: { invoiceId: { in: rows.map((r) => r.id) } } } },
        },
        select: {
          id: true,
          number: true,
          issuedAt: true,
          payment: { select: { allocations: { select: { invoiceId: true } } } },
        },
        orderBy: { issuedAt: 'asc' },
      }),
    }));
    const urls = new Map<string, string>();
    for (const d of docs) urls.set(d.id, (await this.documents.signedUrl(d)).url);
    for (const r of rows)
      out.set(r.id, {
        photoUrls: urls,
        receipts: receipts
          .filter((x) => x.payment?.allocations.some((a) => a.invoiceId === r.id))
          .map((x) => ({ id: x.id, number: x.number })),
      });
    return out;
  }

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
