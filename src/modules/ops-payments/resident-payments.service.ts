import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma } from '@generated/prisma/client';
import { ResidentInvoicesService } from '@modules/ops-billing/resident-invoices.service';
import { signedPdfs } from '@modules/ops-etax/etax-documents';
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
    private readonly keys: TenantDataKeys,
    private readonly audit: AuditService,
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
          select: {
            id: true,
            bankCode: true,
            bankNameTh: true,
            accountName: true,
            accountNoMasked: true,
            accountNoEnc: true,
          },
        });
        // LIFF #20 (D-209): the full receiving account for a plain transfer, only while something is due; audited
        let accountNo: string | null = null;
        if (account && due.gt(0)) {
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${inv.tenantId}, true)`;
          accountNo = await this.keys.decrypt(
            tx,
            {
              tenantId: inv.tenantId,
              table: 'platform.tenant_bank_account',
              column: 'account_no',
              rowId: account.id,
            },
            account.accountNoEnc,
          );
          await this.audit.record(tx, {
            action: 'pii.decrypted',
            tenantId: inv.tenantId,
            buildingId: inv.buildingId,
            subjectType: 'platform.tenant_bank_account',
            subjectId: account.id,
            metadata: { field: 'account_no', purpose: 'resident_transfer', invoiceId: inv.id },
          });
        }
        const now = this.clock.now();
        const scope = { tenantId: inv.tenantId };
        return {
          invoice: fresh,
          due: due.toFixed(2),
          qr,
          account: account
            ? {
                bankCode: account.bankCode,
                bankNameTh: account.bankNameTh,
                accountName: account.accountName,
                accountNoMasked: account.accountNoMasked,
                accountNo,
              }
            : null,
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

  /** LIFF #19: one of my receipts with the invoices its payment paid. */
  async receipt(receiptId: string) {
    const partyIds = await this.partyIds();
    return this.db.platform(async (tx) => {
      const r = await tx.receipt.findFirst({
        where: { id: receiptId, payerPartyId: { in: partyIds } },
        include: {
          tenant: { select: { displayName: true } },
          unit: { select: { unitNo: true } },
          payment: {
            select: {
              allocations: {
                select: { invoice: { select: { id: true, number: true } } },
                orderBy: { id: 'asc' },
              },
            },
          },
        },
      });
      if (!r) throw new DomainException('http.not_found');
      const invoices = new Map<string, string>();
      for (const a of r.payment?.allocations ?? [])
        if (a.invoice.number) invoices.set(a.invoice.id, a.invoice.number);
      return { receipt: r, invoices: [...invoices.entries()].map(([id, number]) => ({ id, number })) };
    });
  }

  /**
   * LIFF #17 (D-208): the slips I sent for an invoice, newest first, with the outcome — confirmed, waiting for the
   * office with the reasons, a duplicate, approved or rejected (D-043, D-198). 404 when the invoice is not mine.
   */
  async slips(invoiceId: string) {
    const inv = await this.invoices.get({ id: invoiceId });
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return this.db.platform((tx) =>
      tx.slipReview.findMany({
        where: { invoiceId: inv.id, uploadedBy: actor.publicId },
        orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
      }),
    );
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
      // e-Tax (B6.2, D-215): the provider-signed PDF once the receipt is signed
      const signed = (await signedPdfs(tx, 'receipt', [r.id])).get(r.id);
      const doc = signed ? await tx.document.findUnique({ where: { id: signed } }) : null;
      return { receipt: r, link: await this.documents.signedUrl(doc ?? r.document) };
    });
  }
}
