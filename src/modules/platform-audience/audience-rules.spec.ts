import {
  costPreview,
  EMPTY_SEGMENT,
  inQuietHours,
  matchesSegment,
  messageLanguage,
  minimumOf,
  parseSegment,
  type PreferenceFacts,
  shownEstimate,
  sponsoredCharges,
  sponsoredMessage,
} from './audience-rules';

const PERSON: PreferenceFacts = {
  areaSlugs: ['ari'],
  budgetMin: '8000.00',
  budgetMax: '15000.00',
  unitKinds: ['condo_unit'],
  moveInFrom: '2026-12-01',
  moveInTo: '2027-01-31',
  language: 'th',
};
const CONDO_12K = [{ rent: '12000.00', unitKind: 'condo_unit' }];
const QUIET = { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' };

describe('G6 segment schema (closed whitelist, D-300)', () => {
  it('accepts the whitelisted fields and normalises money', () => {
    const { segment, problems } = parseSegment({
      areas: ['ari', 'ari'],
      budgetMin: '8000',
      unitKinds: ['room'],
    });
    expect(problems).toEqual([]);
    expect(segment).toEqual({ ...EMPTY_SEGMENT, areas: ['ari'], budgetMin: '8000.00', unitKinds: ['room'] });
  });

  it('refuses anything else — no special-category or free-form targeting', () => {
    const { problems } = parseSegment({ religion: 'x', nationality: 'MM', age: 30, areas: ['ari'] });
    expect(problems.map((p) => p.path)).toEqual(['segment.religion', 'segment.nationality', 'segment.age']);
  });

  it('refuses bad values and inverted ranges', () => {
    const { problems } = parseSegment({
      budgetMin: '9000',
      budgetMax: '8000',
      moveInFrom: '2027-02-01',
      moveInTo: '2027-01-01',
      unitKinds: ['castle'],
      languages: ['fr'],
    });
    expect(problems.map((p) => p.path).sort()).toEqual(
      ['segment.budgetMax', 'segment.languages', 'segment.moveInTo', 'segment.unitKinds'].sort(),
    );
  });
});

describe('G6 matching', () => {
  it('matches when every dimension set on both sides overlaps and a listing fits the person', () => {
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, areas: ['ari', 'chatuchak'] }, CONDO_12K)).toBe(true);
  });

  it('an empty dimension does not restrict', () => {
    expect(
      matchesSegment({ ...PERSON, areaSlugs: [] }, { ...EMPTY_SEGMENT, areas: ['bangna'] }, CONDO_12K),
    ).toBe(true);
    expect(matchesSegment(PERSON, EMPTY_SEGMENT, CONDO_12K)).toBe(true);
  });

  it('other areas, languages, kinds or windows do not match', () => {
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, areas: ['bangna'] }, CONDO_12K)).toBe(false);
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, languages: ['en'] }, CONDO_12K)).toBe(false);
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, unitKinds: ['house'] }, CONDO_12K)).toBe(false);
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, moveInFrom: '2027-03-01' }, CONDO_12K)).toBe(false);
    expect(matchesSegment(PERSON, { ...EMPTY_SEGMENT, budgetMin: '20000.00' }, CONDO_12K)).toBe(false);
  });

  it('never sends a place the person said they do not want (own budget / kind)', () => {
    expect(matchesSegment(PERSON, EMPTY_SEGMENT, [{ rent: '25000.00', unitKind: 'condo_unit' }])).toBe(false);
    expect(matchesSegment(PERSON, EMPTY_SEGMENT, [{ rent: '12000.00', unitKind: 'room' }])).toBe(false);
    expect(
      matchesSegment(PERSON, EMPTY_SEGMENT, [
        { rent: '25000.00', unitKind: 'condo_unit' },
        { rent: '9000.00', unitKind: 'condo_unit' },
      ]),
    ).toBe(true);
  });
});

describe('G6 quiet hours, estimate, charges, message', () => {
  it('quiet hours: platform default, or the person’s own window', () => {
    expect(inQuietHours(new Date('2026-11-01T15:30:00Z'), null, QUIET)).toBe(true); // 22:30 Bangkok
    expect(inQuietHours(new Date('2026-11-01T05:00:00Z'), null, QUIET)).toBe(false); // 12:00
    expect(inQuietHours(new Date('2026-11-01T05:00:00Z'), { start: '11:00', end: '13:00' }, QUIET)).toBe(
      true,
    );
    expect(inQuietHours(new Date('2026-11-01T15:30:00Z'), { start: '11:00', end: '13:00' }, QUIET)).toBe(
      false,
    );
  });

  it('withholds the estimate below the minimum and caps it at the maximum', () => {
    expect(shownEstimate(499, 500, 1000)).toEqual({ estimated: null, belowMinimum: true });
    expect(shownEstimate(2000, 500, 1000)).toEqual({ estimated: 1000, belowMinimum: false });
    expect(shownEstimate(2000, 500, 300)).toEqual({ estimated: null, belowMinimum: true });
  });

  it('bills delivered × price per recipient with VAT, half-up to the satang', () => {
    const c = sponsoredCharges('x', 813, '0.3750', '0.07');
    expect(c.lines[0]).toMatchObject({
      kind: 'sponsored_broadcast',
      quantity: '813.000',
      unitPrice: '0.3750',
    });
    expect(c).toMatchObject({ subtotal: '304.88', vatAmount: '21.34', total: '326.22', discount: '0.00' });
    expect(costPreview(1000, null, '0.07')).toBeNull();
    expect(costPreview(1000, '0.5', '0.07')).toEqual({
      recipients: 1000,
      subtotal: '500.00',
      vatAmount: '35.00',
      total: '535.00',
    });
  });

  it('minimum from the version terms, else the default 500', () => {
    expect(minimumOf({ minimumRecipients: 800 })).toBe(800);
    expect(minimumOf({})).toBe(500);
    expect(minimumOf(null)).toBe(500);
  });

  it('labels every bubble as an ad and ends with the why / stop bubble', () => {
    const [msg] = sponsoredMessage(
      'th',
      [
        {
          title: 'คอนโด',
          rent: '12000.00',
          place: 'พญาไท',
          imageUrl: 'https://x/og.png',
          url: 'https://w/s/abc',
        },
      ],
      'https://liff/recommendations',
    );
    const bubbles = (msg!.contents as { contents: Record<string, unknown>[] }).contents;
    expect(bubbles).toHaveLength(2);
    expect(JSON.stringify(bubbles[0])).toContain('โฆษณา');
    expect(JSON.stringify(bubbles[0])).toContain('฿12,000/เดือน');
    expect(JSON.stringify(bubbles[1])).toContain('https://liff/recommendations');
    expect(messageLanguage('my')).toBe('en');
    expect(messageLanguage('th')).toBe('th');
  });
});
