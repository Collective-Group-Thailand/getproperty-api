import { type ContractKind } from '@generated/prisma/client';

import { type ContractLanguage } from './contract-renderer';

/**
 * Platform drafts of the contract library (G3, D-290, D-294) for the kinds B7 did not have: reservation, brokerage
 * mandate, co-broke, lease addendum, and the renewal / termination notice texts. Seeded as published platform
 * templates (tenant_id NULL) in Thai and English with `legal_review_state = pending_legal_verification`.
 *
 * ⚖ O-025 / O-030: drafted by Claude from the Civil and Commercial Code (hire of property ss. 537–571, brokerage
 * ss. 845–849, earnest money ss. 377–378) and the protections of the สคบ. 2568 announcement (D-020) as a safe default;
 * **not reviewed by counsel** — every API response carries the review state and the disclaimer. Clauses are
 * `<section>`s with an `<h2>` (the clause key of the diff, contract-diff.ts). Handlebars, HTML-escaped.
 */
export const LIBRARY_TEMPLATE_VERSION = 1;
export const LIBRARY_TEMPLATE_EFFECTIVE_FROM = '2026-10-27';

export interface LibraryTemplate {
  key: string;
  kind: ContractKind;
  name: string;
  language: ContractLanguage;
  legalRef: string;
  body: string;
}

const REF_TH = '⚖ ร่างโดยระบบ รอการตรวจสอบทางกฎหมาย (O-025)';
const REF_EN = '⚖ System draft pending legal verification (O-025)';

const disclaimer = `{{#if draft}}<p class="draft">{{disclaimer}}</p>{{/if}}`;
const meta = (th: boolean) => `<table class="meta">
<tr><td>${th ? 'เลขที่' : 'No.'}</td><td>{{#if contract.number}}{{contract.number}}{{else}}${th ? '(ออกเลขเมื่อส่งลงนาม)' : '(numbered when sent for signature)'}{{/if}}</td></tr>
<tr><td>${th ? 'ทำที่' : 'Made at'}</td><td>{{contract.madeAt}}</td></tr>
<tr><td>${th ? 'วันที่' : 'Date'}</td><td>{{contract.madeOn}}</td></tr>
</table>`;
const party = (path: string) =>
  `<b>{{${path}.legalName}}</b>{{#if ${path}.taxId}} (${'{{'}${path}.taxId}}){{/if}}, {{${path}.address}}`;
const premises = (th: boolean) =>
  th
    ? `ห้อง/ยูนิตเลขที่ <b>{{premises.unitNo}}</b> {{premises.buildingName}} ({{premises.propertyName}}) ตั้งอยู่ที่ {{premises.address}}{{#if premises.areaSqm}} พื้นที่ประมาณ {{premises.areaSqm}} ตารางเมตร{{/if}}`
    : `unit <b>{{premises.unitNo}}</b>, {{premises.buildingName}} ({{premises.propertyName}}), {{premises.address}}{{#if premises.areaSqm}}, about {{premises.areaSqm}} sq m{{/if}}`;
const sign = (roles: [string, string][]) => `<section class="signatures">
<table class="sign"><tr>
${roles
  .map(
    ([role, label]) =>
      `<td>{{#if signatures.${role}}}<img class="sig" src="{{signatures.${role}.imageDataUrl}}" alt="${label}"><div class="when">{{signatures.${role}.signedAt}}</div>{{/if}}<div>........................................</div><div>${label}</div></td>`,
  )
  .join('\n')}
