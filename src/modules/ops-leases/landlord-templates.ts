import { type ContractLanguage } from './contract-renderer';
import { CLAUSE_SCHEMA, FORBIDDEN_CLAUSE_TYPES } from './contract-template';

/**
 * Standard leases for self-managing owners (B7.5, D-253): one template per unit kind — condo unit, house, room in
 * an owner's house — each written in Thai and English, seeded **published** as platform templates (tenant_id NULL;
 * founder 2026-10-24). ⚖ O-017: drafted by Claude from the hire-of-property title of the Civil and Commercial Code
 * (ss. 537–571) with the protections of the สคบ. 2568 announcement kept as the safe default even below its unit
 * threshold (D-020, D-158); counsel revises the wording later as new versions — running leases keep theirs.
 *
 * The bodies are assembled from shared clauses plus the clauses that differ by kind (premises, common charges, use
 * of the property) so a correction lands in all six texts at once. Handlebars, HTML-escaped, `ContractData` (the
 * English texts read the `en.*` values and the `*En` fields).
 */
export type LandlordTemplateKind = 'condo_unit' | 'house' | 'room';

export const LANDLORD_TEMPLATE_KINDS: LandlordTemplateKind[] = ['condo_unit', 'house', 'room'];
export const LANDLORD_TEMPLATE_VERSION = 1;
export const LANDLORD_TEMPLATE_EFFECTIVE_FROM = '2026-10-25';
export const LANDLORD_TEMPLATE_LEGAL_REF =
  'ประมวลกฎหมายแพ่งและพาณิชย์ มาตรา 537–571 (เช่าทรัพย์); ประกาศคณะกรรมการว่าด้วยสัญญา พ.ศ. 2568 (ใช้เป็นมาตรฐานขั้นต่ำ, D-020); ประมวลรัษฎากร บัญชีอัตราอากรแสตมป์ ลักษณะแห่งตราสาร 1 (O-019) ⚖ O-017';
export const LANDLORD_TEMPLATE_LEGAL_REF_EN =
  'Civil and Commercial Code ss. 537–571 (hire of property); Contract Committee announcement B.E. 2568 on residential rentals (applied as the minimum standard, D-020); Revenue Code, schedule of stamp duties, instrument 1 (O-019) ⚖ O-017';
export const landlordLegalRef = (language: ContractLanguage) =>
  language === 'en' ? LANDLORD_TEMPLATE_LEGAL_REF_EN : LANDLORD_TEMPLATE_LEGAL_REF;
export { CLAUSE_SCHEMA as LANDLORD_CLAUSE_SCHEMA, FORBIDDEN_CLAUSE_TYPES as LANDLORD_FORBIDDEN_CLAUSE_TYPES };

export const landlordTemplateKey = (kind: LandlordTemplateKind) => `landlord_${kind}`;

/** The template kind of a unit: the portfolio kind the landlord chose (a townhouse is a house), else the unit type. */
export function landlordTemplateKind(
  portfolioKind: string | null | undefined,
  unitType: string,
): LandlordTemplateKind {
  const kind = portfolioKind ?? unitType;
  if (kind === 'condo_unit') return 'condo_unit';
  if (kind === 'house' || kind === 'townhouse') return 'house';
  return 'room';
}

export const LANDLORD_TEMPLATE_NAMES: Record<LandlordTemplateKind, string> = {
  condo_unit: 'สัญญาเช่าห้องชุด (เจ้าของให้เช่าเอง)',
  house: 'สัญญาเช่าบ้าน (เจ้าของให้เช่าเอง)',
  room: 'สัญญาเช่าห้องพักในบ้าน (เจ้าของให้เช่าเอง)',
};

// ------------------------------------------------------------------------------------------------- Thai

const TH_TITLE: Record<LandlordTemplateKind, string> = {
  condo_unit: 'สัญญาเช่าห้องชุด',
  house: 'สัญญาเช่าบ้าน',
  room: 'สัญญาเช่าห้องพัก',
};

