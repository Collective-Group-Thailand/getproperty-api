import { type Availability, freeSlots, slotAt, slotsOn, windowsOn } from './viewing-slots';

// 2026-11-07 is a Saturday (weekday 6); Bangkok is UTC+7.
const AVAILABILITY: Availability = {
  weekly: [
    { weekday: 6, from: '10:00', to: '11:15' },
    { weekday: 0, from: '13:00', to: '14:00' },
  ],
  exceptions: [
    { date: '2026-11-08', closed: true },
    { date: '2026-11-10', from: '18:00', to: '19:00' },
  ],
  slotMinutes: 30,
};
const at = (iso: string) => new Date(iso);
const RULES = { now: at('2026-11-06T09:00:00+07:00'), minNoticeHours: 2, horizonDays: 30 };

describe('viewing slots (B7.3, D-252)', () => {
  it('cuts the weekly windows of a day into whole slots (Bangkok time)', () => {
    expect(windowsOn('2026-11-07', AVAILABILITY)).toEqual([{ from: 600, to: 675 }]);
    expect(slotsOn('2026-11-07', AVAILABILITY).map((s) => s.startsAt.toISOString())).toEqual([
      '2026-11-07T03:00:00.000Z',
      '2026-11-07T03:30:00.000Z',
    ]);
  });

  it('lets an exception close a day or replace its windows', () => {
    expect(slotsOn('2026-11-08', AVAILABILITY)).toEqual([]);
    expect(slotsOn('2026-11-10', AVAILABILITY).map((s) => s.startsAt.toISOString())).toEqual([
      '2026-11-10T11:00:00.000Z',
      '2026-11-10T11:30:00.000Z',
    ]);
  });

  it('accepts only an offered slot inside the notice and the horizon', () => {
    expect(slotAt(at('2026-11-07T10:30:00+07:00'), AVAILABILITY, RULES)?.endsAt.toISOString()).toBe(
      '2026-11-07T04:00:00.000Z',
    );
    expect(slotAt(at('2026-11-07T10:15:00+07:00'), AVAILABILITY, RULES)).toBeNull();
    expect(slotAt(at('2026-11-07T11:00:00+07:00'), AVAILABILITY, RULES)).toBeNull();
    expect(
      slotAt(at('2026-11-07T10:00:00+07:00'), AVAILABILITY, {
        ...RULES,
        now: at('2026-11-07T09:00:00+07:00'),
      }),
    ).toBeNull();
    expect(slotAt(at('2026-11-07T10:00:00+07:00'), AVAILABILITY, { ...RULES, horizonDays: 0 })).toBeNull();
  });

  it('lists free slots, leaving out the ones already taken', () => {
    const taken = [{ startsAt: at('2026-11-07T10:00:00+07:00'), endsAt: at('2026-11-07T10:30:00+07:00') }];
    const free = freeSlots(AVAILABILITY, RULES, '2026-11-06', 5, taken).map((s) => s.startsAt.toISOString());
    expect(free).toEqual([
      '2026-11-07T03:30:00.000Z',
      '2026-11-10T11:00:00.000Z',
      '2026-11-10T11:30:00.000Z',
    ]);
  });
});
