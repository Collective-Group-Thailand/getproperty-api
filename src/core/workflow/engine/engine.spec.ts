import { WORKFLOW_DEFINITIONS } from '../definitions';
import {
  type BusinessCalendar,
  parseDuration,
  planStart,
  planTransition,
  slaTimes,
  specFromRow,
  specToRow,
  validateDefinition,
  type WorkflowDefinitionSpec,
  WorkflowTransitionError,
} from './index';

const calendar: BusinessCalendar = { timeZone: 'Asia/Bangkok', isHoliday: (d) => d === '2026-12-07' };
const settings = (key: string) => ({ 'deposit.refund_days': 7, 'privacy.dsr_due_days': 30 })[key];

const spec: WorkflowDefinitionSpec = {
  key: 'test',
  version: 1,
  initial: 'open',
  states: [
    { key: 'open', sla: { duration: 'P2D', calendar: 'business', warnBefore: 'PT4H' } },
    { key: 'review', sla: { duration: 'P2D', calendar: 'business', warnBefore: 'PT4H' } },
    { key: 'escalated', sla: { duration: 'PT8H', calendar: 'calendar', from: 'state' } },
    { key: 'done', terminal: true },
  ],
  transitions: [
    { from: 'open', event: 'review', to: 'review' },
    { from: 'review', event: 'escalate', to: 'escalated', guard: 'has_reason' },
    { from: ['review', 'escalated'], event: 'close', to: 'done' },
  ],
};

describe('workflow engine (D-159) — pure planning, no getproperty imports', () => {
  it('validates the seeded definitions', () => {
    for (const d of WORKFLOW_DEFINITIONS) expect(validateDefinition(d)).toEqual([]);
    expect(validateDefinition({ ...spec, initial: 'nope' })).not.toHaveLength(0);
  });

  it('start: initial state with warn + breach timers (business days skip weekends and holidays)', () => {
    const fri = new Date('2026-12-04T03:00:00Z'); // Friday 10:00 Bangkok; Mon 7 Dec is a holiday
    const plan = planStart(spec, fri, calendar, settings);
    expect(plan.to).toBe('open');
    expect(plan.slaDueAt!.toISOString()).toBe('2026-12-09T03:00:00.000Z'); // Tue 8 + Wed 9
    expect(plan.timers.map((t) => t.kind)).toEqual(['sla_warn', 'sla_breach']);
  });

  it('same instance-level SLA keeps the clock; a state-level SLA restarts it; terminal closes', () => {
    const t0 = new Date('2026-11-02T03:00:00Z');
    const start = planStart(spec, t0, calendar, settings);
    const snap = { state: 'open', startedAt: t0, slaDueAt: start.slaDueAt };
    const review = planTransition(
      spec,
      snap,
      'review',
      new Date(t0.getTime() + 3_600_000),
      calendar,
      settings,
      () => true,
    );
    expect(review).toMatchObject({ to: 'review', slaDueAt: start.slaDueAt, timers: [], cancelTimers: false });
    const at = new Date(t0.getTime() + 7_200_000);
    const esc = planTransition(
      spec,
      { ...snap, state: 'review' },
      'escalate',
      at,
      calendar,
      settings,
      () => true,
    );
    expect(esc.slaDueAt!.getTime()).toBe(at.getTime() + 8 * 3_600_000);
    expect(esc.cancelTimers).toBe(true);
    const done = planTransition(
      spec,
      { ...snap, state: 'escalated' },
      'close',
      at,
      calendar,
      settings,
      () => true,
    );
    expect(done).toMatchObject({ closed: true, timers: [], cancelTimers: true });
  });

  it('refuses unknown events and failed guards', () => {
    const snap = { state: 'open', startedAt: new Date(), slaDueAt: null };
    expect(() => planTransition(spec, snap, 'close', new Date(), calendar, settings, () => true)).toThrow(
      WorkflowTransitionError,
    );
    try {
      planTransition(
        spec,
        { ...snap, state: 'review' },
        'escalate',
        new Date(),
        calendar,
        settings,
        () => false,
      );
    } catch (error) {
      expect((error as WorkflowTransitionError).reason).toBe('guard_failed');
    }
  });

  it('SLA from settings (deposit 7 calendar days, D-023) with a warning', () => {
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { dueAt, warnAt } = slaTimes(
      { settingKey: 'deposit.refund_days', settingUnit: 'days', calendar: 'calendar', warnBefore: 'P2D' },
      t0,
      calendar,
      7,
    );
    expect(dueAt.toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(warnAt!.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(() => parseDuration('P')).toThrow();
  });

  it('round-trips through the stored row shape', () => {
    for (const d of WORKFLOW_DEFINITIONS) {
      const back = specFromRow(specToRow(d));
      expect(back.initial).toBe(d.initial);
      expect(back.transitions).toEqual(d.transitions);
    }
  });
});