</tr></table>
</section>`;
const footer = (th: boolean) =>
  `<footer class="notes"><p>${th ? 'แบบสัญญา' : 'Template'} {{template.key}} ${th ? 'ฉบับที่' : 'version'} {{template.version}} · {{template.legalRef}}</p></footer>`;

// ------------------------------------------------------------------------------------------------- reservation

const reservationTh = `<article class="contract">
<header><h1>สัญญาจองห้องเช่า</h1>${disclaimer}${meta(true)}</header>
<section><h2>คู่สัญญา</h2>
<p>ผู้ให้เช่า ${party('lessor')} กับผู้จอง <b>{{prospect.displayName}}</b>{{#if prospect.phone}} โทรศัพท์ {{prospect.phone}}{{/if}}</p></section>
<section><h2>ทรัพย์สินที่จอง</h2>
<p>ผู้จองขอจอง${premises(true)} เพื่อเช่าอยู่อาศัย ค่าเช่าเดือนละ <b>{{reservation.rent}} บาท</b> ({{reservation.rentText}}) กำหนดเข้าอยู่วันที่ {{reservation.moveInDate}}</p></section>
<section><h2>เงินจอง</h2>
<p>ผู้จองชำระเงินจองจำนวน <b>{{reservation.fee}} บาท</b> ({{reservation.feeText}}) เมื่อทำสัญญาเช่า เงินจองนี้จะนำไปหักเป็นส่วนหนึ่งของเงินประกันหรือค่าเช่าล่วงหน้า และรวมกันไม่เกินอัตราที่กฎหมายกำหนด</p></section>
<section><h2>ระยะเวลาการจอง</h2>
<p>ผู้ให้เช่าจะสงวนห้องไว้ให้ผู้จองจนถึงวันที่ {{reservation.expiresOn}} หากคู่สัญญาไม่ได้ทำสัญญาเช่าภายในวันดังกล่าวเพราะเหตุที่ผู้ให้เช่าเป็นฝ่ายผิดหรือไม่อาจส่งมอบห้องได้ ผู้ให้เช่าจะคืนเงินจองเต็มจำนวนภายใน 7 วัน</p>
{{#if reservation.refundTerms}}<p>เงื่อนไขการคืนเงินจองเพิ่มเติม: {{reservation.refundTerms}}</p>{{/if}}</section>
<section><h2>การทำสัญญาเช่า</h2>
<p>สัญญาเช่าจะทำตามแบบสัญญาของผู้ให้เช่าในระบบ getproperty และลงลายมือชื่ออิเล็กทรอนิกส์ ผู้ให้เช่าจะไม่เรียกเก็บค่าธรรมเนียมการทำสัญญานอกจากที่ระบุไว้ในสัญญานี้</p></section>
<section><h2>การลงนาม</h2>
<p>คู่สัญญาลงลายมือชื่ออิเล็กทรอนิกส์ ระบบบันทึกเวลา และค่าแฮช SHA-256 ของเอกสารที่ลงนาม</p></section>
${sign([
  ['lessor', 'ผู้ให้เช่า'],
  ['prospect', 'ผู้จอง'],
])}
${footer(true)}
</article>`;

const reservationEn = `<article class="contract">
<header><h1>Reservation Agreement</h1>${disclaimer}${meta(false)}</header>
<section><h2>Parties</h2>
<p>The Lessor ${party('lessor')} and the applicant <b>{{prospect.displayName}}</b>{{#if prospect.phone}}, phone {{prospect.phone}}{{/if}}.</p></section>
<section><h2>Reserved premises</h2>
<p>The applicant reserves ${premises(false)} for residential use at a rent of <b>THB {{reservation.rent}}</b> per month, moving in on {{reservation.moveInDate}}.</p></section>
<section><h2>Reservation fee</h2>
<p>The applicant pays a reservation fee of <b>THB {{reservation.fee}}</b>. When the lease is signed the fee is credited to the deposit or advance rent, which together never exceed the legal limit.</p></section>
<section><h2>Reservation period</h2>
<p>The Lessor holds the premises for the applicant until {{reservation.expiresOn}}. If no lease is signed by then because of the Lessor or because the premises cannot be handed over, the Lessor refunds the fee in full within 7 days.</p>
{{#if reservation.refundTerms}}<p>Further refund terms: {{reservation.refundTerms}}</p>{{/if}}</section>
<section><h2>The lease</h2>
<p>The lease is made on the Lessor's contract template on getproperty and signed electronically. The Lessor charges no contract fee other than those stated here.</p></section>
<section><h2>Signatures</h2>
<p>The parties sign electronically; the system records the time and the SHA-256 hash of the signed document.</p></section>
${sign([
  ['lessor', 'Lessor'],
  ['prospect', 'Applicant'],
])}
${footer(false)}
</article>`;

// ------------------------------------------------------------------------------------------------- brokerage mandate

const mandateTh = `<article class="contract">
<header><h1>สัญญาแต่งตั้งนายหน้า</h1>${disclaimer}${meta(true)}</header>
<section><h2>คู่สัญญา</h2>
<p>เจ้าของทรัพย์ ${party('owner')} แต่งตั้งนายหน้า ${party('agency')}</p></section>
<section><h2>ทรัพย์สินและขอบเขต</h2>
<p>ให้นายหน้าจัดหาผู้เช่าสำหรับ${premises(true)} ขอบเขตงาน: {{mandate.scope}}{{#if mandate.exclusive}} โดยเป็นนายหน้าแต่ผู้เดียว{{/if}}</p></section>
<section><h2>ค่านายหน้า</h2>
<p>{{#if mandate.commissionTerms}}{{mandate.commissionTerms}}{{/if}}{{#if mandate.commissionPercent}} ร้อยละ {{mandate.commissionPercent}} ของค่าเช่าหนึ่งเดือน{{/if}}{{#if mandate.commissionAmount}} จำนวน {{mandate.commissionAmount}} บาท{{/if}} ค่านายหน้าถึงกำหนดชำระเมื่อสัญญาเช่าที่นายหน้าจัดหาได้ลงนามแล้ว และชำระระหว่างคู่สัญญาโดยตรง ไม่ผ่านระบบ getproperty</p></section>
<section><h2>ระยะเวลา</h2>
<p>ตั้งแต่วันที่ {{mandate.validFrom}}{{#if mandate.validTo}} ถึงวันที่ {{mandate.validTo}}{{/if}} คู่สัญญาฝ่ายใดฝ่ายหนึ่งบอกเลิกได้ด้วยการแจ้งในระบบ การบอกเลิกไม่กระทบค่านายหน้าที่ถึงกำหนดแล้ว</p></section>
<section><h2>ข้อมูลส่วนบุคคล</h2>
<p>นายหน้าใช้ข้อมูลของผู้สนใจเช่าและผู้เช่าเพื่อการจัดหาผู้เช่าตามสัญญานี้เท่านั้น ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล</p></section>
{{#if mandate.note}}<section><h2>ข้อตกลงเพิ่มเติม</h2><p>{{mandate.note}}</p></section>{{/if}}
${sign([
  ['owner', 'เจ้าของทรัพย์'],
  ['agency', 'นายหน้า'],
])}
${footer(true)}
</article>`;

const mandateEn = `<article class="contract">
<header><h1>Brokerage Mandate</h1>${disclaimer}${meta(false)}</header>
<section><h2>Parties</h2>
<p>The owner ${party('owner')} appoints the agent ${party('agency')}.</p></section>
<section><h2>Property and scope</h2>
<p>The agent finds tenants for ${premises(false)}. Scope: {{mandate.scope}}{{#if mandate.exclusive}}, as the sole agent{{/if}}.</p></section>
<section><h2>Commission</h2>
<p>{{#if mandate.commissionTerms}}{{mandate.commissionTerms}}{{/if}}{{#if mandate.commissionPercent}} {{mandate.commissionPercent}} % of one month's rent{{/if}}{{#if mandate.commissionAmount}} THB {{mandate.commissionAmount}}{{/if}}. The commission is due when a lease introduced by the agent is signed and is paid directly between the parties, not through getproperty.</p></section>
<section><h2>Term</h2>
<p>From {{mandate.validFrom}}{{#if mandate.validTo}} to {{mandate.validTo}}{{/if}}. Either party may end the mandate in the app; ending it does not affect commission already due.</p></section>
<section><h2>Personal data</h2>
<p>The agent uses the data of prospects and tenants only to find tenants under this mandate, in line with the Personal Data Protection Act.</p></section>
{{#if mandate.note}}<section><h2>Further terms</h2><p>{{mandate.note}}</p></section>{{/if}}
${sign([
  ['owner', 'Owner'],
  ['agency', 'Agent'],
])}
${footer(false)}
</article>`;

// ------------------------------------------------------------------------------------------------- co-broke

const coBrokeTh = `<article class="contract">
<header><h1>สัญญาความร่วมมือระหว่างนายหน้า (Co-broke)</h1>${disclaimer}${meta(true)}</header>
<section><h2>คู่สัญญา</h2>
<p>นายหน้าผู้ลงประกาศ ${party('agency')} กับนายหน้าร่วม ${party('coAgency')}</p></section>
<section><h2>ทรัพย์สิน</h2>
<p>ประกาศ "{{coBroke.listingTitle}}" ${premises(true)}</p></section>
<section><h2>การแบ่งค่านายหน้า</h2>
<p>เมื่อสัญญาเช่ากับผู้เช่าที่นายหน้าร่วมจัดหาได้ลงนามแล้ว นายหน้าผู้ลงประกาศจะแบ่งค่านายหน้าที่ได้รับให้นายหน้าร่วมร้อยละ <b>{{coBroke.splitPercent}}</b> การชำระเงินทำระหว่างคู่สัญญาโดยตรง ไม่ผ่านระบบ getproperty</p></section>
<section><h2>ระยะเวลา</h2>
<p>ตั้งแต่วันที่ {{coBroke.validFrom}}{{#if coBroke.validTo}} ถึงวันที่ {{coBroke.validTo}}{{/if}}</p></section>
<section><h2>การไม่ติดต่อข้ามกัน</h2>
<p>คู่สัญญาจะไม่ติดต่อเจ้าของทรัพย์หรือผู้เช่าที่อีกฝ่ายแนะนำโดยตรงเพื่อหลีกเลี่ยงค่านายหน้าตามสัญญานี้</p></section>
{{#if coBroke.note}}<section><h2>ข้อตกลงเพิ่มเติม</h2><p>{{coBroke.note}}</p></section>{{/if}}
${sign([
  ['agency', 'นายหน้าผู้ลงประกาศ'],
  ['co_agency', 'นายหน้าร่วม'],
])}
${footer(true)}
</article>`;

const coBrokeEn = `<article class="contract">
<header><h1>Co-broke Agreement</h1>${disclaimer}${meta(false)}</header>
<section><h2>Parties</h2>
<p>The listing agent ${party('agency')} and the co-agent ${party('coAgency')}.</p></section>
<section><h2>Property</h2>
<p>Listing "{{coBroke.listingTitle}}", ${premises(false)}.</p></section>
<section><h2>Commission split</h2>
<p>When a lease with a tenant introduced by the co-agent is signed, the listing agent shares <b>{{coBroke.splitPercent}} %</b> of the commission it receives with the co-agent. Payment is made directly between the parties, not through getproperty.</p></section>
<section><h2>Term</h2>
<p>From {{coBroke.validFrom}}{{#if coBroke.validTo}} to {{coBroke.validTo}}{{/if}}.</p></section>
<section><h2>Non-circumvention</h2>
<p>Neither party contacts the owner or a tenant introduced by the other directly to avoid the commission under this agreement.</p></section>
{{#if coBroke.note}}<section><h2>Further terms</h2><p>{{coBroke.note}}</p></section>{{/if}}
${sign([
  ['agency', 'Listing agent'],
  ['co_agency', 'Co-agent'],
])}
${footer(false)}
</article>`;

// ------------------------------------------------------------------------------------------------- addendum

const addendumTh = `<article class="contract">
<header><h1>บันทึกข้อตกลงแนบท้ายสัญญาเช่า</h1>${disclaimer}${meta(true)}</header>
<section><h2>สัญญาเช่าที่แก้ไขเพิ่มเติม</h2>
<p>บันทึกนี้แนบท้ายสัญญาเช่า{{#if lease.number}} เลขที่ {{lease.number}}{{/if}} ระหว่างผู้ให้เช่า ${party('lessor')} กับผู้เช่า <b>{{lessee.displayName}}</b> สำหรับ${premises(true)} ระยะเวลาเช่า {{lease.startDate}} ถึง {{lease.endDate}}</p></section>
<section><h2>ข้อตกลงเพิ่มเติม</h2>
<p>มีผลตั้งแต่วันที่ {{addendum.effectiveDate}}</p>
<ol class="items">{{#each addendum.clauses}}<li><b>{{this.title}}</b> {{this.text}}</li>{{/each}}</ol></section>
<section><h2>ความสัมพันธ์กับสัญญาเช่า</h2>
<p>ข้อความอื่นของสัญญาเช่าคงเดิม ข้อตกลงใดในบันทึกนี้ที่ขัดหรือแย้งกับประกาศคณะกรรมการว่าด้วยสัญญา พ.ศ. ๒๕๖๘ ไม่มีผลใช้บังคับ ผู้ให้เช่าจะไม่ปรับค่าเช่าก่อนสัญญาสิ้นสุดและไม่เรียกเก็บค่าต่อสัญญา</p></section>
${sign([
  ['lessor', 'ผู้ให้เช่า'],
  ['lessee', 'ผู้เช่า'],
])}
${footer(true)}
</article>`;

const addendumEn = `<article class="contract">
<header><h1>Lease Addendum</h1>${disclaimer}${meta(false)}</header>
<section><h2>Lease amended</h2>
<p>This addendum forms part of the lease{{#if lease.number}} no. {{lease.number}}{{/if}} between the Lessor ${party('lessor')} and the Lessee <b>{{lessee.displayName}}</b> for ${premises(false)}, from {{lease.startDate}} to {{lease.endDate}}.</p></section>
<section><h2>Additional terms</h2>
<p>Effective from {{addendum.effectiveDate}}.</p>
<ol class="items">{{#each addendum.clauses}}<li><b>{{this.title}}</b> {{this.text}}</li>{{/each}}</ol></section>
<section><h2>Relation to the lease</h2>
<p>All other terms of the lease stay unchanged. A term of this addendum that conflicts with the Contract Committee announcement B.E. 2568 has no effect. The Lessor will not change the rent before the lease ends and charges no renewal fee.</p></section>
${sign([
  ['lessor', 'Lessor'],
  ['lessee', 'Lessee'],
])}
${footer(false)}
</article>`;

// ------------------------------------------------------------------------------------------------- notices (B7.5 letters)

const noticeHead = (th: boolean, title: string) => `<header>
<h1>${title}</h1>
<table class="meta">
<tr><td>${th ? 'เลขที่' : 'No.'}</td><td>{{number}}</td></tr>
<tr><td>${th ? 'วันที่' : 'Date'}</td><td>{{issuedOn}}</td></tr>
<tr><td>${th ? 'จาก' : 'From'}</td><td>{{lessor.legalName}}, {{lessor.address}}</td></tr>
<tr><td>${th ? 'เรียน' : 'To'}</td><td>{{lessee.displayName}}</td></tr>
</table>
</header>`;
const noticeSign = (th: boolean) =>
  `<section class="signatures"><table class="sign"><tr><td></td><td><div>${th ? 'ลงชื่อ' : 'Signed'} ........................................ ${th ? 'ผู้ให้เช่า' : 'Lessor'}</div><div>({{lessor.legalName}})</div><div class="when">${th ? 'ส่งทางอิเล็กทรอนิกส์เมื่อ' : 'Sent electronically on'} {{issuedOn}}</div></td></tr></table></section>`;
const noticeNote = (th: boolean) =>
  `{{#if message}}<section><h2>${th ? 'หมายเหตุจากผู้ให้เช่า' : 'Note from the Lessor'}</h2><p>{{message}}</p></section>{{/if}}`;

const renewalTh = `<article class="notice">${noticeHead(true, 'หนังสือเสนอต่อสัญญาเช่า')}
<section><h2>สัญญาเช่าปัจจุบัน</h2><p>ตามสัญญาเช่า{{#if lease.number}} เลขที่ {{lease.number}}{{/if}} ห้อง {{premises.unitNo}} {{premises.propertyName}} ค่าเช่าเดือนละ {{lease.rent}} บาท ซึ่งจะสิ้นสุดวันที่ {{lease.endDate}}</p></section>
<section><h2>ข้อเสนอ</h2><p>ผู้ให้เช่าเสนอต่อสัญญาเช่าอีก <b>{{renewalMonths}} เดือน</b> ตั้งแต่วันที่ <b>{{effectiveDate}}</b> ค่าเช่าเดือนละ <b>{{newRent}} บาท</b> ({{newRentText}}) เงื่อนไขอื่นคงเดิม และไม่มีค่าต่อสัญญา</p></section>
<section><h2>การตอบรับ</h2><p>หากประสงค์จะต่อสัญญา โปรดตอบรับในแอปภายในวันที่ <b>{{respondBy}}</b> สัญญาฉบับใหม่จะส่งให้ลงนามทางอิเล็กทรอนิกส์</p></section>
${noticeNote(true)}${noticeSign(true)}</article>`;

const renewalEn = `<article class="notice">${noticeHead(false, 'Offer to renew the lease')}
<section><h2>Current lease</h2><p>The lease{{#if lease.number}} no. {{lease.number}}{{/if}} of {{premises.unitNo}}, {{premises.propertyName}}, at THB {{lease.rent}} per month ends on {{lease.endDate}}.</p></section>
<section><h2>Offer</h2><p>The Lessor offers to renew the lease for <b>{{renewalMonths}} months</b> from <b>{{effectiveDate}}</b> at <b>THB {{newRent}}</b> ({{newRentText}}) per month, on the same other terms and with no renewal fee.</p></section>
<section><h2>Reply</h2><p>If you wish to renew, please accept in the app by <b>{{respondBy}}</b>. The new lease will be sent to you for electronic signature.</p></section>
${noticeNote(false)}${noticeSign(false)}</article>`;

const terminationTh = `<article class="notice">${noticeHead(true, 'หนังสือบอกเลิกสัญญาเช่า')}
<section><h2>สัญญาเช่า</h2><p>ตามสัญญาเช่า{{#if lease.number}} เลขที่ {{lease.number}}{{/if}} ห้อง {{premises.unitNo}} {{premises.propertyName}} ระยะเวลา {{lease.startDate}} ถึง {{lease.endDate}}</p></section>
<section><h2>การบอกเลิก</h2><p>ผู้ให้เช่าขอบอกเลิกสัญญาเช่าโดยมีผลตั้งแต่วันที่ <b>{{effectiveDate}}</b> หนังสือนี้แจ้งล่วงหน้า {{noticeDays}} วัน</p></section>
<section><h2>การส่งมอบและเงินประกัน</h2><p>โปรดส่งมอบห้องคืนภายในวันดังกล่าว ผู้ให้เช่าจะคืนเงินประกันภายใน {{refundDays}} วันนับแต่วันส่งมอบคืน โดยหักเฉพาะความเสียหายหรือหนี้ที่มีหลักฐาน</p></section>
<section><h2>ข้อปฏิบัติของผู้ให้เช่า</h2><p>ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ เปลี่ยนกุญแจ ปิดกั้นการเข้าใช้ห้อง หรือขนย้ายทรัพย์สินของผู้เช่า</p></section>
${noticeNote(true)}${noticeSign(true)}</article>`;

const terminationEn = `<article class="notice">${noticeHead(false, 'Notice of termination')}
<section><h2>The lease</h2><p>The lease{{#if lease.number}} no. {{lease.number}}{{/if}} of {{premises.unitNo}}, {{premises.propertyName}}, from {{lease.startDate}} to {{lease.endDate}}.</p></section>
<section><h2>Termination</h2><p>The Lessor terminates the lease with effect from <b>{{effectiveDate}}</b>. This notice is given {{noticeDays}} days in advance.</p></section>
<section><h2>Hand-back and deposit</h2><p>Please hand the premises back by that date. The Lessor returns the deposit within {{refundDays}} days of the hand-back, deducting only evidenced damage or unpaid amounts.</p></section>
<section><h2>The Lessor's undertakings</h2><p>The Lessor will not cut off water or electricity, change the locks, block access to the premises or remove the Lessee's belongings.</p></section>
${noticeNote(false)}${noticeSign(false)}</article>`;

const NAMES: Record<string, [string, string]> = {
  reservation: ['สัญญาจองห้องเช่า (ร่างจากคลังสัญญา)', 'Reservation agreement (library draft)'],
  brokerage_mandate: ['สัญญาแต่งตั้งนายหน้า (ร่างจากคลังสัญญา)', 'Brokerage mandate (library draft)'],
  co_broke: ['สัญญาความร่วมมือระหว่างนายหน้า (ร่างจากคลังสัญญา)', 'Co-broke agreement (library draft)'],
  addendum: ['บันทึกข้อตกลงแนบท้ายสัญญาเช่า (ร่างจากคลังสัญญา)', 'Lease addendum (library draft)'],
  notice_renewal: ['หนังสือเสนอต่อสัญญาเช่า (ร่างจากคลังสัญญา)', 'Renewal offer letter (library draft)'],
  notice_termination: ['หนังสือบอกเลิกสัญญาเช่า (ร่างจากคลังสัญญา)', 'Termination letter (library draft)'],
};

const BODIES: Record<string, Record<ContractLanguage, string>> = {
  reservation: { th: reservationTh, en: reservationEn },
  brokerage_mandate: { th: mandateTh, en: mandateEn },
  co_broke: { th: coBrokeTh, en: coBrokeEn },
  addendum: { th: addendumTh, en: addendumEn },
  notice_renewal: { th: renewalTh, en: renewalEn },
  notice_termination: { th: terminationTh, en: terminationEn },
};

export const libraryTemplateKey = (kind: ContractKind) => `library_${kind}`;

/** Every seeded library draft: 6 kinds × th / en. */
export function libraryTemplates(): LibraryTemplate[] {
  return Object.keys(BODIES).flatMap((kind) =>
    (['th', 'en'] as const).map((language) => ({
      key: libraryTemplateKey(kind as ContractKind),
      kind: kind as ContractKind,
      name: NAMES[kind]![0],
      language,
      legalRef: language === 'en' ? REF_EN : REF_TH,
      body: BODIES[kind]![language],
    })),
  );
}
