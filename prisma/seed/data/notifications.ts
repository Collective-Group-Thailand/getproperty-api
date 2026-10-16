/**
 * Notification template skeletons (B1.3 builds the renderer): three LINE templates for residents, th + en,
 * version 1, published. Handlebars text; LINE Flex layouts replace them in B4.
 */
export interface TemplateSeed {
  key: string;
  channel: 'line' | 'sms' | 'email' | 'in_app' | 'web_push';
  audience: 'resident' | 'owner';
  description: string;
  versions: { language: 'th' | 'en'; subject: string | null; body: string }[];
}

export const NOTIFICATION_TEMPLATES: TemplateSeed[] = [
  {
    key: 'invoice.issued',
    channel: 'line',
    audience: 'resident',
    description: 'Invoice issued with Thai QR (D-011, D-022, D-042)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ใบแจ้งหนี้ {{invoice.number}} ห้อง {{unit.unitNo}} ยอด {{invoice.total}} บาท ครบกำหนด {{invoice.dueDate}} — แตะเพื่อดูรายละเอียดและชำระด้วย QR',
      },
      {
        language: 'en',
        subject: null,
        body: 'Invoice {{invoice.number}} for unit {{unit.unitNo}}: {{invoice.total}} THB due {{invoice.dueDate}} — tap to view and pay by QR.',
      },
    ],
  },
  {
    key: 'invoice.reminder',
    channel: 'line',
    audience: 'resident',
    description: 'Payment reminder after due date + grace (D-045)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'แจ้งเตือน: ใบแจ้งหนี้ {{invoice.number}} ยอดค้าง {{invoice.balance}} บาท เลยกำหนด {{daysOverdue}} วัน',
      },
      {
        language: 'en',
        subject: null,
        body: 'Reminder: invoice {{invoice.number}} has {{invoice.balance}} THB outstanding, {{daysOverdue}} days overdue.',
      },
    ],
  },
  {
    key: 'receipt.issued',
    channel: 'line',
    audience: 'resident',
    description: 'Receipt issued after payment (D-044)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ได้รับชำระ {{payment.amount}} บาท แล้ว ใบเสร็จ {{receipt.number}} ขอบคุณค่ะ',
      },
      {
        language: 'en',
        subject: null,
        body: 'Payment of {{payment.amount}} THB received — receipt {{receipt.number}}. Thank you.',
      },
    ],
  },
];
