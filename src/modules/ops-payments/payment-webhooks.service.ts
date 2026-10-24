import {
  type ParsedWebhook,
  type ProviderPayment,
  QR_PROVIDERS,
  type QrProvider,
} from '@collective/integrations/payments/qr';
import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { type MerchantAccount, MerchantResolver } from './merchants';
import { type ConfirmInput, PaymentsService } from './payments.service';

/** What a matched provider payment produced (webhook or settlement row). */
export type MatchOutcome =
  'created' | 'duplicate' | 'held_duplicate' | 'unknown_reference' | 'other_merchant' | 'not_paid';

/**
 * Provider callbacks (B4.4, D-042): `POST /webhooks/payments/{provider}` reads the body, finds the merchant by its
 * reference (lookup hash), verifies the signature with that merchant's secret, stores the callback once per provider
 * event id (`ops.payment_webhook`) and answers at once; the worker (`payment.webhook_received`) confirms each paid
 * reference — only when the QR of that reference was issued for **the same merchant account** (another tenant's
 * callback can never pay this tenant's invoice). Idempotent on the provider transaction reference.
 */
@Injectable()
export class PaymentWebhooksService implements EventSubscriber, OnModuleInit {
  readonly name = 'payment-webhooks';
  readonly eventTypes = ['payment.webhook_received'] as const;
  private readonly logger = new Logger(PaymentWebhooksService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly merchants: MerchantResolver,
    private readonly payments: PaymentsService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  isProvider(p: string): p is QrProvider {
    return (QR_PROVIDERS as readonly string[]).includes(p);
  }

  /** The HTTP part: parse, authenticate, store once, enqueue. */
  async receive(
    provider: string,
    headers: Record<string, string | undefined>,
    rawBody: Buffer | undefined,
  ): Promise<{ id: string; duplicate: boolean }> {
    if (!this.isProvider(provider)) throw new DomainException('http.not_found');
    if (!rawBody?.length) throw new DomainException('webhook.malformed');
    const adapter = this.merchants.adapter(provider);
    let parsed: ParsedWebhook;
    try {
      parsed = adapter.parseWebhook(headers, rawBody);
    } catch {
      throw new DomainException('webhook.malformed');
    }
    const outcome = await RequestContext.run({ actor: systemActor(`webhook:${provider}`) }, () =>
      this.db.platform(async (tx) => {
        const ma = parsed.merchantRef
          ? await this.merchants.byMerchantRef(tx, provider, parsed.merchantRef)
          : null;
        const valid = ma ? adapter.verifyWebhook(headers, rawBody, ma.merchant) : false;
        if (!ma || !valid)
          return {
            rejected: true as const,
            tenantId: ma?.account.tenantId ?? null,
            bankAccountId: ma?.account.id ?? null,
            detail: ma ? 'signature invalid' : 'unknown merchant',
          };
        const existing = await tx.paymentWebhook.findUnique({
          where: { provider_eventId: { provider, eventId: parsed.eventId } },
        });
        if (existing) return { rejected: false as const, id: existing.id, duplicate: true };
        const row = await tx.paymentWebhook.create({
          data: {
            provider,
            eventId: parsed.eventId,
            tenantId: ma.account.tenantId,
            bankAccountId: ma.account.id,
            signatureValid: true,
            // only what reconciling needs: references, amounts, provider ids (no account numbers)
            payload: {
              payments: parsed.payments.map((p) => ({
                providerRef: p.providerRef,
                reference: p.reference,
                amount: p.amount,
                paidAt: p.paidAt.toISOString(),
                status: p.status,
              })),
            },
          },
        });
        await this.events.record(tx, {
          type: 'payment.webhook_received',
          aggregateType: 'payment_webhook',
          aggregateId: row.id,
          tenantId: ma.account.tenantId,
          payload: { webhookId: row.id, provider, payments: parsed.payments.length },
        });
        return { rejected: false as const, id: row.id, duplicate: false };
      }),
    );
    if (outcome.rejected) {
      // the refusal is logged without the body (unauthenticated input), in its own transaction
      await RequestContext.run({ actor: systemActor(`webhook:${provider}`) }, () =>
        this.db.platform((tx) =>
          tx.paymentWebhook.upsert({
            where: { provider_eventId: { provider, eventId: `rejected:${parsed.eventId}` } },
            create: {
              provider,
              eventId: `rejected:${parsed.eventId}`,
              tenantId: outcome.tenantId,
              bankAccountId: outcome.bankAccountId,
              signatureValid: false,
              outcome: 'rejected',
              detail: outcome.detail,
              processedAt: this.clock.now(),
            },
            update: {},
          }),
        ),
      );
      throw new DomainException('webhook.signature_invalid');
    }
    return { id: outcome.id, duplicate: outcome.duplicate };
  }

  /** Worker: confirm the paid references of a stored callback. */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const hook = await tx.paymentWebhook.findUnique({ where: { id: event.payload.webhookId as string } });
    if (!hook || hook.outcome !== 'received' || !hook.bankAccountId || !this.isProvider(hook.provider))
      return;
    const ma = await this.merchants.byId(tx, hook.bankAccountId);
    const rows = ((hook.payload as { payments?: Record<string, string>[] }).payments ?? []).map(
      (p): ProviderPayment => ({
        providerRef: p.providerRef!,
        reference: p.reference!,
        amount: p.amount!,
        paidAt: new Date(p.paidAt!),
        status: (p.status as ProviderPayment['status']) ?? 'paid',
      }),
    );
    const outcomes: MatchOutcome[] = [];
    for (const r of rows) outcomes.push(await this.match(tx, hook.provider, ma, r, 'webhook'));
    await tx.paymentWebhook.update({
      where: { id: hook.id },
      data: {
        outcome: outcomes.some((o) => o === 'created' || o === 'duplicate' || o === 'held_duplicate')
          ? 'processed'
          : 'ignored',
        detail: outcomes.join(','),
        processedAt: this.clock.now(),
      },
    });
  }

