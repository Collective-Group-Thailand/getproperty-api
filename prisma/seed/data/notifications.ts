/**
 * Notification templates (B1.3): the LINE templates for residents (Handlebars text, version 1; B4.3 publishes
 * version 2 as LINE Flex for `invoice.issued` and `deposit.refunded`) and the operator templates of the notifiable
 * events (in-app + LINE, th + en). Later versions are made in the admin zone (never by re-seeding).
 */
export interface TemplateSeed {
  key: string;
  channel: 'line' | 'sms' | 'email' | 'in_app' | 'web_push';
  audience: 'resident' | 'owner' | 'technician';
  description: string;
  versions: {
    language: 'th' | 'en';
    subject: string | null;
    body: string;
    /** Default 1 / handlebars_text; B4.3 adds version 2 (LINE Flex) of the billing messages. */
    version?: number;
    format?: 'handlebars_text' | 'line_flex_json';
  }[];
}

/**
 * LIFF #28 (D-218): version 2 of a LINE text template — the same text with the app screen it opens (`link`).
 * Older versions stay as history (retired by the seed only when nothing newer was published since).
 */
const withLink = (th: string, en: string, link = '{{link}}'): TemplateSeed['versions'] => [
  { language: 'th', subject: null, body: `${th}\n${link}`, version: 2 },
  { language: 'en', subject: null, body: `${en}\n${link}`, version: 2 },
];

/** The LINE Flex body of the billing messages: the modules build `flex` (B4.3, `src/modules/ops-documents/flex.ts`). */
// (the space before the last brace keeps Handlebars from reading `}}}` as a triple-stash close)
const FLEX_BODY = '{"altText": {{json flex.altText}}, "contents": {{json flex.contents}} }';
const flexVersions = (): TemplateSeed['versions'] =>
  (['th', 'en'] as const).map((language) => ({
    language,
    subject: null,
    body: FLEX_BODY,
    version: 2,
    format: 'line_flex_json' as const,
  }));

