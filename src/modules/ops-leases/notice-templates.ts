import { type ContractLanguage } from './contract-renderer';

export type LeaseNoticeKind =
  'rent_increase' | 'renewal_offer' | 'non_renewal' | 'termination' | 'late_payment';
export const LEASE_NOTICE_KINDS: LeaseNoticeKind[] = [
  'rent_increase',
  'renewal_offer',
  'non_renewal',
  'termination',
  'late_payment',
];

/** Lessor grounds a termination letter may cite (D-020 ข้อ 4 (12), D-176); `end_of_term` is the non-renewal letter. */
export const TERMINATION_REASONS = [
  'lessee_breach',
  'disturbance',
  'unlawful_use',
  'mutual_agreement',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** What a notice letter shows; every value is already formatted for its language (dates, money, words). */
export interface NoticeData {
  number: string;
  issuedOn: string;
  lessor: { legalName: string; taxId: string | null; address: string };
  lessee: { displayName: string; address: string | null };
  premises: { unitNo: string; propertyName: string; address: string };
  lease: { number: string | null; startDate: string; endDate: string; rent: string; rentText: string };
  effectiveDate: string | null;
  respondBy: string | null;
  noticeDays: number | null;
  newRent: string | null;
  newRentText: string | null;
  renewalMonths: number | null;
  reasonCode: TerminationReason | null;
  amountDue: string | null;
  amountDueText: string | null;
  items: { number: string; dueDate: string; balance: string }[];
  refundDays: number;
  message: string | null;
}

const esc = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const TITLE: Record<ContractLanguage, Record<LeaseNoticeKind, string>> = {
  th: {
    rent_increase: 'หนังสือแจ้งการปรับค่าเช่า',
    renewal_offer: 'หนังสือเสนอต่อสัญญาเช่า',
    non_renewal: 'หนังสือแจ้งไม่ต่อสัญญาเช่า',
    termination: 'หนังสือบอกเลิกสัญญาเช่า',
    late_payment: 'หนังสือแจ้งค่าเช่าค้างชำระ',
  },
  en: {
    rent_increase: 'Notice of rent change',
    renewal_offer: 'Offer to renew the lease',
    non_renewal: 'Notice of non-renewal',
    termination: 'Notice of termination',
    late_payment: 'Notice of overdue rent',
  },
};

const REASON: Record<ContractLanguage, Record<TerminationReason, string>> = {
  th: {
    lessee_breach: 'ผู้เช่าผิดสัญญาในข้อที่เป็นสาระสำคัญ และไม่แก้ไขภายในเวลาที่ผู้ให้เช่าแจ้งเป็นหนังสือ',
    disturbance: 'ผู้เช่ากระทำการอันกระทบต่อความปลอดภัยหรือความสงบสุขของผู้อื่น หลังได้รับหนังสือเตือนแล้ว',
    unlawful_use: 'ผู้เช่าใช้ทรัพย์สินที่เช่าเพื่อการอันผิดกฎหมาย',
    mutual_agreement: 'คู่สัญญาตกลงเลิกสัญญาร่วมกัน',
  },
  en: {
    lessee_breach:
      'the Lessee is in material breach of the lease and did not remedy it within the period given in writing',
    disturbance: 'the Lessee endangered the safety or peace of others after a written warning',
    unlawful_use: 'the Lessee used the premises for an unlawful purpose',
    mutual_agreement: 'the parties agreed to end the lease',
  },
};

/** The title of a notice in a language (also the PDF title and the LINE message). */
export const noticeTitle = (kind: LeaseNoticeKind, language: ContractLanguage) => TITLE[language][kind];

function thBody(kind: LeaseNoticeKind, d: NoticeData): string {
  const ref = `ตามสัญญาเช่า${d.lease.number ? `เลขที่ ${esc(d.lease.number)}` : ''} ระยะเวลาเช่า ${esc(d.lease.startDate)} ถึง ${esc(d.lease.endDate)} สำหรับทรัพย์สินเลขที่ ${esc(d.premises.unitNo)} ${esc(d.premises.propertyName)} ${esc(d.premises.address)} ค่าเช่าเดือนละ ${esc(d.lease.rent)} บาท`;
  switch (kind) {
    case 'rent_increase':
      return `<p>${ref}</p>
<p>ผู้ให้เช่าขอแจ้งว่า หากมีการต่อสัญญาเช่าเมื่อสัญญาปัจจุบันสิ้นสุดในวันที่ ${esc(d.lease.endDate)} ค่าเช่าจะเป็นเดือนละ <b>${esc(d.newRent)} บาท</b> (${esc(d.newRentText)}) ตั้งแต่วันที่ <b>${esc(d.effectiveDate)}</b> หนังสือนี้แจ้งล่วงหน้า ${esc(d.noticeDays)} วัน</p>
<p>ค่าเช่าและเงื่อนไขทั้งหมดตลอดสัญญาปัจจุบันไม่เปลี่ยนแปลง และผู้ให้เช่าจะไม่เรียกเก็บค่าต่อสัญญา</p>`;
    case 'renewal_offer':
      return `<p>${ref} ซึ่งจะสิ้นสุดในวันที่ ${esc(d.lease.endDate)}</p>
<p>ผู้ให้เช่ายินดีต่อสัญญาเช่าออกไปอีก <b>${esc(d.renewalMonths)} เดือน</b> เริ่มวันที่ <b>${esc(d.effectiveDate)}</b> ค่าเช่าเดือนละ <b>${esc(d.newRent)} บาท</b> (${esc(d.newRentText)}) เงื่อนไขอื่นเป็นไปตามสัญญาเดิม โดยไม่มีค่าต่อสัญญา</p>
<p>หากผู้เช่าประสงค์จะต่อสัญญา กรุณาตอบรับภายในวันที่ <b>${esc(d.respondBy)}</b> ผ่านแอปพลิเคชันหรือติดต่อผู้ให้เช่า ผู้ให้เช่าจะส่งสัญญาฉบับใหม่ให้ลงนามทางอิเล็กทรอนิกส์</p>`;
    case 'non_renewal':
      return `<p>${ref}</p>
<p>ผู้ให้เช่าขอแจ้งว่าจะไม่ต่อสัญญาเช่า สัญญาเช่าจะสิ้นสุดในวันที่ <b>${esc(d.effectiveDate)}</b> ตามกำหนด หนังสือนี้แจ้งล่วงหน้า ${esc(d.noticeDays)} วัน</p>
<p>กรุณาส่งมอบทรัพย์สินที่เช่าคืนภายในวันดังกล่าว ผู้ให้เช่าจะนัดตรวจสภาพร่วมกัน และคืนเงินประกันภายใน ${esc(d.refundDays)} วันหลังส่งมอบ โดยหักเฉพาะความเสียหายหรือหนี้ค้างที่มีหลักฐาน</p>`;
    case 'termination':
      return `<p>${ref}</p>
<p>เนื่องจาก${esc(REASON.th[d.reasonCode ?? 'lessee_breach'])} ผู้ให้เช่าจึงขอบอกเลิกสัญญาเช่า มีผลวันที่ <b>${esc(d.effectiveDate)}</b> หนังสือนี้แจ้งล่วงหน้า ${esc(d.noticeDays)} วัน</p>
<p>กรุณาส่งมอบทรัพย์สินที่เช่าคืนภายในวันดังกล่าว ผู้ให้เช่าจะคืนเงินประกันภายใน ${esc(d.refundDays)} วันหลังส่งมอบ โดยหักเฉพาะความเสียหายหรือหนี้ค้างที่มีหลักฐาน</p>
<p>ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ เปลี่ยนกุญแจ ปิดกั้นการเข้าใช้ทรัพย์สิน หรือขนย้ายทรัพย์สินของผู้เช่า</p>`;
    case 'late_payment':
      return `<p>${ref}</p>
<p>ผู้ให้เช่าขอแจ้งว่าผู้เช่ามียอดค้างชำระ ดังนี้</p>
<table class="lines"><tr><th>ใบแจ้งหนี้</th><th>ครบกำหนด</th><th class="num">ค้างชำระ (บาท)</th></tr>${d.items
        .map(
          (i) =>
            `<tr><td>${esc(i.number)}</td><td>${esc(i.dueDate)}</td><td class="num">${esc(i.balance)}</td></tr>`,
        )
        .join(
          '',
        )}<tr><td colspan="2"><b>รวม</b></td><td class="num"><b>${esc(d.amountDue)}</b></td></tr></table>
<p>รวมเป็นเงิน <b>${esc(d.amountDue)} บาท</b> (${esc(d.amountDueText)}) กรุณาชำระภายในวันที่ <b>${esc(d.respondBy)}</b> ผ่าน Thai QR ในใบแจ้งหนี้ หากชำระแล้วโปรดละเว้นหนังสือนี้</p>
<p>หนังสือนี้ไม่ใช่การบอกเลิกสัญญา ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ หรือปิดกั้นการเข้าใช้ทรัพย์สินเพราะเหตุค้างชำระ</p>`;
  }
}

function enBody(kind: LeaseNoticeKind, d: NoticeData): string {
  const ref = `Re: the lease${d.lease.number ? ` no. ${esc(d.lease.number)}` : ''} from ${esc(d.lease.startDate)} to ${esc(d.lease.endDate)} of ${esc(d.premises.unitNo)}, ${esc(d.premises.propertyName)}, ${esc(d.premises.address)}, at a rent of THB ${esc(d.lease.rent)} per month.`;
  switch (kind) {
    case 'rent_increase':
      return `<p>${ref}</p>
<p>The Lessor gives notice that, if the lease is renewed when the current lease ends on ${esc(d.lease.endDate)}, the rent will be <b>THB ${esc(d.newRent)}</b> (${esc(d.newRentText)}) per month from <b>${esc(d.effectiveDate)}</b>. This notice is given ${esc(d.noticeDays)} days in advance.</p>
<p>The rent and every term of the current lease stay unchanged until it ends, and no renewal fee is charged.</p>`;
    case 'renewal_offer':
      return `<p>${ref} The lease ends on ${esc(d.lease.endDate)}.</p>
<p>The Lessor offers to renew the lease for <b>${esc(d.renewalMonths)} months</b> from <b>${esc(d.effectiveDate)}</b> at <b>THB ${esc(d.newRent)}</b> (${esc(d.newRentText)}) per month, on the same other terms and with no renewal fee.</p>
<p>If you wish to renew, please reply by <b>${esc(d.respondBy)}</b> in the app or by contacting the Lessor. The new lease will be sent to you for electronic signature.</p>`;
    case 'non_renewal':
      return `<p>${ref}</p>
<p>The Lessor gives notice that the lease will not be renewed and ends as agreed on <b>${esc(d.effectiveDate)}</b>. This notice is given ${esc(d.noticeDays)} days in advance.</p>
<p>Please hand the premises back by that date. The Lessor will inspect them with you and return the deposit within ${esc(d.refundDays)} days of the hand-back, deducting only evidenced damage or unpaid amounts.</p>`;
    case 'termination':
      return `<p>${ref}</p>
<p>Because ${esc(REASON.en[d.reasonCode ?? 'lessee_breach'])}, the Lessor terminates the lease with effect from <b>${esc(d.effectiveDate)}</b>. This notice is given ${esc(d.noticeDays)} days in advance.</p>
<p>Please hand the premises back by that date. The Lessor will return the deposit within ${esc(d.refundDays)} days of the hand-back, deducting only evidenced damage or unpaid amounts.</p>
<p>The Lessor will not cut off water or electricity, change the locks, block access to the premises or remove the Lessee's belongings.</p>`;
    case 'late_payment':
      return `<p>${ref}</p>
<p>The following amounts are overdue:</p>
<table class="lines"><tr><th>Invoice</th><th>Due</th><th class="num">Overdue (THB)</th></tr>${d.items
        .map(
          (i) =>
            `<tr><td>${esc(i.number)}</td><td>${esc(i.dueDate)}</td><td class="num">${esc(i.balance)}</td></tr>`,
        )
        .join(
          '',
        )}<tr><td colspan="2"><b>Total</b></td><td class="num"><b>${esc(d.amountDue)}</b></td></tr></table>
<p>Please pay <b>THB ${esc(d.amountDue)}</b> (${esc(d.amountDueText)}) by <b>${esc(d.respondBy)}</b> with the Thai QR on the invoice. If you have already paid, please disregard this notice.</p>
<p>This notice does not terminate the lease. The Lessor will not cut off water or electricity or block access to the premises because of arrears.</p>`;
  }
}

/** The body of a notice letter (B7.5, D-253): header, the kind's paragraphs, the owner's note, the signature. */
export function noticeBody(kind: LeaseNoticeKind, language: ContractLanguage, d: NoticeData): string {
  const th = language === 'th';
  const head = `<header>
<h1>${esc(noticeTitle(kind, language))}</h1>
<table class="meta">
<tr><td>${th ? 'เลขที่' : 'No.'}</td><td>${esc(d.number)}</td></tr>
<tr><td>${th ? 'วันที่' : 'Date'}</td><td>${esc(d.issuedOn)}</td></tr>
<tr><td>${th ? 'จาก' : 'From'}</td><td>${esc(d.lessor.legalName)}${d.lessor.taxId ? ` (${th ? 'เลขประจำตัวผู้เสียภาษี' : 'tax id'} ${esc(d.lessor.taxId)})` : ''}${d.lessor.address ? `, ${esc(d.lessor.address)}` : ''}</td></tr>
<tr><td>${th ? 'เรียน' : 'To'}</td><td>${esc(d.lessee.displayName)}${d.lessee.address ? `, ${esc(d.lessee.address)}` : ''}</td></tr>
</table>
</header>`;
  const note = d.message
    ? `<section><h2>${th ? 'หมายเหตุจากผู้ให้เช่า' : 'Note from the Lessor'}</h2><p>${esc(d.message)}</p></section>`
    : '';
  const sign = `<section class="signatures"><table class="sign"><tr><td></td><td><div>${th ? 'ลงชื่อ' : 'Signed'} ........................................ ${th ? 'ผู้ให้เช่า' : 'Lessor'}</div><div>(${esc(d.lessor.legalName)})</div><div class="when">${th ? 'ส่งทางอิเล็กทรอนิกส์เมื่อ' : 'Sent electronically on'} ${esc(d.issuedOn)}</div></td></tr></table></section>`;
  return `<article class="notice">${head}<section>${th ? thBody(kind, d) : enBody(kind, d)}</section>${note}${sign}</article>`;
}
