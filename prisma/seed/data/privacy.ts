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
    key: 'resident.relocation',
    audience: 'resident',
    required: false,
    th: {
      title: 'ช่วยหาที่อยู่ใหม่เมื่อย้ายออก',
      body: 'ร่าง ⚖ — เมื่อท่านแจ้งย้ายออก getproperty (Collective Group) จะแสดงห้องว่างในพื้นที่ที่ท่านบอกว่าจะย้ายไป ใช้เฉพาะพื้นที่ปลายทางและงบที่ท่านกรอก ไม่ส่งให้ผู้ให้เช่าปัจจุบัน และประวัติการจ่ายค่าเช่าจะส่งให้เจ้าของใหม่เฉพาะเมื่อท่านกดส่งเอง เลิกรับได้ทุกเมื่อ (ข้อมูลปลายทางถูกลบทันที)',
    },
    en: {
      title: 'Help finding my next home when I move out',
      body: 'Draft ⚖ — when you give notice, getproperty (Collective Group) shows vacant places in the area you say you are moving to, using only that destination and budget. Your current landlord does not see it, and your rent record goes to a new landlord only when you send it. Withdraw any time (the destination is erased at once).',
    },
  },
  {
    // G6 (D-300): Collective is the controller (consent rows with tenant NULL); separate from every service consent,
    // never pre-ticked, withdrawn in one tap. Alongside G8's narrower `resident.relocation`, not instead of it.
    key: 'platform.recommendations',
    audience: 'prospect',
    required: false,
    th: {
      title: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)',
      body: [
        'ร่าง ⚖ — เลือกรับหรือไม่ก็ได้ ไม่มีผลต่อการใช้บริการอื่น',
        '',
        '**เราจะทำอะไร** getproperty (บริษัท Collective Group (Thailand) จำกัด ผู้ควบคุมข้อมูล) จะส่งห้องเช่าที่น่าจะตรงกับที่คุณมองหาทาง LINE ของ getproperty บางข้อความเป็น **โฆษณา** ที่เจ้าของประกาศหรือนายหน้าจ่ายเงินให้ส่ง ซึ่งจะมีป้าย "โฆษณา" ทุกครั้ง',
        '',
        '**ข้อมูลที่ใช้** เฉพาะสิ่งที่คุณกรอกเอง: พื้นที่ งบ ประเภทห้อง ช่วงเวลาที่จะย้ายเข้า ภาษา และเวลาที่ไม่อยากถูกรบกวน',
        '',
        '**การจัดกลุ่ม (profiling)** ระบบจับคู่ข้อมูลข้างต้นกับประกาศเพื่อเลือกว่าจะส่งห้องไหนให้คุณ เราไม่ใช้ข้อมูลอ่อนไหว (เช่น ศาสนา สุขภาพ เชื้อชาติ) ไม่ใช้ประวัติการจ่ายค่าเช่า และไม่ใช้ข้อมูลที่ผู้ให้เช่าปัจจุบันเก็บไว้',
        '',
        '**ผู้ซื้อโฆษณาไม่เห็นตัวคุณ** เขาเห็นเพียงตัวเลขรวม (ส่งกี่คน คลิกกี่ครั้ง) และจะได้ข้อมูลของคุณเฉพาะเมื่อคุณกดสอบถามหรือนัดดูห้องเอง',
        '',
        '**ไม่รบกวนเกินไป** ไม่เกิน 2 ข้อความโฆษณาต่อสัปดาห์ (ค่าตั้งต้น) และไม่ส่งในช่วงเวลาพัก',
        '',
        '**เลิกรับได้ทุกเมื่อในแตะเดียว** หลังเลิกรับจะไม่มีข้อความใหม่ และข้อมูลความสนใจจะถูกลบภายใน 30 วัน (หรือขอลบทันทีได้) ดูประวัติสิ่งที่ส่งถึงคุณได้ในหน้าตั้งค่านี้',
      ].join('\n'),
    },
    en: {
      title: 'Recommended places from getproperty (incl. ads)',
      body: [
        'Draft ⚖ — optional; saying no changes nothing else you use.',
        '',
        '**What we do** getproperty (Collective Group (Thailand) Co., Ltd., the data controller) sends you places to rent that seem to fit what you look for, through getproperty’s LINE account. Some messages are **ads** paid for by a listing owner or agent — they are always labelled "Sponsored".',
        '',
        '**What we use** only what you type yourself: areas, budget, kind of place, when you want to move in, language and the hours you do not want to be disturbed.',
        '',
        '**Profiling** we match the details above with listings to choose what to send you. We never use sensitive data (such as religion, health or ethnicity), your rent payment history or anything your current landlord keeps.',
        '',
        '**Advertisers never see you** — only totals (how many got it, how many clicks). They get your details only when you enquire or book a viewing yourself.',
        '',
        '**Not too often** at most 2 sponsored messages a week (default) and none during quiet hours.',
        '',
        '**Stop any time with one tap.** Nothing new is sent after that and your preferences are deleted within 30 days (or at once on request). You can see what was sent to you on this settings page.',
      ].join('\n'),
    },
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
  // G1 / D-286: legal holds of the classes the seed lacked — periods ⚖ until counsel confirms them (O-025)
  {
    target: 'document_class',
    targetKey: 'pdf_tax_invoice',
    retainFor: '5 years',
    basis: 'issued_at; ⚖ Revenue Code retention to confirm',
    action: 'archive',
    legalRef: 'ประมวลรัษฎากร ม.87/3 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'pdf_note',
    retainFor: '5 years',
    basis: 'issued_at; ⚖ accounting retention to confirm',
    action: 'archive',
    legalRef: 'พ.ร.บ.การบัญชี 2543 ม.14 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'deposit_settlement',
    retainFor: '5 years',
    basis: 'issued_at; ⚖ accounting retention to confirm',
    action: 'archive',
    legalRef: 'พ.ร.บ.การบัญชี 2543 ม.14; D-023 ⚖',
  },
  {
    target: 'document_class',
    targetKey: 'tm30_export',
    retainFor: '5 years',
    basis: 'generated_at; ⚖ immigration (TM30) retention to confirm',
    action: 'archive',
    legalRef: 'พ.ร.บ.คนเข้าเมือง 2522 ม.38 ⚖',
  },
];
