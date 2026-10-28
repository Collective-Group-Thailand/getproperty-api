import {
  codeWindow,
  endStateAfterWindow,
  insideWindow,
  missingRequirements,
  overstaying,
  termsOutdated,
  visitorTerms,
} from './self-viewing-rules';

const at = (iso: string) => new Date(iso);
const SLOT = at('2026-11-07T10:00:00+07:00');

describe('self-viewing rules (G7, D-289 (1), D-295)', () => {
  it('opens the code early minutes before the slot and closes it code minutes after the start', () => {
    const w = codeWindow(SLOT, { codeMinutes: 30, earlyMinutes: 5 });
    expect(w.validFrom.toISOString()).toBe('2026-11-07T02:55:00.000Z');
    expect(w.validTo.toISOString()).toBe('2026-11-07T03:30:00.000Z');
    expect(insideWindow(w, at('2026-11-07T09:54:59+07:00'))).toBe(false);
    expect(insideWindow(w, at('2026-11-07T09:55:00+07:00'))).toBe(true);
    expect(insideWindow(w, at('2026-11-07T10:29:59+07:00'))).toBe(true);
    expect(insideWindow(w, at('2026-11-07T10:30:00+07:00'))).toBe(false);
  });

  it('lists what a prospect still lacks, in order', () => {
    expect(
      missingRequirements({
        identityVerified: false,
        phoneVerified: false,
        termsVersion: null,
        currentTermsVersion: 1,
      }),
    ).toEqual(['identity', 'phone', 'terms']);
    expect(
      missingRequirements({
        identityVerified: true,
        phoneVerified: false,
        termsVersion: 1,
        currentTermsVersion: 1,
      }),
    ).toEqual(['phone']);
    expect(
      missingRequirements({
        identityVerified: true,
        phoneVerified: true,
        termsVersion: 1,
        currentTermsVersion: 1,
      }),
    ).toEqual([]);
  });

  it('asks for a new acceptance when the visitor terms changed', () => {
    expect(termsOutdated(1, 1)).toBe(false);
    expect(termsOutdated(1, 2)).toBe(true);
    expect(termsOutdated(null, 2)).toBe(false);
  });

  it('reports an entered visitor who did not leave only after the overstay minutes', () => {
    const access = {
      enteredAt: at('2026-11-07T10:01:00+07:00'),
      exitedAt: null,
      validTo: at('2026-11-07T10:30:00+07:00'),
    };
    expect(overstaying(access, at('2026-11-07T10:59:00+07:00'), 30)).toBe(false);
    expect(overstaying(access, at('2026-11-07T11:00:00+07:00'), 30)).toBe(true);
    expect(
      overstaying(
        { ...access, exitedAt: at('2026-11-07T10:20:00+07:00') },
        at('2026-11-07T12:00:00+07:00'),
        30,
      ),
    ).toBe(false);
    expect(overstaying({ ...access, enteredAt: null }, at('2026-11-07T12:00:00+07:00'), 30)).toBe(false);
  });

  it('ends a window without an entry as a no show, with one as expired', () => {
    expect(endStateAfterWindow({ enteredAt: null })).toBe('no_show');
    expect(endStateAfterWindow({ enteredAt: SLOT })).toBe('expired');
  });

  it('parses the visitor-terms setting', () => {
    expect(visitorTerms({ version: 2, th: 'ก', en: 'a' })).toEqual({ version: 2, th: 'ก', en: 'a' });
    expect(visitorTerms({ version: 0, th: 'ก', en: 'a' })).toBeNull();
    expect(visitorTerms({ version: 1, th: 'ก' })).toBeNull();
    expect(visitorTerms(null)).toBeNull();
  });
});
