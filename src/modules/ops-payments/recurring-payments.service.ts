import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { isUniqueViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type PaymentMandate,
  type PaymentMandateMethod,
  type PaymentMandateScope,
  type PaymentMandateState,
  type Prisma,
} from '@generated/prisma/client';
import {
  RECURRING_PAYMENTS,
  type RecurringEvent,
  type RecurringPaymentsPort,
  RecurringUnavailableError,
  RecurringWebhookError,
} from '@integrations/recurring-payments/recurring-payments.port';
import { residentUnitAccess } from '@modules/ops-juristic/resident-unit-access';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PaymentsService } from './payments.service';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const OPEN = ['issued', 'partially_paid', 'overdue'];

export const MANDATE_INCLUDE = {
  unit: { select: { id: true, unitNo: true } },
  party: { select: { id: true, displayName: true } },
} as const satisfies Prisma.PaymentMandateInclude;
export type MandateRow = Prisma.PaymentMandateGetPayload<{ include: typeof MANDATE_INCLUDE }>;

export type WebhookResult = { received: true; duplicate: boolean };

/**
 * The `recurring` payment channel (D-308 = D-J07, D-325, O-020): a billed resident authorises a direct debit or a
 * tokenised card for a unit (`ops.payment_mandate`, the provider keeps the token); once the provider confirms it on
 * the signed webhook it is `active`, and every **advance** invoice (quarterly / semiannual / annual cycle — or every
 * invoice with scope `all_invoices`) of that party × unit is charged once when it is issued (after the payer's
 * credit). `charge.succeeded` books a `recurring` payment through the allocation policy (receipt as usual); a replayed
 * callback is acknowledged as a duplicate and changes nothing. Fake provider until O-020.
 */
