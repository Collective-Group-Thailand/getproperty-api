import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { BillingDocuments } from './billing-documents.service';

/**
 * Document generation is an event subscriber, never inline (CLAUDE.md): an issued invoice or note gets its A4 PDF
 * (`core.document`) in the worker; idempotent (the row's `document_id` is set once).
 */
@Injectable()
export class BillingDocumentsSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'billing-documents';
  readonly eventTypes = ['invoice.issued', 'credit_note.issued', 'debit_note.issued'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly documents: BillingDocuments,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'invoice.issued')
      await this.documents.generateInvoice(tx, event.payload.invoiceId as string);
    else
      await this.documents.generateNote(
        tx,
        event.type === 'credit_note.issued' ? 'credit' : 'debit',
        event.payload.noteId as string,
      );
  }
}
