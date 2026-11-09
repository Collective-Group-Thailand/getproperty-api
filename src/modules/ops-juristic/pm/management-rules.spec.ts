import {
  chargeableSlices,
  dueOnAfter,
  feePeriods,
  lastServiceDay,
  periodOf,
  proratedFee,
  termsProblems,
} from './management-rules';

describe('J3.3 management contract rules (D-334)', () => {
  it('names calendar periods by frequency', () => {
    expect(periodOf('monthly', '2027-02-14')).toEqual({
      key: '2027-02',
      start: '2027-02-01',
      end: '2027-02-28',
    });
    expect(periodOf('quarterly', '2027-05-01')).toEqual({
      key: '2027-Q2',
      start: '2027-04-01',
      end: '2027-06-30',
    });
    expect(periodOf('annual', '2028-02-29')).toEqual({ key: '2028', start: '2028-01-01', end: '2028-12-31' });
  });

  it('slices a term into periods with the days of service in each', () => {
    const s = feePeriods('monthly', '2027-01-15', '2027-03-10');
    expect(s.map((x) => [x.periodKey, x.serviceDays, x.periodDays])).toEqual([
      ['2027-01', 17, 31],
      ['2027-02', 28, 28],
      ['2027-03', 10, 31],
    ]);
    expect(feePeriods('quarterly', '2027-01-01', '2027-12-31')).toHaveLength(4);
    expect(feePeriods('annual', '2027-07-01', '2028-06-30').map((x) => x.serviceDays)).toEqual([184, 182]);
    expect(feePeriods('monthly', '2027-02-01', '2027-01-31')).toEqual([]);
  });

  it('prorates a partial period half-up and keeps a whole period exact', () => {
    expect(proratedFee('85600.00', '5600.00', { serviceDays: 31, periodDays: 31 })).toEqual({
      amount: '85600.00',
      vatAmount: '5600.00',
    });
    // 85,600 × 17 / 31 = 46,941.935… → 46,941.94; VAT 5,600 × 17 / 31 = 3,070.967… → 3,070.97
    expect(proratedFee('85600.00', '5600.00', { serviceDays: 17, periodDays: 31 })).toEqual({
      amount: '46941.94',
      vatAmount: '3070.97',
    });
    expect(proratedFee('100.00', '0', { serviceDays: 1, periodDays: 3 })).toEqual({
      amount: '33.33',
      vatAmount: '0.00',
    });
  });

  it('falls due in arrears on the due day of the next month', () => {
    expect(dueOnAfter('2027-01-31', 5)).toBe('2027-02-05');
    expect(dueOnAfter('2027-12-31', 28)).toBe('2028-01-28');
    expect(dueOnAfter('2027-03-31', 1)).toBe('2027-04-01');
  });

  it('stops service the day before a termination takes effect', () => {
    expect(lastServiceDay({ endsOn: '2027-12-31', terminatedOn: null })).toBe('2027-12-31');
    expect(lastServiceDay({ endsOn: '2027-12-31', terminatedOn: '2027-06-16' })).toBe('2027-06-15');
  });

  it('requests a period only after its service ended — never in advance', () => {
    const c = {
      feePeriod: 'monthly' as const,
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
      terminatedOn: null,
    };
    expect(chargeableSlices(c, '2027-01-31')).toEqual([]);
    expect(chargeableSlices(c, '2027-02-01').map((s) => s.periodKey)).toEqual(['2027-01']);
    expect(chargeableSlices(c, '2027-04-15').map((s) => s.periodKey)).toEqual([
      '2027-01',
      '2027-02',
      '2027-03',
    ]);
    // terminated effective 16 June: June is served 15 days and becomes chargeable from the 16th
    const t = { ...c, terminatedOn: '2027-06-16' };
    const june = chargeableSlices(t, '2027-06-16').find((s) => s.periodKey === '2027-06');
    expect(june).toMatchObject({ serviceDays: 15, periodDays: 30, serviceEnd: '2027-06-15' });
    expect(chargeableSlices(t, '2028-01-01').map((s) => s.periodKey)).toHaveLength(6);
    // terminated before it started: nothing to charge
    expect(chargeableSlices({ ...c, terminatedOn: '2027-01-01' }, '2027-06-01')).toEqual([]);
  });

  it('validates the terms', () => {
    expect(
      termsProblems({
        fee: '85600.00',
        vatAmount: '5600.00',
        dueDay: 5,
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
      }),
    ).toEqual([]);
    const bad = termsProblems({
      fee: '0',
      vatAmount: '1.234',
      dueDay: 29,
      startsOn: '2027-02-01',
      endsOn: '2027-01-01',
    });
    expect(bad.map((p) => p.path).sort()).toEqual(['dueDay', 'endsOn', 'fee', 'vatAmount']);
    expect(
      termsProblems({
        fee: '10.00',
        vatAmount: '11.00',
        dueDay: 1,
        startsOn: '2027-01-01',
        endsOn: '2027-01-01',
      }).map((p) => p.path),
    ).toEqual(['vatAmount']);
  });
});
