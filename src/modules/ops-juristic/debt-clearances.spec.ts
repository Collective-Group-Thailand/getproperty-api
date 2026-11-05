import { nameInitials } from './debt-clearances.service';

describe('nameInitials (PDPA, D-306)', () => {
  it('Thai names: first consonant of each word, leading vowels and titles skipped', () => {
    expect(nameInitials('สมชาย ใจดี')).toBe('ส. จ.');
    expect(nameInitials('นางสาว เอกชัย แก้วมณี')).toBe('อ. ก.');
  });

  it('Latin names upper-cased, titles dropped, at most three words', () => {
    expect(nameInitials('Mr. somchai  jaidee')).toBe('S. J.');
    expect(nameInitials('Anna Maria Lena Svensson')).toBe('A. M. L.');
  });
});
