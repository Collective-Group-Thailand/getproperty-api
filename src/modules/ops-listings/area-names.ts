/**
 * Reference names of the areas and stations that area pages are made of (D-272): the Thai name owners type, the
 * English name for `/en`, and a stable ASCII slug for the page URL (`/rent/area/phaya-thai`). Bangkok's 50 districts,
 * the districts of Nonthaburi, Samut Prakan and Pathum Thani, and the stations of the BTS Sukhumvit / Silom lines, the
 * MRT Blue line and the Airport Rail Link. A name not listed here still gets a page under a hashed slug and its Thai
 * name; adding it here gives it its English name and readable slug.
 */

export interface PlaceName {
  en: string;
  slug: string;
}

const slugOf = (en: string) =>
  en
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const PROVINCES: Record<string, string> = {
  กรุงเทพมหานคร: 'Bangkok',
  นนทบุรี: 'Nonthaburi',
  สมุทรปราการ: 'Samut Prakan',
  ปทุมธานี: 'Pathum Thani',
};

const DISTRICT_EN: Record<string, Record<string, string>> = {
  กรุงเทพมหานคร: {
    พระนคร: 'Phra Nakhon',
    ดุสิต: 'Dusit',
    หนองจอก: 'Nong Chok',
    บางรัก: 'Bang Rak',
    บางเขน: 'Bang Khen',
    บางกะปิ: 'Bang Kapi',
    ปทุมวัน: 'Pathum Wan',
    ป้อมปราบศัตรูพ่าย: 'Pom Prap Sattru Phai',
    พระโขนง: 'Phra Khanong',
    มีนบุรี: 'Min Buri',
    ลาดกระบัง: 'Lat Krabang',
    ยานนาวา: 'Yan Nawa',
    สัมพันธวงศ์: 'Samphanthawong',
    พญาไท: 'Phaya Thai',
    ธนบุรี: 'Thon Buri',
    บางกอกใหญ่: 'Bangkok Yai',
    ห้วยขวาง: 'Huai Khwang',
    คลองสาน: 'Khlong San',
    ตลิ่งชัน: 'Taling Chan',
    บางกอกน้อย: 'Bangkok Noi',
    บางขุนเทียน: 'Bang Khun Thian',
    ภาษีเจริญ: 'Phasi Charoen',
    หนองแขม: 'Nong Khaem',
    ราษฎร์บูรณะ: 'Rat Burana',
    บางพลัด: 'Bang Phlat',
    ดินแดง: 'Din Daeng',
    บึงกุ่ม: 'Bueng Kum',
    สาทร: 'Sathon',
    บางซื่อ: 'Bang Sue',
    จตุจักร: 'Chatuchak',
    บางคอแหลม: 'Bang Kho Laem',
    ประเวศ: 'Prawet',
    คลองเตย: 'Khlong Toei',
    สวนหลวง: 'Suan Luang',
    จอมทอง: 'Chom Thong',
    ดอนเมือง: 'Don Mueang',
    ราชเทวี: 'Ratchathewi',
    ลาดพร้าว: 'Lat Phrao',
    วัฒนา: 'Watthana',
    บางแค: 'Bang Khae',
    หลักสี่: 'Lak Si',
    สายไหม: 'Sai Mai',
    คันนายาว: 'Khan Na Yao',
    สะพานสูง: 'Saphan Sung',
    วังทองหลาง: 'Wang Thonglang',
    คลองสามวา: 'Khlong Sam Wa',
    บางนา: 'Bang Na',
    ทวีวัฒนา: 'Thawi Watthana',
    ทุ่งครุ: 'Thung Khru',
    บางบอน: 'Bang Bon',
  },
  นนทบุรี: {
    เมืองนนทบุรี: 'Mueang Nonthaburi',
    บางกรวย: 'Bang Kruai',
    บางใหญ่: 'Bang Yai',
    บางบัวทอง: 'Bang Bua Thong',
    ไทรน้อย: 'Sai Noi',
    ปากเกร็ด: 'Pak Kret',
  },
  สมุทรปราการ: {
    เมืองสมุทรปราการ: 'Mueang Samut Prakan',
    บางบ่อ: 'Bang Bo',
    บางพลี: 'Bang Phli',
    พระประแดง: 'Phra Pradaeng',
    พระสมุทรเจดีย์: 'Phra Samut Chedi',
    บางเสาธง: 'Bang Sao Thong',
  },
  ปทุมธานี: {
    เมืองปทุมธานี: 'Mueang Pathum Thani',
    คลองหลวง: 'Khlong Luang',
    ธัญบุรี: 'Thanyaburi',
    หนองเสือ: 'Nong Suea',
    ลาดหลุมแก้ว: 'Lat Lum Kaeo',
    ลำลูกกา: 'Lam Luk Ka',
    สามโคก: 'Sam Khok',
  },
};

