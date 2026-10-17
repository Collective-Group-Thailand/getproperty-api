/**
 * The platform standard residential lease (สคบ. 2568), Thai, version 1 (D-020, D-149; docs/compliance/
 * legal-reference.md §2). Seeded into `ops.lease_template(_version)` as the platform template (tenant_id NULL); a new
 * text is a new version, running leases keep theirs. ⚖ Built from the clause structure of the announcement (ข้อ 4–6)
 * pending verification of the Gazette text and the OCPB "แบบ ก" form by legal counsel; the rules it states are
 * enforced by the compliance checks of B2.3/B2.4 whatever the wording.
 *
 * Handlebars, HTML escaped by default; helpers in contract-renderer.ts. Font size ≥ 2 mm (ข้อ 4): 13 pt body.
 * Termination grounds of the lessor are red, bold and underlined (ข้อ 4 (12)).
 */
export const STANDARD_TEMPLATE_KEY = 'ocpb_2568_residential_th';
export const STANDARD_TEMPLATE_VERSION = 1;
export const STANDARD_TEMPLATE_NAME = 'สัญญาเช่าอาคารเพื่ออยู่อาศัย (แบบมาตรฐาน สคบ. 2568)';
export const STANDARD_TEMPLATE_LEGAL_REF =
  'ประกาศคณะกรรมการว่าด้วยสัญญา เรื่อง ให้ธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา พ.ศ. 2568 ข้อ 4–6 (ราชกิจจานุเบกษา เล่ม 142 ตอนพิเศษ 211 ง); legal-reference §2 ⚖';
export const STANDARD_TEMPLATE_EFFECTIVE_FROM = '2025-09-04';

/** Clause types the announcement forbids (ข้อ 5 (1)–(12)); an addendum of these types is refused. */
export const FORBIDDEN_CLAUSE_TYPES = [
  'liability_exclusion',
  'excess_deposit',
  'midterm_increase',
  'forfeiture_without_breach',
  'entry_without_notice',
  'utility_above_tariff',
  'normal_wear_liability',
  'defect_liability',
  'termination_without_breach',
  'lockout_or_removal',
  'renewal_fee',
  'future_terms',
] as const;
export type ForbiddenClauseType = (typeof FORBIDDEN_CLAUSE_TYPES)[number];

/** Addendum clauses a tenant may add (house rules and the like); validated against this list (D-020). */
export const ALLOWED_CLAUSE_TYPES = [
  'house_rules',
  'pets',
  'smoking',
  'guests',
  'quiet_hours',
  'parking_rules',
  'furniture_care',
  'waste',
  'other',
] as const;
export type AllowedClauseType = (typeof ALLOWED_CLAUSE_TYPES)[number];

export const CLAUSE_SCHEMA = {
  allowed: ALLOWED_CLAUSE_TYPES,
  maxClauses: 20,
  maxTextLength: 2000,
  item: { type: 'one of allowed', title: 'text ≤ 200', text: 'text ≤ 2000' },
} as const;

