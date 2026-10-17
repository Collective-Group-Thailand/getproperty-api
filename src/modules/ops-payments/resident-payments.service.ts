import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma } from '@generated/prisma/client';
import { ResidentInvoicesService } from '@modules/ops-billing/resident-invoices.service';
import { Inject, Injectable } from '@nestjs/common';

import { PaymentsService } from './payments.service';

/**
 * The resident's side of paying (B4.4, D-042, D-043, D-063): the invoice's Thai QR for what is due now (created on
 * demand when the issue-time one is missing, expired or for another amount), the landlord's receiving account for a
 * plain transfer, whether slips and partial payments are accepted; my receipts and their PDFs.
 */
@Injectable()
export class ResidentPaymentsService {
  constructor(
    private readonly db: TenantTx,
    private readonly invoices: ResidentInvoicesService,
    private readonly payments: PaymentsService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async payment(invoiceId: string) {
    const inv = await this.invoices.get({ id: invoiceId });
    return this.db.platform(
      async (tx) => {
        const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: inv.id } });
        const due = await this.payments.dueFor(tx, fresh);
        const qr = due.gt(0) ? await this.payments.ensureQr(tx, inv.id) : null;
        const account = await tx.tenantBankAccount.findFirst({
          where: { tenantId: inv.tenantId, state: 'active', isDefault: true },
          select: { bankCode: true, bankNameTh: true, accountName: true, accountNoMasked: true },
        });
        const now = this.clock.now();
        const scope = { tenantId: inv.tenantId };
        return {
          invoice: fresh,
          due: due.toFixed(2),
          qr,
          account,
          allowSlip: (await this.settings.valueAt<boolean>('payments.allow_slip', now, scope)) === true,
          allowPartial: (await this.settings.valueAt<boolean>('payments.allow_partial', now, scope)) === true,
        };
      },
      { timeout: 30_000 },
    );
  }

  private async partyIds(): Promise<string[]> {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    const links = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({
        where: { userId: actor.publicId, state: 'active' },
        select: { partyId: true },
      }),
    );
    return links.map((l) => l.partyId);
  }

  async receipts(q: { skip: number; take: number }) {
    const partyIds = await this.partyIds();
    const where: Prisma.ReceiptWhereInput = { payerPartyId: { in: partyIds } };
    return this.db.platform(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.receipt.findMany({
          where,
          include: { tenant: { select: { displayName: true } }, unit: { select: { unitNo: true } } },
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.receipt.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async receiptDocument(receiptId: string) {
    const partyIds = await this.partyIds();
    return this.db.platform(async (tx) => {
      const r = await tx.receipt.findFirst({
        where: { id: receiptId, payerPartyId: { in: partyIds } },
        include: { document: true },
      });
      if (!r) throw new DomainException('http.not_found');
      if (!r.document) throw new DomainException('export.not_ready');
      return { receipt: r, link: await this.documents.signedUrl(r.document) };
    });
  }
}
