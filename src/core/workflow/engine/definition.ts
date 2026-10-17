/**
 * Workflow engine — definitions (D-159). Product-neutral: nothing in `engine/` imports getproperty code, so the
 * folder can move to `collective-shared` as is. A definition is a versioned state machine with SLA policies;
 * definitions live in code, are seeded into storage (`ops.workflow_definition`) and an instance keeps the version it
 * started with.
 */
export type SlaCalendar = 'calendar' | 'business';

export interface SlaPolicy {
  /** ISO 8601 duration (`P7D`, `PT4H`, `P1DT12H`); or */
  duration?: string;
  /** a setting holding a number of `settingUnit`s (e.g. `deposit.refund_days`), resolved at start/transition. */
  settingKey?: string;
  settingUnit?: 'days' | 'hours';
  /** `business`: whole days skip weekends and holidays of the business calendar (hours are counted as calendar). */
  calendar: SlaCalendar;
  /** Warn this long before the due time (ISO 8601 duration). */
  warnBefore?: string;
  /**
   * `instance` (default): the clock runs from the instance start and survives transitions between states that share
   * the policy (e.g. a 30-day request deadline); `state`: it restarts when the state is entered.
   */
  from?: 'instance' | 'state';
}

export interface StateDef {
  key: string;
  terminal?: boolean;
  sla?: SlaPolicy;
}

export interface TransitionDef {
  /** A state key, a list, or `*` (any non-terminal state). */
  from: string | readonly string[];
  event: string;
  to: string;
  /** Named guard evaluated by the host (e.g. `has_evidence`). */
  guard?: string;
}

export interface WorkflowDefinitionSpec {
  key: string;
  version: number;
  initial: string;
  states: readonly StateDef[];
  transitions: readonly TransitionDef[];
  description?: string;
}

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const DURATION = /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?)?$/;

/** Structural checks; returns problems (empty = valid). */
export function validateDefinition(spec: WorkflowDefinitionSpec): string[] {
  const problems: string[] = [];
  if (!KEY.test(spec.key)) problems.push(`key "${spec.key}" must be snake_case`);
  if (!Number.isInteger(spec.version) || spec.version < 1)
    problems.push('version must be a positive integer');
  const states = new Map(spec.states.map((s) => [s.key, s]));
  if (states.size !== spec.states.length) problems.push('duplicate state keys');
  if (!states.has(spec.initial)) problems.push(`initial state "${spec.initial}" is not defined`);
  if (states.get(spec.initial)?.terminal) problems.push('the initial state cannot be terminal');
  if (![...states.values()].some((s) => s.terminal)) problems.push('at least one state must be terminal');
  for (const s of spec.states) {
    if (!KEY.test(s.key)) problems.push(`state "${s.key}" must be snake_case`);
    if (s.sla) {
      if (!s.sla.duration === !s.sla.settingKey)
        problems.push(`state "${s.key}": sla needs duration xor settingKey`);
      if (s.sla.duration && !DURATION.test(s.sla.duration)) problems.push(`state "${s.key}": bad duration`);
      if (s.sla.warnBefore && !DURATION.test(s.sla.warnBefore))
        problems.push(`state "${s.key}": bad warnBefore`);
      if (s.terminal) problems.push(`terminal state "${s.key}" cannot have an SLA`);
    }
  }
  const seen = new Set<string>();
  for (const t of spec.transitions) {
    const froms = t.from === '*' ? ['*'] : typeof t.from === 'string' ? [t.from] : [...t.from];
    for (const f of froms) {
      if (f !== '*' && !states.has(f)) problems.push(`transition ${t.event}: unknown from state "${f}"`);
      if (f !== '*' && states.get(f)?.terminal)
        problems.push(`transition ${t.event}: leaves terminal "${f}"`);
      const k = `${f}|${t.event}`;
      if (seen.has(k)) problems.push(`transition ${t.event} from "${f}" is ambiguous`);
      seen.add(k);
    }
    if (!states.has(t.to)) problems.push(`transition ${t.event}: unknown target "${t.to}"`);
  }
  return problems;
}

/** The transition taken by `event` in `state`, or null when the event is not allowed there. */
export function findTransition(
  spec: WorkflowDefinitionSpec,
  state: string,
  event: string,
): TransitionDef | null {
  const current = spec.states.find((s) => s.key === state);
  if (!current || current.terminal) return null;
  const exact = spec.transitions.find(
    (t) => t.event === event && (t.from === state || (Array.isArray(t.from) && t.from.includes(state))),
  );
  return exact ?? spec.transitions.find((t) => t.event === event && t.from === '*') ?? null;
}

/** Events allowed in a state (for UIs: "next actions"). */
export function allowedEvents(spec: WorkflowDefinitionSpec, state: string): string[] {
  const current = spec.states.find((s) => s.key === state);
  if (!current || current.terminal) return [];
  return [
    ...new Set(
      spec.transitions
        .filter(
          (t) =>
            t.from === '*' ||
            t.from === state ||
            (Array.isArray(t.from) && (t.from as string[]).includes(state)),
        )
        .map((t) => t.event),
    ),
  ];
}

export function stateOf(spec: WorkflowDefinitionSpec, key: string): StateDef {
  const s = spec.states.find((x) => x.key === key);
  if (!s) throw new Error(`workflow ${spec.key}@${spec.version}: unknown state ${key}`);
  return s;
}
