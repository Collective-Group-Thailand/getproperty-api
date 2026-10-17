import {
  type StateDef,
  type TransitionDef,
  validateDefinition,
  type WorkflowDefinitionSpec,
} from './definition';

interface StoredState extends StateDef {
  initial?: boolean;
}

/** Spec ↔ `ops.workflow_definition` row (states with `initial`, transitions, sla per state). */
export function specToRow(spec: WorkflowDefinitionSpec) {
  return {
    key: spec.key,
    version: spec.version,
    states: spec.states.map((s) => ({ ...s, ...(s.key === spec.initial ? { initial: true } : {}) })),
    transitions: spec.transitions,
    sla: Object.fromEntries(spec.states.filter((s) => s.sla).map((s) => [s.key, s.sla])),
  };
}

export function specFromRow(row: { key: string; version: number; states: unknown; transitions: unknown }) {
  const states = row.states as StoredState[];
  const initial = states.find((s) => s.initial)?.key;
  if (!initial) throw new Error(`workflow definition ${row.key}@${row.version} has no initial state`);
  const spec: WorkflowDefinitionSpec = {
    key: row.key,
    version: row.version,
    initial,
    states: states.map(({ initial: _i, ...s }) => s),
    transitions: row.transitions as TransitionDef[],
  };
  const problems = validateDefinition(spec);
  if (problems.length)
    throw new Error(`workflow definition ${row.key}@${row.version}: ${problems.join('; ')}`);
  return spec;
}