const TH_PREMISES: Record<LandlordTemplateKind, string> = {
  condo_unit: `<p>ผู้ให้เช่าตกลงให้เช่าและผู้เช่าตกลงเช่าห้องชุดเลขที่ <b>{{premises.unitNo}}</b> {{premises.floorName}} อาคารชุด {{premises.propertyName}} ตั้งอยู่ที่ {{premises.address}}{{#if premises.areaSqm}} พื้นที่ห้องชุดประมาณ {{premises.areaSqm}} ตารางเมตร{{/if}} ซึ่งผู้ให้เช่าเป็นเจ้าของกรรมสิทธิ์ เพื่อใช้เป็นที่อยู่อาศัยเท่านั้น</p>`,
  house: `<p>ผู้ให้เช่าตกลงให้เช่าและผู้เช่าตกลงเช่าบ้านเลขที่ <b>{{premises.unitNo}}</b> {{premises.propertyName}} ตั้งอยู่ที่ {{premises.address}}{{#if premises.areaSqm}} พื้นที่ใช้สอยประมาณ {{premises.areaSqm}} ตารางเมตร{{/if}} พร้อมที่ดินและบริเวณบ้าน ซึ่งผู้ให้เช่าเป็นเจ้าของกรรมสิทธิ์ เพื่อใช้เป็นที่อยู่อาศัยเท่านั้น</p>`,
  room: `<p>ผู้ให้เช่าตกลงให้เช่าและผู้เช่าตกลงเช่าห้องพักเลขที่ <b>{{premises.unitNo}}</b> {{premises.floorName}} ในบ้านหรืออาคาร {{premises.buildingName}} ({{premises.propertyName}}) ตั้งอยู่ที่ {{premises.address}}{{#if premises.areaSqm}} พื้นที่ประมาณ {{premises.areaSqm}} ตารางเมตร{{/if}} เพื่อใช้เป็นที่อยู่อาศัยเท่านั้น และมีสิทธิใช้พื้นที่ส่วนกลางของบ้านร่วมกับผู้อยู่อาศัยอื่นตามสมควร</p>`,
};

const TH_CHARGES: Record<LandlordTemplateKind, string> = {
  condo_unit:
    'ผู้ให้เช่าเป็นผู้ชำระค่าใช้จ่ายส่วนกลาง เงินกองทุน และค่าใช้จ่ายอื่นที่นิติบุคคลอาคารชุดเรียกเก็บจากเจ้าของห้องชุด รวมถึงภาษีที่ดินและสิ่งปลูกสร้าง ผู้ให้เช่าจะไม่เรียกเก็บค่าใช้จ่ายเหล่านี้จากผู้เช่า',
  house:
    'ผู้ให้เช่าเป็นผู้ชำระภาษีที่ดินและสิ่งปลูกสร้าง และค่าส่วนกลางของหมู่บ้านหรือโครงการ (ถ้ามี) ผู้ให้เช่าจะไม่เรียกเก็บค่าใช้จ่ายเหล่านี้จากผู้เช่า',
  room: 'ผู้ให้เช่าเป็นผู้ชำระภาษีที่ดินและสิ่งปลูกสร้าง และค่าใช้จ่ายของพื้นที่ส่วนกลางของบ้าน ผู้ให้เช่าจะไม่เรียกเก็บค่าใช้จ่ายเหล่านี้จากผู้เช่า',
};

const TH_USE: Record<LandlordTemplateKind, string> = {
  condo_unit: `<li>ผู้เช่าตกลงปฏิบัติตามข้อบังคับและระเบียบของนิติบุคคลอาคารชุด ผู้ให้เช่าจะแจ้งชื่อผู้เช่าต่อนิติบุคคลอาคารชุดและส่งมอบบัตรผ่านหรืออุปกรณ์เข้าออกอาคารที่ได้รับมา</li>
<li>ผู้เช่าจะไม่ต่อเติม ดัดแปลง หรือเจาะผนังห้องชุดโดยไม่ได้รับความยินยอมเป็นหนังสือจากผู้ให้เช่าและนิติบุคคลอาคารชุด</li>`,
  house: `<li>ผู้เช่าจะดูแลรักษาบ้าน บริเวณบ้าน และสวนตามสมควรเยี่ยงวิญญูชนจะพึงสงวนทรัพย์สินของตนเอง</li>
<li>ผู้เช่าจะไม่ต่อเติม ดัดแปลง หรือรื้อถอนส่วนใดของบ้านโดยไม่ได้รับความยินยอมเป็นหนังสือจากผู้ให้เช่า และปฏิบัติตามระเบียบของหมู่บ้านหรือโครงการ (ถ้ามี)</li>`,
  room: `<li>ผู้เช่าจะใช้พื้นที่ส่วนกลางของบ้าน เช่น ครัว ห้องน้ำรวม และที่ซักล้าง ร่วมกับผู้อยู่อาศัยอื่นตามสมควร รักษาความสะอาด และเคารพความเป็นส่วนตัวของผู้อยู่อาศัยอื่น</li>
<li>ผู้เช่าจะไม่ต่อเติมหรือดัดแปลงห้องพักโดยไม่ได้รับความยินยอมเป็นหนังสือจากผู้ให้เช่า</li>`,
};