/** Operator events of B1.3 (`src/core/notifications/notifiable-events.ts`): th/en text per channel. */
const OPERATOR_EVENTS: { key: string; description: string; th: [string, string]; en: [string, string] }[] = [
  {
    key: 'tenant.bank_account.changed',
    description: 'Owner: receiving bank account changed (D-091)',
    th: [
      'บัญชีรับเงินถูกเปลี่ยน',
      'บัญชีรับเงินของ {{tenant.name}} ถูกเปลี่ยนเป็นบัญชี {{account.masked}} แล้ว หากไม่ได้ทำรายการนี้ โปรดติดต่อทีมงานทันที',
    ],
    en: [
      'Receiving bank account changed',
      'The receiving bank account of {{tenant.name}} is now {{account.masked}}. If this was not you, contact us at once.',
    ],
  },
  {
    key: 'support_grant.requested',
    description: 'Owner: Collective support asks for temporary access (D-090)',
    th: [
      'ทีมซัพพอร์ตขอสิทธิ์เข้าถึงชั่วคราว',
      'ทีมซัพพอร์ตขอสิทธิ์เข้าถึงข้อมูลของ {{tenant.name}} ชั่วคราว เหตุผล: {{reason}} — อนุมัติหรือปฏิเสธได้ในหน้าตั้งค่า',
    ],
    en: [
      'Support asks for temporary access',
      'Support asks for temporary access to {{tenant.name}}. Reason: {{reason}} — approve or deny in settings.',
    ],
  },
  {
    key: 'workflow.sla_breached',
    description: 'Owner/Manager: a workflow passed its SLA (D-159)',
    th: [
      'งานเกินกำหนดเวลา',
      'งาน {{workflow.definitionKey}} ของ {{tenant.name}} เกินกำหนดเวลาแล้ว (สถานะ {{workflow.state}})',
    ],
    en: [
      'Task overdue',
      'A {{workflow.definitionKey}} task of {{tenant.name}} is past its due time (state {{workflow.state}}).',
    ],
  },
  {
    key: 'workflow.sla_reminder',
    description: 'Owner/Manager: a workflow is due soon, e.g. a deposit refund at T-3 / T-1 (D-023, D-159)',
    th: [
      'ใกล้ถึงกำหนดเวลา',
      'งาน {{workflow.definitionKey}} ของ {{tenant.name}} จะครบกำหนดในอีก {{workflow.daysLeft}} วัน (สถานะ {{workflow.state}})',
    ],
    en: [
      'Due soon',
      'A {{workflow.definitionKey}} task of {{tenant.name}} is due in {{workflow.daysLeft}} day(s) (state {{workflow.state}}).',
    ],
  },
  {
    key: 'dsr.received',
    description: 'Owner: a PDPA data subject request arrived (D-025)',
    th: [
      'มีคำขอใช้สิทธิ์ข้อมูลส่วนบุคคล',
      'มีคำขอ {{dsr.kind}} ตาม PDPA ถึง {{tenant.name}} ต้องดำเนินการภายใน {{dsr.dueAt}}',
    ],
    en: [
      'PDPA request received',
      'A PDPA {{dsr.kind}} request for {{tenant.name}} must be handled by {{dsr.dueAt}}.',
    ],
  },
  {
    key: 'meter.stale',
    description: 'Owner/Manager/Staff: a meter has not reported for longer than health.stale_after (D-034)',
    th: [
      'มิเตอร์ไม่ส่งข้อมูล',
      'มิเตอร์ {{meter.label}} ของ {{tenant.name}} ไม่ส่งข้อมูลตั้งแต่ {{meter.lastSeenAt}} — โปรดตรวจสอบเกตเวย์หรือจดเลขมิเตอร์เอง',
    ],
    en: [
      'Meter not reporting',
      'Meter {{meter.label}} of {{tenant.name}} has not reported since {{meter.lastSeenAt}} — check the gateway or read the meter manually.',
    ],
  },
  {
    key: 'meter.silent',
    description: 'Owner/Manager/Staff: a meter is silent; a service request is raised (D-034)',
    th: [
      'มิเตอร์เงียบ',
      'มิเตอร์ {{meter.label}} ของ {{tenant.name}} ไม่ส่งข้อมูลนานเกินกำหนด (ล่าสุด {{meter.lastSeenAt}}) ระบบเปิดงานซ่อมให้แล้ว',
    ],
    en: [
      'Meter silent',
      'Meter {{meter.label}} of {{tenant.name}} has been silent too long (last {{meter.lastSeenAt}}); a service request was raised.',
    ],
  },
  {
    key: 'device.offline',
    description: 'Owner/Manager/Staff: a gateway went offline (LWT or missed heartbeats, D-034)',
    th: [
      'เกตเวย์ออฟไลน์',
      'เกตเวย์ {{device.serial}} ของ {{tenant.name}} ออฟไลน์ตั้งแต่ {{device.since}} — มิเตอร์ที่ต่ออยู่จะไม่ส่งข้อมูลจนกว่าจะกลับมา',
    ],
    en: [
      'Gateway offline',
      'Gateway {{device.serial}} of {{tenant.name}} has been offline since {{device.since}}; its meters will not report until it is back.',
    ],
  },
  {
    key: 'billing_cycle.readings_requested',
    description:
      'Owner/Manager/Staff: readings missing at the cut-off — read the meters before the grace deadline (D-031)',
    th: [
      'ขอให้จดเลขมิเตอร์',
      'รอบบิล {{cycle.periodKey}} ของ {{property.name}} ยังขาดค่ามิเตอร์ {{cycle.missing}} รายการ — โปรดจดเลขมิเตอร์ก่อน {{cycle.graceDeadlineAt}}',
    ],
    en: [
      'Meter readings needed',
      'Billing cycle {{cycle.periodKey}} of {{property.name}} is missing {{cycle.missing}} reading(s) — please read the meters before {{cycle.graceDeadlineAt}}.',
    ],
  },
  {
    key: 'slip.review_requested',
    description:
      'Owner/Manager: a transfer slip could not be confirmed automatically and waits for review (D-043)',
    th: ['สลิปรอตรวจสอบ', 'มีสลิปโอนเงินรอตรวจสอบของ {{tenant.name}} ({{slip.reasons}})'],
    en: ['Slip to review', 'A transfer slip of {{tenant.name}} waits for your review ({{slip.reasons}}).'],
  },
  {
    key: 'payment.held',
    description:
      'Owner/Manager: a QR payment looks like a transfer already booked and waits for a decision (D-220)',
    th: [
      'ยอดชำระรอตรวจสอบ (อาจซ้ำ)',
      'มียอดชำระผ่าน QR {{payment.amount}} บาท ของ {{tenant.name}} ที่อาจเป็นการโอนเดียวกับที่บันทึกแล้ว — โปรดยืนยันหรือปฏิเสธในเมนูการชำระเงิน',
    ],
    en: [
      'Payment held (possible duplicate)',
      'A QR payment of {{payment.amount}} THB for {{tenant.name}} looks like a transfer already booked — confirm or dismiss it in Payments.',
    ],
  },
  {
    key: 'settlement_file.processed',
    description: 'Owner: the provider settlement shows payments that do not match (D-042)',
    th: [
      'ยอดชำระไม่ตรงกับรายการของผู้ให้บริการ',
      'ไฟล์สรุปยอดวันที่ {{settlement.statementDate}} ของ {{tenant.name}} มีรายการไม่ตรง {{settlement.discrepancies}} รายการ',
    ],
    en: [
      'Settlement discrepancies',
      'The settlement of {{settlement.statementDate}} for {{tenant.name}} has {{settlement.discrepancies}} item(s) that do not match.',
    ],
  },
  {
    key: 'billing_cycle.computed',
    description: 'Owner/Manager: the cycle drafts are computed and ready to review and issue (D-011)',
    th: [
      'ร่างใบแจ้งหนี้พร้อมตรวจ',
      'รอบบิล {{cycle.periodKey}} ของ {{property.name}}: ร่างใบแจ้งหนี้ {{cycle.drafts}} ใบ พร้อมตรวจและออก ({{cycle.needsReview}} ใบต้องตรวจสอบ)',
    ],
    en: [
      'Invoice drafts ready',
      'Billing cycle {{cycle.periodKey}} of {{property.name}}: {{cycle.drafts}} invoice draft(s) ready to review and issue ({{cycle.needsReview}} need review).',
    ],
  },
  {
    key: 'reading.requested',
    description: 'Staff: the owner asked for meter readings of a billing cycle (web F2, D-208)',
    th: [
      'มีคำขอให้จดเลขมิเตอร์',
      '{{tenant.name}} ขอให้จดเลขมิเตอร์ {{request.count}} จุด สำหรับรอบบิล {{request.periodKey}} — ดูรายการในรอบการจด',
    ],
    en: [
      'Meter readings requested',
      '{{tenant.name}} asks for {{request.count}} meter reading(s) for billing period {{request.periodKey}} — see the reading round.',
    ],
  },
  {
    key: 'service_request.created',
    description: 'Operators: a repair request was reported (resident, staff or automatic, D-072, D-034)',
    th: [
      'มีงานแจ้งซ่อมใหม่',
      '{{tenant.name}}: แจ้งซ่อม {{request.category}} ที่ {{request.unitNo}} — {{request.description}} (#{{request.ref}})',
    ],
    en: [
      'New repair request',
      '{{tenant.name}}: {{request.categoryEn}} at {{request.unitNo}} — {{request.description}} (#{{request.ref}})',
    ],
  },
  {
    key: 'work_order.assigned',
    description: 'Staff: a work order was assigned to me (D-072)',
    th: [
      'มีใบสั่งงานใหม่',
      '{{tenant.name}} มอบหมายงาน "{{workOrder.title}}" ที่ {{workOrder.place}} นัดหมาย {{workOrder.scheduledAt}} (#{{workOrder.ref}})',
    ],
    en: [
      'New work order',
      '{{tenant.name}} assigned you "{{workOrder.title}}" at {{workOrder.place}}, scheduled {{workOrder.scheduledAt}} (#{{workOrder.ref}})',
    ],
  },
  {
    key: 'foreign_stay.due',
    description: 'Owner/Manager: a foreign occupant moved in — TM30 due within 24 h (D-052, D-216)',
    th: [
      'ต้องแจ้ง ตม.30 ภายใน 24 ชั่วโมง',
      '{{tenant.name}}: {{tm30.name}} ห้อง {{tm30.unitNo}} เข้าพักแล้ว ต้องแจ้งที่พักคนต่างด้าว (ตม.30) ภายใน {{tm30.dueAt}} — สร้างไฟล์แจ้งได้ในเมนู ตม.30',
    ],
    en: [
      'TM30 due within 24 hours',
      '{{tenant.name}}: {{tm30.name}} moved into {{tm30.unitNo}} — notify Immigration (TM30) by {{tm30.dueAt}}; generate the upload file in TM30.',
    ],
  },
  {
    key: 'etax.rejected',
    description: 'Owner/Accountant: the e-Tax provider rejected a document or every retry failed (D-215)',
    th: [
      'ส่ง e-Tax ไม่สำเร็จ',
      '{{tenant.name}}: เอกสาร {{etax.number}} ส่งผู้ให้บริการ e-Tax ไม่สำเร็จ ({{etax.error}}) — แก้ไขข้อมูลแล้วกดส่งใหม่',
    ],
    en: [
      'e-Tax submission failed',
      '{{tenant.name}}: document {{etax.number}} was not accepted by the e-Tax provider ({{etax.error}}) — fix the data and send it again.',
    ],
  },
  {
    key: 'etax.monthly_summary',
    description: 'Owner/Accountant: the e-Tax figures of last month (D-215)',
    th: [
      'สรุป e-Tax ประจำเดือน',
      '{{tenant.name}}: e-Tax งวด {{summary.month}} ลงนามแล้ว {{summary.signed}} ฉบับ ภาษีมูลค่าเพิ่ม {{summary.vat}} บาท มีปัญหา {{summary.problems}} ฉบับ — ดาวน์โหลดทะเบียนได้ในเมนูส่งออกข้อมูล',
    ],
    en: [
      'Monthly e-Tax summary',
      '{{tenant.name}}: e-Tax {{summary.month}} — {{summary.signed}} documents signed, VAT {{summary.vat}} THB, {{summary.problems}} with problems; download the register in Exports.',
    ],
  },
];

