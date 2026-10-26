/**
 * The five guides of the public site in Thai and English (D-271), moved from getproperty-web's content files
 * (`src/features/owner/marketing/guides/content.{th,en}.ts`, B7.13). Seeded published once (`ON CONFLICT DO
 * NOTHING`): after that the platform team edits them in admin › Guides and a re-seed never overwrites an edit.
 */
import { type GuideBlock } from '../../../src/modules/platform-content/guide-content';

export interface GuideSeed {
  slug: string;
  locale: 'th' | 'en';
  category: 'tax' | 'law' | 'landlord' | 'operations';
  audience: 'landlord' | 'apartment';
  title: string;
  summary: string;
  answer: string;
  reviewed: string;
  published: string;
  readMinutes: number;
  general: boolean;
  sections: { id: string; heading: string; blocks: GuideBlock[] }[];
  faq: { q: string; a: string }[];
  sources: { label: string; url: string }[];
}

export const GUIDES: GuideSeed[] = [
  {
    slug: 'rental-income-tax',
    locale: 'th',
    category: 'tax',
    title: 'ภาษีค่าเช่าบ้านและคอนโด: ยื่นเมื่อไร หักค่าใช้จ่ายได้เท่าไร',
    summary:
      'รายได้ค่าเช่าเป็นเงินได้ตามมาตรา 40(5) หักค่าใช้จ่ายเหมา 30% หรือตามจริง ยื่น ภ.ง.ด.94 กลางปีและ ภ.ง.ด.90 ปลายปี พร้อมเรื่องหัก ณ ที่จ่ายและอากรแสตมป์',
    answer:
      'ค่าเช่าบ้านและคอนโดเป็นเงินได้ประเภทที่ 5 (มาตรา 40(5)) เจ้าของหักค่าใช้จ่ายได้แบบเหมา 30% หรือตามจริงที่มีหลักฐาน รายได้เดือนมกราคมถึงมิถุนายนยื่นแบบ ภ.ง.ด.94 ภายใน 30 กันยายน และรายได้ทั้งปียื่นแบบ ภ.ง.ด.90 ภายใน 31 มีนาคมของปีถัดไป',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 6,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'type',
        heading: 'ค่าเช่าเป็นเงินได้ประเภทไหน',
        blocks: [
          {
            p: 'เงินที่ได้จากการให้เช่าบ้าน คอนโด ห้องพัก หรือที่ดิน เป็นเงินได้พึงประเมินตามมาตรา 40(5) แห่งประมวลรัษฎากร เจ้าของที่เป็นบุคคลธรรมดาต้องนำมารวมคำนวณภาษีเงินได้บุคคลธรรมดาเหมือนรายได้อื่น',
          },
          {
            p: 'ค่าส่วนกลาง ค่าน้ำ ค่าไฟ ที่เก็บจากผู้เช่าแล้วจ่ายต่อให้ผู้ให้บริการ ควรแยกแสดงในบิลและเก็บหลักฐานไว้ จะได้แยกให้เห็นว่าส่วนไหนคือค่าเช่า',
          },
        ],
      },
      {
        id: 'deduct',
        heading: 'หักค่าใช้จ่ายได้เท่าไร',
        blocks: [
          {
            p: 'สำหรับการให้เช่าบ้านหรือสิ่งปลูกสร้าง เลือกหักค่าใช้จ่ายได้หนึ่งในสองแบบ',
          },
          {
            ul: [
              'เหมา 30% ของค่าเช่า ไม่ต้องแนบหลักฐาน เหมาะกับเจ้าของส่วนใหญ่',
              'ตามจริงตามความจำเป็นและสมควร ต้องมีหลักฐาน เช่น ค่าซ่อม ค่าเฟอร์นิเจอร์ ค่าส่วนกลางที่เจ้าของจ่ายเอง เหมาะเมื่อค่าใช้จ่ายจริงสูงกว่า 30%',
            ],
          },
          {
            note: 'ตัวอย่าง: ค่าเช่าคอนโดเดือนละ 15,000 บาท ทั้งปี 180,000 บาท ถ้าหักเหมา 30% จะเหลือเงินได้สุทธิ 126,000 บาทก่อนหักลดหย่อนส่วนตัว',
            tone: 'info',
          },
        ],
      },
      {
        id: 'file',
        heading: 'ยื่นแบบไหน เมื่อไร',
        blocks: [
          {
            ul: [
              'ภ.ง.ด.94 (ภาษีครึ่งปี): สำหรับเงินได้เดือนมกราคมถึงมิถุนายน ยื่นภายใน 30 กันยายนของปีนั้น เมื่อเงินได้ประเภท 5 ถึง 8 รวมกันเกิน 60,000 บาท (โสด) หรือ 120,000 บาท (มีคู่สมรส) ภาษีที่จ่ายไปนำไปหักตอนยื่นปลายปีได้',
              'ภ.ง.ด.90 (ภาษีทั้งปี): รวมค่าเช่าทั้งปีกับเงินได้อื่น ยื่นภายใน 31 มีนาคมของปีถัดไป',
              'ยื่นออนไลน์ทางเว็บไซต์กรมสรรพากรมักได้ขยายเวลาเพิ่มอีกไม่กี่วัน ให้ตรวจวันที่ที่กรมสรรพากรประกาศในแต่ละปี',
            ],
          },
        ],
      },
      {
        id: 'withholding',
        heading: 'ผู้เช่าเป็นบริษัท: หัก ณ ที่จ่าย 5%',
        blocks: [
          {
            p: 'ถ้าผู้เช่าเป็นนิติบุคคล (เช่น บริษัทเช่าคอนโดให้พนักงาน) ผู้เช่ามีหน้าที่หักภาษี ณ ที่จ่าย 5% ของค่าเช่าและออกหนังสือรับรองการหักภาษี (50 ทวิ) ให้เจ้าของ เก็บหนังสือนี้ไว้ใช้เป็นเครดิตตอนยื่น ภ.ง.ด.90',
          },
        ],
      },
      {
        id: 'stamp',
        heading: 'อากรแสตมป์ของสัญญาเช่า',
        blocks: [
          {
            p: 'สัญญาเช่าที่ดินหรืออาคารต้องเสียอากรแสตมป์ 1 บาทต่อค่าเช่าทุก 1,000 บาท (หรือเศษ) ของค่าเช่าตลอดอายุสัญญา ผู้ให้เช่าเป็นผู้เสียตามกฎหมาย ส่วนใครออกเงินจริงตกลงกันในสัญญาได้ ชำระได้แบบออนไลน์ (e-Stamp Duty) ภายใน 15 วันนับจากวันทำสัญญา',
          },
          {
            note: 'ตัวอย่าง: สัญญา 1 ปี ค่าเช่าเดือนละ 10,000 บาท รวม 120,000 บาท เสียอากร 120 บาท',
            tone: 'info',
          },
        ],
      },
      {
        id: 'records',
        heading: 'เก็บหลักฐานให้พร้อมตลอดปี',
        blocks: [
          {
            ul: [
              'สัญญาเช่าทุกฉบับและหลักฐานชำระอากรแสตมป์',
              'ใบเสร็จค่าเช่าทุกเดือน แยกค่าเช่าออกจากค่าน้ำไฟและค่าบริการ',
              'หนังสือรับรองการหักภาษี ณ ที่จ่าย (ถ้ามี)',
              'หลักฐานค่าใช้จ่าย ถ้าเลือกหักตามจริง',
            ],
          },
          {
            note: 'getproperty ออกใบเสร็จทุกเดือนในชื่อเจ้าของ แยกค่าเช่ากับค่าบริการให้ และสรุปรายได้ค่าเช่าทั้งปีต่อห้องไว้ใช้ตอนยื่นภาษี',
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'ปล่อยเช่าคอนโดห้องเดียวต้องยื่นภาษีไหม',
        a: 'ต้องนำค่าเช่าไปรวมเป็นเงินได้ตามมาตรา 40(5) ทุกกรณี ส่วนจะต้องยื่น ภ.ง.ด.94 กลางปีหรือไม่ขึ้นกับว่าเงินได้ประเภท 5 ถึง 8 ช่วงครึ่งปีแรกเกินเกณฑ์ 60,000 บาท (โสด) หรือ 120,000 บาท (มีคู่สมรส) หรือไม่',
      },
      {
        q: 'หักค่าใช้จ่ายเหมาหรือตามจริงดีกว่า',
        a: 'ถ้าค่าใช้จ่ายจริงที่มีหลักฐานต่ำกว่า 30% ของค่าเช่า การหักเหมาง่ายและได้มากกว่า ถ้าปีนั้นมีค่าซ่อมหรือค่าตกแต่งสูง การหักตามจริงอาจคุ้มกว่า',
      },
      {
        q: 'เงินประกันต้องเสียภาษีไหม',
        a: 'เงินประกันที่ต้องคืนผู้เช่ายังไม่ใช่รายได้ แต่ส่วนที่หักไว้แทนค่าเช่าค้างหรือค่าเสียหายและไม่ได้คืน อาจถือเป็นเงินได้ในปีที่หัก ควรปรึกษาผู้เชี่ยวชาญภาษีกรณีของคุณ',
      },
    ],
    sources: [
      {
        label: 'กรมสรรพากร',
        url: 'https://www.rd.go.th/',
      },
      {
        label: 'Flow Account: อากรแสตมป์',
        url: 'https://flowaccount.com/blog/stamp-duty-thailand-payment/',
      },
      {
        label: 'FlowAccount: ภ.ง.ด.94 คืออะไร ยื่นเมื่อไร',
        url: 'https://flowaccount.com/blog/pnd-94-personal-income-tax/',
      },
    ],
  },
  {
    slug: 'tm30',
    locale: 'th',
    category: 'law',
    title: 'ตม.30 คืออะไร ปล่อยเช่าให้ชาวต่างชาติต้องแจ้งอย่างไร',
    summary:
      'ตม.30 คือการแจ้งที่พักของคนต่างด้าวตามมาตรา 38 พ.ร.บ.คนเข้าเมือง ต้องแจ้งภายใน 24 ชั่วโมง ทำออนไลน์ได้ เจ้าบ้านไม่แจ้งปรับไม่เกิน 2,000 บาท',
    answer:
      'ตม.30 คือการแจ้งว่าคนต่างด้าวเข้าพักที่ไหน ตามมาตรา 38 พ.ร.บ.คนเข้าเมือง พ.ศ. 2522 เจ้าบ้าน ผู้ครอบครองเคหสถาน หรือผู้จัดการโรงแรมต้องแจ้งภายใน 24 ชั่วโมงหลังผู้เช่าต่างชาติเข้าพัก แจ้งออนไลน์หรือที่สำนักงานตรวจคนเข้าเมืองได้ ถ้าไม่แจ้ง เจ้าบ้านมีโทษปรับไม่เกิน 2,000 บาท',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 4,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'what',
        heading: 'ตม.30 คืออะไร',
        blocks: [
          {
            p: 'ตม.30 คือแบบแจ้งที่พักของคนต่างด้าว ใช้ให้สำนักงานตรวจคนเข้าเมืองรู้ว่าชาวต่างชาติพักอยู่ที่ไหน ผู้มีหน้าที่แจ้งคือฝ่ายที่ให้ที่พัก ไม่ใช่ตัวชาวต่างชาติ',
          },
        ],
      },
      {
        id: 'who',
        heading: 'ใครต้องแจ้ง และแจ้งเมื่อไร',
        blocks: [
          {
            ul: [
              'เจ้าบ้าน ผู้ครอบครองเคหสถาน หรือผู้จัดการโรงแรม ที่ให้คนต่างด้าวพัก',
              'ต้องแจ้งภายใน 24 ชั่วโมงหลังจากผู้เช่าต่างชาติเริ่มเข้าพัก',
              'เมื่อปล่อยเช่า ควรระบุในสัญญาให้ชัดว่าใครเป็นผู้แจ้ง และให้ผู้เช่าแจ้งเจ้าของทุกครั้งที่มีคนต่างชาติมาพักเพิ่ม',
            ],
          },
          {
            note: 'ไม่แจ้งหรือแจ้งช้า เจ้าบ้านหรือผู้ครอบครองมีโทษปรับไม่เกิน 2,000 บาท ผู้จัดการโรงแรม 2,000 ถึง 10,000 บาท และผู้เช่าอาจต่อวีซ่าไม่ได้จนกว่าจะเคลียร์',
            tone: 'warning',
          },
        ],
      },
      {
        id: 'how',
        heading: 'แจ้งอย่างไร',
        blocks: [
          {
            ol: [
              'เตรียมข้อมูลจากหนังสือเดินทางของผู้เช่า: ชื่อ สัญชาติ เลขหนังสือเดินทาง ประเภทวีซ่า วันที่เข้าประเทศ',
              'เตรียมข้อมูลที่พักและหลักฐานความเป็นเจ้าของหรือสัญญาเช่า',
              'แจ้งผ่านระบบออนไลน์ของสำนักงานตรวจคนเข้าเมือง หรือไปที่ ตม. ในพื้นที่ (ถ้าไม่มี แจ้งที่สถานีตำรวจ)',
              'เก็บใบรับแจ้งไว้ ผู้เช่าต้องใช้ตอนต่อวีซ่าหรือรายงานตัว',
            ],
          },
          {
            note: 'getproperty เตือนเมื่อมีผู้เช่าต่างชาติเข้าพัก เตรียมข้อมูลสำหรับแจ้ง ตม.30 จากสัญญาให้ และนับเวลาถอยหลัง 24 ชั่วโมง',
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'เจ้าของคอนโดที่ปล่อยเช่าต้องแจ้ง ตม.30 เองไหม',
        a: 'เจ้าบ้านหรือผู้ครอบครองที่ให้ชาวต่างชาติพักมีหน้าที่แจ้ง เมื่อปล่อยเช่าทั้งห้อง ควรตกลงในสัญญาว่าใครแจ้ง โดยทั่วไปเจ้าของห้องเป็นผู้แจ้ง',
      },
      {
        q: 'ผู้เช่าต่างชาติเดินทางกลับประเทศแล้วกลับมาพักต่อ ต้องแจ้งใหม่ไหม',
        a: 'แนวปฏิบัติของแต่ละพื้นที่ไม่เหมือนกัน ควรสอบถามสำนักงานตรวจคนเข้าเมืองที่ดูแลพื้นที่ของคุณ',
      },
    ],
    sources: [
      {
        label: 'Thai Law Online: TM30',
        url: 'https://www.thailawonline.com/th/glossary/tm30/',
      },
      {
        label: 'สำนักงานตรวจคนเข้าเมือง',
        url: 'https://www.immigration.go.th/',
      },
    ],
  },
  {
    slug: 'security-deposit',
    locale: 'th',
    category: 'law',
    title: 'เงินประกันห้องเช่า: หักได้แค่ไหน คืนเมื่อไร',
    summary:
      'หลักการคืนเงินประกันตามประกาศ สคบ. ปี 2568 สำหรับผู้ให้เช่าตั้งแต่ 3 ห้อง: คืนภายใน 7 วัน หักได้เฉพาะความเสียหายจริงที่มีหลักฐาน และวิธีกันข้อพิพาทตั้งแต่วันเข้าอยู่',
    answer:
      'ตามประกาศคณะกรรมการว่าด้วยสัญญา ปี 2568 ที่มีผลตั้งแต่ 4 กันยายน 2568 ผู้ประกอบการที่ให้เช่าที่อยู่อาศัยตั้งแต่ 3 ห้องขึ้นไป ต้องคืนเงินประกันภายใน 7 วันเมื่อสัญญาสิ้นสุดและไม่มีข้อพิพาท หักได้เฉพาะค่าเช่าค้างหรือความเสียหายจริงที่มีหลักฐาน และห้ามหักค่าเสื่อมสภาพตามการใช้งานปกติ',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'rule',
        heading: 'กติกาใหม่ปี 2568 ใช้กับใคร',
        blocks: [
          {
            p: 'ประกาศคณะกรรมการว่าด้วยสัญญา เรื่องให้ธุรกิจให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา พ.ศ. 2568 มีผลตั้งแต่ 4 กันยายน 2568 ใช้กับผู้ประกอบการที่ให้เช่าที่อยู่อาศัยตั้งแต่ 3 ห้องหรือ 3 หลังขึ้นไป ทั้งบ้าน คอนโด และอพาร์ตเมนต์ ส่วนหอพักและโรงแรมที่มีกฎหมายเฉพาะแยกไป',
          },
          {
            p: 'ถ้าคุณปล่อยเช่าน้อยกว่า 3 ห้อง สัญญาและประมวลกฎหมายแพ่งและพาณิชย์ยังเป็นหลัก แต่การปฏิบัติตามหลักเดียวกันจะช่วยให้ผู้เช่าไว้ใจและลดข้อพิพาท',
          },
        ],
      },
      {
        id: 'deduct',
        heading: 'หักอะไรได้ หักอะไรไม่ได้',
        blocks: [
          {
            ul: [
              'หักได้: ค่าเช่าหรือค่าบริการที่ค้างชำระ ความเสียหายที่ผู้เช่าทำและมีหลักฐานชัดเจน',
              'หักไม่ได้: ความเสื่อมตามการใช้งานปกติ เช่น สีผนังซีด พรมสึก เฟอร์นิเจอร์เก่าตามอายุ',
              'หักไม่ได้: ความเสียหายจากเหตุสุดวิสัย เช่น น้ำท่วม แผ่นดินไหว',
              'หักไม่ได้: ยึดเงินประกันโดยไม่มีเหตุผลที่ชอบธรรม',
            ],
          },
        ],
      },
      {
        id: 'evidence',
        heading: 'กันข้อพิพาทตั้งแต่วันเข้าอยู่',
        blocks: [
          {
            ol: [
              'ตรวจสภาพห้องพร้อมผู้เช่าในวันเข้าอยู่ ถ่ายรูปทุกจุดพร้อมวันเวลา',
              'ให้ผู้เช่ายืนยันรายการตรวจสภาพเป็นลายลักษณ์อักษร',
              'วันย้ายออก ตรวจตามรายการเดิม เทียบรูปก่อนและหลัง',
              'แจ้งรายการหักพร้อมรูปและใบเสร็จค่าซ่อม แล้วคืนส่วนที่เหลือภายในกำหนด',
            ],
          },
          {
            note: 'getproperty บันทึกการตรวจสภาพห้องพร้อมรูป ผูกกับสัญญาเช่า และคำนวณยอดคืนเงินประกันจากรายการหักที่มีหลักฐาน ผู้เช่าเห็นรายละเอียดเดียวกันใน LINE',
            tone: 'product',
          },
        ],
      },
      {
        id: 'other',
        heading: 'ข้อห้ามอื่นที่ควรรู้',
        blocks: [
          {
            ul: [
              'ขึ้นค่าเช่าหรือค่าบริการระหว่างสัญญา ถ้าไม่ได้ตกลงไว้ล่วงหน้า',
              'เข้าห้องผู้เช่าโดยไม่ได้รับอนุญาตหรือไม่แจ้งล่วงหน้า ยกเว้นเหตุฉุกเฉิน เช่น ไฟไหม้ น้ำรั่ว',
              'บอกเลิกสัญญาด้วยวาจาแล้วให้ออกทันที ต้องแจ้งเป็นหนังสือและให้เวลาแก้ไขตามที่กฎหมายกำหนด',
              'บิลค่าน้ำไฟต้องแสดงหน่วยที่ใช้และราคาต่อหน่วยให้ผู้เช่าตรวจสอบได้',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'ต้องคืนเงินประกันภายในกี่วัน',
        a: 'ตามประกาศปี 2568 สำหรับผู้ประกอบการที่ให้เช่าตั้งแต่ 3 ห้องขึ้นไป ต้องคืนภายใน 7 วันเมื่อสัญญาสิ้นสุดและไม่มีข้อพิพาท',
      },
      {
        q: 'ผู้เช่าทำของเสียหาย หักเงินประกันได้ไหม',
        a: 'หักได้ตามความเสียหายจริงที่มีหลักฐาน เช่น รูปก่อนและหลังและใบเสร็จค่าซ่อม แต่หักค่าเสื่อมตามการใช้งานปกติไม่ได้',
      },
    ],
    sources: [
      {
        label: 'ฐานเศรษฐกิจ: สคบ. อัปเดตกฎหมายสัญญาเช่า',
        url: 'https://www.thansettakij.com/real-estate/650793',
      },
      {
        label: 'สำนักงานคณะกรรมการคุ้มครองผู้บริโภค',
        url: 'https://www.ocpb.go.th/',
      },
    ],
  },
  {
    slug: 'lease-essentials',
    locale: 'th',
    category: 'landlord',
    title: 'สัญญาเช่าบ้านและคอนโดต้องมีอะไรบ้าง',
    summary:
      'เช็กลิสต์สิ่งที่สัญญาเช่าที่อยู่อาศัยควรมี: คู่สัญญา ทรัพย์ที่เช่า ค่าเช่า เงินประกัน ค่าบริการ วันชำระ ข้อห้าม การต่อและเลิกสัญญา และอากรแสตมป์',
    answer:
      'สัญญาเช่าที่ดีต้องระบุคู่สัญญา ทรัพย์ที่เช่าและอุปกรณ์ ระยะเวลาเช่า ค่าเช่าและวันชำระ เงินประกันและเงื่อนไขการคืน ค่าน้ำไฟและค่าบริการ กฎการอยู่อาศัย การต่อและการเลิกสัญญา พร้อมรายการตรวจสภาพห้องแนบท้าย และเสียอากรแสตมป์ภายใน 15 วัน',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'checklist',
        heading: 'เช็กลิสต์ 10 ข้อ',
        blocks: [
          {
            ol: [
              'คู่สัญญา: ชื่อ ที่อยู่ เลขบัตรหรือหนังสือเดินทาง และผู้ติดต่อฉุกเฉิน',
              'ทรัพย์ที่เช่า: ที่อยู่ เลขห้อง ขนาด และรายการเฟอร์นิเจอร์และเครื่องใช้ไฟฟ้า',
              'ระยะเวลาเช่า: วันเริ่ม วันสิ้นสุด และระยะเวลาขั้นต่ำ',
              'ค่าเช่า: จำนวน วันครบกำหนด ช่องทางชำระ และค่าปรับชำระช้า (ถ้ามี)',
              'เงินประกันและค่าเช่าล่วงหน้า: จำนวนและเงื่อนไขการคืน',
              'ค่าน้ำไฟและค่าบริการ: วิธีคิด อัตราต่อหน่วย และค่าบริการอื่น',
              'กฎการอยู่อาศัย: สัตว์เลี้ยง การสูบบุหรี่ ผู้พักอาศัยเพิ่ม การใช้พื้นที่ส่วนกลาง',
              'การซ่อมแซม: อะไรเป็นหน้าที่ของใคร และวิธีแจ้งซ่อม',
              'การต่อสัญญาและการบอกเลิก: ต้องแจ้งล่วงหน้ากี่วันและแจ้งอย่างไร',
              'เอกสารแนบ: รายการตรวจสภาพห้องพร้อมรูป และสำเนาเอกสารของทั้งสองฝ่าย',
            ],
          },
        ],
      },
      {
        id: 'law',
        heading: 'ถ้าคุณปล่อยเช่าตั้งแต่ 3 ห้องขึ้นไป',
        blocks: [
          {
            p: 'ประกาศคณะกรรมการว่าด้วยสัญญา พ.ศ. 2568 (มีผล 4 กันยายน 2568) กำหนดให้การให้เช่าที่อยู่อาศัยตั้งแต่ 3 ห้องขึ้นไปเป็นธุรกิจที่ควบคุมสัญญา สัญญาต้องมีข้อความที่ประกาศกำหนดและห้ามมีข้อสัญญาที่เอาเปรียบผู้เช่า ดูรายละเอียดเรื่องเงินประกันได้ในคู่มือเรื่องเงินประกัน',
          },
        ],
      },
      {
        id: 'stamp',
        heading: 'อย่าลืมอากรแสตมป์',
        blocks: [
          {
            p: 'สัญญาเช่าเสียอากร 1 บาทต่อค่าเช่าทุก 1,000 บาทของค่าเช่าตลอดอายุสัญญา ชำระออนไลน์ได้ภายใน 15 วัน สัญญาที่ไม่ได้เสียอากรใช้เป็นหลักฐานในคดีแพ่งไม่ได้จนกว่าจะเสียอากรและเงินเพิ่ม',
          },
          {
            note: 'getproperty สร้างสัญญาเช่าจากข้อมูลห้องและผู้เช่า สองภาษา เซ็นออนไลน์ได้ แนบรายการตรวจสภาพห้อง และเก็บไว้คู่กับบิลและใบเสร็จของห้องนั้น',
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'ทำสัญญาเช่าออนไลน์ใช้ได้ไหม',
        a: 'สัญญาที่ทำและลงลายมือชื่ออิเล็กทรอนิกส์ใช้ได้ตามกฎหมายว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ และต้องเสียอากรแสตมป์เช่นเดียวกับสัญญากระดาษ',
      },
      {
        q: 'เช่าน้อยกว่า 3 ห้องต้องทำตามประกาศ สคบ. ไหม',
        a: 'ประกาศปี 2568 ใช้กับผู้ประกอบการที่ให้เช่าตั้งแต่ 3 ห้องขึ้นไป ถ้าน้อยกว่านั้นสัญญาและประมวลกฎหมายแพ่งและพาณิชย์เป็นหลัก แต่ใช้แนวเดียวกันจะช่วยลดข้อพิพาท',
      },
    ],
    sources: [
      {
        label: 'ฐานเศรษฐกิจ: สคบ. อัปเดตกฎหมายสัญญาเช่า',
        url: 'https://www.thansettakij.com/real-estate/650793',
      },
      {
        label: 'กรมสรรพากร (อากรแสตมป์)',
        url: 'https://www.rd.go.th/',
      },
    ],
  },
  {
    slug: 'first-time-landlord',
    locale: 'th',
    category: 'landlord',
    title: 'ปล่อยเช่าคอนโดครั้งแรก: เช็กลิสต์ตั้งแต่ตั้งราคาจนเก็บค่าเช่า',
    summary:
      'ขั้นตอนปล่อยเช่าคอนโดหรือบ้านครั้งแรก: เตรียมห้อง ตั้งราคา ถ่ายรูป ลงประกาศ คัดผู้เช่า ทำสัญญา ส่งมอบห้อง และเก็บค่าเช่าทุกเดือนโดยไม่ต้องทวง',
    answer:
      'ปล่อยเช่าครั้งแรกให้ทำตามลำดับ: เตรียมห้องให้พร้อมอยู่ ตั้งราคาจากห้องคล้ายกันในย่าน ถ่ายรูปช่วงกลางวันอย่างน้อย 5 รูป ลงประกาศพร้อมที่อยู่และเงื่อนไขครบ คัดผู้เช่าและนัดดูห้อง ทำสัญญาพร้อมตรวจสภาพห้อง แล้วตั้งระบบส่งบิลและออกใบเสร็จอัตโนมัติ',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: false,
    sections: [
      {
        id: 'prepare',
        heading: '1. เตรียมห้องและตั้งราคา',
        blocks: [
          {
            ul: [
              'ทำความสะอาดใหญ่ ซ่อมทุกจุด เปลี่ยนหลอดไฟและแบตเตอรี่ล็อก',
              'ดูค่าเช่าของห้องขนาดและชั้นใกล้เคียงในโครงการเดียวกันหรือย่านเดียวกัน',
              'ตั้งราคาที่ปล่อยได้ภายในหนึ่งเดือน ห้องว่างหนึ่งเดือนเสียรายได้มากกว่าลดราคาเล็กน้อย',
            ],
          },
        ],
      },
      {
        id: 'list',
        heading: '2. ถ่ายรูปและลงประกาศ',
        blocks: [
          {
            ul: [
              'ถ่ายตอนกลางวัน เปิดไฟทุกดวง ถ่ายจากมุมห้องให้เห็นพื้นที่ อย่างน้อย 5 รูป',
              'บอกข้อมูลที่ผู้เช่าอยากรู้ให้ครบ: ค่าเช่า เงินประกัน สัญญาขั้นต่ำ ค่าน้ำไฟ สัตว์เลี้ยง ระยะถึงรถไฟฟ้า',
              'ใส่ที่อยู่จริง ผู้เช่าจะเชื่อใจมากขึ้นและได้คนที่ตั้งใจจริง',
            ],
          },
          {
            note: 'ลงประกาศบน getproperty ได้ฟรี คนสนใจทักผ่าน LINE ตรงถึงคุณ ไม่ผ่านนายหน้า',
            tone: 'product',
          },
        ],
      },
      {
        id: 'tenant',
        heading: '3. คัดผู้เช่าและป้องกันการโกง',
        blocks: [
          {
            ul: [
              'นัดดูห้องจริงก่อนรับเงินทุกครั้ง',
              'ขอดูบัตรประชาชนหรือหนังสือเดินทาง และสอบถามที่ทำงาน',
              'รับเงินจองหรือเงินประกันเข้าบัญชีชื่อคุณเองเท่านั้น และออกใบรับเงินทุกครั้ง',
            ],
          },
        ],
      },
      {
        id: 'move-in',
        heading: '4. ทำสัญญาและส่งมอบห้อง',
        blocks: [
          {
            ol: [
              'ทำสัญญาเช่าตามเช็กลิสต์ในคู่มือสัญญาเช่า',
              'ตรวจสภาพห้องพร้อมผู้เช่า ถ่ายรูปทุกจุด',
              'จดเลขมิเตอร์น้ำไฟวันส่งมอบ',
              'ถ้าผู้เช่าเป็นชาวต่างชาติ แจ้ง ตม.30 ภายใน 24 ชั่วโมง',
            ],
          },
        ],
      },
      {
        id: 'collect',
        heading: '5. เก็บค่าเช่าทุกเดือนโดยไม่ต้องทวง',
        blocks: [
          {
            p: 'ส่งบิลวันเดียวกันทุกเดือน แสดงยอดและวิธีจ่ายชัดเจน ยืนยันยอดเข้าและออกใบเสร็จทันที ผู้เช่าที่ได้บิลตรงเวลาจะจ่ายตรงเวลามากขึ้น',
          },
          {
            note: 'getproperty ส่งบิลพร้อม QR เข้า LINE ผู้เช่า ยืนยันยอดและออกใบเสร็จให้อัตโนมัติ ใช้ฟรีไม่มีค่ารายเดือน',
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'ควรเก็บเงินประกันกี่เดือน',
        a: 'ในตลาดคอนโดและบ้านเช่าทั่วไปมักเก็บเงินประกัน 2 เดือนและค่าเช่าล่วงหน้า 1 เดือน ให้ระบุจำนวนและเงื่อนไขการคืนในสัญญาให้ชัด',
      },
      {
        q: 'ต้องจ้างนายหน้าไหม',
        a: 'ไม่จำเป็น ถ้าคุณมีเวลาตอบคนสนใจและพาดูห้อง การลงประกาศเองและคุยกับผู้เช่าโดยตรงช่วยประหยัดค่านายหน้า',
      },
    ],
    sources: [],
  },
  {
    slug: 'rental-income-tax',
    locale: 'en',
    category: 'tax',
    title: 'Tax on rental income in Thailand: when to file and what you can deduct',
    summary:
      'Rent is income under Section 40(5): deduct a flat 30% or actual expenses, file PND 94 mid-year and PND 90 for the year, plus withholding tax and lease stamp duty.',
    answer:
      'Rent from a house or condo is type-5 income under Section 40(5) of the Revenue Code. Owners deduct either a flat 30% or actual, documented expenses. Income for January–June is filed on PND 94 by 30 September; the whole year on PND 90 by 31 March of the following year.',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 6,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'type',
        heading: 'What kind of income is rent',
        blocks: [
          {
            p: 'Money from renting out a house, condo, room or land is assessable income under Section 40(5) of the Thai Revenue Code. An individual owner adds it to their other income for personal income tax.',
          },
          {
            p: 'Common fees, water and electricity collected from the tenant and passed on to the provider should be shown separately on the bill, with records kept, so the rent itself is clear.',
          },
        ],
      },
      {
        id: 'deduct',
        heading: 'How much you can deduct',
        blocks: [
          {
            p: 'For renting out a house or building you choose one of two methods.',
          },
          {
            ul: [
              'A flat 30% of the rent, with no receipts needed — right for most owners.',
              'Actual expenses that are necessary and reasonable, with evidence (repairs, furniture, common fees you pay) — worth it when they exceed 30%.',
            ],
          },
          {
            note: 'Example: a condo let at 15,000 baht a month earns 180,000 baht a year; with the flat 30% the net income is 126,000 baht before personal allowances.',
            tone: 'info',
          },
        ],
      },
      {
        id: 'file',
        heading: 'Which form, and when',
        blocks: [
          {
            ul: [
              'PND 94 (half-year): income from January to June, filed by 30 September of that year when type 5–8 income exceeds 60,000 baht (single) or 120,000 baht (married). Tax paid is credited at year end.',
              'PND 90 (full year): all rent plus your other income, filed by 31 March of the following year.',
              "Filing online on the Revenue Department's website usually gives a few extra days — check the dates announced each year.",
            ],
          },
        ],
      },
      {
        id: 'withholding',
        heading: 'Company tenants withhold 5%',
        blocks: [
          {
            p: 'When the tenant is a juristic person (for example a company renting a condo for staff), it withholds 5% of the rent and gives you a withholding certificate (50 Tawi). Keep it: it is a credit on your PND 90.',
          },
        ],
      },
      {
        id: 'stamp',
        heading: 'Stamp duty on the lease',
        blocks: [
          {
            p: 'A lease of land or a building carries stamp duty of 1 baht for every 1,000 baht (or part) of the rent over the whole term. By law the lessor pays; who actually bears it can be agreed in the lease. Pay online (e-Stamp Duty) within 15 days of signing.',
          },
          {
            note: 'Example: a one-year lease at 10,000 baht a month totals 120,000 baht, so the duty is 120 baht.',
            tone: 'info',
          },
        ],
      },
      {
        id: 'records',
        heading: 'Keep your records all year',
        blocks: [
          {
            ul: [
              'Every lease and its stamp-duty receipt',
              'Monthly rent receipts, with rent separated from utilities and service charges',
              'Withholding tax certificates, if any',
              'Expense evidence, if you deduct actual expenses',
            ],
          },
          {
            note: "getproperty issues a receipt every month in the owner's name, separates rent from service charges, and sums each unit's rental income for the year when you file.",
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'I rent out one condo. Do I need to file tax?',
        a: 'Rent is always Section 40(5) income. Whether you must also file PND 94 mid-year depends on whether your type 5–8 income for January–June exceeds 60,000 baht (single) or 120,000 baht (married).',
      },
      {
        q: 'Flat 30% or actual expenses?',
        a: 'If your documented expenses are below 30% of the rent, the flat deduction is simpler and larger. In a year with big repairs or furnishing, actual expenses may be worth more.',
      },
      {
        q: 'Is the security deposit taxable?',
        a: 'A deposit you must return is not income. An amount kept for unpaid rent or damage may be income in the year it is kept — ask a tax adviser about your case.',
      },
    ],
    sources: [
      {
        label: 'Revenue Department',
        url: 'https://www.rd.go.th/',
      },
      {
        label: 'FlowAccount: stamp duty payment',
        url: 'https://flowaccount.com/blog/stamp-duty-thailand-payment/',
      },
      {
        label: 'FlowAccount: PND 94 explained (Thai)',
        url: 'https://flowaccount.com/blog/pnd-94-personal-income-tax/',
      },
    ],
  },
  {
    slug: 'tm30',
    locale: 'en',
    category: 'law',
    title: "TM30 for landlords: reporting a foreign tenant's address",
    summary:
      'TM30 is the foreigner address report under Section 38 of the Immigration Act: file within 24 hours, online or in person; a householder who fails faces a fine up to 2,000 baht.',
    answer:
      'TM30 is the report of where a foreigner stays, required by Section 38 of the Immigration Act B.E. 2522. The householder, occupier or hotel manager must file it within 24 hours after a foreign tenant moves in, online or at an immigration office. A householder who does not file can be fined up to 2,000 baht.',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 4,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'what',
        heading: 'What TM30 is',
        blocks: [
          {
            p: 'TM30 is the form that tells the Immigration Bureau where a foreigner is staying. The duty lies with whoever provides the accommodation, not with the foreigner.',
          },
        ],
      },
      {
        id: 'who',
        heading: 'Who files, and when',
        blocks: [
          {
            ul: [
              'The householder, the occupier of the residence, or the hotel manager who lets a foreigner stay.',
              'Within 24 hours after the foreign tenant starts staying.',
              'When you let a unit, say in the lease who files, and ask the tenant to tell you whenever another foreigner comes to stay.',
            ],
          },
          {
            note: 'Late or missing reports: a fine up to 2,000 baht for a householder or occupier, 2,000–10,000 baht for a hotel manager — and the tenant may be unable to extend a visa until it is settled.',
            tone: 'warning',
          },
        ],
      },
      {
        id: 'how',
        heading: 'How to file',
        blocks: [
          {
            ol: [
              "From the tenant's passport: name, nationality, passport number, visa type, date of entry.",
              'Details of the residence and proof of ownership or the lease.',
              "File through the Immigration Bureau's online system, or at the local immigration office (or a police station where there is none).",
              'Keep the receipt: the tenant needs it for visa extensions and reporting.',
            ],
          },
          {
            note: 'getproperty alerts you when a foreign tenant moves in, prepares the TM30 details from the lease and counts down the 24 hours.',
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'I own a condo and rent it to a foreigner. Do I file TM30?',
        a: 'The householder or occupier who lets a foreigner stay must file. When you let a whole unit, agree in the lease who files — usually the owner.',
      },
      {
        q: 'My tenant travelled abroad and came back. File again?',
        a: 'Practice differs between offices. Ask the immigration office responsible for your area.',
      },
    ],
    sources: [
      {
        label: 'Thai Law Online: TM30',
        url: 'https://www.thailawonline.com/th/glossary/tm30/',
      },
      {
        label: 'Immigration Bureau',
        url: 'https://www.immigration.go.th/',
      },
    ],
  },
  {
    slug: 'security-deposit',
    locale: 'en',
    category: 'law',
    title: 'Security deposits in Thailand: what you may deduct and when to return it',
    summary:
      'The 2025 consumer-protection rules for landlords of three or more units: return the deposit within 7 days, deduct only proven damage, and how to avoid disputes from move-in day.',
    answer:
      'Under the Contract Committee notification of 2025 (in force since 4 September 2025), businesses letting three or more residential units must return the deposit within 7 days when the lease ends without dispute, may deduct only unpaid rent or proven damage, and may not charge for normal wear and tear.',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'rule',
        heading: 'Who the 2025 rules apply to',
        blocks: [
          {
            p: "The Contract Committee's notification making residential leasing a contract-controlled business (B.E. 2568) took effect on 4 September 2025. It covers operators letting three or more houses, condo units or apartments; dormitories and hotels have their own laws.",
          },
          {
            p: 'With fewer than three units your lease and the Civil and Commercial Code govern, but following the same principles builds trust and avoids disputes.',
          },
        ],
      },
      {
        id: 'deduct',
        heading: 'What you may and may not deduct',
        blocks: [
          {
            ul: [
              'May deduct: unpaid rent or charges, and damage the tenant caused, with clear evidence.',
              'May not deduct: normal wear and tear — faded paint, worn carpet, ageing furniture.',
              'May not deduct: damage from force majeure such as floods or earthquakes.',
              'May not keep the deposit without a justified reason.',
            ],
          },
        ],
      },
      {
        id: 'evidence',
        heading: 'Avoid disputes from move-in day',
        blocks: [
          {
            ol: [
              'Inspect the unit with the tenant on move-in day and photograph everything with date and time.',
              'Have the tenant confirm the inspection list in writing.',
              'On move-out, inspect against the same list and compare before and after photos.',
              'Send the deductions with photos and repair receipts, and return the rest on time.',
            ],
          },
          {
            note: 'getproperty records the inspection with photos on the lease and works out the deposit refund from deductions that have evidence; the tenant sees the same details in LINE.',
            tone: 'product',
          },
        ],
      },
      {
        id: 'other',
        heading: 'Other rules worth knowing',
        blocks: [
          {
            ul: [
              'No raising rent or charges during the lease unless agreed in advance.',
              'No entering the unit without permission or notice, except emergencies such as fire or leaks.',
              'No verbal termination with immediate eviction: notice must be in writing, with time to remedy as the law requires.',
              'Utility bills show the units used and the price per unit so the tenant can check them.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'How many days do I have to return the deposit?',
        a: 'Under the 2025 notification, operators letting three or more units must return it within 7 days when the lease ends without dispute.',
      },
      {
        q: 'Can I deduct for damage?',
        a: 'Yes, for real damage you can prove — before and after photos and repair receipts — but not for normal wear and tear.',
      },
    ],
    sources: [
      {
        label: 'Thansettakij: new residential lease rules (Thai)',
        url: 'https://www.thansettakij.com/real-estate/650793',
      },
      {
        label: 'Office of the Consumer Protection Board',
        url: 'https://www.ocpb.go.th/',
      },
    ],
  },
  {
    slug: 'lease-essentials',
    locale: 'en',
    category: 'landlord',
    title: 'What a Thai residential lease should contain',
    summary:
      'A checklist for house and condo leases: parties, the unit, rent, deposit, charges, due dates, house rules, renewal and termination, and stamp duty.',
    answer:
      'A sound lease names the parties, the unit and its contents, the term, the rent and due date, the deposit and how it is returned, utilities and service charges, house rules, repairs, renewal and termination, with a move-in inspection attached — and stamp duty paid within 15 days.',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: true,
    sections: [
      {
        id: 'checklist',
        heading: 'A 10-point checklist',
        blocks: [
          {
            ol: [
              'Parties: names, addresses, ID or passport numbers, and an emergency contact.',
              'The unit: address, unit number, size, and the list of furniture and appliances.',
              'Term: start, end and minimum period.',
              'Rent: amount, due date, how to pay, and any late fee.',
              'Deposit and advance rent: amounts and how the deposit is returned.',
              'Utilities and service charges: how they are calculated and the unit rates.',
              'House rules: pets, smoking, extra occupants, common areas.',
              'Repairs: who is responsible for what, and how to report.',
              "Renewal and termination: how many days' notice and how it is given.",
              "Attachments: the inspection list with photos, and copies of both parties' documents.",
            ],
          },
        ],
      },
      {
        id: 'law',
        heading: 'If you let three or more units',
        blocks: [
          {
            p: 'The Contract Committee notification of 2025 (in force 4 September 2025) makes letting three or more residential units a contract-controlled business: the lease must contain the prescribed terms and must not contain unfair ones. See the security deposit guide for the deposit rules.',
          },
        ],
      },
      {
        id: 'stamp',
        heading: "Don't forget stamp duty",
        blocks: [
          {
            p: 'A lease carries duty of 1 baht per 1,000 baht of the rent over the whole term, payable online within 15 days. An unstamped lease cannot be used as evidence in a civil case until the duty and surcharge are paid.',
          },
          {
            note: "getproperty drafts the lease from the unit and tenant details in Thai and English, lets both sides sign online, attaches the inspection and keeps it with the unit's bills and receipts.",
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is an online lease valid?',
        a: 'A lease made and signed electronically is valid under the Electronic Transactions Act, and carries stamp duty like a paper one.',
      },
      {
        q: 'Do the consumer-protection rules apply if I let fewer than three units?',
        a: 'The 2025 notification covers operators letting three or more units. Below that, your lease and the Civil and Commercial Code govern — following the same approach still avoids disputes.',
      },
    ],
    sources: [
      {
        label: 'Thansettakij: new residential lease rules (Thai)',
        url: 'https://www.thansettakij.com/real-estate/650793',
      },
      {
        label: 'Revenue Department (stamp duty)',
        url: 'https://www.rd.go.th/',
      },
    ],
  },
  {
    slug: 'first-time-landlord',
    locale: 'en',
    category: 'landlord',
    title: 'Renting out your condo for the first time: a checklist',
    summary:
      'From preparing the unit and setting the rent to photos, listing, choosing a tenant, the lease, handover and collecting rent every month without chasing.',
    answer:
      'Work in order: get the unit ready, price it against similar units nearby, take at least five daylight photos, list it with the address and full terms, screen tenants and arrange viewings, sign the lease with a move-in inspection, then set up automatic bills and receipts.',
    reviewed: '2026-10-24',
    published: '2026-10-24',
    readMinutes: 5,
    audience: 'landlord',
    general: false,
    sections: [
      {
        id: 'prepare',
        heading: '1. Prepare the unit and set the rent',
        blocks: [
          {
            ul: [
              'Deep-clean, fix everything, replace bulbs and lock batteries.',
              'Compare rents of similar size and floor in the same building or area.',
              'Price to let within a month: an empty month costs more than a small discount.',
            ],
          },
        ],
      },
      {
        id: 'list',
        heading: '2. Photos and listing',
        blocks: [
          {
            ul: [
              'Shoot in daylight with every light on, from the corners, at least five photos.',
              'Give what tenants ask first: rent, deposit, minimum term, utilities, pets, distance to transit.',
              'Show the real address: tenants trust it more and you get serious enquiries.',
            ],
          },
          {
            note: 'List free on getproperty; enquiries reach you directly in LINE, with no agent.',
            tone: 'product',
          },
        ],
      },
      {
        id: 'tenant',
        heading: '3. Screen tenants and avoid scams',
        blocks: [
          {
            ul: [
              'Always show the unit in person before taking money.',
              'See an ID card or passport and ask about work.',
              'Take booking money or deposits only into an account in your own name, with a receipt every time.',
            ],
          },
        ],
      },
      {
        id: 'move-in',
        heading: '4. Lease and handover',
        blocks: [
          {
            ol: [
              'Sign a lease following the lease checklist.',
              'Inspect the unit with the tenant and photograph everything.',
              'Record the water and electricity meter readings on handover.',
              'For a foreign tenant, file TM30 within 24 hours.',
            ],
          },
        ],
      },
      {
        id: 'collect',
        heading: '5. Collect rent every month without chasing',
        blocks: [
          {
            p: 'Send the bill on the same day every month with the amount and how to pay, confirm payment and issue the receipt at once. Tenants who get bills on time pay on time.',
          },
          {
            note: "getproperty sends bills with a QR to your tenant's LINE, confirms payments and issues receipts automatically — free, with no monthly fee.",
            tone: 'product',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'How many months of deposit should I take?',
        a: "Condos and houses commonly take two months' deposit and one month in advance. State the amounts and how the deposit is returned in the lease.",
      },
      {
        q: 'Do I need an agent?',
        a: 'Not necessarily. If you can answer enquiries and show the unit, listing it yourself and talking to tenants directly saves the commission.',
      },
    ],
    sources: [],
  },
];
