import { isValidThaiId } from './thai-id';

describe('Thai national id checksum', () => {
  it('accepts ids whose 13th digit matches (generated fixtures, not real people)', () => {
    // 1-2345-67890-12-1: Σ digit×weight = 352 → (11 − 352 mod 11) mod 10 = 1
    expect(isValidThaiId('1234567890121')).toBe(true);
    expect(isValidThaiId('1-2345-67890-12-1')).toBe(true);
  });
  it('refuses wrong check digits, lengths and letters', () => {
    expect(isValidThaiId('1234567890122')).toBe(false);
    expect(isValidThaiId('0000000000002')).toBe(false); // the contract examples' fake id never validates
    expect(isValidThaiId('123456789012')).toBe(false);
    expect(isValidThaiId('12345678901AB')).toBe(false);
  });
});
