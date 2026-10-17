import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PaymentsService } from './payments.service';

/**
 * `invoice.issued` → the payer's credit pays it first (D-044), then its Thai QR is created for what is still due
 * (D-042) — then `invoice.payment_ready`, which the document and LINE subscribers wait for so the PDF and the
 * Flex carry the QR. A provider failure never blocks the invoice: it goes out without a QR (savepoint + log) and
 * the resident's payment page creates one later.
 */
@Injectable()
export class PaymentReadySubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'payment-ready';
  readonly eventTypes = ['invoice.issued'] as const;
  private readonly logger = new Logger(PaymentReadySubscriber.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly payments: PaymentsService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const invoiceId = event.payload.invoiceId as string;
    let credited: string | null = null;
    let qr = false;
    await tx.$executeRawUnsafe('SAVEPOINT payment_ready');
    try {
      const offset = await this.payments.applyCredit(tx, invoiceId);
      credited = offset ? offset.amount.toFixed(2) : null;
      qr = (await this.payments.ensureQr(tx, invoiceId)) !== null;
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_ready');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT payment_ready');
      this.logger.error(`payment setup of invoice ${invoiceId} failed: ${(error as Error).message}`);
    }
    await this.events.record(tx, {
      type: 'invoice.payment_ready',
      aggregateType: 'invoice',
      aggregateId: invoiceId,
      tenantId: event.tenantId,
      buildingId: event.buildingId,
      payload: { ...event.payload, qr, creditApplied: credited },
    });
  }
}
