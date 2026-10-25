/**
 * Consent purposes (D-025, schema-design §3.2.7) and retention policies. Texts are placeholders for the legal
 * team (⚖): version 1 in th/en, effective from the seed run. Retention periods marked ⚖ wait for legal review;
 * the retention job (B1.3) reads them and does nothing destructive before review (`basis` says so).
 */
export interface ConsentPurposeSeed {
  key: string;
  audience: 'resident' | 'owner' | 'platform' | 'prospect';
  required: boolean;
  th: { title: string; body: string };
  en: { title: string; body: string };
}

export const CONSENT_PURPOSES: ConsentPurposeSeed[] = [
  {
    key: 'resident.service',
    audience: 'resident',
    required: true,
    th: {
      title: 'การใช้ข้อมูลเพื่อให้บริการ',
      body: 'ร่าง ⚖ — ผู้ให้เช่า (ผู้ควบคุมข้อมูล) ใช้ข้อมูลของท่านเพื่อจัดการสัญญาเช่า ใบแจ้งหนี้ การชำระเงิน และการแจ้งเตือนผ่าน LINE',
    },
    en: {
      title: 'Use of data to provide the service',
      body: 'Draft ⚖ — the lessor (data controller) uses your data to manage the lease, invoices, payments and LINE notifications.',
    },
  },
  {
    key: 'resident.marketing',
    audience: 'resident',
    required: false,
    th: { title: 'ข่าวสารและข้อเสนอ', body: 'ร่าง ⚖ — รับข่าวสารและข้อเสนอจากผู้ให้เช่า (เลือกได้)' },
    en: { title: 'News and offers', body: 'Draft ⚖ — receive news and offers from the lessor (optional).' },
  },
  {
    key: 'prospect.enquiry',
    audience: 'prospect',
    required: true,
    th: {
      title: 'การใช้ข้อมูลเพื่อตอบคำถามเรื่องเช่า',
      body: 'ร่าง ⚖ — เจ้าของประกาศ (ผู้ควบคุมข้อมูล) ใช้ชื่อ ข้อความ และช่องทาง LINE ของท่าน เพื่อตอบคำถาม นัดดูห้อง และติดต่อเรื่องการเช่าห้องที่ท่านสอบถามเท่านั้น',
    },
    en: {
      title: 'Use of your details to answer a rental enquiry',
      body: 'Draft ⚖ — the owner of the listing (data controller) uses your name, messages and LINE contact only to answer your enquiry, arrange viewings and talk about renting the place you asked about.',
    },
  },
  {
    key: 'tenant.terms',
    audience: 'owner',
    required: true,
    th: {
      title: 'ข้อกำหนดการใช้บริการ getproperty',
      body: 'ร่าง ⚖ — ข้อกำหนดการใช้บริการระหว่างลูกค้าและ Collective Group (Thailand)',
    },
    en: {
      title: 'getproperty terms of service',
      body: 'Draft ⚖ — terms of service between the customer and Collective Group (Thailand).',
    },
  },
  {
    key: 'tenant.dpa',
    audience: 'owner',
    required: true,
    th: {
      title: 'ข้อตกลงการประมวลผลข้อมูลส่วนบุคคล',
      body: 'ร่าง ⚖ — ลูกค้าเป็นผู้ควบคุมข้อมูล Collective เป็นผู้ประมวลผลข้อมูล (D-025)',
    },
    en: {
      title: 'Data processing agreement',
      body: 'Draft ⚖ — the customer is the controller, Collective the processor (D-025).',
    },
  },
  {
    key: 'analytics.anonymised',
    audience: 'owner',
    required: false,
    th: {
      title: 'การใช้ข้อมูลนิรนามเพื่อพัฒนาบริการ',
      body: 'ร่าง ⚖ — ใช้ข้อมูลที่ไม่ระบุตัวตนเพื่อสถิติและเปรียบเทียบ (D-083)',
    },
    en: {
      title: 'Anonymised analytics',
      body: 'Draft ⚖ — anonymised data for statistics and benchmarks (D-083).',
    },
  },
];

export interface RetentionSeed {
  target: 'document_class' | 'table';
  targetKey: string;
  retainFor: string;
  basis: string;
  action: 'delete' | 'anonymise' | 'archive';
  legalRef: string | null;
}

export const RETENTION_POLICIES: RetentionSeed[] = [
  {
    target: 'table',
    targetKey: 'platform.audit_log',
    retainFor: '10 years',
    basis: 'occurred_at',
    action: 'archive',
    legalRef: 'blueprint: audit 10 years',
  },
  {
    target: 'table',
    targetKey: 'platform.otp_challenge',
    retainFor: '30 days',
    basis: 'created_at',
    action: 'delete',
    legalRef: null,
  },
  {
    target: 'table',
    targetKey: 'platform.auth_session',
    retainFor: '90 days',
    basis: 'expires_at',
    action: 'delete',
    legalRef: null,
  },
  {
    target: 'table',
    targetKey: 'platform.idempotency_key',
    retainFor: '1 day',
    basis: 'expires_at',
    action: 'delete',
    legalRef: 'contract §3 (24 h replay)',
  },
  {
    target: 'table',
    targetKey: 'platform.notification',
    retainFor: '2 years',
    basis: 'created_at; ⚖ pending legal review',
    action: 'delete',
    legalRef: null,
  },
  {
    target: 'document_class',
    targetKey: 'id_document',
    retainFor: '1 year',
    basis: 'lease end; ⚖ pending legal review — no deletion before review',
    action: 'delete',
    legalRef: 'D-025 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'meter_photo',
    retainFor: '2 years',
    basis: 'reading date; ⚖ pending legal review',
    action: 'delete',
    legalRef: 'D-030/D-035 evidence ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'slip',
    retainFor: '5 years',
    basis: 'payment date; ⚖ accounting retention to confirm',
    action: 'delete',
    legalRef: 'พ.ร.บ.การบัญชี 2543 ม.14 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'pdf_invoice',
    retainFor: '5 years',
    basis: 'issued_at; ⚖ accounting retention to confirm',
    action: 'archive',
    legalRef: 'พ.ร.บ.การบัญชี 2543 ม.14 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'pdf_receipt',
    retainFor: '5 years',
    basis: 'issued_at; ⚖ accounting retention to confirm',
    action: 'archive',
    legalRef: 'พ.ร.บ.การบัญชี 2543 ม.14 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'contract',
    retainFor: '5 years',
    basis: 'lease end; ⚖ pending legal review',
    action: 'archive',
    legalRef: 'D-020 ⚖',
  },
];