@Injectable()
export class RecurringPaymentsService
  extends TenantScopedRepository
  implements EventSubscriber, OnModuleInit
{
  readonly name = 'recurring-charge';
  readonly eventTypes = ['invoice.payment_ready'] as const;
  private readonly logger = new Logger(RecurringPaymentsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(RECURRING_PAYMENTS) private readonly port: RecurringPaymentsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  get mode(): 'fake' | 'off' {
    return this.port.mode;
  }

  // ------------------------------------------------------------------------------------------- resident

  private access(unitId: string) {
    return this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner', 'payer', 'tenant'], this.clock.now()),
    );
  }

  /** `POST /v1/resident/units/{unitId}/payment-mandates`: start an authorisation; the provider page finishes it. */
  async residentCreate(
    unitId: string,
    input: { method: PaymentMandateMethod; scope?: PaymentMandateScope | null },
  ): Promise<{ mandate: MandateRow; setupUrl: string }> {
    const access = await this.access(unitId);
    if (this.port.mode === 'off') throw new DomainException('recurring.unavailable');
    const partyId = access.partyIds[0]!;
    let setup;
    try {
      setup = await this.port.createMandate({ reference: `${unitId}:${partyId}`, method: input.method });
    } catch (error) {
      if (error instanceof RecurringUnavailableError) throw new DomainException('recurring.unavailable');
      throw error;
    }
    try {
      const id = await this.db.tenant(access.ctx, async (tx) => {
        const m = await tx.paymentMandate.create({
          data: {
            tenantId: access.tenantId,
            buildingId: access.buildingId,
            unitId,
            partyId,
            provider: this.port.provider,
            method: input.method,
            scope: input.scope ?? 'advance_invoices',
            mandateRef: setup.mandateRef,
            requestedBy: access.userId,
            createdBy: access.userId,
          },
        });
        await this.audit.record(tx, {
          action: 'payment_mandate.requested',
          tenantId: access.tenantId,
          buildingId: access.buildingId,
          subjectType: 'ops.payment_mandate',
          subjectId: m.id,
          metadata: { method: m.method, scope: m.scope, provider: m.provider },
        });
        await this.changed(tx, m, 'requested');
        return m.id;
      });
      const mandate = await this.db.tenant(access.ctx, (tx) =>
        tx.paymentMandate.findUniqueOrThrow({ where: { id }, include: MANDATE_INCLUDE }),
      );
      return { mandate, setupUrl: setup.setupUrl };
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.port.revokeMandate(setup.mandateRef).catch(() => undefined);
        throw new DomainException('payment_mandate.open_exists');
      }
      throw error;
    }
  }

  async residentList(unitId: string): Promise<MandateRow[]> {
    const access = await this.access(unitId);
    return this.db.tenant(access.ctx, (tx) =>
      tx.paymentMandate.findMany({
        where: { tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
        include: MANDATE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  /** The resident stops their mandate (pending or active): nothing more is charged. */
  async residentCancel(unitId: string, id: string): Promise<MandateRow> {
    const access = await this.access(unitId);
    await this.db.tenant(access.ctx, async (tx) => {
      const m = await tx.paymentMandate.findFirst({
        where: { id, tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
      });
      if (!m) throw new DomainException('http.not_found');
      await this.end(tx, m, 'revoked', 'cancelled by the resident');
    });
    return this.db.tenant(access.ctx, (tx) =>
      tx.paymentMandate.findUniqueOrThrow({ where: { id }, include: MANDATE_INCLUDE }),
    );
  }

  // ------------------------------------------------------------------------------------------- owner

  list(
    ctx: TenantContext,
    q: { state?: PaymentMandateState; unitId?: string; skip: number; take: number },
  ): Promise<{ rows: MandateRow[]; total: number }> {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.PaymentMandateWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.paymentMandate.findMany({
          where,
          include: MANDATE_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.paymentMandate.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async revoke(ctx: TenantContext, id: string, reason: string): Promise<MandateRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 500)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'reason', code: 'length', message: 'between 3 and 500 characters' }],
      });
    await this.db.tenant(ctx, async (tx) => {
      const m = this.found(await tx.paymentMandate.findFirst({ where: this.own(ctx, { id }) }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(m.buildingId))
        throw new DomainException('http.not_found');
      await this.end(tx, m, 'revoked', text);
    });
    return this.db.tenant(ctx, (tx) =>
      tx.paymentMandate.findUniqueOrThrow({ where: { id }, include: MANDATE_INCLUDE }),
    );
  }

  private async end(tx: Tx, m: PaymentMandate, to: 'revoked' | 'failed', reason: string): Promise<void> {
    const updated = await tx.paymentMandate.updateMany({
      where: { id: m.id, state: { in: ['pending', 'active'] } },
      data: {
        state: to,
        endedAt: this.clock.now(),
        endReason: reason.slice(0, 500),
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new DomainException('payment_mandate.invalid_state', { params: { state: m.state } });
    if (to === 'revoked') await this.port.revokeMandate(m.mandateRef).catch(() => undefined);
    await this.audit.record(tx, {
      action: 'payment_mandate.ended',
      tenantId: m.tenantId,
      buildingId: m.buildingId,
      subjectType: 'ops.payment_mandate',
      subjectId: m.id,
      metadata: { to, reason },
    });
    await this.changed(tx, { ...m, state: to }, to);
  }

  private changed(tx: Tx, m: PaymentMandate, change: string) {
    return this.events.record(tx, {
      type: 'payment_mandate.changed',
      aggregateType: 'payment_mandate',
      aggregateId: m.id,
      tenantId: m.tenantId,
      buildingId: m.buildingId,
      payload: { mandateId: m.id, unitId: m.unitId, partyId: m.partyId, change, state: m.state },
    });
  }

  // ------------------------------------------------------------------------------------------- charge on issue

  /** `invoice.payment_ready` (after the payer's credit): charge an advance invoice once through an active mandate. */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const invoiceId = event.payload.invoiceId as string;
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { billingCycle: { select: { frequency: true } } },
    });
    if (!inv?.unitId || !inv.issuedAt || !OPEN.includes(inv.status) || D(inv.balance).lte(0)) return;
    const mandate = await tx.paymentMandate.findFirst({
      where: { tenantId: inv.tenantId, unitId: inv.unitId, partyId: inv.billedPartyId, state: 'active' },
    });
    if (!mandate) return;
    const advance = Boolean(inv.billingCycle && inv.billingCycle.frequency !== 'monthly');
    if (mandate.scope === 'advance_invoices' && !advance) return;
    if (
      await tx.recurringCharge.findFirst({
        where: { mandateId: mandate.id, invoiceId, state: { not: 'failed' } },
      })
    )
      return;
    const charge = await tx.recurringCharge.create({
      data: {
        tenantId: inv.tenantId,
        mandateId: mandate.id,
        invoiceId,
        amount: D(inv.balance).toFixed(2),
        provider: mandate.provider,
      },
    });
    let state: 'pending' | 'failed' = 'pending';
    let chargeRef: string | null = null;
    let failure: string | null = null;
    try {
      // UNVERIFIED against a live provider (O-020): a real adapter calls out before this transaction (prepare step)
      const accepted = await this.port.charge({
        mandateRef: mandate.mandateRef,
        amount: charge.amount.toFixed(2),
        reference: inv.number ?? inv.id,
        idempotencyKey: charge.id,
      });
      chargeRef = accepted.chargeRef;
      if (accepted.state === 'failed') state = 'failed';
    } catch (error) {
      state = 'failed';
      failure = (error as Error).message.slice(0, 500);
      this.logger.warn(`recurring charge of invoice ${invoiceId} failed: ${failure}`);
    }
    await tx.recurringCharge.update({
      where: { id: charge.id },
      data: {
        chargeRef,
        state,
        failureReason: failure,
        settledAt: state === 'failed' ? this.clock.now() : null,
      },
    });
    await this.audit.record(tx, {
      action: 'recurring_charge.requested',
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      subjectType: 'ops.recurring_charge',
      subjectId: charge.id,
      metadata: { invoiceId, amount: charge.amount.toFixed(2), state, chargeRef },
    });
    await this.events.record(tx, {
      type: 'recurring_charge.changed',
      aggregateType: 'recurring_charge',
      aggregateId: charge.id,
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      payload: {
        chargeId: charge.id,
        invoiceId,
        mandateId: mandate.id,
        state,
        amount: charge.amount.toFixed(2),
      },
    });
  }

  // ------------------------------------------------------------------------------------------- webhook

  /** `POST /webhooks/recurring/{provider}`: authenticate, store once per event id, apply. */
  async receive(
    provider: string,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<WebhookResult> {
    if (this.port.mode === 'off' || provider !== this.port.provider)
      throw new DomainException('http.not_found');
    if (!rawBody?.length) throw new DomainException('webhook.malformed');
    let event: RecurringEvent;
    try {
      event = this.port.parseWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof RecurringWebhookError && error.kind === 'malformed')
        throw new DomainException('webhook.malformed');
      throw new DomainException('webhook.signature_invalid');
    }
    return this.apply(provider, event);
  }

  /** Applies one authenticated provider event (also the fake provider's page). Idempotent per (provider, event id). */
  async apply(provider: string, event: RecurringEvent): Promise<WebhookResult> {
    return RequestContext.run({ actor: systemActor(`webhook:recurring:${provider}`) }, async () => {
      try {
        return await this.db.platform(async (tx) => {
          const known = await tx.recurringWebhook.findUnique({
            where: { provider_eventId: { provider, eventId: event.eventId } },
          });
          if (known) return { received: true as const, duplicate: true };
          const mandate = await tx.paymentMandate.findUnique({
            where: { provider_mandateRef: { provider, mandateRef: event.mandateRef } },
          });
          const hook = await tx.recurringWebhook.create({
            data: {
              provider,
              eventId: event.eventId,
              eventType: event.type,
              tenantId: mandate?.tenantId ?? null,
              signatureValid: true,
              // references and amounts only (no account / card numbers)
              payload: {
                mandateRef: event.mandateRef,
                chargeRef: event.chargeRef,
                amount: event.amount,
                occurredAt: event.occurredAt.toISOString(),
              },
            },
          });
          const { outcome, detail } = mandate
            ? await this.applyEvent(tx, mandate, event)
            : { outcome: 'ignored' as const, detail: 'unknown mandate' };
          await tx.recurringWebhook.update({
            where: { id: hook.id },
            data: { outcome, detail, processedAt: this.clock.now() },
          });
          return { received: true as const, duplicate: false };
        });
      } catch (error) {
        // a concurrent delivery of the same event stored it first
        if (isUniqueViolation(error)) return { received: true as const, duplicate: true };
        throw error;
      }
    });
  }

  private async applyEvent(
    tx: Tx,
    mandate: PaymentMandate,
    event: RecurringEvent,
  ): Promise<{ outcome: 'processed' | 'ignored'; detail: string | null }> {
    const now = this.clock.now();
    switch (event.type) {
      case 'mandate.activated': {
        const r = await tx.paymentMandate.updateMany({
          where: { id: mandate.id, state: 'pending' },
          data: { state: 'active', activatedAt: now, masked: event.masked, version: { increment: 1 } },
        });
        if (!r.count) return { outcome: 'ignored', detail: `mandate ${mandate.state}` };
        await this.audit.record(tx, {
          action: 'payment_mandate.activated',
          tenantId: mandate.tenantId,
          buildingId: mandate.buildingId,
          subjectType: 'ops.payment_mandate',
          subjectId: mandate.id,
          metadata: { masked: event.masked },
        });
        await this.changed(tx, { ...mandate, state: 'active' }, 'activated');
        return { outcome: 'processed', detail: null };
      }
      case 'mandate.failed':
      case 'mandate.revoked': {
        const to = event.type === 'mandate.failed' ? 'failed' : 'revoked';
        const r = await tx.paymentMandate.updateMany({
          where: { id: mandate.id, state: { in: ['pending', 'active'] } },
          data: {
            state: to,
            endedAt: now,
            endReason: event.reason ?? `provider: ${event.type}`,
            version: { increment: 1 },
          },
        });
        if (!r.count) return { outcome: 'ignored', detail: `mandate ${mandate.state}` };
        await this.audit.record(tx, {
          action: 'payment_mandate.ended',
          tenantId: mandate.tenantId,
          buildingId: mandate.buildingId,
          subjectType: 'ops.payment_mandate',
          subjectId: mandate.id,
          metadata: { to, reason: event.reason },
        });
        await this.changed(tx, { ...mandate, state: to }, to);
        return { outcome: 'processed', detail: null };
      }
      case 'charge.succeeded':
      case 'charge.failed': {
        const charge = await tx.recurringCharge.findFirst({
          where: { provider: mandate.provider, chargeRef: event.chargeRef!, mandateId: mandate.id },
          include: { invoice: true },
        });
        if (!charge) return { outcome: 'ignored', detail: 'unknown charge' };
        await tx.$queryRaw`SELECT id FROM ops.recurring_charge WHERE id = ${charge.id}::uuid FOR UPDATE`;
        const fresh = await tx.recurringCharge.findUniqueOrThrow({ where: { id: charge.id } });
        if (fresh.state !== 'pending') return { outcome: 'ignored', detail: `charge ${fresh.state}` };
        if (event.type === 'charge.failed') {
          await tx.recurringCharge.update({
            where: { id: charge.id },
            data: { state: 'failed', failureReason: event.reason ?? 'declined', settledAt: now },
          });
        } else {
          const amount = event.amount ?? charge.amount.toFixed(2);
          const { payment } = await this.payments.confirm(tx, {
            tenantId: charge.tenantId,
            buildingId: charge.invoice.buildingId,
            unitId: charge.invoice.unitId,
            invoiceId: charge.invoiceId,
            payerPartyId: mandate.partyId,
            leaseId: charge.invoice.leaseId,
            amount,
            method: 'recurring',
            confirmedVia: 'webhook',
            paidAt: event.occurredAt,
            notes: `recurring ${event.chargeRef}`,
          });
          await tx.recurringCharge.update({
            where: { id: charge.id },
            data: { state: 'succeeded', paymentId: payment.id, settledAt: now },
          });
        }
        await this.audit.record(tx, {
          action: 'recurring_charge.settled',
          tenantId: charge.tenantId,
          buildingId: charge.invoice.buildingId,
          subjectType: 'ops.recurring_charge',
          subjectId: charge.id,
          metadata: { outcome: event.type, amount: event.amount, reason: event.reason },
        });
        await this.events.record(tx, {
          type: 'recurring_charge.changed',
          aggregateType: 'recurring_charge',
          aggregateId: charge.id,
          tenantId: charge.tenantId,
          buildingId: charge.invoice.buildingId,
          payload: {
            chargeId: charge.id,
            invoiceId: charge.invoiceId,
            mandateId: mandate.id,
            state: event.type === 'charge.succeeded' ? 'succeeded' : 'failed',
          },
        });
        return { outcome: 'processed', detail: null };
      }
      default:
        return { outcome: 'ignored', detail: 'unknown event' };
    }
  }
}
