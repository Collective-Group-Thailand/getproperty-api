import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import {
  billedParty,
  type NotifiableResolver,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { formatThb } from '@modules/ops-leases/thai-text';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { type InvoiceSnapshot, invoiceView } from './document-views';
import { depositStatementBubble, flexMessage, invoiceAltText, invoiceBubble } from './flex';

/**
 * LINE Flex for billing messages (B4.3, D-011): the resolvers of `invoice.payment_ready` / `invoice.resent` (the billed
 * party gets the invoice bubble built from the issue snapshot) and `deposit.refunded` (the statement bubble)
 * replace the B1.3 text ones; the published `line_flex_json` template embeds `flex` (`{{json flex.contents}}`).
 */
@Injectable()
export class BillingNotifications implements OnModuleInit {
  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    const invoice: NotifiableResolver = async (tx, e) => {
      const id = e.payload.invoiceId as string | undefined;
      if (!id || !e.tenantId) return null;
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv?.snapshot || !inv.issuedAt) return null;
      const view = invoiceView(inv.snapshot as unknown as InvoiceSnapshot, {
        promptpayRef: inv.promptpayRef,
        link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/invoices/${inv.id}`,
      });
      const flex = flexMessage(invoiceAltText(view), [invoiceBubble(view)]);
      return {
        recipients: await billedParty(tx, inv.billedPartyId),
        templateKey: 'invoice.issued',
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          invoice: {
            ...e.payload,
            number: view.number,
            total: view.total,
            dueDate: view.dueOn,
            amountDue: view.amountDue,
          },
          unit: { unitNo: view.unitNo ?? '' },
          flex: { altText: flex.altText, contents: flex.contents },
        },
        consentPurpose: 'resident.service',
      };
    };
    // the invoice goes out once its credit and QR are settled (B4.4 `invoice.payment_ready`)
    registerNotifiable('invoice.payment_ready', invoice);
    registerNotifiable('invoice.resent', invoice);

    registerNotifiable('deposit.refunded', async (tx, e) => {
      const settlementId = e.payload.settlementId as string | undefined;
      if (!settlementId || !e.tenantId) return null;
      const st = await tx.depositSettlement.findUnique({
        where: { id: settlementId },
        include: { deposit: { include: { lease: { include: { unit: true } } } } },
      });
      if (!st) return null;
      const lease = st.deposit.lease;
      const issuerName = await tenantName(tx, e.tenantId);
      const bubble = depositStatementBubble({
        number: st.statementNumber,
        unitNo: lease.unit.unitNo,
        issuerName,
        depositHeld: st.depositHeld.toFixed(2),
        deductionsTotal: st.deductionsTotal.toFixed(2),
        utilitiesFinal: st.utilitiesFinal.toFixed(2),
        advanceRentUnused: st.advanceRentUnused.toFixed(2),
        refund: (st.refundAmount ?? st.agreedRefund ?? st.proposedRefund)?.toFixed(2) ?? '0.00',
        deadlineOn: bangkokDate(st.deadlineAt),
        link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/deposits/${st.depositId}`,
      });
      const refund = (st.refundAmount ?? st.agreedRefund ?? st.proposedRefund)?.toFixed(2) ?? '0.00';
      const flex = flexMessage(`คืนเงินประกันห้อง ${lease.unit.unitNo} ${formatThb(refund)} บาท`, [bubble]);
      return {
        recipients: await billedParty(tx, lease.lesseePartyId),
        data: {
          tenant: { name: issuerName },
          settlement: e.payload,
          flex: { altText: flex.altText, contents: flex.contents },
        },
        consentPurpose: 'resident.service',
      };
    });
  }
}
