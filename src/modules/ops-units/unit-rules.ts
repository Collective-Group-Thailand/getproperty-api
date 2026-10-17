import { type UnitStatus } from '@generated/prisma/client';

/**
 * Unit status rules (B2.1 prompt §3, D-082). Leases (B2.3) and service work (B5) drive `reserved`/`occupied`;
 * an operator may only switch a unit between `vacant` and `inactive` or `maintenance`, with a reason. `inactive`
 * units are not counted for the subscription (D-082, D-156).
 */
export const MANUAL_STATUS_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  vacant: ['inactive', 'maintenance'],
  inactive: ['vacant'],
  maintenance: ['vacant'],
  reserved: [],
  occupied: [],
};

export function canSetStatusManually(from: UnitStatus, to: UnitStatus): boolean {
  return MANUAL_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses counted for the per-unit subscription (D-082: every unit whose status is not `inactive`). */
export const BILLABLE_STATUSES: readonly UnitStatus[] = ['vacant', 'reserved', 'occupied', 'maintenance'];

export interface UnitNumberContext {
  building: string;
  floor: number;
  seq: number;
}

const TOKEN = /\{(building|floor|n+|ff)\}/g;

/**
 * Expands a unit number pattern (`{building}-{floor}{nn}` → `A-201`): `{building}` = building code, `{floor}` =
 * floor level, `{ff}` = level on 2 digits, `{n…}` = sequence on as many digits as there are `n`s.
 */
export function expandUnitNo(pattern: string, ctx: UnitNumberContext): string {
  return pattern.replace(TOKEN, (_m, token: string) => {
    if (token === 'building') return ctx.building;
    if (token === 'floor') return String(ctx.floor);
    if (token === 'ff') return String(ctx.floor).padStart(2, '0');
    return String(ctx.seq).padStart(token.length, '0');
  });
}

/** A pattern must contain a sequence token, or every unit of a floor would get the same number. */
export function patternProblems(pattern: string): string[] {
  const problems: string[] = [];
  if (!/\{n+\}/.test(pattern)) problems.push('the pattern needs a sequence token such as {nn}');
  if (!/\{(floor|ff)\}/.test(pattern)) problems.push('the pattern needs a floor token ({floor} or {ff})');
  const rest = pattern.replace(TOKEN, '');
  if (/[{}]/.test(rest)) problems.push('unknown token in the pattern');
  if (!/^[\p{L}\p{M}\p{N} ./_-]*$/u.test(rest))
    problems.push('the pattern may only contain letters, digits and - _ . /');
  return problems;
}

/** Unit numbers: letters (Thai or Latin), digits and - _ . / (max 20). */
export const UNIT_NO_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ./_-]{0,19}$/u;
