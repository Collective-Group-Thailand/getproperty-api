import {
  billedParty,
  type NotifiableResolver,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { flexMessage, receiptBubble } from '@modules/ops-documents/flex';
import { formatThb } from '@modules/ops-leases/thai-text';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ReceiptsService } from './receipts.service';

/**
 * LINE / in-app messages of payments (B4.4): the payer gets the receipt Flex (D-044); the owner and managers are
 * told when a slip waits for review (D-043) and when a settlement file shows discrepancies (D-042).
 */
@Injectable()
export class PaymentNotifications implements OnModuleInit {
  constructor(private readonly receipts: ReceiptsService) {}

  onModuleInit(): void {
    const receipt =
      (kind: 'receipt' | 'receipt_tax_invoice'): NotifiableResolver =>
      async (tx, e) => {
        const id = e.payload.receiptId as string | undefined;
        const payer = e.payload.payerPartyId as string | undefined;
        if (!id || !payer || !e.tenantId) return null;
        const view = await this.receipts.viewOf(tx, kind, id);
        const flex = flexMessage(`${view.title} ${view.number} ยอด ${formatThb(view.total)} บาท`, [
          receiptBubble(view),
        ]);
        return {
          recipients: await billedParty(tx, payer),
          templateKey: 'receipt.issued',
          data: {
            tenant: { name: await tenantName(tx, e.tenantId) },
            receipt: { number: view.number },
            payment: { amount: formatThb(view.total) },
            flex: { altText: flex.altText, contents: flex.contents },
          },
          consentPurpose: 'resident.service',
        };
      };
    registerNotifiable('receipt.issued', receipt('receipt'));
    registerNotifiable('tax_invoice.issued', receipt('receipt_tax_invoice'));
    registerNotifiable('slip.review_requested', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              slip: { reasons: ((e.payload.reasons as string[] | undefined) ?? []).join(', ') },
            },
          }
        : null,
    );
    registerNotifiable('settlement_file.processed', async (tx, e) =>
      e.tenantId && Number(e.payload.discrepancies ?? 0) > 0
        ? {
            recipients: await operators(tx, e.tenantId, ['owner'], 'owner'),
            data: { tenant: { name: await tenantName(tx, e.tenantId) }, settlement: e.payload },
          }
        : null,
    );
  }
}
