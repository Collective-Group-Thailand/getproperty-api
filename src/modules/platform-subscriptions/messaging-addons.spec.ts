import { monthPeriod } from './messaging-addons.service';

describe('LINE OA integration fee months (G4, D-287)', () => {
  it('bills whole Bangkok calendar months', () => {
    expect(monthPeriod('2026-11')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(monthPeriod('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(monthPeriod('2027-02')).toEqual({ start: '2027-02-01', end: '2027-02-28' });
  });
});
