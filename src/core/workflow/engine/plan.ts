import { findTransition, stateOf, type TransitionDef, type WorkflowDefinitionSpec } from './definition';
import { type BusinessCalendar, slaTimes } from './sla';

export interface InstanceSnapshot {
  state: string;
  startedAt: Date;
  slaDueAt: Date | null;
}

export interface TimerPlan {
  kind: 'sla_warn' | 'sla_breach';
  fireAt: Date;
}

export interface Plan {
  from: string | null;
  to: string;
  closed: boolean;
  slaDueAt: Date | null;
  /** Cancel the open SLA timers of the instance before creating `timers`. */
  cancelTimers: boolean;
  timers: TimerPlan[];
  transition: TransitionDef | null;
}

export class WorkflowTransitionError extends Error {
  constructor(
    readonly reason: 'invalid_transition' | 'guard_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

/** Setting values the plan may need (`settingKey` SLAs), resolved by the host before planning. */
export type SettingLookup = (key: string) => number | undefined;

function slaFor(
  spec: WorkflowDefinitionSpec,
  state: string,
  start: Date,
  enteredAt: Date,
  previousDue: Date | null,
  previousState: string | null,
  calendar: BusinessCalendar,
  settings: SettingLookup,
): { slaDueAt: Date | null; timers: TimerPlan[]; keep: boolean } {
  const def = stateOf(spec, state);
  if (!def.sla) return { slaDueAt: null, timers: [], keep: false };
  const from = def.sla.from ?? 'instance';
  const prev = previousState ? stateOf(spec, previousState) : null;
  // Same instance-level policy as the previous state: the clock keeps running, timers stay as they are.
  if (
    from === 'instance' &&
    previousDue &&
    prev?.sla &&
    (prev.sla.from ?? 'instance') === 'instance' &&
    JSON.stringify(prev.sla) === JSON.stringify(def.sla)
  ) {
    return { slaDueAt: previousDue, timers: [], keep: true };
  }
  const value = def.sla.settingKey ? settings(def.sla.settingKey) : undefined;
  const { dueAt, warnAt } = slaTimes(def.sla, from === 'instance' ? start : enteredAt, calendar, value);
  const timers: TimerPlan[] = [];
  if (warnAt && warnAt.getTime() > enteredAt.getTime()) timers.push({ kind: 'sla_warn', fireAt: warnAt });
  timers.push({ kind: 'sla_breach', fireAt: dueAt });
  return { slaDueAt: dueAt, timers, keep: false };
}

/** Plan of `start(…)`: the initial state and its SLA timers. */
export function planStart(
  spec: WorkflowDefinitionSpec,
  now: Date,
  calendar: BusinessCalendar,
  settings: SettingLookup,
): Plan {
  const sla = slaFor(spec, spec.initial, now, now, null, null, calendar, settings);
  return {
    from: null,
    to: spec.initial,
    closed: false,
    slaDueAt: sla.slaDueAt,
    cancelTimers: false,
    timers: sla.timers,
    transition: null,
  };
}

/**
 * Plan of `transition(instance, event)`. `guards` evaluates named guards (host-provided); a missing guard
 * implementation fails closed.
 */
export function planTransition(
  spec: WorkflowDefinitionSpec,
  instance: InstanceSnapshot,
  event: string,
  now: Date,
  calendar: BusinessCalendar,
  settings: SettingLookup,
  guards: (name: string) => boolean,
): Plan {
  const transition = findTransition(spec, instance.state, event);
  if (!transition)
    throw new WorkflowTransitionError(
      'invalid_transition',
      `${spec.key}: event "${event}" is not allowed in state "${instance.state}"`,
    );
  if (transition.guard && !guards(transition.guard))
    throw new WorkflowTransitionError('guard_failed', `${spec.key}: guard "${transition.guard}" failed`);
  const target = stateOf(spec, transition.to);
  if (target.terminal) {
    return {
      from: instance.state,
      to: target.key,
      closed: true,
      slaDueAt: instance.slaDueAt,
      cancelTimers: true,
      timers: [],
      transition,
    };
  }
  const sla = slaFor(
    spec,
    target.key,
    instance.startedAt,
    now,
    instance.slaDueAt,
    instance.state,
    calendar,
    settings,
  );
  return {
    from: instance.state,
    to: target.key,
    closed: false,
    slaDueAt: sla.slaDueAt,
    cancelTimers: !sla.keep,
    timers: sla.timers,
    transition,
  };
}
