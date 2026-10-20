import {
  bangkokWeek,
  bookingPolicy,
  bookingProblems,
  cleanAudience,
  cleanTranslations,
  DEFAULT_BOOKING_POLICY,
  inAudience,
  localized,
} from './community-rules';

describe('community rules (B5.3)', () => {
  it('keeps known translations with a body and falls back to Thai', () => {
    const t = cleanTranslations({
      en: { title: ' Hi ', body: ' Body ' },
      fr: { body: 'x' },
      my: { body: '  ' },
    });
    expect(t).toEqual({ en: { title: 'Hi', body: 'Body' } });
    const base = { title: 'หัวข้อ', bodyTh: 'เนื้อหา' };
    expect(localized(base, t, 'en')).toEqual({ language: 'en', title: 'Hi', body: 'Body' });
    expect(localized(base, t, 'zh')).toEqual({ language: 'th', title: 'หัวข้อ', body: 'เนื้อหา' });
    expect(localized(base, { lo: { body: 'ລາວ' } }, 'lo')).toEqual({
      language: 'lo',
      title: 'หัวข้อ',
      body: 'ລາວ',
    });
  });

  it('targets everyone, or only the listed floors / units', () => {
    expect(inAudience(cleanAudience(null), { id: 'u1', floorId: 'f1' })).toBe(true);
    const f = cleanAudience({ floorIds: ['f2', 'f2', 3], unitIds: ['u9'] });
    expect(f).toEqual({ floorIds: ['f2'], unitIds: ['u9'] });
    expect(inAudience(f, { id: 'u1', floorId: 'f2' })).toBe(true);
    expect(inAudience(f, { id: 'u9', floorId: null })).toBe(true);
    expect(inAudience(f, { id: 'u1', floorId: 'f1' })).toBe(false);
  });

  it('defaults and bounds a booking policy', () => {
    expect(bookingPolicy(undefined)).toEqual(DEFAULT_BOOKING_POLICY);
    const p = bookingPolicy({
      slotMinutes: 5,
      openFrom: '23:00',
      openTo: '07:00',
      maxPerUnitPerWeek: 3,
      requiresApproval: true,
    });
    expect(p.slotMinutes).toBe(60);
    expect([p.openFrom, p.openTo]).toEqual(['08:00', '22:00']);
    expect(p.maxPerUnitPerWeek).toBe(3);
    expect(p.requiresApproval).toBe(true);
  });

  it('checks a booking against the policy in Bangkok time', () => {
    const now = new Date('2026-11-02T03:00:00Z'); // Mon 10:00 Bangkok
    const p = DEFAULT_BOOKING_POLICY;
    const at = (iso: string) => new Date(iso);
    expect(bookingProblems(p, at('2026-11-03T10:00:00+07:00'), at('2026-11-03T11:00:00+07:00'), now)).toEqual(
      [],
    );
    expect(
      bookingProblems(p, at('2026-11-03T10:00:00+07:00'), at('2026-11-03T10:30:00+07:00'), now),
    ).toContain('book whole slots of 60 minutes');
    expect(
      bookingProblems(p, at('2026-11-03T10:00:00+07:00'), at('2026-11-03T13:00:00+07:00'), now),
    ).toContain('at most 120 minutes');
    expect(
      bookingProblems(p, at('2026-11-03T07:00:00+07:00'), at('2026-11-03T08:00:00+07:00'), now),
    ).toContain('open 08:00–22:00');
    expect(
      bookingProblems(p, at('2026-11-01T10:00:00+07:00'), at('2026-11-01T11:00:00+07:00'), now),
    ).toContain('the booking starts in the past');
    expect(
      bookingProblems(p, at('2026-11-30T10:00:00+07:00'), at('2026-11-30T11:00:00+07:00'), now),
    ).toContain('at most 14 days ahead');
    expect(
      bookingProblems(p, at('2026-11-03T10:30:00+07:00'), at('2026-11-03T11:30:00+07:00'), now),
    ).toContain('start on a slot boundary from 08:00');
  });

  it('computes the Monday–Sunday week in Bangkok', () => {
    // Sunday 23:30 Bangkok belongs to the week starting the previous Monday
    const w = bangkokWeek(new Date('2026-11-08T16:30:00Z'));
    expect(w.from.toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-08T17:00:00.000Z');
    // Monday 00:10 Bangkok starts a new week
    expect(bangkokWeek(new Date('2026-11-08T17:10:00Z')).from.toISOString()).toBe('2026-11-08T17:00:00.000Z');
  });
});
