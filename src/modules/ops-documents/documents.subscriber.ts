import { type UploadedGenerated } from '@core/documents/documents.service';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { BillingDocuments } from './billing-documents.service';

/**
 * Document generation is an event subscriber, never inline (CLAUDE.md): an issued invoice (once its QR exists —
 * `invoice.payment_ready`, B4.4) or note gets its A4 PDF (`core.document`) in the worker; idempotent (the row's
 * `document_id` is set once).
 */
@Injectable()
export class BillingDocumentsSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'billing-documents';
  readonly eventTypes = ['invoice.payment_ready', 'credit_note.issued', 'debit_note.issued'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly documents: BillingDocuments,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Review #10: render (headless Chromium) and upload before the transaction; `handle` only records the row. */
  prepare(event: DomainEventEnvelope): Promise<UploadedGenerated | null> {
    return event.type === 'invoice.payment_ready'
      ? this.documents.prepareInvoice(event.payload.invoiceId as string)
      : this.documents.prepareNote(
          event.type === 'credit_note.issued' ? 'credit' : 'debit',
          event.payload.noteId as string,
        );
  }

  async handle(event: DomainEventEnvelope, tx: Tx, prepared?: unknown): Promise<void> {
    const uploaded = (prepared as UploadedGenerated | null | undefined) ?? null;
    if (event.type === 'invoice.payment_ready')
      await this.documents.generateInvoice(tx, event.payload.invoiceId as string, uploaded);
    else
      await this.documents.generateNote(
        tx,
        event.type === 'credit_note.issued' ? 'credit' : 'debit',
        event.payload.noteId as string,
        uploaded,
      );
  }
}