export const STANDARD_TEMPLATE_BODY = `<article class="contract">
<header>
<h1>สัญญาเช่าอาคารเพื่ออยู่อาศัย</h1>
<p class="sub">ตามประกาศคณะกรรมการว่าด้วยสัญญา เรื่อง ให้ธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา พ.ศ. ๒๕๖๘</p>
{{#if draft}}<p class="draft">ร่างสัญญา — ยังไม่มีผลผูกพัน</p>{{/if}}
<table class="meta">
<tr><td>เลขที่สัญญา</td><td>{{#if contract.number}}{{contract.number}}{{else}}(ออกเลขเมื่อส่งลงนาม){{/if}}</td></tr>
<tr><td>ทำที่</td><td>{{contract.madeAt}}</td></tr>
<tr><td>วันที่</td><td>{{contract.madeOn}}</td></tr>
</table>
</header>

<section>
<p>สัญญานี้ทำขึ้นระหว่าง <b>{{lessor.legalName}}</b>{{#if lessor.taxId}} เลขประจำตัวผู้เสียภาษี {{lessor.taxId}}{{/if}} สำนักงานตั้งอยู่ที่ {{lessor.address}} ซึ่งต่อไปในสัญญานี้เรียกว่า “ผู้ให้เช่า” ฝ่ายหนึ่ง</p>
<p>กับ <b>{{lessee.displayName}}</b> {{lessee.idDocumentLabel}} {{lessee.idNumber}}{{#if lessee.nationality}} สัญชาติ {{lessee.nationality}}{{/if}}{{#if lessee.address}} ที่อยู่ {{lessee.address}}{{/if}}{{#if lessee.phone}} โทรศัพท์ {{lessee.phone}}{{/if}} ซึ่งต่อไปในสัญญานี้เรียกว่า “ผู้เช่า” อีกฝ่ายหนึ่ง{{#if coTenants.length}} โดยมีผู้เช่าร่วม ได้แก่ {{#each coTenants}}{{#if @index}}, {{/if}}{{this.displayName}}{{/each}}{{/if}}</p>
<p>ทั้งสองฝ่ายตกลงทำสัญญากันดังต่อไปนี้</p>
</section>

<section>
<h2>ข้อ ๑ ทรัพย์สินที่ให้เช่า</h2>
<p>ผู้ให้เช่าตกลงให้เช่าและผู้เช่าตกลงเช่าห้องเลขที่ <b>{{premises.unitNo}}</b> {{premises.floorName}} {{premises.buildingName}} ({{premises.propertyName}}) ตั้งอยู่ที่ {{premises.address}}{{#if premises.areaSqm}} พื้นที่ประมาณ {{premises.areaSqm}} ตารางเมตร{{/if}} เพื่อใช้เป็นที่อยู่อาศัยเท่านั้น</p>
<p>พร้อมทรัพย์สินและอุปกรณ์ ดังนี้{{#unless premises.equipment.length}} — ไม่มี —{{/unless}}</p>
{{#if premises.equipment.length}}<ol class="items">{{#each premises.equipment}}<li>{{this.name}}{{#if this.location}} ({{this.location}}){{/if}}</li>{{/each}}</ol>{{/if}}
<p>กุญแจห้อง {{premises.keysCount}} ดอก{{#if premises.parkingSlots}} และสิทธิที่จอดรถ {{premises.parkingSlots}} คัน{{/if}} สภาพของห้องและทรัพย์สินเป็นไปตามบันทึกการตรวจรับสภาพแนบท้ายสัญญา</p>
</section>

<section>
<h2>ข้อ ๒ ระยะเวลาเช่า</h2>
<p>สัญญาเช่ามีกำหนด {{term.months}} เดือน เริ่มตั้งแต่วันที่ {{term.startDate}} สิ้นสุดวันที่ {{term.endDate}}</p>
</section>

<section>
<h2>ข้อ ๓ ค่าเช่าและการชำระ</h2>
<p>ผู้เช่าตกลงชำระค่าเช่าเดือนละ <b>{{rent.amount}} บาท</b> ({{rent.text}}) ภายในวันที่ {{rent.dueDay}} ของทุกเดือน ผ่านช่องทาง Thai QR ตามใบแจ้งหนี้หรือโอนเข้าบัญชีของผู้ให้เช่าที่ระบุในใบแจ้งหนี้</p>
{{#if rentIncreases.length}}<p>คู่สัญญาตกลงไว้ ณ วันทำสัญญาว่าค่าเช่าจะเปลี่ยนแปลงตามกำหนดดังต่อไปนี้เท่านั้น</p>
<ol class="items">{{#each rentIncreases}}<li>ตั้งแต่วันที่ {{this.effectiveFrom}} ค่าเช่าเดือนละ {{this.amount}} บาท ({{this.text}})</li>{{/each}}</ol>{{/if}}
<p>ผู้ให้เช่าจะไม่เปลี่ยนแปลงอัตราค่าเช่า ค่าสาธารณูปโภค หรือค่าบริการ ก่อนสัญญาสิ้นสุด{{#if rentIncreases.length}} เว้นแต่ตามกำหนดที่ตกลงไว้ข้างต้น{{/if}}</p>
</section>

<section>
<h2>ข้อ ๔ ค่าสาธารณูปโภค</h2>
{{#if utilities.metered}}<p>ค่าไฟฟ้าและค่าน้ำประปาคิดตามจำนวนหน่วยที่ใช้จริงตามมิเตอร์ประจำห้อง ในอัตราไม่เกินอัตราที่{{utilities.electricProvider}}และ{{utilities.waterProvider}}เรียกเก็บจากผู้ให้เช่า ใบแจ้งหนี้ทุกฉบับแสดงเลขมิเตอร์ครั้งก่อนและครั้งนี้ จำนวนหน่วยที่ใช้ และอัตราต่อหน่วย</p>
{{else}}<p>ค่าไฟฟ้าและค่าน้ำประปารวมอยู่ในค่าเช่าตามข้อ ๓ แล้ว ผู้ให้เช่าจะไม่เรียกเก็บแยกต่างหาก</p>{{/if}}
</section>

<section>
<h2>ข้อ ๕ ค่าบริการอื่น</h2>
{{#if lines.length}}<p>ผู้เช่าตกลงชำระค่าบริการซึ่งเป็นค่าใช้จ่ายตามจริงและสมควร ดังนี้</p>
<table class="lines">{{#each lines}}<tr><td>{{this.description}}</td><td class="num">{{this.amount}} บาท</td><td>{{this.recurrence}}</td></tr>{{/each}}</table>
{{else}}<p>ไม่มีค่าบริการอื่นนอกจากที่ระบุในสัญญานี้</p>{{/if}}
</section>

<section>
<h2>ข้อ ๖ เงินประกันและค่าเช่าล่วงหน้า</h2>
<p>ในวันทำสัญญา ผู้เช่าได้วางเงินประกันการเช่าจำนวน <b>{{deposit.amount}} บาท</b> ({{deposit.text}}) และชำระค่าเช่าล่วงหน้าจำนวน <b>{{advanceRent.amount}} บาท</b> ({{advanceRent.text}}) รวมกันไม่เกินค่าเช่า {{depositCapMonths}} เดือน</p>
</section>

<section>
<h2>ข้อ ๗ ใบแจ้งหนี้</h2>
<p>ผู้ให้เช่าจะส่งใบแจ้งหนี้ค่าเช่า ค่าสาธารณูปโภค และค่าบริการ ให้ผู้เช่าทราบล่วงหน้าไม่น้อยกว่า {{invoiceLeadDays}} วันก่อนถึงกำหนดชำระ โดยแสดงอัตราต่อหน่วยและจำนวนหน่วยที่ใช้ และผู้เช่ามีสิทธิตรวจสอบข้อมูลการคิดค่าใช้จ่ายได้</p>
</section>

<section>
<h2>ข้อ ๘ การตรวจรับสภาพ</h2>
<p>คู่สัญญาจะตรวจสภาพห้องและทรัพย์สินร่วมกันเมื่อส่งมอบห้อง จัดทำบันทึกพร้อมภาพถ่ายแนบท้ายสัญญา และผู้ให้เช่าจะส่งมอบสำเนาให้ผู้เช่า</p>
</section>

<section>
<h2>ข้อ ๙ การคืนเงินประกัน</h2>
<p>เมื่อสัญญาสิ้นสุดและผู้เช่าส่งมอบห้องคืนแล้ว ผู้ให้เช่าจะคืนเงินประกันภายใน {{refundDays}} วัน หากมีความเสียหายที่ผู้เช่าเป็นผู้ก่อหรือมีหนี้ค้างชำระ ผู้ให้เช่าจะแจ้งรายการพร้อมหลักฐานเป็นหนังสือ หักเฉพาะจำนวนดังกล่าว และคืนส่วนที่เหลือภายในระยะเวลาเดียวกัน ผู้ให้เช่าจะไม่หักค่าเสื่อมสภาพจากการใช้งานตามปกติ และจะไม่ริบเงินประกันหรือค่าเช่าล่วงหน้าโดยผู้เช่าไม่ได้ผิดสัญญา</p>
</section>

<section>
<h2>ข้อ ๑๐ การบอกเลิกสัญญาของผู้เช่า</h2>
<p>ผู้เช่ามีสิทธิบอกเลิกสัญญาก่อนครบกำหนด โดยแจ้งเป็นหนังสือหรือผ่านแอปพลิเคชันให้ผู้ให้เช่าทราบล่วงหน้าไม่น้อยกว่า {{noticeDays}} วัน</p>
</section>

<section>
<h2>ข้อ ๑๑ การบอกเลิกสัญญาของผู้ให้เช่า</h2>
<p class="termination">ผู้ให้เช่ามีสิทธิบอกเลิกสัญญาได้เฉพาะกรณี (ก) ผู้เช่าผิดสัญญาในข้อที่เป็นสาระสำคัญ โดยผู้ให้เช่าได้มีหนังสือแจ้งให้ผู้เช่าแก้ไขภายในเวลาไม่น้อยกว่า {{remedyDays}} วัน และผู้เช่าไม่แก้ไข หรือ (ข) ผู้เช่ากระทำการอันกระทบต่อความปลอดภัยหรือความสงบสุขของผู้อยู่อาศัยอื่น โดยผู้ให้เช่าได้มีหนังสือเตือนล่วงหน้าไม่น้อยกว่า {{disturbanceDays}} วัน</p>
</section>

<section>
<h2>ข้อ ๑๒ ข้อปฏิบัติของผู้ให้เช่า</h2>
<ol class="items">
<li>ผู้ให้เช่าจะไม่เข้าไปในห้องเช่าโดยไม่แจ้งให้ผู้เช่าทราบล่วงหน้า เว้นแต่มีเหตุฉุกเฉิน</li>
<li>ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ ปิดกั้นหรือขัดขวางการเข้าใช้ห้องเช่า หรือขนย้ายทรัพย์สินของผู้เช่า เพราะเหตุค้างชำระ</li>
<li>ผู้ให้เช่าจะไม่เรียกเก็บค่าต่อสัญญาเช่าจากผู้เช่ารายเดิม</li>
<li>ผู้ให้เช่ารับผิดในความชำรุดบกพร่องที่เกิดจากการใช้งานตามปกติของอาคารและอุปกรณ์</li>
</ol>
</section>

<section>
<h2>ข้อ ๑๓ ข้อตกลงเพิ่มเติม</h2>
{{#if addendum.length}}<ol class="items">{{#each addendum}}<li><b>{{this.title}}</b> {{this.text}}</li>{{/each}}</ol>
{{else}}<p>— ไม่มี —</p>{{/if}}
<p>ข้อตกลงใดในสัญญานี้หรือเอกสารแนบท้ายที่ขัดหรือแย้งกับประกาศคณะกรรมการว่าด้วยสัญญาข้างต้น ไม่มีผลใช้บังคับ และให้ถือว่าสัญญานี้มีข้อความตามที่ประกาศกำหนด</p>
</section>

<section>
<h2>ข้อ ๑๔ การลงนามและคู่ฉบับ</h2>
<p>คู่สัญญาตกลงลงลายมือชื่ออิเล็กทรอนิกส์ในสัญญานี้ ผู้เช่ายืนยันตัวตนด้วยรหัส OTP ทางโทรศัพท์และบัญชี LINE ระบบบันทึกเวลา และค่าแฮช SHA-256 ของเอกสารที่ลงนาม สัญญานี้มีข้อความตรงกันสองฉบับ ผู้เช่าได้รับฉบับอิเล็กทรอนิกส์ทันทีที่ลงนามครบถ้วน</p>
</section>

<section class="signatures">
<table class="sign">
<tr>
<td>{{#if signatures.lessor}}<img class="sig" src="{{signatures.lessor.imageDataUrl}}" alt="ลายมือชื่อผู้ให้เช่า">{{/if}}<div>ลงชื่อ ........................................ ผู้ให้เช่า</div><div>({{lessor.legalName}})</div>{{#if signatures.lessor}}<div class="when">ลงนามเมื่อ {{signatures.lessor.signedAt}}</div>{{/if}}</td>
<td>{{#if signatures.lessee}}<img class="sig" src="{{signatures.lessee.imageDataUrl}}" alt="ลายมือชื่อผู้เช่า">{{/if}}<div>ลงชื่อ ........................................ ผู้เช่า</div><div>({{lessee.displayName}})</div>{{#if signatures.lessee}}<div class="when">ลงนามเมื่อ {{signatures.lessee.signedAt}}</div>{{/if}}</td>
</tr>
</table>
</section>

<footer class="notes">
<p>แบบสัญญา {{template.key}} ฉบับที่ {{template.version}} · {{template.legalRef}}</p>
</footer>
</article>`;