/** Station → [English name, system]. An interchange (สยาม, พญาไท, บางหว้า) is one station. */
const STATION_EN: Record<string, [string, 'BTS' | 'MRT' | 'ARL']> = {
  // BTS Sukhumvit line
  คูคต: ['Khu Khot', 'BTS'],
  แยก_คปอ: ['Yaek Kor Por Aor', 'BTS'],
  สะพานใหม่: ['Saphan Mai', 'BTS'],
  สายหยุด: ['Sai Yud', 'BTS'],
  'พหลโยธิน 59': ['Phahon Yothin 59', 'BTS'],
  วัดพระศรีมหาธาตุ: ['Wat Phra Sri Mahathat', 'BTS'],
  'กรมทหารราบที่ 11': ['11th Infantry Regiment', 'BTS'],
  บางบัว: ['Bang Bua', 'BTS'],
  กรมป่าไม้: ['Royal Forest Department', 'BTS'],
  มหาวิทยาลัยเกษตรศาสตร์: ['Kasetsart University', 'BTS'],
  เสนานิคม: ['Sena Nikhom', 'BTS'],
  รัชโยธิน: ['Ratchayothin', 'BTS'],
  'พหลโยธิน 24': ['Phahon Yothin 24', 'BTS'],
  ห้าแยกลาดพร้าว: ['Ha Yaek Lat Phrao', 'BTS'],
  หมอชิต: ['Mo Chit', 'BTS'],
  สะพานควาย: ['Saphan Khwai', 'BTS'],
  อารีย์: ['Ari', 'BTS'],
  สนามเป้า: ['Sanam Pao', 'BTS'],
  อนุสาวรีย์ชัยสมรภูมิ: ['Victory Monument', 'BTS'],
  พญาไท: ['Phaya Thai', 'BTS'],
  ราชเทวี: ['Ratchathewi', 'BTS'],
  สยาม: ['Siam', 'BTS'],
  ชิดลม: ['Chit Lom', 'BTS'],
  เพลินจิต: ['Phloen Chit', 'BTS'],
  นานา: ['Nana', 'BTS'],
  อโศก: ['Asok', 'BTS'],
  พร้อมพงษ์: ['Phrom Phong', 'BTS'],
  ทองหล่อ: ['Thong Lo', 'BTS'],
  เอกมัย: ['Ekkamai', 'BTS'],
  พระโขนง: ['Phra Khanong', 'BTS'],
  อ่อนนุช: ['On Nut', 'BTS'],
  บางจาก: ['Bang Chak', 'BTS'],
  ปุณณวิถี: ['Punnawithi', 'BTS'],
  อุดมสุข: ['Udom Suk', 'BTS'],
  บางนา: ['Bang Na', 'BTS'],
  แบริ่ง: ['Bearing', 'BTS'],
  สำโรง: ['Samrong', 'BTS'],
  // BTS Silom line
  สนามกีฬาแห่งชาติ: ['National Stadium', 'BTS'],
  ราชดำริ: ['Ratchadamri', 'BTS'],
  ศาลาแดง: ['Sala Daeng', 'BTS'],
  ช่องนนทรี: ['Chong Nonsi', 'BTS'],
  เซนต์หลุยส์: ['Saint Louis', 'BTS'],
  สุรศักดิ์: ['Surasak', 'BTS'],
  สะพานตากสิน: ['Saphan Taksin', 'BTS'],
  กรุงธนบุรี: ['Krung Thon Buri', 'BTS'],
  วงเวียนใหญ่: ['Wongwian Yai', 'BTS'],
  โพธิ์นิมิตร: ['Pho Nimit', 'BTS'],
  ตลาดพลู: ['Talat Phlu', 'BTS'],
  วุฒากาศ: ['Wutthakat', 'BTS'],
  บางหว้า: ['Bang Wa', 'BTS'],
  // MRT Blue line
  หัวลำโพง: ['Hua Lamphong', 'MRT'],
  สามย่าน: ['Sam Yan', 'MRT'],
  สีลม: ['Si Lom', 'MRT'],
  ลุมพินี: ['Lumphini', 'MRT'],
  คลองเตย: ['Khlong Toei', 'MRT'],
  ศูนย์การประชุมแห่งชาติสิริกิติ์: ['Queen Sirikit National Convention Centre', 'MRT'],
  สุขุมวิท: ['Sukhumvit', 'MRT'],
  เพชรบุรี: ['Phetchaburi', 'MRT'],
  'พระราม 9': ['Phra Ram 9', 'MRT'],
  ศูนย์วัฒนธรรมแห่งประเทศไทย: ['Thailand Cultural Centre', 'MRT'],
  ห้วยขวาง: ['Huai Khwang', 'MRT'],
  สุทธิสาร: ['Sutthisan', 'MRT'],
  รัชดาภิเษก: ['Ratchadaphisek', 'MRT'],
  ลาดพร้าว: ['Lat Phrao', 'MRT'],
  พหลโยธิน: ['Phahon Yothin', 'MRT'],
  สวนจตุจักร: ['Chatuchak Park', 'MRT'],
  กำแพงเพชร: ['Kamphaeng Phet', 'MRT'],
  บางซื่อ: ['Bang Sue', 'MRT'],
  เตาปูน: ['Tao Poon', 'MRT'],
  บางโพ: ['Bang Pho', 'MRT'],
  บางอ้อ: ['Bang O', 'MRT'],
  บางพลัด: ['Bang Phlat', 'MRT'],
  สิรินธร: ['Sirindhorn', 'MRT'],
  บางยี่ขัน: ['Bang Yi Khan', 'MRT'],
  บางขุนนนท์: ['Bang Khun Non', 'MRT'],
  แยกไฟฉาย: ['Fai Chai', 'MRT'],
  'จรัญฯ 13': ['Charan 13', 'MRT'],
  ท่าพระ: ['Tha Phra', 'MRT'],
  วัดมังกร: ['Wat Mangkon', 'MRT'],
  สามยอด: ['Sam Yot', 'MRT'],
  สนามไชย: ['Sanam Chai', 'MRT'],
  อิสรภาพ: ['Itsaraphap', 'MRT'],
  บางไผ่: ['Bang Phai', 'MRT'],
  'เพชรเกษม 48': ['Phetkasem 48', 'MRT'],
  ภาษีเจริญ: ['Phasi Charoen', 'MRT'],
  บางแค: ['Bang Khae', 'MRT'],
  หลักสอง: ['Lak Song', 'MRT'],
  // Airport Rail Link
  ราชปรารภ: ['Ratchaprarop', 'ARL'],
  มักกะสัน: ['Makkasan', 'ARL'],
  รามคำแหง: ['Ramkhamhaeng', 'ARL'],
  หัวหมาก: ['Hua Mak', 'ARL'],
  บ้านทับช้าง: ['Ban Thap Chang', 'ARL'],
  ลาดกระบัง: ['Lat Krabang', 'ARL'],
  สุวรรณภูมิ: ['Suvarnabhumi', 'ARL'],
};

