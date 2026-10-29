import {
  addMonths,
  cleanText,
  personalDataIn,
  reviewEligibility,
  summarise,
  type TenureLease,
  tenureMonths,
  tenureOf,
} from './review-rules';

const RULES = { minTenureMonths: 3, windowAfterEndDays: 365 };
const lease = (over: Partial<TenureLease> = {}): TenureLease => ({
  status: 'active',
  startDate: new Date('2026-01-15'),
  endDate: new Date('2027-01-14'),
  activatedAt: new Date('2026-01-10T03:00:00Z'),
  moveInAt: null,
  moveOutAt: null,
  endedAt: null,
  terminatedAt: null,
  ...over,
});

describe('review rules (G9, D-301)', () => {
  it('adds calendar months with end-of-month clamping', () => {
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    expect(addMonths('2025-11-30', 3)).toBe('2026-02-28');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
  });

  it('tenure starts at move-in (Bangkok date), else the lease start; ends at move-out, else the end', () => {
    expect(tenureOf(lease())).toEqual({ from: '2026-01-15', to: null });
    expect(tenureOf(lease({ moveInAt: new Date('2026-01-19T18:30:00Z') }))).toEqual({
      from: '2026-01-20',
      to: null,
    });
    expect(
      tenureOf(
        lease({
          status: 'ended',
          moveOutAt: new Date('2026-08-31T05:00:00Z'),
          endedAt: new Date('2026-09-01'),
        }),
      ),
    ).toEqual({ from: '2026-01-15', to: '2026-08-31' });
    expect(tenureOf(lease({ status: 'terminated', terminatedAt: new Date('2026-05-02T02:00:00Z') }))).toEqual(
      {
        from: '2026-01-15',
        to: '2026-05-02',
      },
    );
  });

  it('a lease that never started (draft, pending signature, cancelled, not activated) cannot be reviewed', () => {
    for (const status of ['draft', 'pending_signature', 'cancelled'] as const)
      expect(reviewEligibility(lease({ status }), '2026-10-01', RULES)).toMatchObject({
        eligible: false,
        reason: 'not_started',
      });
    expect(reviewEligibility(lease({ activatedAt: null }), '2026-10-01', RULES)).toMatchObject({
      eligible: false,
      reason: 'not_started',
    });
  });

  it('while living there: only after the minimum tenure, with the first eligible day', () => {
    expect(reviewEligibility(lease(), '2026-04-14', RULES)).toEqual({
      eligible: false,
      reason: 'too_early',
      eligibleFrom: '2026-04-15',
      tenure: { from: '2026-01-15', to: null },
    });
    expect(reviewEligibility(lease(), '2026-04-15', RULES)).toMatchObject({ eligible: true });
    expect(reviewEligibility(lease({ status: 'notice_given' }), '2026-05-01', RULES)).toMatchObject({
      eligible: true,
    });
  });

  it('after move-out: at once (even after a short stay), until the window closes', () => {
    const ended = lease({ status: 'ended', moveOutAt: new Date('2026-02-20T04:00:00Z') });
    expect(reviewEligibility(ended, '2026-02-21', RULES)).toMatchObject({ eligible: true });
    expect(reviewEligibility(ended, '2027-02-20', RULES)).toMatchObject({ eligible: true });
    expect(reviewEligibility(ended, '2027-02-21', RULES)).toMatchObject({
      eligible: false,
      reason: 'window_closed',
      eligibleFrom: null,
    });
  });

  it('shows tenure as months only', () => {
    expect(tenureMonths({ from: '2025-01-15', to: '2026-03-31' })).toEqual({
      from: '2025-01',
      to: '2026-03',
    });
    expect(tenureMonths({ from: '2025-01-15', to: null })).toEqual({ from: '2025-01', to: null });
  });

  it('finds contact, account and ID data in a review (Thai digits and separators too)', () => {
    expect(personalDataIn('ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย ค่าไฟ 7 บาท อยู่ชั้น 12')).toEqual(
      [],
    );
    expect(personalDataIn('The BTS line is close and the 24-hour shop is great, 4 stars')).toEqual([]);
    expect(personalDataIn('โทรหาเจ้าของ 081-234-5678')).toEqual(['phone']);
    expect(personalDataIn('โทร ๐๘๑๒๓๔๕๖๗๘ ได้เลย')).toEqual(['phone']);
    expect(personalDataIn('mail me: somchai@example.com')).toEqual(['email']);
    expect(personalDataIn('แอดไลน์ ไลน์: somchai99')).toEqual(['line_id']);
    expect(personalDataIn('add @mybuilding for deals')).toEqual(['line_id']);
    expect(personalDataIn('ดูรีวิวเพิ่มที่ https://example.com/x')).toEqual(['link']);
    expect(personalDataIn('โอนเข้าบัญชี 123-4-56789-0 ก่อน')).toEqual(['bank_account']);
    expect(personalDataIn('เลขบัตร 1-2345-67890-12-3 ของนิติ')).toEqual(['national_id']);
  });

  it('cleans whitespace and summarises ratings half-up to one decimal', () => {
    expect(cleanText('  a \t b \r\n\r\n\r\n c  ')).toBe('a b \n\n c');
    expect(cleanText('   ')).toBeNull();
    expect(summarise([])).toEqual({ count: 0, average: null, distribution: [0, 0, 0, 0, 0] });
    expect(summarise([5, 4, 4, 2])).toEqual({ count: 4, average: '3.8', distribution: [0, 1, 0, 2, 1] });
    expect(summarise([5, 4]).average).toBe('4.5');
  });
});
