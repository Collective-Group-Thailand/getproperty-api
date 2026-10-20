import { type Column, xlsxOf } from '@modules/ops-receivables/exports/sheets';

import { ISO3166_ALPHA3 } from './iso3166';

/** Format version written on every `ops.tm30_export` row (a column change is a new version). */
export const TM30_FORMAT = 'immigration_xlsx_v1';

/** One foreign occupant as the Immigration Bureau upload file needs it (values already decrypted). */
export interface Tm30Person {
  passportNo: string | null;
  /** ISO 3166-1 alpha-2 (`core.party.nationality`). */
  nationality: string | null;
  firstName: string | null;
  middleName?: string | null;
  lastName: string | null;
  /** `M` / `F` (`core.party.gender`). */
  gender: string | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
  /** Date of entry into Thailand `YYYY-MM-DD` (`ops.occupant_profile.arrival_date`). */
  arrivalDate: string | null;
  visaType: string | null;
  entryPort: string | null;
  /** Check-in at the premises = the move-in, Bangkok date `YYYY-MM-DD`. */
  checkInDate: string;
  unitNo: string;
}

/** Fields the Immigration Bureau requires per person (`tm30.data_missing` lists those absent). */
export const TM30_REQUIRED: readonly (keyof Tm30Person)[] = [
  'passportNo',
  'nationality',
  'firstName',
  'lastName',
  'gender',
  'dateOfBirth',
  'arrivalDate',
];

export function tm30Missing(p: Tm30Person): string[] {
  const missing = TM30_REQUIRED.filter((k) => !p[k] || String(p[k]).trim() === '') as string[];
  if (p.nationality && !ISO3166_ALPHA3.has(p.nationality.toUpperCase())) missing.push('nationality');
  if (p.gender && !['M', 'F'].includes(p.gender.toUpperCase())) missing.push('gender');
  return [...new Set(missing)];
}

/** `YYYY-MM-DD` → `DD/MM/YYYY` in the Buddhist Era (พ.ศ. = ค.ศ. + 543), the form Thai government uploads use. */
export function thaiDate(ymd: string | null): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const [y, m, d] = ymd.split('-') as [string, string, string];
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * Columns of the Immigration Bureau's TM30 bulk upload (`immigration_xlsx_v1`): one row per foreign occupant, the
 * header in the first row (the upload has no preamble), dates DD/MM/YYYY พ.ศ., nationality as ISO alpha-3, names in
 * upper-case Latin letters as in the passport.
 * // UNVERIFIED against live provider: column set and order follow the Immigration Bureau's published "แจ้งที่พัก
 * คนต่างด้าว (ตม.30)" upload template as described on its web service; confirm with the current template before
 * the first upload — a change is a new format version.
 */
export const TM30_COLUMNS: readonly Column[] = [
  { key: 'seq', header: 'ลำดับ (No.)', type: 'int', width: 8 },
  { key: 'passportNo', header: 'เลขหนังสือเดินทาง (Passport No.)', width: 22 },
  { key: 'nationality', header: 'สัญชาติ (Nationality)', width: 12 },
  { key: 'firstName', header: 'ชื่อ (First Name)', width: 20 },
  { key: 'middleName', header: 'ชื่อกลาง (Middle Name)', width: 16 },
  { key: 'lastName', header: 'นามสกุล (Last Name)', width: 20 },
  { key: 'gender', header: 'เพศ (Gender)', width: 8 },
  { key: 'dateOfBirth', header: 'วันเกิด (Date of Birth)', width: 14 },
  { key: 'arrivalDate', header: 'วันที่เดินทางเข้า (Arrival Date)', width: 14 },
  { key: 'visaType', header: 'ประเภทการตรวจลงตรา (Visa Type)', width: 14 },
  { key: 'entryPort', header: 'ช่องทางเข้า (Port of Entry)', width: 18 },
  { key: 'checkInDate', header: 'วันที่เข้าพัก (Check-in Date)', width: 14 },
  { key: 'unitNo', header: 'ห้อง (Room No.)', width: 10 },
];

const upperLatin = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/** The rows of the upload, ordered by check-in date, unit and last name (deterministic). */
export function tm30Rows(people: readonly Tm30Person[]): Record<string, string | number | null>[] {
  return [...people]
    .sort(
      (a, b) =>
        a.checkInDate.localeCompare(b.checkInDate) ||
        a.unitNo.localeCompare(b.unitNo) ||
        upperLatin(a.lastName).localeCompare(upperLatin(b.lastName)),
    )
    .map((p, i) => ({
      seq: i + 1,
      passportNo: upperLatin(p.passportNo).replace(/\s+/g, ''),
      nationality: ISO3166_ALPHA3.get(upperLatin(p.nationality)) ?? upperLatin(p.nationality),
      firstName: upperLatin(p.firstName),
      middleName: upperLatin(p.middleName),
      lastName: upperLatin(p.lastName),
      gender: upperLatin(p.gender),
      dateOfBirth: thaiDate(p.dateOfBirth),
      arrivalDate: thaiDate(p.arrivalDate),
      visaType: upperLatin(p.visaType),
      entryPort: (p.entryPort ?? '').trim(),
      checkInDate: thaiDate(p.checkInDate),
      unitNo: p.unitNo,
    }));
}

/** The `.xlsx` upload file (sheet `TM30`). */
export function tm30Workbook(people: readonly Tm30Person[], createdAt: Date): Promise<Buffer> {
  return xlsxOf([{ name: 'TM30', columns: TM30_COLUMNS, rows: tm30Rows(people) }], {
    creator: 'getproperty',
    createdAt,
  });
}