const th = (kind: LandlordTemplateKind) => `<article class="contract">
<header>
<h1>${TH_TITLE[kind]}</h1>
<p class="sub">ระหว่างเจ้าของทรัพย์สินกับผู้เช่า เพื่อใช้เป็นที่อยู่อาศัย</p>
{{#if draft}}<p class="draft">ร่างสัญญา — ยังไม่มีผลผูกพัน</p>{{/if}}
<table class="meta">
<tr><td>เลขที่สัญญา</td><td>{{#if contract.number}}{{contract.number}}{{else}}(ออกเลขเมื่อส่งลงนาม){{/if}}</td></tr>
<tr><td>ทำที่</td><td>{{contract.madeAt}}</td></tr>
<tr><td>วันที่</td><td>{{contract.madeOn}}</td></tr>
</table>
</header>

<section>
<p>สัญญานี้ทำขึ้นระหว่าง <b>{{lessor.legalName}}</b>{{#if lessor.taxId}} เลขประจำตัวผู้เสียภาษี {{lessor.taxId}}{{/if}}{{#if lessor.address}} ที่อยู่ {{lessor.address}}{{/if}} ซึ่งต่อไปในสัญญานี้เรียกว่า “ผู้ให้เช่า” ฝ่ายหนึ่ง</p>
<p>กับ <b>{{lessee.displayName}}</b> {{lessee.idDocumentLabel}} {{lessee.idNumber}}{{#if lessee.nationality}} สัญชาติ {{lessee.nationality}}{{/if}}{{#if lessee.address}} ที่อยู่ {{lessee.address}}{{/if}}{{#if lessee.phone}} โทรศัพท์ {{lessee.phone}}{{/if}} ซึ่งต่อไปในสัญญานี้เรียกว่า “ผู้เช่า” อีกฝ่ายหนึ่ง{{#if coTenants.length}} โดยมีผู้เช่าร่วม ได้แก่ {{#each coTenants}}{{#if @index}}, {{/if}}{{this.displayName}}{{/each}}{{/if}}</p>
<p>ทั้งสองฝ่ายตกลงทำสัญญากันดังต่อไปนี้</p>
</section>

<section>
<h2>ข้อ ๑ ทรัพย์สินที่ให้เช่า</h2>
${TH_PREMISES[kind]}
<p>พร้อมทรัพย์สินและอุปกรณ์ ดังนี้{{#unless premises.equipment.length}} — ไม่มี —{{/unless}}</p>
{{#if premises.equipment.length}}<ol class="items">{{#each premises.equipment}}<li>{{this.name}}{{#if this.location}} ({{this.location}}){{/if}}</li>{{/each}}</ol>{{/if}}
<p>กุญแจ {{premises.keysCount}} ดอก{{#if premises.parkingSlots}} และสิทธิที่จอดรถ {{premises.parkingSlots}} คัน{{/if}} สภาพของทรัพย์สินเป็นไปตามบันทึกการตรวจรับสภาพพร้อมภาพถ่ายแนบท้ายสัญญา</p>
</section>

<section>
<h2>ข้อ ๒ ระยะเวลาเช่า</h2>
<p>สัญญาเช่ามีกำหนด {{term.months}} เดือน เริ่มตั้งแต่วันที่ {{term.startDate}} สิ้นสุดวันที่ {{term.endDate}} หากคู่สัญญาประสงค์จะต่อสัญญา ให้ทำสัญญาฉบับใหม่ โดยผู้ให้เช่าจะไม่เรียกเก็บค่าต่อสัญญา</p>
</section>

<section>
<h2>ข้อ ๓ ค่าเช่าและการชำระ</h2>
<p>ผู้เช่าตกลงชำระค่าเช่าเดือนละ <b>{{rent.amount}} บาท</b> ({{rent.text}}) ภายในวันที่ {{rent.dueDay}} ของทุกเดือน ผ่านช่องทาง Thai QR ตามใบแจ้งหนี้หรือโอนเข้าบัญชีของผู้ให้เช่าที่ระบุในใบแจ้งหนี้ ผู้ให้เช่าจะออกใบเสร็จรับเงินให้ทุกครั้งที่ได้รับชำระ</p>
{{#if rentIncreases.length}}<p>คู่สัญญาตกลงไว้ ณ วันทำสัญญาว่าค่าเช่าจะเปลี่ยนแปลงตามกำหนดดังต่อไปนี้เท่านั้น</p>
<ol class="items">{{#each rentIncreases}}<li>ตั้งแต่วันที่ {{this.effectiveFrom}} ค่าเช่าเดือนละ {{this.amount}} บาท ({{this.text}})</li>{{/each}}</ol>{{/if}}
<p>ผู้ให้เช่าจะไม่เปลี่ยนแปลงอัตราค่าเช่าหรือค่าบริการก่อนสัญญาสิ้นสุด{{#if rentIncreases.length}} เว้นแต่ตามกำหนดที่ตกลงไว้ข้างต้น{{/if}}</p>
</section>

<section>
<h2>ข้อ ๔ ค่าสาธารณูปโภค</h2>
{{#if utilities.metered}}<p>ผู้เช่าชำระค่าไฟฟ้าและค่าน้ำประปาตามจำนวนหน่วยที่ใช้จริงตามมิเตอร์ ในอัตราไม่เกินอัตราที่{{utilities.electricProvider}}และ{{utilities.waterProvider}}เรียกเก็บ ใบแจ้งหนี้แสดงเลขมิเตอร์ จำนวนหน่วยที่ใช้ และอัตราต่อหน่วย</p>
{{else}}<p>ค่าไฟฟ้าและค่าน้ำประปารวมอยู่ในค่าเช่าตามข้อ ๓ แล้ว ผู้ให้เช่าจะไม่เรียกเก็บแยกต่างหาก</p>{{/if}}
</section>

<section>
<h2>ข้อ ๕ ค่าส่วนกลาง ภาษี และค่าบริการอื่น</h2>
<p>${TH_CHARGES[kind]}</p>
{{#if lines.length}}<p>ผู้เช่าตกลงชำระค่าบริการที่ตกลงกันไว้ ดังนี้</p>
<table class="lines">{{#each lines}}<tr><td>{{this.description}}</td><td class="num">{{this.amount}} บาท</td><td>{{this.recurrence}}</td></tr>{{/each}}</table>
{{else}}<p>ไม่มีค่าบริการอื่นนอกจากที่ระบุในสัญญานี้</p>{{/if}}
</section>

<section>
<h2>ข้อ ๖ เงินประกันและค่าเช่าล่วงหน้า</h2>
<p>ในวันทำสัญญา ผู้เช่าได้วางเงินประกันการเช่าจำนวน <b>{{deposit.amount}} บาท</b> ({{deposit.text}}) และชำระค่าเช่าล่วงหน้าจำนวน <b>{{advanceRent.amount}} บาท</b> ({{advanceRent.text}}) ผู้ให้เช่าจะออกใบรับเงินประกันและค่าเช่าล่วงหน้าให้ผู้เช่า</p>
</section>

<section>
<h2>ข้อ ๗ การใช้ทรัพย์สิน</h2>
<ol class="items">
<li>ผู้เช่าจะใช้ทรัพย์สินที่เช่าเป็นที่อยู่อาศัยเท่านั้น และจะไม่ใช้เพื่อการอันผิดกฎหมายหรือก่อความเดือดร้อนรำคาญแก่ผู้อื่น</li>
${TH_USE[kind]}
<li>ผู้เช่าจะไม่ให้เช่าช่วงหรือโอนสิทธิการเช่าไม่ว่าทั้งหมดหรือบางส่วน เว้นแต่ได้รับความยินยอมเป็นหนังสือจากผู้ให้เช่า</li>
</ol>
</section>

<section>
<h2>ข้อ ๘ การซ่อมแซม</h2>
<p>ผู้ให้เช่ารับผิดชอบการซ่อมแซมใหญ่และความชำรุดบกพร่องที่เกิดจากการใช้งานตามปกติของทรัพย์สินและอุปกรณ์ ผู้เช่ารับผิดชอบการบำรุงรักษาเล็กน้อยตามปกติ และความเสียหายที่ผู้เช่าหรือบริวารเป็นผู้ก่อ ผู้เช่าแจ้งเหตุชำรุดผ่านแอปพลิเคชันพร้อมภาพถ่ายได้ทันที และผู้ให้เช่าจะแจ้งกำหนดการซ่อมภายในเวลาอันสมควร</p>
</section>

<section>
<h2>ข้อ ๙ การตรวจรับสภาพและการเข้าตรวจทรัพย์สิน</h2>
<p>คู่สัญญาจะตรวจสภาพทรัพย์สินร่วมกันเมื่อส่งมอบและเมื่อส่งคืน จัดทำบันทึกพร้อมภาพถ่ายที่ทั้งสองฝ่ายยืนยัน ผู้ให้เช่าจะเข้าไปในทรัพย์สินที่เช่าเพื่อตรวจหรือซ่อมแซมได้เมื่อแจ้งให้ผู้เช่าทราบล่วงหน้าและในเวลาอันสมควร เว้นแต่มีเหตุฉุกเฉิน</p>
</section>

<section>
<h2>ข้อ ๑๐ การคืนเงินประกัน</h2>
<p>เมื่อสัญญาสิ้นสุดและผู้เช่าส่งมอบทรัพย์สินคืนแล้ว ผู้ให้เช่าจะคืนเงินประกันภายใน {{refundDays}} วัน หากมีความเสียหายที่ผู้เช่าเป็นผู้ก่อหรือมีหนี้ค้างชำระ ผู้ให้เช่าจะแจ้งรายการหักพร้อมหลักฐานเป็นหนังสือ หักเฉพาะจำนวนดังกล่าว และคืนส่วนที่เหลือภายในระยะเวลาเดียวกัน ผู้ให้เช่าจะไม่หักค่าเสื่อมสภาพจากการใช้งานตามปกติ</p>
</section>

<section>
<h2>ข้อ ๑๑ การบอกเลิกสัญญาของผู้เช่า</h2>
<p>ผู้เช่ามีสิทธิบอกเลิกสัญญาก่อนครบกำหนด โดยแจ้งเป็นหนังสือหรือผ่านแอปพลิเคชันให้ผู้ให้เช่าทราบล่วงหน้าไม่น้อยกว่า {{noticeDays}} วัน</p>
</section>

<section>
<h2>ข้อ ๑๒ การบอกเลิกสัญญาของผู้ให้เช่า</h2>
<p class="termination">ผู้ให้เช่ามีสิทธิบอกเลิกสัญญาได้เฉพาะกรณี (ก) ผู้เช่าผิดสัญญาในข้อที่เป็นสาระสำคัญ รวมถึงค้างชำระค่าเช่า โดยผู้ให้เช่าได้มีหนังสือแจ้งให้ผู้เช่าแก้ไขภายในเวลาไม่น้อยกว่า {{remedyDays}} วัน และผู้เช่าไม่แก้ไข หรือ (ข) ผู้เช่ากระทำการอันกระทบต่อความปลอดภัยหรือความสงบสุขของผู้อื่น โดยผู้ให้เช่าได้มีหนังสือเตือนล่วงหน้าไม่น้อยกว่า {{disturbanceDays}} วัน</p>
<p>ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ เปลี่ยนกุญแจ ปิดกั้นการเข้าใช้ทรัพย์สิน หรือขนย้ายทรัพย์สินของผู้เช่า เพราะเหตุค้างชำระ</p>
</section>

<section>
<h2>ข้อ ๑๓ อากรแสตมป์</h2>
{{#if stampDuty}}<p>สัญญานี้ต้องเสียอากรแสตมป์ตามประมวลรัษฎากรจำนวน {{stampDuty.amount}} บาท ({{stampDuty.text}}) โดย{{stampDuty.payerTh}}เป็นผู้ชำระ</p>
{{else}}<p>คู่สัญญาจะชำระอากรแสตมป์ตามประมวลรัษฎากร โดยผู้ให้เช่าเป็นผู้ชำระ เว้นแต่จะตกลงกันเป็นอย่างอื่นเป็นหนังสือ</p>{{/if}}
</section>

<section>
<h2>ข้อ ๑๔ ข้อตกลงเพิ่มเติม</h2>
{{#if addendum.length}}<ol class="items">{{#each addendum}}<li><b>{{this.title}}</b> {{this.text}}</li>{{/each}}</ol>
{{else}}<p>— ไม่มี —</p>{{/if}}
<p>ข้อตกลงเพิ่มเติมใดที่ขัดต่อกฎหมายหรือทำให้ผู้เช่าได้รับความคุ้มครองน้อยกว่าที่สัญญานี้กำหนด ไม่มีผลใช้บังคับ</p>
</section>

<section>
<h2>ข้อ ๑๕ การลงนามและคู่ฉบับ</h2>
<p>คู่สัญญาตกลงลงลายมือชื่ออิเล็กทรอนิกส์ในสัญญานี้ ผู้เช่ายืนยันตัวตนด้วยรหัส OTP ทางโทรศัพท์และบัญชี LINE ระบบบันทึกเวลาและค่าแฮช SHA-256 ของเอกสารที่ลงนาม สัญญานี้มีข้อความตรงกันสองฉบับ คู่สัญญาได้รับฉบับอิเล็กทรอนิกส์ทันทีที่ลงนามครบถ้วน</p>
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

// ----------------------------------------------------------------------------------------------- English

const EN_TITLE: Record<LandlordTemplateKind, string> = {
  condo_unit: 'Condominium Unit Lease Agreement',
  house: 'House Lease Agreement',
  room: 'Room Lease Agreement',
};

const EN_PREMISES: Record<LandlordTemplateKind, string> = {
  condo_unit: `<p>The Lessor agrees to let and the Lessee agrees to rent condominium unit no. <b>{{premises.unitNo}}</b>, {{premises.floorName}}, {{premises.propertyName}} condominium, located at {{premises.address}}{{#if premises.areaSqm}}, approximately {{premises.areaSqm}} square metres{{/if}}, owned by the Lessor, for residential use only.</p>`,
  house: `<p>The Lessor agrees to let and the Lessee agrees to rent the house no. <b>{{premises.unitNo}}</b>, {{premises.propertyName}}, located at {{premises.address}}{{#if premises.areaSqm}}, with approximately {{premises.areaSqm}} square metres of usable area{{/if}}, together with its land and grounds, owned by the Lessor, for residential use only.</p>`,
  room: `<p>The Lessor agrees to let and the Lessee agrees to rent room no. <b>{{premises.unitNo}}</b>, {{premises.floorName}}, in the house or building {{premises.buildingName}} ({{premises.propertyName}}), located at {{premises.address}}{{#if premises.areaSqm}}, approximately {{premises.areaSqm}} square metres{{/if}}, for residential use only, with reasonable shared use of the common areas of the house.</p>`,
};

const EN_CHARGES: Record<LandlordTemplateKind, string> = {
  condo_unit:
    'The Lessor pays the common-area charges, sinking fund and any other charges the juristic person of the condominium levies on the unit owner, as well as the land and building tax, and will not pass them on to the Lessee.',
  house:
    'The Lessor pays the land and building tax and the estate or project common charges (if any), and will not pass them on to the Lessee.',
  room: 'The Lessor pays the land and building tax and the costs of the common areas of the house, and will not pass them on to the Lessee.',
};

const EN_USE: Record<LandlordTemplateKind, string> = {
  condo_unit: `<li>The Lessee will comply with the regulations and rules of the juristic person of the condominium. The Lessor will register the Lessee with the juristic person and hand over the access cards or devices received.</li>
<li>The Lessee will not alter, extend or drill the walls of the unit without the written consent of the Lessor and the juristic person.</li>`,
  house: `<li>The Lessee will look after the house, its grounds and garden with the care a reasonable person takes of their own property.</li>
<li>The Lessee will not extend, alter or demolish any part of the house without the Lessor's written consent, and will follow the estate or project rules (if any).</li>`,
  room: `<li>The Lessee will share the common areas of the house, such as the kitchen, shared bathrooms and laundry area, reasonably with the other occupants, keep them clean and respect the privacy of the other occupants.</li>
<li>The Lessee will not alter the room without the Lessor's written consent.</li>`,
};

const en = (kind: LandlordTemplateKind) => `<article class="contract">
<header>
<h1>${EN_TITLE[kind]}</h1>
<p class="sub">Between the owner of the property and the lessee, for residential use</p>
{{#if draft}}<p class="draft">DRAFT — NOT BINDING</p>{{/if}}
<table class="meta">
<tr><td>Lease no.</td><td>{{#if contract.number}}{{contract.number}}{{else}}(numbered when sent for signature){{/if}}</td></tr>
<tr><td>Made at</td><td>{{contract.madeAt}}</td></tr>
<tr><td>Date</td><td>{{en.madeOn}}</td></tr>
</table>
</header>

<section>
<p>This agreement is made between <b>{{lessor.legalName}}</b>{{#if lessor.taxId}}, tax identification no. {{lessor.taxId}}{{/if}}{{#if lessor.address}}, of {{lessor.address}}{{/if}}, hereinafter the “Lessor”, of the one part,</p>
<p>and <b>{{lessee.displayName}}</b>, {{en.idDocumentLabel}} {{lessee.idNumber}}{{#if lessee.nationality}}, nationality {{lessee.nationality}}{{/if}}{{#if lessee.address}}, of {{lessee.address}}{{/if}}{{#if lessee.phone}}, telephone {{lessee.phone}}{{/if}}, hereinafter the “Lessee”, of the other part{{#if coTenants.length}}, with co-lessees {{#each coTenants}}{{#if @index}}, {{/if}}{{this.displayName}}{{/each}}{{/if}}.</p>
<p>The parties agree as follows.</p>
</section>

<section>
<h2>1. The premises</h2>
${EN_PREMISES[kind]}
<p>Together with the following fixtures and equipment:{{#unless premises.equipment.length}} — none —{{/unless}}</p>
{{#if premises.equipment.length}}<ol class="items">{{#each premises.equipment}}<li>{{this.name}}{{#if this.location}} ({{this.location}}){{/if}}</li>{{/each}}</ol>{{/if}}
<p>{{premises.keysCount}} key(s){{#if premises.parkingSlots}} and the right to {{premises.parkingSlots}} parking space(s){{/if}}. The condition of the premises is recorded in the inspection report with photographs attached to this agreement.</p>
</section>

<section>
<h2>2. Term</h2>
<p>The lease runs for {{term.months}} months, from {{en.startDate}} to {{en.endDate}}. A renewal is made by a new agreement, and the Lessor charges no renewal fee.</p>
</section>

<section>
<h2>3. Rent and payment</h2>
<p>The Lessee will pay rent of <b>THB {{rent.amount}}</b> ({{en.rentText}}) per month by day {{rent.dueDay}} of each month, through the Thai QR payment on the invoice or by transfer to the Lessor's account stated on the invoice. The Lessor issues a receipt for every payment.</p>
{{#if rentIncreases.length}}<p>The parties agreed on the date of this agreement that the rent will change only as follows:</p>
<ol class="items">{{#each rentIncreases}}<li>from {{this.effectiveFromEn}}, THB {{this.amount}} ({{this.textEn}}) per month</li>{{/each}}</ol>{{/if}}
<p>The Lessor will not change the rent or the service charges before the lease ends{{#if rentIncreases.length}}, except as scheduled above{{/if}}.</p>
</section>

<section>
<h2>4. Utilities</h2>
{{#if utilities.metered}}<p>The Lessee pays for electricity and water by the units actually used according to the meters, at rates not above those charged by {{en.electricProvider}} and {{en.waterProvider}}. Each invoice shows the meter readings, the units used and the rate per unit.</p>
{{else}}<p>Electricity and water are included in the rent under clause 3; the Lessor will not charge for them separately.</p>{{/if}}
</section>

<section>
<h2>5. Common charges, taxes and other services</h2>
<p>${EN_CHARGES[kind]}</p>
{{#if lines.length}}<p>The Lessee will pay the following agreed services:</p>
<table class="lines">{{#each lines}}<tr><td>{{this.description}}</td><td class="num">THB {{this.amount}}</td><td>{{this.recurrenceEn}}</td></tr>{{/each}}</table>
{{else}}<p>There are no other service charges than those stated in this agreement.</p>{{/if}}
</section>

<section>
<h2>6. Security deposit and advance rent</h2>
<p>On signing, the Lessee has placed a security deposit of <b>THB {{deposit.amount}}</b> ({{en.depositText}}) and paid advance rent of <b>THB {{advanceRent.amount}}</b> ({{en.advanceText}}). The Lessor issues a receipt for the deposit and advance rent.</p>
</section>

<section>
<h2>7. Use of the premises</h2>
<ol class="items">
<li>The Lessee will use the premises as a residence only, and not for any unlawful purpose or in a way that causes nuisance to others.</li>
${EN_USE[kind]}
<li>The Lessee will not sublet or assign the lease, in whole or in part, without the Lessor's written consent.</li>
</ol>
</section>

<section>
<h2>8. Repairs</h2>
<p>The Lessor is responsible for major repairs and for defects arising from normal use of the premises and equipment. The Lessee is responsible for minor routine maintenance and for damage caused by the Lessee or their household. The Lessee can report a defect with photographs in the app at any time, and the Lessor will schedule the repair within a reasonable time.</p>
</section>

<section>
<h2>9. Condition reports and entry</h2>
<p>The parties inspect the premises together at hand-over and at hand-back and record a report with photographs confirmed by both. The Lessor may enter the premises to inspect or repair them after notifying the Lessee in advance and at a reasonable time, except in an emergency.</p>
</section>

<section>
<h2>10. Return of the deposit</h2>
<p>When the lease ends and the Lessee has handed the premises back, the Lessor will return the deposit within {{refundDays}} days. Where the Lessee caused damage or owes money, the Lessor will give written itemised deductions with evidence, deduct only those amounts and return the balance within the same period. The Lessor will not deduct for normal wear and tear.</p>
</section>

<section>
<h2>11. Termination by the Lessee</h2>
<p>The Lessee may terminate the lease before it ends by giving the Lessor at least {{noticeDays}} days' notice in writing or through the app.</p>
</section>

<section>
<h2>12. Termination by the Lessor</h2>
<p class="termination">The Lessor may terminate the lease only if (a) the Lessee is in material breach, including unpaid rent, has been given written notice to remedy it within at least {{remedyDays}} days and has not done so, or (b) the Lessee endangers the safety or peace of others and has been warned in writing at least {{disturbanceDays}} days in advance.</p>
<p>The Lessor will not cut off water or electricity, change the locks, block access to the premises or remove the Lessee's belongings because of arrears.</p>
</section>

<section>
<h2>13. Stamp duty</h2>
{{#if stampDuty}}<p>This agreement bears stamp duty under the Revenue Code of THB {{stampDuty.amount}} ({{stampDuty.textEn}}), paid by {{stampDuty.payerEn}}.</p>
{{else}}<p>Stamp duty under the Revenue Code is paid by the Lessor unless the parties agree otherwise in writing.</p>{{/if}}
</section>

<section>
<h2>14. Additional terms</h2>
{{#if addendum.length}}<ol class="items">{{#each addendum}}<li><b>{{this.title}}</b> {{this.text}}</li>{{/each}}</ol>
{{else}}<p>— none —</p>{{/if}}
<p>Any additional term that is unlawful or gives the Lessee less protection than this agreement has no effect.</p>
</section>

<section>
<h2>15. Signature and counterparts</h2>
<p>The parties sign this agreement electronically. The Lessee confirms their identity with a one-time password sent by telephone and their LINE account; the system records the time and the SHA-256 hash of the signed document. This agreement is made in two identical counterparts; each party receives the electronic copy as soon as both have signed.</p>
<p>Where a Thai version of this agreement is signed with it, the Thai version prevails in case of inconsistency.</p>
</section>

<section class="signatures">
<table class="sign">
<tr>
<td>{{#if signatures.lessor}}<img class="sig" src="{{signatures.lessor.imageDataUrl}}" alt="Lessor's signature">{{/if}}<div>Signed ........................................ Lessor</div><div>({{lessor.legalName}})</div>{{#if signatures.lessor}}<div class="when">Signed on {{signatures.lessor.signedAtEn}}</div>{{/if}}</td>
<td>{{#if signatures.lessee}}<img class="sig" src="{{signatures.lessee.imageDataUrl}}" alt="Lessee's signature">{{/if}}<div>Signed ........................................ Lessee</div><div>({{lessee.displayName}})</div>{{#if signatures.lessee}}<div class="when">Signed on {{signatures.lessee.signedAtEn}}</div>{{/if}}</td>
</tr>
</table>
</section>

<footer class="notes">
<p>Template {{template.key}} version {{template.version}} · {{template.legalRef}}</p>
</footer>
</article>`;

/** The Handlebars body of a landlord template (B7.5). */
export function landlordTemplateBody(kind: LandlordTemplateKind, language: ContractLanguage): string {
  return language === 'en' ? en(kind) : th(kind);
}

/** Every seeded landlord template version: 3 kinds × th / en. */
export function landlordTemplates(): {
  key: string;
  name: string;
  kind: LandlordTemplateKind;
  language: ContractLanguage;
  body: string;
}[] {
  return LANDLORD_TEMPLATE_KINDS.flatMap((kind) =>
    (['th', 'en'] as const).map((language) => ({
      key: landlordTemplateKey(kind),
      name: LANDLORD_TEMPLATE_NAMES[kind],
      kind,
      language,
      body: landlordTemplateBody(kind, language),
    })),
  );
}
