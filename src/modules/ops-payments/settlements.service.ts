import { type ProviderPayment } from '@collective/integrations/payments/qr';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { type MerchantAccount, MerchantResolver } from './merchants';
import { PaymentWebhooksService } from './payment-webhooks.service';

const by = () => userIdOf(RequestContext.actor());
const day = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Settlement / statement reconciliation (B4.4, D-042): every provider row is matched by its provider reference —
 * known → matched (amount compared), unknown but the QR reference is ours → the payment is created (a callback was
 * missed), otherwise a discrepancy for the owner. Daily for each provider account (worker job `payment-settlement`,
 * yesterday's statement), or from a file the owner uploads. One file per provider × account × statement date.
 */
@Injectable()
export class SettlementsService extends TenantScopedRepository {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly merchants: MerchantResolver,
    private readonly webhooks: PaymentWebhooksService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async reconcile(
    tx: Tx,
    ma: MerchantAccount,
    statementDate: string,
    rows: ProviderPayment[],
    fileDocumentId: string | null,
  ) {
    const existing = await tx.paymentSettlementFile.findFirst({
      where: {
        provider: ma.merchant.provider,
        bankAccountId: ma.account.id,
        statementDate: day(statementDate),
      },
    });
    if (existing) throw new DomainException('settlement.duplicate');
    let matched = 0;
    let created = 0;
    const discrepancies: Record<string, string>[] = [];
    for (const r of rows) {
      const known = await tx.payment.findFirst({
        where: { provider: ma.merchant.provider, providerRef: r.providerRef },
      });
      if (known) {
        matched += 1;
        if (!known.amount.equals(r.amount))
          discrepancies.push({
            providerRef: r.providerRef,
            reason: 'amount_differs',
            recorded: known.amount.toFixed(2),
            file: r.amount,
          });
        if (!known.reconciledAt)
          await tx.payment.update({ where: { id: known.id }, data: { reconciledAt: this.clock.now() } });
        continue;
      }
      const outcome = await this.webhooks.match(tx, ma.merchant.provider, ma, r, 'settlement_file');
      if (outcome === 'created') created += 1;
      else if (outcome !== 'duplicate')
        discrepancies.push({
          providerRef: r.providerRef,
          reference: r.reference,
          amount: r.amount,
          reason: outcome,
        });
    }
    const file = await tx.paymentSettlementFile.create({
      data: {
        tenantId: ma.account.tenantId,
        provider: ma.merchant.provider,
        bankAccountId: ma.account.id,
        statementDate: day(statementDate),
        fileDocumentId,
        rowsTotal: rows.length,
        rowsMatched: matched,
        rowsCreated: created,
        rowsUnmatched: discrepancies.filter((d) => d.reason !== 'amount_differs').length,
        discrepancies: discrepancies,
        processedAt: this.clock.now(),
        status: 'processed',
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'settlement_file.processed',
      tenantId: ma.account.tenantId,
      subjectType: 'ops.payment_settlement_file',
      subjectId: file.id,
      metadata: { statementDate, rows: rows.length, matched, created, discrepancies: discrepancies.length },
    });
    await this.events.record(tx, {
      type: 'settlement_file.processed',
      aggregateType: 'payment_settlement_file',
      aggregateId: file.id,
      tenantId: ma.account.tenantId,
      payload: {
        fileId: file.id,
        statementDate,
        rows: rows.length,
        matched,
        created,
        discrepancies: discrepancies.length,
      },
    });
    return file;
  }

  /** `POST /v1/owner/payment-settlements`: a statement file the owner downloaded from the provider. */
  async upload(
    ctx: TenantContext,
    input: { bankAccountId: string; statementDate: string; documentId: string },
  ) {
    return this.db.tenant(
      ctx,
      async (tx) => {
        const account = this.found(
          await tx.tenantBankAccount.findFirst({ where: this.own(ctx, { id: input.bankAccountId }) }),
        );
        const ma = await this.merchants.byId(tx, account.id);
        if (!ma) throw new DomainException('payment.unavailable');
        const doc = this.found(
          await tx.document.findFirst({
            where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
          }),
        );
        let rows: ProviderPayment[];
        try {
          rows = ma.adapter.parseSettlementFile(await this.documents.bytesOf(doc));
        } catch {
          throw new DomainException('settlement.unreadable');
        }
        return this.reconcile(tx, ma, input.statementDate, rows, doc.id);
      },
      { timeout: 60_000 },
    );
  }

  list(ctx: TenantContext, q: { skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId };
      const [rows, total] = await Promise.all([
        tx.paymentSettlementFile.findMany({
          where,
          orderBy: [{ statementDate: 'desc' }, { createdAt: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.paymentSettlementFile.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** Worker job `payment-settlement`: yesterday's statement of every provider account (fetched from the provider). */
  async daily(): Promise<number> {
    const yesterday = bangkokDate(new Date(this.clock.now().getTime() - 86_400_000));
    return RequestContext.run({ actor: systemActor('payment-settlement') }, async () => {
      const accounts = await this.db.platform((tx) =>
        tx.tenantBankAccount.findMany({
          where: { state: 'active', paymentProvider: { not: 'none' }, providerMerchantRefEnc: { not: null } },
          select: { id: true, tenantId: true },
        }),
      );
      let done = 0;
      for (const a of accounts) {
        try {
          await this.db.tenant(
            systemTenantContext(a.tenantId),
            async (tx) => {
              const ma = await this.merchants.byId(tx, a.id);
              if (!ma) return;
              const known = await tx.paymentSettlementFile.findFirst({
                where: { provider: ma.merchant.provider, bankAccountId: a.id, statementDate: day(yesterday) },
              });
              if (known) return;
              const rows = await ma.adapter.fetchSettlement(ma.merchant, yesterday);
              await this.reconcile(tx, ma, yesterday, rows, null);
              done += 1;
            },
            { timeout: 120_000 },
          );
        } catch (error) {
          this.logger.error(`settlement of account ${a.id}: ${(error as Error).message}`);
        }
      }
      return done;
    });
  }
}
