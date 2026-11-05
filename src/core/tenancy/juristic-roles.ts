import { isJuristicTenantType } from '@collective/asset-core';
import { DomainException } from '@common/errors/domain.exception';

/** D-320 (J1.1b): roles that exist only in juristic tenants; the auditor's membership is time-boxed. */
export const JURISTIC_ONLY_ROLES: readonly string[] = ['committee', 'auditor'];

/**
 * Checks a role grant (invitation or role change, D-320 / D-324): `committee` and `auditor` only in a juristic tenant
 * (422 `membership.role_not_allowed`); an auditor needs `accessUntil` in the future and within
 * `juristic.auditor_max_days` (422 `membership.access_until_required`). Returns the time-box to store (null = none).
 */
export function checkRoleGrant(input: {
  role: string;
  tenantType: string;
  accessUntil?: string | Date | null;
  now: Date;
  maxDays: number;
}): Date | null {
  if (JURISTIC_ONLY_ROLES.includes(input.role) && !isJuristicTenantType(input.tenantType))
    throw new DomainException('membership.role_not_allowed');
  if (input.role !== 'auditor') return null;
  const until = input.accessUntil ? new Date(input.accessUntil) : null;
  if (
    !until ||
    Number.isNaN(until.getTime()) ||
    until.getTime() <= input.now.getTime() ||
    until.getTime() > input.now.getTime() + input.maxDays * 86_400_000
  )
    throw new DomainException('membership.access_until_required', { params: { maxDays: input.maxDays } });
  return until;
}

/** `core.membership.module_scopes.accessUntil` has passed: the membership no longer grants access. */
export function membershipExpired(moduleScopes: unknown, now: Date): boolean {
  const until = (moduleScopes as { accessUntil?: string } | null)?.accessUntil;
  return Boolean(until) && new Date(until!).getTime() <= now.getTime();
}