/** Operator audiences per event: workflow → owner + manager; device/meter health → owner + manager + staff. */
const operatorAudiences = (key: string): string[] =>
  key.startsWith('workflow.') ||
  key === 'billing_cycle.computed' ||
  key === 'slip.review_requested' ||
  key === 'payment.held'
    ? ['owner', 'manager']
    : key.startsWith('meter.') ||
        key.startsWith('device.') ||
        key === 'billing_cycle.readings_requested' ||
        key === 'reading.requested' ||
        key === 'service_request.created' ||
        key === 'work_order.assigned'
      ? ['owner', 'manager', 'staff']
      : key === 'foreign_stay.due'
        ? ['owner', 'manager']
        : key.startsWith('etax.')
          ? ['owner', 'accountant']
          : ['owner'];

const operatorTemplates = (): TemplateSeed[] =>
  OPERATOR_EVENTS.flatMap((e) =>
    (['in_app', 'line'] as const).map((channel) => ({
      key: e.key,
      channel,
      audience: 'owner' as const,
      description: e.description,
      versions: [
        { language: 'th' as const, subject: e.th[0], body: e.th[1] },
        { language: 'en' as const, subject: e.en[0], body: e.en[1] },
      ],
    })),
  );

/**
 * Platform default routing matrix (event × audience × channel). Operator events go in-app and by LINE (urgent ones
 * ignore quiet hours); resident billing messages go by LINE. Tenants override resident routes (B1.3).
 */
