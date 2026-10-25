import { bahtTextEn, englishDate } from './english-text';

describe('English text for landlord documents', () => {
  it.each([
    ['0', 'Zero baht only'],
    ['1', 'One baht only'],
    ['15', 'Fifteen baht only'],
    ['21', 'Twenty-one baht only'],
    ['101', 'One hundred one baht only'],
    ['15000', 'Fifteen thousand baht only'],
    ['30000.00', 'Thirty thousand baht only'],
    ['1250.50', 'One thousand two hundred fifty baht and fifty satang'],
    ['0.25', 'Twenty-five satang'],
    ['1000000', 'One million baht only'],
    ['2511021.01', 'Two million five hundred eleven thousand twenty-one baht and one satang'],
  ])('%s → %s', (amount, text) => {
    expect(bahtTextEn(amount)).toBe(text);
  });

  it('formats dates in the Gregorian calendar', () => {
    expect(englishDate('2026-11-01')).toBe('1 November 2026');
    expect(englishDate('2027-02-28')).toBe('28 February 2027');
    expect(() => englishDate('2027-2-28')).toThrow(RangeError);
  });
});