const space = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** `เขตพญาไท`, `อ. ปากเกร็ด` → `พญาไท`, `ปากเกร็ด`. */
export function districtKey(name: string): string {
  return space(name).replace(/^(เขต|อำเภอ|อ\.)\s*/u, '');
}

/** `BTS อารีย์`, `สถานีรถไฟฟ้า MRT ลาดพร้าว`, `Ari BTS` → `อารีย์`, `ลาดพร้าว`, `ari`. */
export function stationKey(name: string): string {
  let s = space(name);
  for (let i = 0; i < 4; i++)
    s = s
      .replace(/^(สถานี|รถไฟฟ้า|bts|mrt|arl|airport rail link|srt)\s*/iu, '')
      .replace(/\s*(สถานี|bts|mrt|arl|station)$/iu, '')
      .trim();
  return s.replace(/^จรัญ\s*13$/u, 'จรัญฯ 13').replace(/^แยก\s*คปอ\.?$/u, 'แยก_คปอ');
}

const DISTRICT_SLUGS = new Set(
  Object.values(DISTRICT_EN).flatMap((districts) => Object.values(districts).map(slugOf)),
);

/** A short, stable ASCII id of a name that has no English name here. */
function hashed(text: string): string {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

export function districtName(district: string, province: string | null): PlaceName {
  const key = districtKey(district);
  const en = province ? DISTRICT_EN[space(province)]?.[key] : undefined;
  if (en) return { en, slug: slugOf(en) };
  return { en: key, slug: `area-${hashed(`${province ?? ''}|${key}`)}` };
}

export function stationName(name: string): PlaceName & { system: string | null } {
  const key = stationKey(name);
  const known = STATION_EN[key];
  if (!known) return { en: key, slug: `station-${hashed(key.toLowerCase())}`, system: null };
  const slug = slugOf(known[0]);
  return { en: known[0], slug: DISTRICT_SLUGS.has(slug) ? `${slug}-station` : slug, system: known[1] };
}

/** The Thai display name of a station key (`แยก_คปอ` → `แยก คปอ.`). */
export function stationDisplay(key: string): string {
  return key === 'แยก_คปอ' ? 'แยก คปอ.' : key;
}

export function provinceEn(province: string | null): string | null {
  return province ? (PROVINCES[space(province)] ?? province) : null;
}
