/**
 * Which of the image's processes this is (`main.js` = api, `worker.js`, `ingest.js`; D-230). Set by each entry point
 * before Nest boots; read where a process-specific limit applies (the PostgreSQL pool, T-5).
 */
export type ProcessRole = 'api' | 'worker' | 'ingest';

let current: ProcessRole = 'api';

export function setProcessRole(role: ProcessRole): void {
  current = role;
}

export function processRole(): ProcessRole {
  return current;
}

/**
 * PostgreSQL pool per process (blueprint T-5, platform image contract item 11, A-1): the platform allows ≤ 15
 * connections for the API and ≤ 10 for the worker; ingest is small (5). `DATABASE_POOL_MAX` lowers or raises the pool
 * within the ceiling; a value above it fails the start-up — the shared PostgreSQL's connection budget is a contract,
 * not a hint. getproperty's total stays ≤ 35 with migrate (one connection) and, from Phase 2, the Python workers (5).
 */
export const POOL_DEFAULTS: Record<ProcessRole, number> = { api: 10, worker: 10, ingest: 5 };
export const POOL_CEILINGS: Record<ProcessRole, number> = { api: 15, worker: 10, ingest: 5 };

export function poolMaxFor(role: ProcessRole, configured?: number): number {
  const ceiling = POOL_CEILINGS[role];
  if (configured === undefined) return POOL_DEFAULTS[role];
  if (!Number.isInteger(configured) || configured < 1 || configured > ceiling)
    throw new Error(
      `DATABASE_POOL_MAX=${configured} is outside 1…${ceiling} for the ${role} process (platform pool limits, T-5)`,
    );
  return configured;
}
