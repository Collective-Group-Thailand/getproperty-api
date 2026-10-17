/**
 * PostgreSQL error classes surfaced through Prisma 7 + the pg driver adapter. Prisma maps some SQLSTATEs to its own
 * codes (23505 → P2002) and wraps others in a driver-adapter error whose `cause` carries the original SQLSTATE, so the
 * helpers look at the error, its `meta` and its `cause` chain.
 */
const SQLSTATE = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
} as const;

function codesOf(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 5) return [];
  const e = error as Record<string, unknown>;
  const own = ['code', 'originalCode', 'sqlState', 'kind']
    .map((k) => e[k])
    .filter((v): v is string => typeof v === 'string');
  const message = typeof e.message === 'string' ? e.message : '';
  const fromMessage = [...message.matchAll(/\b(23505|23P01|23503|23514)\b/g)].map((m) => m[1]!);
  if (/exclusion constraint/i.test(message)) fromMessage.push(SQLSTATE.exclusionViolation);
  if (/unique constraint/i.test(message)) fromMessage.push(SQLSTATE.uniqueViolation);
  return [
    ...own,
    ...fromMessage,
    ...codesOf(e.cause, depth + 1),
    ...codesOf(e.meta, depth + 1),
    ...codesOf((e.meta as Record<string, unknown> | undefined)?.driverAdapterError, depth + 1),
  ];
}

export function isUniqueViolation(error: unknown): boolean {
  const codes = codesOf(error);
  return codes.includes('P2002') || codes.includes(SQLSTATE.uniqueViolation);
}

export function isExclusionViolation(error: unknown): boolean {
  return codesOf(error).includes(SQLSTATE.exclusionViolation);
}

export function isForeignKeyViolation(error: unknown): boolean {
  const codes = codesOf(error);
  return codes.includes('P2003') || codes.includes(SQLSTATE.foreignKeyViolation);
}

export function isCheckViolation(error: unknown): boolean {
  return codesOf(error).includes(SQLSTATE.checkViolation);
}

/** Runs `work`; maps a unique or exclusion violation to the error `onConflict` returns. */
export async function mapConflicts<T>(
  work: () => Promise<T>,
  onConflict: (error: unknown) => Error,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error) || isExclusionViolation(error)) throw onConflict(error);
    throw error;
  }
}