  /** The hold of a provider payment that most likely repeats a transfer already booked (D-220), else undefined. */
  private async duplicateHold(
    tx: Tx,
    qr: { status: string },
    inv: { id: string; tenantId: string; billedPartyId: string; unitId: string | null },
    row: ProviderPayment,
  ): Promise<ConfirmInput['hold']> {
    if (qr.status === 'paid') {
      const earlier = await tx.payment.findFirst({
        where: {
          tenantId: inv.tenantId,
          status: 'confirmed',
          allocations: { some: { invoiceId: inv.id, reversedAt: null } },
        },
        orderBy: { paidAt: 'desc' },
        select: { id: true },
      });
      return { reason: 'qr_already_paid', duplicateOfPaymentId: earlier?.id ?? null };
    }
    const same = await this.payments.sameTransfer(
      tx,
      {
        tenantId: inv.tenantId,
        invoiceId: inv.id,
        payerPartyId: inv.billedPartyId,
        unitId: inv.unitId,
        amount: row.amount,
        paidAt: row.paidAt,
      },
      ['transfer_slip', 'bank_transfer_manual'],
    );
    return same ? { reason: 'possible_duplicate_transfer', duplicateOfPaymentId: same.id } : undefined;
  }

  /**
   * Matches one provider payment to the QR of its reference and confirms it (webhook or settlement file). The QR
   * must have been issued for this merchant account; a known provider reference is a duplicate.
   */
  async match(
    tx: Tx,
    provider: QrProvider,
    ma: MerchantAccount | null,
    row: ProviderPayment,
    via: 'webhook' | 'settlement_file',
  ): Promise<MatchOutcome> {
    if (row.status !== 'paid') return 'not_paid';
    const known = await tx.payment.findFirst({ where: { provider, providerRef: row.providerRef } });
    if (known) return 'duplicate';
    // references repeat across tenants (each has its own INV series): only a QR issued for this merchant account counts
    const qr = ma
      ? await tx.paymentQrCode.findFirst({
          where: { provider, reference: row.reference, bankAccountId: ma.account.id },
          orderBy: { createdAt: 'desc' },
          include: { invoice: true },
        })
      : null;
    if (!qr || !ma) {
      const elsewhere = await tx.paymentQrCode.count({ where: { provider, reference: row.reference } });
      if (!elsewhere) return 'unknown_reference';
      this.logger.warn(
        `${provider} ${row.providerRef}: reference ${row.reference} belongs to another merchant`,
      );
      return 'other_merchant';
    }
    const inv = qr.invoice;
    // D-220 (review #2): one bank transfer is booked once. A QR already paid, or a slip / hand-recorded transfer of
    // the same amount for the same payer × unit around the same time, means this is most likely the same money:
    // held for the owner (confirm or dismiss), never a second receipt or a phantom credit.
    await this.payments.lockPayer(tx, {
      payerPartyId: inv.billedPartyId,
      unitId: inv.unitId,
      invoiceId: inv.id,
    });
    const hold = await this.duplicateHold(tx, qr, inv, row);
    try {
      const r = await this.payments.confirm(tx, {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        unitId: inv.unitId,
        invoiceId: inv.id,
        payerPartyId: inv.billedPartyId,
        leaseId: inv.leaseId,
        amount: row.amount,
        method: 'qr',
        confirmedVia: via,
        paidAt: row.paidAt,
        provider,
        providerRef: row.providerRef,
        providerPayload: { reference: row.reference, amount: row.amount },
        bankAccountId: ma.account.id,
        qrCodeId: qr.id,
        hold,
      });
      if (via === 'settlement_file')
        await tx.payment.update({ where: { id: r.payment.id }, data: { reconciledAt: this.clock.now() } });
      return r.duplicate ? 'duplicate' : hold ? 'held_duplicate' : 'created';
    } catch (error) {
      if (PaymentsService.isDuplicate(error)) return 'duplicate';
      throw error;
    }
  }
}
