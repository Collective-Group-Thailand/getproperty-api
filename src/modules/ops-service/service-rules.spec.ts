import { workflowDefinition } from '@core/workflow/definitions';
import {
  allowedEvents,
  type BusinessCalendar,
  planStart,
  planTransition,
  validateDefinition,
} from '@core/workflow/engine';

import {
  autoRequestCategory,
  canWorkOrder,
  inWarranty,
  nextDueOn,
  planDue,
  plannedVisit,
  requestOperatorActions,
  requestResidentActions,
  requestStatusOf,
  slaView,
  statusHistory,
  visitConfirmation,
  workOrderActions,
} from './service-rules';

const CAL: BusinessCalendar = { timeZone: 'Asia/Bangkok', isHoliday: () => false };
const DEF = workflowDefinition('service_request');

describe('service_request workflow (D-072, D-159)', () => {
  it('is a valid definition', () => {
    expect(validateDefinition(DEF)).toEqual([]);
  });

  it('starts with the SLA hours of the category from the instance context; warning 2 h before', () => {
    const now = new Date('2026-11-01T02:00:00Z');
    const plan = planStart(DEF, now, CAL, (k) => (k === 'context.slaHours' ? 24 : undefined));
    expect(plan.to).toBe('new');
    expect(plan.slaDueAt?.toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(plan.timers.map((t) => [t.kind, t.fireAt.toISOString()])).toEqual([
      ['sla_warn', '2026-11-02T00:00:00.000Z'],
      ['sla_breach', '2026-11-02T02:00:00.000Z'],
    ]);
  });

  it('keeps one clock through triage, assignment, work and waiting for parts', () => {
    const start = new Date('2026-11-01T02:00:00Z');
    const due = new Date('2026-11-02T02:00:00Z');
    let state = 'new';
    for (const [event, to] of [
      ['triage', 'triaged'],
      ['assign', 'assigned'],
      ['start', 'in_progress'],
      ['wait_parts', 'waiting_parts'],
      ['start', 'in_progress'],
    ] as const) {
      const plan = planTransition(
        DEF,
        { state, startedAt: start, slaDueAt: due },
        event,
        new Date('2026-11-01T10:00:00Z'),
        CAL,
        () => 24,
        () => true,
      );
      expect(plan.to).toBe(to);
      expect(plan.slaDueAt?.toISOString()).toBe(due.toISOString());
      expect(plan.cancelTimers).toBe(false);
      state = plan.to;
    }
  });

  it('done stops the clock; the resident rating (close) or a reopen follows', () => {
    const plan = planTransition(
      DEF,
      { state: 'in_progress', startedAt: new Date(), slaDueAt: new Date() },
      'complete',
      new Date(),
      CAL,
      () => 24,
      () => true,
    );
    expect(plan.to).toBe('done');
    expect(plan.cancelTimers).toBe(true);
    expect(plan.timers).toEqual([]);
    expect(allowedEvents(DEF, 'done').sort()).toEqual(['close', 'reopen']);
  });

  it('a warranty referral has no SLA and ends by getbuild closing or returning it (D-153)', () => {
    expect(allowedEvents(DEF, 'referred').sort()).toEqual(['cancel', 'warranty_closed', 'warranty_returned']);
    expect(allowedEvents(DEF, 'new')).not.toContain('warranty_closed');
  });

  it('maps workflow states to request statuses (referred shows as triaged)', () => {
    expect(requestStatusOf('referred')).toBe('triaged');
    expect(requestStatusOf('waiting_parts')).toBe('waiting_parts');
    expect(() => requestStatusOf('nope')).toThrow();
  });
});

describe('next actions', () => {
  it('operators: from the workflow; no work order for a referred request', () => {
    expect(requestOperatorActions('new', allowedEvents(DEF, 'new'), false)).toEqual([
      'triage',
      'create-work-order',
      'cancel',
    ]);
    expect(requestOperatorActions('triaged', allowedEvents(DEF, 'referred'), true)).toEqual(['cancel']);
    expect(requestOperatorActions('done', allowedEvents(DEF, 'done'), false)).toEqual([
      'close',
      'reopen',
      'rate',
    ]);
  });

  it('residents: cancel before the work is assigned, rate once done', () => {
    expect(requestResidentActions('new', false)).toEqual(['cancel']);
    expect(requestResidentActions('assigned', false)).toEqual([]);
    expect(requestResidentActions('done', false)).toEqual(['rate']);
    expect(requestResidentActions('done', true)).toEqual([]);
  });

  it('work orders: field steps for the assignee, assign / cancel for operators', () => {
    expect(workOrderActions('assigned', 'assignee')).toEqual(['accept', 'check-in', 'complete']);
    expect(workOrderActions('in_progress', 'assignee')).toEqual(['wait-parts', 'complete']);
    expect(workOrderActions('in_progress', 'assignee', true)).toEqual(['resume', 'complete']);
    expect(workOrderActions('open', 'operator')).toEqual(['assign', 'cancel']);
    expect(workOrderActions('done', 'operator')).toEqual(['verify']);
    expect(canWorkOrder('complete', 'verified')).toBe(false);
    expect(canWorkOrder('assign', 'in_progress')).toBe(false);
  });
});

describe('warranty decision (blueprint A4.6, D-153)', () => {
  const today = '2026-11-01';
  it('an asset item from getbuild inside its warranty date', () => {
    expect(
      inWarranty({
        today,
        assetItem: { sourceRef: 'gb-1', warrantyUntil: '2026-11-01' },
        warrantyGrantActive: false,
      }),
    ).toBe(true);
    expect(
      inWarranty({
        today,
        assetItem: { sourceRef: 'gb-1', warrantyUntil: '2026-10-31' },
        warrantyGrantActive: true,
      }),
    ).toBe(false);
    expect(
      inWarranty({
        today,
        assetItem: { sourceRef: null, warrantyUntil: '2027-01-01' },
        warrantyGrantActive: true,
      }),
    ).toBe(false);
  });

  it('a unit from getbuild while a warranty grant is active', () => {
    expect(inWarranty({ today, unit: { sourceRef: 'gb-u1' }, warrantyGrantActive: true })).toBe(true);
    expect(inWarranty({ today, unit: { sourceRef: 'gb-u1' }, warrantyGrantActive: false })).toBe(false);
    expect(inWarranty({ today, unit: { sourceRef: null }, warrantyGrantActive: true })).toBe(false);
  });
});

describe('automatic requests and preventive plans', () => {
  it('maps devices to categories (D-034)', () => {
    expect(autoRequestCategory('meter_water')).toBe('plumbing');
    expect(autoRequestCategory('meter_electric')).toBe('electrical');
    expect(autoRequestCategory('gateway')).toBe('electrical');
    expect(autoRequestCategory('lock')).toBe('electrical');
    expect(autoRequestCategory(null, 'water')).toBe('plumbing');
    expect(autoRequestCategory('furniture')).toBe('other');
  });

  it('opens a plan’s work order lead days before the due date and moves the date one interval on', () => {
    expect(planDue('2026-11-10', 7, '2026-11-02')).toBe(false);
    expect(planDue('2026-11-10', 7, '2026-11-03')).toBe(true);
    expect(nextDueOn('2026-11-10', 90)).toBe('2027-02-08');
  });
});

describe('resident view of a request (LIFF #22, #24, D-218)', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h));

  it('offers confirm-visit only while a scheduled visit waits for the resident', () => {
    expect(requestResidentActions('assigned', false, true)).toEqual(['confirm-visit']);
    expect(requestResidentActions('triaged', false, true)).toEqual(['cancel', 'confirm-visit']);
    expect(requestResidentActions('done', false, true)).toEqual(['rate']);
    expect(requestResidentActions('closed', true, true)).toEqual([]);
  });

  it('the planned visit is the earliest scheduled work order that is not cancelled', () => {
    const wos = [
      { id: 'a', status: 'cancelled' as const, scheduledAt: at(1) },
      { id: 'b', status: 'assigned' as const, scheduledAt: at(5) },
      { id: 'c', status: 'open' as const, scheduledAt: null },
      { id: 'd', status: 'assigned' as const, scheduledAt: at(3) },
    ];
    expect(plannedVisit(wos)?.id).toBe('d');
    expect(plannedVisit([])).toBeNull();
  });

  it('a confirmation counts for the visit start it confirmed; a moved visit asks again', () => {
    const wo = { id: 'w', status: 'assigned' as const, scheduledAt: at(9) };
    expect(visitConfirmation([wo], { at: null, for: null })).toMatchObject({ confirmedAt: null, due: true });
    expect(visitConfirmation([wo], { at: at(2), for: at(9) })).toMatchObject({
      confirmedAt: at(2),
      due: false,
    });
    expect(visitConfirmation([{ ...wo, scheduledAt: at(10) }], { at: at(2), for: at(9) })).toMatchObject({
      confirmedAt: null,
      due: true,
    });
    // once the technician started there is nothing to confirm
    expect(visitConfirmation([{ ...wo, status: 'in_progress' }], { at: null, for: null }).due).toBe(false);
    expect(visitConfirmation([], { at: null, for: null })).toEqual({
      visit: null,
      confirmedAt: null,
      due: false,
    });
  });

  it('SLA state: on track, at risk 2 h before (or once warned), breached, paused when referred, none when done', () => {
    const due = at(12);
    const base = { state: 'assigned', slaDueAt: due, slaWarnedAt: null, slaBreachedAt: null };
    expect(slaView(null, at(0))).toBeNull();
    expect(slaView(base, at(9))).toEqual({ dueAt: due, state: 'on_track' });
    expect(slaView(base, at(10))).toEqual({ dueAt: due, state: 'at_risk' });
    expect(slaView({ ...base, slaWarnedAt: at(9) }, at(9))).toEqual({ dueAt: due, state: 'at_risk' });
    expect(slaView(base, at(12))).toEqual({ dueAt: due, state: 'breached' });
    expect(slaView({ ...base, state: 'closed', slaBreachedAt: at(12) }, at(20))).toEqual({
      dueAt: due,
      state: 'breached',
    });
    expect(slaView({ ...base, state: 'referred' }, at(9))).toEqual({ dueAt: null, state: 'paused' });
    expect(slaView({ ...base, state: 'done' }, at(9))).toEqual({ dueAt: null, state: 'none' });
    expect(slaView({ ...base, state: 'waiting_parts' }, at(1))).toEqual({ dueAt: due, state: 'on_track' });
  });

  it('status history: one entry per change of the mirrored status, oldest first', () => {
    expect(
      statusHistory([
        { toState: 'assigned', occurredAt: at(3) },
        { toState: 'new', occurredAt: at(1) },
        { toState: 'triaged', occurredAt: at(2) },
        { toState: 'assigned', occurredAt: at(4) },
        { toState: 'referred', occurredAt: at(5) },
        { toState: 'nonsense', occurredAt: at(6) },
      ]).map((e) => [e.status, e.at.getUTCHours()]),
    ).toEqual([
      ['new', 1],
      ['triaged', 2],
      ['assigned', 3],
      ['triaged', 5],
    ]);
  });
});
