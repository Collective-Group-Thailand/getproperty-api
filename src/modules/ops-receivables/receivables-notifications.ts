import { AppConfig } from '@config/app-config';
import { PlatformBrand } from '@core/brand/platform-brand.service';
import { billedParty, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { flexMessage, reminderBubble } from '@modules/ops-documents/flex';
import { formatThb } from '@modules/ops-leases/thai-text';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * The payment reminder (B4.5, D-045): the billed party gets the reminder Flex — balance, due date, days overdue and
 * the button to the payment page with the Thai QR for what is due (template `invoice.reminder`, version 2 Flex);
 * held through quiet hours by the notification service like every non-urgent resident message.
 */
@Injectable()
export class ReceivablesNotifications implements OnModuleInit {
  constructor(
    private readonly config: AppConfig,
    private readonly brand: PlatformBrand,
  ) {}

  onModuleInit(): void {
    registerNotifiable('invoice.reminder_sent', async (tx, e) => {
      const id = e.payload.invoiceId as string | undefined;
      if (!id || !e.tenantId) return null;
      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { unit: { select: { unitNo: true } } },
      });
      if (!inv?.number || !inv.dueDate) return null;
      const issuerName = await tenantName(tx, e.tenantId);
      const due = (e.payload.due as string | undefined) ?? inv.balance.toFixed(2);
      const daysOverdue = Number(e.payload.daysOverdue ?? 0);
      const item = {
        number: inv.number,
        unitNo: inv.unit?.unitNo ?? null,
        issuerName,
        balance: due,
        dueOn: inv.dueDate.toISOString().slice(0, 10),
        daysOverdue,
        link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/invoices/${inv.id}`,
      };
      const flex = flexMessage(
        `แจ้งเตือนการชำระเงิน ${inv.number} ยอด ${formatThb(due)} บาท เลยกำหนด ${daysOverdue} วัน`,
        [reminderBubble(item, await this.brand.flex())],
      );
      return {
        recipients: await billedParty(tx, inv.billedPartyId),
        templateKey: 'invoice.reminder',
        data: {
          tenant: { name: issuerName },
          invoice: { number: inv.number, balance: formatThb(due) },
          daysOverdue,
          flex: { altText: flex.altText, contents: flex.contents },
        },
        consentPurpose: 'resident.service',
      };
    });
  }
}
