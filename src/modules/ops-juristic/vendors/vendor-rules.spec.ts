import {
  alertDue,
  averageScore,
  evaluationTrend,
  instalmentPlanProblems,
  instalmentSchedule,
  quotationRule,
  slaBreaches,
  slaTermsProblems,
  type SlaWorkOrder,
} from './vendor-rules';

const at = (iso: string) => new Date(iso);

describe('J2.2 vendor rules (D-310, D-331)', () => {
  it('schedules instalments inside the term on the due day, by frequency', () => {
    const monthly = instalmentSchedule(
      { frequency: 'monthly', dueDay: 5, amount: '16050', vatAmount: '1050' },
      '2027-01-01',
      '2027-12-31',
    );
    expect(monthly).toHaveLength(12);
    expect(monthly[0]).toEqual({ seq: 1, dueOn: '2027-01-05', amount: '16050.00', vatAmount: '1050.00' });
    expect(monthly[11]!.dueOn).toBe('2027-12-05');
    // a start after the due day → the first instalment next month; the last one never after the end
    const late = instalmentSchedule(
      { frequency: 'monthly', dueDay: 5, amount: '100' },
      '2027-01-10',
      '2027-04-04',
    );
    expect(late.map((x) => x.dueOn)).toEqual(['2027-02-05', '2027-03-05']);
    const quarterly = instalmentSchedule(
      { frequency: 'quarterly', dueDay: 28, amount: '30000.00' },
      '2027-01-01',
      '2027-12-31',
    );
    expect(quarterly.map((x) => x.dueOn)).toEqual(['2027-01-28', '2027-04-28', '2027-07-28', '2027-10-28']);
    expect(
      instalmentSchedule({ frequency: 'annual', dueDay: 1, amount: '1' }, '2027-03-01', '2029-03-01').map(
        (x) => x.dueOn,
      ),
    ).toEqual(['2027-03-01', '2028-03-01', '2029-03-01']);
    expect(
      instalmentSchedule(
        { frequency: 'once', dueDay: 1, amount: '5000', firstDueOn: '2027-06-30' },
        '2027-01-01',
        '2027-12-31',
      ),
    ).toEqual([{ seq: 1, dueOn: '2027-06-30', amount: '5000.00', vatAmount: '0.00' }]);
    expect(() =>
      instalmentSchedule(
        { frequency: 'monthly', dueDay: 5, amount: '1', firstDueOn: '2028-01-05' },
        '2027-01-01',
        '2027-12-31',
      ),
    ).toThrow(RangeError);
    expect(() =>
      instalmentSchedule({ frequency: 'monthly', dueDay: 1, amount: '1' }, '2027-01-01', '2040-12-31'),
    ).toThrow('too_many_instalments');
  });

  it('validates the plan and the SLA terms', () => {
    expect(instalmentPlanProblems({ frequency: 'monthly', dueDay: 5, amount: '100.00' })).toEqual([]);
    expect(
      instalmentPlanProblems({ frequency: 'weekly' as never, dueDay: 31, amount: '0', vatAmount: '5' }).map(
        (p) => p.path,
      ),
    ).toEqual(['frequency', 'dueDay', 'amount', 'vatAmount']);
    expect(instalmentPlanProblems({ frequency: 'once', dueDay: 1, amount: '10', vatAmount: '11' })).toEqual([
      { path: 'vatAmount', message: '0 … amount' },
    ]);
    expect(slaTermsProblems([{ priority: 'urgent', responseHours: 2, resolveHours: 24 }])).toEqual([]);
    expect(
      slaTermsProblems([
        { priority: 'urgent', responseHours: 2, resolveHours: 1 },
        { priority: 'urgent', responseHours: 0, resolveHours: 24 },
      ]).map((p) => p.path),
    ).toEqual(['slaTerms[0].resolveHours', 'slaTerms[1].priority', 'slaTerms[1].responseHours']);
  });

  it('≥ 3 quotations above the threshold, or a recorded reason', () => {
    expect(quotationRule({ amount: '50000.00', threshold: '50000.00', quotations: 1 })).toEqual({
      aboveThreshold: false,
      minimumMet: true,
      allowed: true,
    });
    expect(quotationRule({ amount: '50000.01', threshold: '50000.00', quotations: 2 })).toEqual({
      aboveThreshold: true,
      minimumMet: false,
      allowed: false,
    });
    expect(
      quotationRule({ amount: '80000', threshold: '50000', quotations: 2, reason: 'short' }).allowed,
    ).toBe(false);
    expect(
      quotationRule({
        amount: '80000',
        threshold: '50000',
        quotations: 2,
        reason: 'only two vendors in the area',
      }).allowed,
    ).toBe(true);
    expect(quotationRule({ amount: '80000', threshold: '50000', quotations: 3 }).minimumMet).toBe(true);
  });

  it('expiry alerts: the nearest threshold once, never a burst', () => {
    const t = [90, 60, 30];
    expect(alertDue(120, t, [])).toBeNull();
    expect(alertDue(90, t, [])).toBe(90);
    expect(alertDue(89, t, [90])).toBeNull();
    expect(alertDue(60, t, [90])).toBe(60);
    expect(alertDue(45, t, [])).toBe(60); // a late first run: only the nearest
    expect(alertDue(25, t, [90, 60])).toBe(30);
    expect(alertDue(0, t, [90, 60, 30])).toBeNull();
    expect(alertDue(-1, t, [])).toBeNull();
  });

  it('SLA breaches: response and resolve against the terms, unfinished until now, request SLA, cancelled skipped', () => {
    const base: SlaWorkOrder = {
      id: 'wo1',
      title: 'ลิฟต์ค้าง',
      priority: 'urgent',
      status: 'completed',
      createdAt: at('2027-03-01T01:00:00Z'),
      assignedAt: at('2027-03-01T01:00:00Z'),
      acceptedAt: at('2027-03-01T02:30:00Z'),
      checkedInAt: null,
      completedAt: at('2027-03-01T10:00:00Z'),
      serviceRequest: null,
    };
    const terms = [{ priority: 'urgent' as const, responseHours: 2, resolveHours: 24 }];
    const now = at('2027-03-05T00:00:00Z');
    expect(slaBreaches([base], terms, now)).toEqual([]);
    const slow = { ...base, id: 'wo2', acceptedAt: at('2027-03-01T05:00:00Z') };
    expect(slaBreaches([slow], terms, now)).toEqual([
      expect.objectContaining({ kind: 'response', workOrderId: 'wo2', allowedHours: 2, actualHours: 4 }),
    ]);
    const open = { ...base, id: 'wo3', acceptedAt: null, completedAt: null, status: 'assigned' };
    expect(slaBreaches([open], terms, now).map((b) => b.kind)).toEqual(['response', 'resolve']);
    const viaRequest = {
      ...base,
      id: 'wo4',
      priority: 'low' as const,
      serviceRequest: {
        id: 'sr1',
        createdAt: at('2027-02-27T00:00:00Z'),
        slaBreachedAt: at('2027-02-28T00:00:00Z'),
      },
    };
    expect(slaBreaches([viaRequest], terms, now)).toEqual([
      expect.objectContaining({ kind: 'request_sla', serviceRequestId: 'sr1', allowedHours: null }),
    ]);
    expect(slaBreaches([{ ...open, status: 'cancelled' }], terms, now)).toEqual([]);
  });

  it('evaluation score and trend over the last 6', () => {
    expect(averageScore([4, 3, 4, 4])).toBe('3.75');
    expect(averageScore([5, 4, 4])).toBe('4.33');
    expect(evaluationTrend([])).toEqual({
      count: 0,
      averageScore: null,
      lastScore: null,
      trend: null,
      slaBreaches: 0,
    });
    const pts = (scores: string[]) =>
      scores.map((score, i) => ({
        month: `2027-${String(i + 1).padStart(2, '0')}-01`,
        score,
        slaBreaches: 1,
      }));
    expect(evaluationTrend(pts(['3.00'])).trend).toBeNull();
    expect(evaluationTrend(pts(['3.00', '3.00', '3.50']))).toMatchObject({
      trend: 'improving',
      lastScore: '3.50',
    });
    expect(evaluationTrend(pts(['4.00', '4.00', '3.50'])).trend).toBe('declining');
    expect(evaluationTrend(pts(['4.00', '4.10'])).trend).toBe('steady');
    const eight = evaluationTrend(pts(['1.00', '1.00', '4.00', '4.00', '4.00', '4.00', '4.00', '4.00']));
    expect(eight).toMatchObject({ count: 6, averageScore: '4.00', slaBreaches: 6, trend: 'steady' });
  });
});
