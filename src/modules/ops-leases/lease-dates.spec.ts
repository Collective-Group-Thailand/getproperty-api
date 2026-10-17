import { addDays, endDateFor, monthsBetween } from './lease-dates';

describe('lease dates', () => {
  it('ends a lease the day before the same date n months later, clamping month ends', () => {
    expect(endDateFor('2026-11-01', 12)).toBe('2027-10-31');
    expect(endDateFor('2026-11-15', 6)).toBe('2027-05-14');
    expect(endDateFor('2027-01-31', 1)).toBe('2027-02-27');
    expect(endDateFor('2028-01-31', 1)).toBe('2028-02-28');
  });
  it('counts months of a term and adds days', () => {
    expect(monthsBetween('2026-11-01', '2027-10-31')).toBe(12);
    expect(monthsBetween('2026-11-01', '2026-11-30')).toBe(1);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
