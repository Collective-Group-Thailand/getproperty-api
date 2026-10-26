/**
 * Notification templates (B1.3): the LINE templates for residents (Handlebars text, version 1; B4.3 publishes
 * version 2 as LINE Flex for `invoice.issued` and `deposit.refunded`) and the operator templates of the notifiable
 * events (in-app + LINE, th + en). Later versions are made in the admin zone (never by re-seeding).
 */
export interface TemplateSeed {
  key: string;
  channel: 'line' | 'sms' | 'email' | 'in_app' | 'web_push';
  audience: 'resident' | 'owner' | 'technician' | 'prospect';
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
    key: 'storage.threshold_crossed',
    description: 'Owner: storage usage reached a notice threshold of the allowance (D-276: 80 % / 100 %)',
    th: [
      'พื้นที่จัดเก็บใช้ไปแล้ว {{storage.usedPercent}}%',
      'บัญชี {{tenant.name}} ใช้พื้นที่จัดเก็บไปแล้ว {{storage.used}} จาก {{storage.allowance}} ({{storage.usedPercent}}%) ข้อมูลทั้งหมดยังอยู่ครบและเอกสารที่กฎหมายกำหนดยังออกได้ตามปกติ ดูรายละเอียดหรือเพิ่มพื้นที่ได้ในหน้าตั้งค่า',
    ],
    en: [
      'Storage {{storage.usedPercent}}% used',
      '{{tenant.name}} has used {{storage.used}} of its {{storage.allowance}} storage ({{storage.usedPercent}}%). All your data stays, and documents the law requires are always produced. See details or add space in Settings.',
    ],
  },
  {
    key: 'inspection.countersigned',
    description: 'Owner: the resident countersigned the move-in / move-out report in LINE (L5 5.2, D-253)',
    th: [
      'ผู้เช่าลงนามบันทึกตรวจสภาพห้องแล้ว',
      'ผู้เช่าห้อง {{inspection.unitNo}} ลงนามบันทึกการตรวจสภาพห้องเลขที่ {{inspection.number}} ผ่าน LINE แล้ว',
    ],
    en: [
      'The resident signed the inspection report',
      'The resident of unit {{inspection.unitNo}} signed inspection report {{inspection.number}} in LINE.',
    ],
  },
  {
    key: 'messaging.allowance_threshold',
    description: 'Owner: the shared LINE OA reached 80 % / 100 % of the free messages this month (D-254)',
    th: [
      'ข้อความ LINE ใช้ไปแล้ว {{messaging.usedPercent}}% ของโควตาฟรี',
      'เดือนนี้ {{tenant.name}} ส่งข้อความผ่าน LINE ของ getproperty ไปแล้ว {{messaging.counted}} จาก {{messaging.allowance}} ข้อความฟรี ข้อความหลังจากนี้คิดค่าบริการตามอัตราที่ประกาศ ดูรายละเอียดหรือเชื่อม LINE OA ของตัวเองได้ในหน้าตั้งค่า',
    ],
    en: [
      'LINE messages: {{messaging.usedPercent}}% of the free messages used',
      'This month {{tenant.name}} has sent {{messaging.counted}} of {{messaging.allowance}} free messages through getproperty’s LINE. Further messages are charged at the published rate. See details, or connect your own LINE OA, in Settings.',
    ],
  },
  {
    key: 'messaging.quota_fallback',
    description: 'Owner: LINE refused a message for quota and it went by SMS (D-254)',
    th: [
      'LINE ส่งข้อความไม่ได้เพราะเกินโควตา',
      'LINE ปฏิเสธข้อความของ {{tenant.name}} เพราะเกินโควตาของ{{messaging.oaLabelTh}} ข้อความที่สำคัญจะส่งทาง SMS แทนเมื่อมีเบอร์โทร ตรวจสอบแพ็กเกจ LINE OA หรือดูรายละเอียดในหน้าตั้งค่า',
    ],
    en: [
      'LINE refused messages: quota reached',
      'LINE refused a message of {{tenant.name}} because {{messaging.oaLabelEn}} reached its quota. Messages go by SMS instead where a phone number is known. Check the LINE OA plan, or see details in Settings.',
    ],
  },
  {
    key: 'messaging.channel_failing',
    description: 'Owner: the own LINE OA no longer accepts the access token (D-254)',
    th: [
      'LINE OA ของคุณเชื่อมต่อไม่ได้',
      'LINE ไม่รับ access token ของ {{channel.name}} แล้ว ({{channel.reason}}) ระหว่างนี้ข้อความจะส่งผ่าน LINE ของ getproperty แก้ไขได้ในหน้าตั้งค่า › LINE OA',
    ],
    en: [
      'Your LINE OA is not connecting',
      'LINE no longer accepts the access token of {{channel.name}} ({{channel.reason}}). Meanwhile messages go through getproperty’s LINE. Fix it in Settings › LINE OA.',
    ],
  },
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
    key: 'party.link_requested',
    description:
      'Owner: someone signed in with the SMS code sent to a party’s phone and waits to be linked to it (D-226)',
    th: [
      'มีผู้ขอเชื่อมบัญชีกับผู้เช่า',
      'มีผู้เข้าสู่ระบบด้วยเบอร์โทรของ {{party.name}} ({{tenant.name}}) — โปรดตรวจสอบตัวตนก่อนยืนยันในเมนูบุคคล',
    ],
    en: [
      'Login waiting to be linked',
      'Someone signed in with the phone number of {{party.name}} ({{tenant.name}}) — check who it is before confirming in Parties.',
    ],
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
  // --- listings and enquiries (B7.2 / B7.3, D-252) — the owner of a landlord or apartment tenant
  {
    key: 'listing.rejected',
    description: 'Owner: moderation did not approve a listing; the reason says what to change (D-252)',
    th: [
      'ประกาศ "{{listing.title}}" ยังไม่ผ่านการตรวจ',
      'ประกาศ "{{listing.title}}" ของ {{tenant.name}} ยังไม่ผ่านการตรวจ เหตุผล: {{reason}} — แก้ไขแล้วส่งตรวจใหม่ได้ในหน้าประกาศ',
    ],
    en: [
      'Listing "{{listing.titleEn}}" not approved',
      'The listing "{{listing.titleEn}}" of {{tenant.name}} was not approved. Reason: {{reason}} — edit it and submit again on the listing page.',
    ],
  },
  {
    key: 'listing.hidden',
    description: 'Owner: a listing was hidden pending review (reports or a moderator) (D-252)',
    th: [
      'ประกาศ "{{listing.title}}" ถูกซ่อนชั่วคราว',
      'ประกาศ "{{listing.title}}" ของ {{tenant.name}} ถูกซ่อนจากหน้าค้นหาชั่วคราวระหว่างทีมงานตรวจสอบ เหตุผล: {{reason}} — ทีมงานจะแจ้งผลโดยเร็ว',
    ],
    en: [
      'Listing "{{listing.titleEn}}" hidden for now',
      'The listing "{{listing.titleEn}}" of {{tenant.name}} is hidden from search while our team checks it. Reason: {{reason}} — we will let you know soon.',
    ],
  },
  {
    key: 'listing.verification_decided',
    description: 'Owner: the owner verification of a unit was decided (D-252)',
    th: [
      'ผลการยืนยันเจ้าของห้อง {{unit.name}}',
      'การยืนยันเจ้าของห้อง {{unit.name}} ของ {{tenant.name}}: {{verification.result}}',
    ],
    en: [
      'Owner verification of {{unit.name}}',
      'Owner verification of {{unit.name}} for {{tenant.name}}: {{verification.resultEn}}',
    ],
  },
  {
    key: 'lease.rent_certificate_requested',
    description: 'Owner: a resident asked for a rent payment certificate (B7.5, D-253)',
    th: [
      'คำขอหนังสือรับรองค่าเช่า ห้อง {{certificate.unitNo}}',
      '{{lessee.name}} ขอหนังสือรับรองการชำระค่าเช่า (ใช้สำหรับ{{certificate.purposeTh}}) ออกหนังสือหรือปฏิเสธได้ในหน้าหนังสือรับรอง',
    ],
    en: [
      'Rent certificate requested for {{certificate.unitNo}}',
      '{{lessee.name}} asked for a rent payment certificate ({{certificate.purposeEn}}). Issue or decline it on the certificates page.',
    ],
  },
  {
    key: 'listing.lead_received',
    description: 'Owner: a prospect asked about a listing (B7.3, D-252)',
    th: [
      'มีคนสนใจ "{{listing.title}}"',
      '{{lead.name}} สอบถามประกาศ "{{listing.title}}": {{message.excerpt}} — ตอบกลับได้ในกล่องคนสนใจ',
    ],
    en: [
      'New enquiry about "{{listing.titleEn}}"',
      '{{lead.name}} asked about "{{listing.titleEn}}": {{message.excerpt}} — reply in your enquiries inbox.',
    ],
  },
  {
    key: 'listing.lead_message',
    description: 'Owner: a prospect wrote again in an open enquiry (B7.3, D-252)',
    th: [
      'ข้อความใหม่จาก {{lead.name}}',
      '{{lead.name}} ส่งข้อความเรื่อง "{{listing.title}}": {{message.excerpt}}',
    ],
    en: [
      'New message from {{lead.name}}',
      '{{lead.name}} wrote about "{{listing.titleEn}}": {{message.excerpt}}',
    ],
  },
  {
    key: 'listing.lead_unanswered',
    description: 'Owner: an enquiry has waited listing.lead.nudge_after_hours without an answer (B7.3)',
    th: [
      '{{lead.name}} ยังรอคำตอบอยู่',
      '{{lead.name}} สอบถามประกาศ "{{listing.title}}" มาแล้วกว่า {{hours}} ชั่วโมงและยังไม่ได้รับคำตอบ ผู้เช่าที่ได้คำตอบเร็วมักตัดสินใจเร็วกว่า',
    ],
    en: [
      '{{lead.name}} is still waiting',
      '{{lead.name}} asked about "{{listing.titleEn}}" more than {{hours}} hours ago and has no answer yet. Quick answers win renters.',
    ],
  },
  {
    key: 'listing.viewing_requested',
    description:
      'Owner: a prospect asked for a viewing slot (new or rescheduled) — confirm or decline (B7.3, D-252)',
    th: [
      'ขอนัดดูห้อง {{viewing.at}}',
      '{{lead.name}} ขอนัดดู "{{listing.title}}" {{viewing.at}} น. — ยืนยันหรือปฏิเสธได้ในกล่องคนสนใจ',
    ],
    en: [
      'Viewing request {{viewing.atEn}}',
      '{{lead.name}} asks to view "{{listing.titleEn}}" on {{viewing.atEn}} — confirm or decline in your enquiries inbox.',
    ],
  },
  {
    key: 'listing.viewing_cancelled',
    description: 'Owner: the prospect cancelled a viewing (B7.3, D-252)',
    th: [
      'ยกเลิกนัดดูห้อง {{viewing.at}}',
      '{{lead.name}} ยกเลิกนัดดู "{{listing.title}}" {{viewing.at}} น. แล้ว',
    ],
    en: [
      'Viewing cancelled {{viewing.atEn}}',
      '{{lead.name}} cancelled the viewing of "{{listing.titleEn}}" on {{viewing.atEn}}.',
    ],
  },
  {
    key: 'listing.relist_due',
    description:
      'Owner: a lease that came from a listing ends soon — re-open the listing or offer a renewal (B7.4, D-253)',
    th: [
      'สัญญาห้อง {{listing.unitNo}} จะหมด {{lease.endDate}}',
      'สัญญาเช่าที่ได้จากประกาศ "{{listing.title}}" จะหมด {{lease.endDate}} เปิดประกาศใหม่ได้ในคลิกเดียวจากหน้าประกาศ หรือเสนอต่อสัญญาให้ผู้เช่าเดิม',
    ],
    en: [
      'Lease of {{listing.unitNo}} ends {{lease.endDateEn}}',
      'The lease that came from "{{listing.titleEn}}" ends {{lease.endDateEn}}. Re-open the listing in one tap from the listing page, or offer the tenant a renewal.',
    ],
  },
  {
    key: 'listing.viewing_reminder',
    description: 'Owner: a confirmed viewing is near (B7.3)',
    th: ['ใกล้ถึงเวลานัดดูห้อง', 'อย่าลืมนัดดู "{{listing.title}}" กับ {{lead.name}} {{viewing.at}} น.'],
    en: [
      'Viewing soon',
      'Reminder: viewing of "{{listing.titleEn}}" with {{lead.name}} on {{viewing.atEn}}.',
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
/** B7.3 (D-252): the prospect hears the owner's answers in LINE (consent `prospect.enquiry`, quiet hours). */
const PROSPECT_EVENTS = [
  'listing.lead_replied',
  'listing.lead_state_changed',
  'listing.viewing_confirmed',
  'listing.viewing_declined',
  'listing.viewing_cancelled',
  'listing.viewing_reminder',
];

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
    'lease.notice_issued',
    'lease.rent_certificate_issued',
    'lease.rent_certificate_declined',
    'inspection.completed',
    'service_request.decided',
    'service_request.cost_settled',
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
  ...PROSPECT_EVENTS.map((eventType) => ({
    eventType,
    audience: 'prospect',
    channel: 'line',
    urgent: false,
  })),
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
    key: 'service_request.decided',
    channel: 'line',
    audience: 'resident',
    description: 'The landlord decided who fixes my repair request and who pays (D-263)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'แจ้งซ่อม {{request.ref}} ({{request.category}}): {{decision.handledTh}} ค่าใช้จ่าย{{decision.bearerTh}}\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Repair {{request.ref}} ({{request.category}}): {{decision.handledEn}}; cost {{decision.bearerEn}}.\n{{link}}',
      },
    ],
  },
  {
    key: 'service_request.cost_settled',
    channel: 'line',
    audience: 'resident',
    description: 'My share of a repair goes on my next bill, or a credit is coming (D-263)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'แจ้งซ่อม {{request.ref}}: {{settlement.th}} {{settlement.amount}} บาท จะอยู่ในบิลถัดไปของคุณ\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Repair {{request.ref}}: {{settlement.en}} of THB {{settlement.amount}} will be on your next bill.\n{{link}}',
      },
    ],
  },
  {
    key: 'inspection.completed',
    channel: 'line',
    audience: 'resident',
    description:
      'The landlord completed the move-in / move-out report: check it and countersign (L5 5.2, D-253)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} บันทึกการตรวจสภาพห้องตอน{{inspection.typeTh}}แล้ว (เลขที่ {{inspection.number}}) แตะเพื่อดูรูปและลงนาม\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} completed the {{inspection.typeEn}} inspection report {{inspection.number}}. Tap to see the photos and sign it.\n{{link}}',
      },
    ],
  },
  {
    key: 'lease.rent_certificate_issued',
    channel: 'line',
    audience: 'resident',
    description: 'The rent payment certificate I asked for is ready (B7.5, D-253)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ออกหนังสือรับรองการชำระค่าเช่าเลขที่ {{certificate.number}} ให้แล้ว แตะเพื่อเปิด\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Your rent payment certificate {{certificate.number}} from {{tenant.name}} is ready. Tap to open it.\n{{link}}',
      },
    ],
  },
  {
    key: 'lease.rent_certificate_declined',
    channel: 'line',
    audience: 'resident',
    description: 'The landlord declined my rent certificate request, with the reason (B7.5, D-253)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ยังออกหนังสือรับรองการชำระค่าเช่าให้ไม่ได้: {{certificate.reason}}\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} could not issue your rent payment certificate: {{certificate.reason}}\n{{link}}',
      },
    ],
  },
  {
    key: 'lease.notice_issued',
    channel: 'line',
    audience: 'resident',
    description:
      'A written notice from the landlord: rent change, renewal offer, non-renewal, termination or overdue rent (B7.5, D-253)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ส่ง{{notice.titleTh}} เลขที่ {{notice.number}} ถึงคุณ แตะเพื่ออ่านฉบับเต็ม\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} sent you a letter: {{notice.titleEn}} ({{notice.number}}). Tap to read it in full.\n{{link}}',
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
  {
    key: 'listing.lead_replied',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: the owner replied to my enquiry (B7.3, D-252)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: '{{tenant.name}} ตอบเรื่อง "{{listing.title}}": {{message.excerpt}}\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: '{{tenant.name}} replied about "{{listing.titleEn}}": {{message.excerpt}}\n{{link}}',
      },
    ],
  },
  {
    key: 'listing.viewing_confirmed',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: the owner confirmed my viewing (B7.3, D-252)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ยืนยันนัดดู "{{listing.title}}" {{viewing.at}} น. แล้ว — ดูที่อยู่และแผนที่ได้ในแอป\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Your viewing of "{{listing.titleEn}}" on {{viewing.atEn}} is confirmed — address and map in the app.\n{{link}}',
      },
    ],
  },
  {
    key: 'listing.viewing_declined',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: the owner could not keep my viewing time (B7.3, D-252)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'เจ้าของไม่สะดวกนัดดู "{{listing.title}}" {{viewing.at}} น. ({{viewing.reason}}) — เลือกเวลาใหม่ได้ในแอป\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'The owner cannot do the viewing of "{{listing.titleEn}}" on {{viewing.atEn}} ({{viewing.reason}}) — pick another time in the app.\n{{link}}',
      },
    ],
  },
  {
    key: 'listing.viewing_cancelled',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: my viewing was cancelled because the owner closed the enquiry (B7.3, D-252)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'นัดดู "{{listing.title}}" {{viewing.at}} น. ถูกยกเลิกแล้ว ขอบคุณที่สนใจ — ดูประกาศอื่นได้ในแอป\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'The viewing of "{{listing.titleEn}}" on {{viewing.atEn}} was cancelled. Thank you for your interest — see other places in the app.\n{{link}}',
      },
    ],
  },
  {
    key: 'listing.viewing_reminder',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: my confirmed viewing is near (B7.3)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'อย่าลืมนัดดู "{{listing.title}}" {{viewing.at}} น. — ดูที่อยู่และแผนที่ได้ในแอป\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Reminder: viewing of "{{listing.titleEn}}" on {{viewing.atEn}} — address and map in the app.\n{{link}}',
      },
    ],
  },
  {
    key: 'listing.lead_state_changed',
    channel: 'line',
    audience: 'prospect',
    description: 'Prospect: the place I asked about has been rented to someone else (B7.4, D-252)',
    versions: [
      {
        language: 'th',
        subject: null,
        body: 'ขอบคุณที่สนใจ "{{listing.title}}" ตอนนี้ห้องนี้มีผู้เช่าแล้ว ลองดูห้องอื่นที่ใกล้เคียงได้ในแอป\n{{link}}',
      },
      {
        language: 'en',
        subject: null,
        body: 'Thank you for your interest in "{{listing.titleEn}}". It has now been rented. Have a look at similar places in the app.\n{{link}}',
      },
    ],
  },
  ...operatorTemplates(),
];