export const NOTIFICATION_ROUTES: {
  eventType: string;
  audience: string;
  channel: string;
  urgent: boolean;
}[] = [
  ...OPERATOR_EVENTS.flatMap((e) =>
    operatorAudiences(e.key).flatMap((audience) =>
      (['in_app', 'line'] as const).map((channel) => ({
        eventType: e.key,
        audience,
        channel,
        urgent: e.key === 'tenant.bank_account.changed' || e.key === 'support_grant.requested',
      })),
    ),
  ),
  ...[
    'invoice.issued',
    'invoice.reminder',
    'receipt.issued',
    'deposit.settlement_proposed',
    'deposit.refunded',
    'service_request.changed',
    'service_request.message',
    'access.credential_issued',
    'access.credential_revoked',
    'announcement.published',
    'parcel.received',
    'building_rule.published',
    'etax.signed',
  ].map((eventType) => ({
    eventType,
    audience: 'resident',
    channel: 'line',
    urgent: false,
  })),
  { eventType: 'work_order.assigned', audience: 'technician', channel: 'line', urgent: false },
  { eventType: 'service_request.message', audience: 'technician', channel: 'line', urgent: false },
  { eventType: 'service_request.visit_confirmed', audience: 'technician', channel: 'line', urgent: false },
  { eventType: 'access.credential_issued', audience: 'technician', channel: 'line', urgent: false },
];

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
      ...flexVersions(),
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
      ...flexVersions(),
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
      ...flexVersions(),
    ],
  },
  {
    key: 'deposit.settlement_proposed',
    channel: 'line',
    audience: 'resident',
    description: 'Deposit settlement proposed: review, accept or dispute in the LIFF (D-023)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} เสนอการคืนเงินประกัน: หัก {{settlement.deductionsTotal}} บาท คืน {{settlement.proposedRefund}} บาท ภายใน {{settlement.deadlineOn}} — แตะเพื่อดูรายการและหลักฐาน แล้วยอมรับหรือโต้แย้ง',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} proposes your deposit settlement: {{settlement.deductionsTotal}} THB deducted, {{settlement.proposedRefund}} THB refunded by {{settlement.deadlineOn}} — tap to see the items and evidence, then accept or dispute.',
      },
    ],
  },
  {
    key: 'deposit.refunded',
    channel: 'line',
    audience: 'resident',
    description: 'Deposit refunded with the statement (D-023)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} คืนเงินประกัน {{settlement.refundAmount}} บาท แล้ว ใบแจ้งรายการ {{settlement.statementNumber}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} refunded {{settlement.refundAmount}} THB of your deposit — statement {{settlement.statementNumber}}.',
      },
      ...flexVersions(),
    ],
  },
  {
    key: 'service_request.changed',
    channel: 'line',
    audience: 'resident',
    description: 'Repair request status changed (D-072); the resident rates it once done',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'งานแจ้งซ่อม #{{request.ref}} ({{request.category}} ห้อง {{request.unitNo}}): {{request.statusTh}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Repair request #{{request.ref}} ({{request.categoryEn}}, unit {{request.unitNo}}): {{request.statusEn}}',
      },
      ...withLink(
        'งานแจ้งซ่อม #{{request.ref}} ({{request.category}} ห้อง {{request.unitNo}}): {{request.statusTh}}',
        'Repair request #{{request.ref}} ({{request.categoryEn}}, unit {{request.unitNo}}): {{request.statusEn}}',
      ),
    ],
  },
  {
    key: 'service_request.message',
    channel: 'line',
    audience: 'resident',
    description: 'A new message from the office or the technician in my repair request (LIFF #23, D-218)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ข้อความใหม่ในงานแจ้งซ่อม #{{request.ref}} จาก {{message.authorName}}: {{message.excerpt}}\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'New message on repair request #{{request.ref}} from {{message.authorName}}: {{message.excerpt}}\n{{link}}',
      },
    ],
  },
  {
    key: 'service_request.message',
    channel: 'line',
    audience: 'technician',
    description: 'Technician: a new message in the thread of my work order (LIFF #23, D-218)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ข้อความใหม่ในงาน #{{request.ref}} ห้อง {{request.unitNo}} จาก {{message.authorName}}: {{message.excerpt}}\n{{technicianLink}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'New message on job #{{request.ref}}, unit {{request.unitNo}}, from {{message.authorName}}: {{message.excerpt}}\n{{technicianLink}}',
      },
    ],
  },
  {
    key: 'service_request.visit_confirmed',
    channel: 'line',
    audience: 'technician',
    description: 'Technician: the resident confirmed the visit (LIFF #24, D-218)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ผู้แจ้งยืนยันนัดหมายงาน #{{request.ref}} ห้อง {{request.unitNo}} เวลา {{visit.scheduledAt}} แล้ว\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'The resident confirmed the visit for job #{{request.ref}}, unit {{request.unitNo}}, at {{visit.scheduledAt}}.\n{{link}}',
      },
    ],
  },
  {
    key: 'work_order.assigned',
    channel: 'line',
    audience: 'technician',
    description: 'Technician: a work order was assigned — open it in the technician app (D-072, D-154)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} มอบหมายงาน "{{workOrder.title}}" ที่ {{workOrder.place}} นัดหมาย {{workOrder.scheduledAt}} — เปิดในแอปช่าง (#{{workOrder.ref}})',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} assigned you "{{workOrder.title}}" at {{workOrder.place}}, scheduled {{workOrder.scheduledAt}} — open it in the technician app (#{{workOrder.ref}})',
      },
      ...withLink(
        '{{tenant.name}} มอบหมายงาน "{{workOrder.title}}" ที่ {{workOrder.place}} นัดหมาย {{workOrder.scheduledAt}} (#{{workOrder.ref}})',
        '{{tenant.name}} assigned you "{{workOrder.title}}" at {{workOrder.place}}, scheduled {{workOrder.scheduledAt}} (#{{workOrder.ref}})',
      ),
    ],
  },
  {
    key: 'announcement.published',
    channel: 'line',
    audience: 'resident',
    description: 'A new announcement of the building (D-073)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ประกาศจาก {{tenant.name}}: {{announcement.title}} — {{announcement.excerpt}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Announcement from {{tenant.name}}: {{announcement.title}} — open the app to read it.',
      },
      ...withLink(
        'ประกาศจาก {{tenant.name}}: {{announcement.title}} — {{announcement.excerpt}}',
        'Announcement from {{tenant.name}}: {{announcement.title}}',
      ),
    ],
  },
  {
    key: 'parcel.received',
    channel: 'line',
    audience: 'resident',
    description: 'A parcel arrived for my unit; pick it up with the PIN in the app (D-073)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}}: มีพัสดุ ({{parcel.carrier}}) มาถึงห้อง {{parcel.unitNo}} — แสดงรหัสรับพัสดุในแอปที่เคาน์เตอร์',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}}: a parcel ({{parcel.carrier}}) arrived for unit {{parcel.unitNo}} — show the pick-up PIN in the app at the desk.',
      },
      ...withLink(
        '{{tenant.name}}: มีพัสดุ ({{parcel.carrier}}) มาถึงห้อง {{parcel.unitNo}} — แสดงรหัสรับพัสดุในแอปที่เคาน์เตอร์',
        '{{tenant.name}}: a parcel ({{parcel.carrier}}) arrived for unit {{parcel.unitNo}} — show the pick-up PIN in the app at the desk.',
      ),
    ],
  },
  {
    key: 'building_rule.published',
    channel: 'line',
    audience: 'resident',
    description: 'New building rules to read and acknowledge (D-073)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ปรับปรุงระเบียบอาคาร "{{rule.title}}" (ฉบับที่ {{rule.version}} มีผล {{rule.effectiveFrom}}) — โปรดอ่านและกดรับทราบในแอป',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} updated the building rules "{{rule.title}}" (version {{rule.version}}, from {{rule.effectiveFrom}}) — please read and acknowledge them in the app.',
      },
    ],
  },
  {
    key: 'access.credential_issued',
    channel: 'line',
    audience: 'resident',
    description: 'Door code ready (D-070): the code is shown in the app, never in the message',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}}: รหัสเข้า {{lock.name}} {{lock.unitNo}} พร้อมใช้แล้ว — เปิดดูรหัสได้ในแอป',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}}: your code for {{lock.name}} {{lock.unitNo}} is ready — open the app to see it.',
      },
    ],
  },
  {
    key: 'access.credential_issued',
    channel: 'line',
    audience: 'technician',
    description: 'Technician: the time-boxed door code of a work order is ready (D-070)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}}: รหัสเข้า {{lock.name}} {{lock.unitNo}} สำหรับงานของคุณ ใช้ได้ถึง {{credential.validTo}} — ดูรหัสในแอปช่าง',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}}: the code for {{lock.name}} {{lock.unitNo}} for your job is valid until {{credential.validTo}} — see it in the technician app.',
      },
    ],
  },
  {
    key: 'access.credential_revoked',
    channel: 'line',
    audience: 'resident',
    description: 'An owner revoked a door code with a reason (D-071)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ยกเลิกรหัสเข้า {{lock.name}} {{lock.unitNo}} เหตุผล: {{credential.reason}} — ติดต่อผู้ดูแลอาคารหากมีข้อสงสัย',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} revoked your code for {{lock.name}} {{lock.unitNo}}. Reason: {{credential.reason}} — contact the building office with any question.',
      },
    ],
  },
  {
    key: 'etax.signed',
    channel: 'line',
    audience: 'resident',
    description: 'The e-Tax provider signed my receipt / tax invoice: the signed PDF (D-050, D-215)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}}: ใบเสร็จอิเล็กทรอนิกส์ (e-Receipt / e-Tax Invoice) เลขที่ {{document.number}} ลงลายมือชื่อดิจิทัลแล้ว — ดาวน์โหลดฉบับ PDF ได้ที่ {{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}}: your e-Receipt / e-Tax Invoice {{document.number}} is digitally signed — download the PDF at {{link}}',
      },
    ],
  },
  ...operatorTemplates(),
];
