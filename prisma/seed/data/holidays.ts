/**
 * Thai public holidays 2026–2027 (platform.business_calendar, calendar th_public) used by SLA timers and due dates
 * (D-159). Dates as published for the year, including substitution days; weekend holidays are listed too.
 * Bank holidays (BOT) are a separate calendar (th_bank) seeded once the Bank of Thailand announces them.
 * Sources: 2026 — InfoQuest "วันหยุดประจำปี 2569"; 2027 — Time Out Bangkok "ปฏิทินวันหยุดไทยประจำปี 2570"
 * (the Ploughing Ceremony day 2027 was not yet announced and is not listed). Re-check against the cabinet
 * resolution when it is published.
 */
export interface HolidaySeed {
  date: string;
  nameTh: string;
  nameEn: string;
  sourceUrl: string;
}

const S2026 = 'https://www.infoquest.co.th/?p=64932';
const S2027 = 'https://www.timeout.com/bangkok/th/news/thailand-public-holidays-100226';

export const HOLIDAYS: HolidaySeed[] = [
  // 2026 (B.E. 2569)
  { date: '2026-01-01', nameTh: 'วันขึ้นปีใหม่', nameEn: "New Year's Day", sourceUrl: S2026 },
  { date: '2026-01-02', nameTh: 'วันหยุดพิเศษ', nameEn: 'Special holiday', sourceUrl: S2026 },
  { date: '2026-03-03', nameTh: 'วันมาฆบูชา', nameEn: 'Makha Bucha Day', sourceUrl: S2026 },
  { date: '2026-04-06', nameTh: 'วันจักรี', nameEn: 'Chakri Memorial Day', sourceUrl: S2026 },
  { date: '2026-04-13', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2026 },
  { date: '2026-04-14', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2026 },
  { date: '2026-04-15', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2026 },
  { date: '2026-05-01', nameTh: 'วันแรงงานแห่งชาติ', nameEn: 'National Labour Day', sourceUrl: S2026 },
  { date: '2026-05-04', nameTh: 'วันฉัตรมงคล', nameEn: 'Coronation Day', sourceUrl: S2026 },
  {
    date: '2026-05-13',
    nameTh: 'วันพืชมงคล (หน่วยงานราชการ)',
    nameEn: 'Royal Ploughing Ceremony (government offices)',
    sourceUrl: S2026,
  },
  { date: '2026-05-31', nameTh: 'วันวิสาขบูชา', nameEn: 'Visakha Bucha Day', sourceUrl: S2026 },
  {
    date: '2026-06-01',
    nameTh: 'วันหยุดชดเชยวันวิสาขบูชา',
    nameEn: 'Visakha Bucha Day (substitution)',
    sourceUrl: S2026,
  },
  {
    date: '2026-06-03',
    nameTh: 'วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี',
    nameEn: "Queen Suthida's Birthday",
    sourceUrl: S2026,
  },
  {
    date: '2026-07-28',
    nameTh: 'วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว',
    nameEn: "King's Birthday",
    sourceUrl: S2026,
  },
  { date: '2026-07-29', nameTh: 'วันอาสาฬหบูชา', nameEn: 'Asalha Bucha Day', sourceUrl: S2026 },
  {
    date: '2026-07-30',
    nameTh: 'วันเข้าพรรษา (หน่วยงานราชการ)',
    nameEn: 'Buddhist Lent Day (government offices)',
    sourceUrl: S2026,
  },
  { date: '2026-08-12', nameTh: 'วันแม่แห่งชาติ', nameEn: "National Mother's Day", sourceUrl: S2026 },
  { date: '2026-10-13', nameTh: 'วันนวมินทรมหาราช', nameEn: 'King Bhumibol Memorial Day', sourceUrl: S2026 },
  { date: '2026-10-23', nameTh: 'วันปิยมหาราช', nameEn: 'Chulalongkorn Day', sourceUrl: S2026 },
  {
    date: '2026-12-05',
    nameTh: 'วันพ่อแห่งชาติ วันชาติ',
    nameEn: "National Day / Father's Day",
    sourceUrl: S2026,
  },
  {
    date: '2026-12-07',
    nameTh: 'วันหยุดชดเชยวันพ่อแห่งชาติ',
    nameEn: "Father's Day (substitution)",
    sourceUrl: S2026,
  },
  { date: '2026-12-10', nameTh: 'วันรัฐธรรมนูญ', nameEn: 'Constitution Day', sourceUrl: S2026 },
  { date: '2026-12-31', nameTh: 'วันสิ้นปี', nameEn: "New Year's Eve", sourceUrl: S2026 },
  // 2027 (B.E. 2570)
  { date: '2027-01-01', nameTh: 'วันขึ้นปีใหม่', nameEn: "New Year's Day", sourceUrl: S2027 },
  { date: '2027-02-21', nameTh: 'วันมาฆบูชา', nameEn: 'Makha Bucha Day', sourceUrl: S2027 },
  {
    date: '2027-02-22',
    nameTh: 'วันหยุดชดเชยวันมาฆบูชา',
    nameEn: 'Makha Bucha Day (substitution)',
    sourceUrl: S2027,
  },
  { date: '2027-04-06', nameTh: 'วันจักรี', nameEn: 'Chakri Memorial Day', sourceUrl: S2027 },
  { date: '2027-04-13', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2027 },
  { date: '2027-04-14', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2027 },
  { date: '2027-04-15', nameTh: 'วันสงกรานต์', nameEn: 'Songkran', sourceUrl: S2027 },
  { date: '2027-05-01', nameTh: 'วันแรงงานแห่งชาติ', nameEn: 'National Labour Day', sourceUrl: S2027 },
  {
    date: '2027-05-03',
    nameTh: 'วันหยุดชดเชยวันแรงงาน',
    nameEn: 'Labour Day (substitution)',
    sourceUrl: S2027,
  },
  { date: '2027-05-04', nameTh: 'วันฉัตรมงคล', nameEn: 'Coronation Day', sourceUrl: S2027 },
  { date: '2027-05-20', nameTh: 'วันวิสาขบูชา', nameEn: 'Visakha Bucha Day', sourceUrl: S2027 },
  {
    date: '2027-06-03',
    nameTh: 'วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี',
    nameEn: "Queen Suthida's Birthday",
    sourceUrl: S2027,
  },
  { date: '2027-07-18', nameTh: 'วันอาสาฬหบูชา', nameEn: 'Asalha Bucha Day', sourceUrl: S2027 },
  {
    date: '2027-07-19',
    nameTh: 'วันเข้าพรรษา / หยุดชดเชยวันอาสาฬหบูชา',
    nameEn: 'Buddhist Lent Day / Asalha Bucha (substitution)',
    sourceUrl: S2027,
  },
  {
    date: '2027-07-28',
    nameTh: 'วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว',
    nameEn: "King's Birthday",
    sourceUrl: S2027,
  },
  { date: '2027-08-12', nameTh: 'วันแม่แห่งชาติ', nameEn: "National Mother's Day", sourceUrl: S2027 },
  { date: '2027-10-13', nameTh: 'วันนวมินทรมหาราช', nameEn: 'King Bhumibol Memorial Day', sourceUrl: S2027 },
  { date: '2027-10-23', nameTh: 'วันปิยมหาราช', nameEn: 'Chulalongkorn Day', sourceUrl: S2027 },
  {
    date: '2027-10-25',
    nameTh: 'วันหยุดชดเชยวันปิยมหาราช',
    nameEn: 'Chulalongkorn Day (substitution)',
    sourceUrl: S2027,
  },
  {
    date: '2027-12-05',
    nameTh: 'วันพ่อแห่งชาติ วันชาติ',
    nameEn: "National Day / Father's Day",
    sourceUrl: S2027,
  },
  {
    date: '2027-12-06',
    nameTh: 'วันหยุดชดเชยวันพ่อแห่งชาติ',
    nameEn: "Father's Day (substitution)",
    sourceUrl: S2027,
  },
  { date: '2027-12-10', nameTh: 'วันรัฐธรรมนูญ', nameEn: 'Constitution Day', sourceUrl: S2027 },
  { date: '2027-12-31', nameTh: 'วันสิ้นปี', nameEn: "New Year's Eve", sourceUrl: S2027 },
];
