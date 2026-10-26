import { bankAccountIn } from './message-safety';

/** D-267: bank account numbers never travel in enquiry messages. */
describe('bank account numbers in enquiry messages (D-267)', () => {
  it.each([
    'โอนมัดจำมาที่ 123-4-56789-0 นะคะ',
    'บัญชีกสิกร 1234567890 ชื่อสมชาย',
    'เลขบัญชี ๑๒๓๔๕๖๗๘๙๐',
    'Please transfer the booking to account 0123456789',
    'SCB 987654321012',
  ])('refuses %s', (text) => expect(bankAccountIn(text)).toBe(true));

  it.each([
    'โทรหาผมได้ที่ 081-234-5678 ครับ',
    'เบอร์ 0812345678 ว่างทุกวัน',
    'ค่าเช่า 15,000 บาท มัดจำ 2 เดือน',
    'ห้อง 12/345 ชั้น 12 นัดดูเสาร์ 10:00',
    'รหัสไปรษณีย์ 10400',
  ])('lets %s through', (text) => expect(bankAccountIn(text)).toBe(false));
});
