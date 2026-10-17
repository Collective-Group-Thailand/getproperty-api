/** One line of an inspection checklist (`ops.inspection_template.items`). */
export interface ChecklistItem {
  key: string;
  labelTh: string;
  labelEn: string;
  area: string;
}

/** The platform default room checklist (tenant_id NULL), used when the room type names no template. */
export const DEFAULT_INSPECTION_TEMPLATE_NAME = 'ตรวจสภาพห้องมาตรฐาน';
export const DEFAULT_INSPECTION_ITEMS: readonly ChecklistItem[] = [
  { key: 'door_lock', labelTh: 'ประตูและกุญแจ', labelEn: 'Door and lock', area: 'entrance' },
  {
    key: 'keys',
    labelTh: 'กุญแจ / คีย์การ์ด ครบตามจำนวน',
    labelEn: 'Keys / key cards complete',
    area: 'entrance',
  },
  { key: 'walls', labelTh: 'ผนังและสี', labelEn: 'Walls and paint', area: 'room' },
  { key: 'floor', labelTh: 'พื้น', labelEn: 'Floor', area: 'room' },
  { key: 'ceiling', labelTh: 'ฝ้าเพดาน', labelEn: 'Ceiling', area: 'room' },
  { key: 'windows', labelTh: 'หน้าต่างและมุ้งลวด', labelEn: 'Windows and screens', area: 'room' },
  { key: 'curtains', labelTh: 'ม่าน', labelEn: 'Curtains', area: 'room' },
  { key: 'lights', labelTh: 'หลอดไฟและสวิตช์', labelEn: 'Lights and switches', area: 'room' },
  { key: 'sockets', labelTh: 'ปลั๊กไฟ', labelEn: 'Power sockets', area: 'room' },
  { key: 'bathroom_toilet', labelTh: 'สุขภัณฑ์', labelEn: 'Toilet', area: 'bathroom' },
  { key: 'bathroom_sink', labelTh: 'อ่างล้างหน้าและก๊อกน้ำ', labelEn: 'Sink and taps', area: 'bathroom' },
  { key: 'bathroom_shower', labelTh: 'ฝักบัวและท่อระบายน้ำ', labelEn: 'Shower and drain', area: 'bathroom' },
  { key: 'balcony', labelTh: 'ระเบียง', labelEn: 'Balcony', area: 'balcony' },
];
