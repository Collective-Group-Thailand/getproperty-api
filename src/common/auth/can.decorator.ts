import { PERMISSIONS } from '@core/rbac/catalogue';
import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const REQUIRED_PERMISSIONS = 'getproperty:required-permissions';

/** `resource.action` (D-091), checked against the catalogue when the route is declared. */
export type PermissionKey = `${string}.${string}`;

const KNOWN = new Set(PERMISSIONS.map((p) => p.key));

/**
 * Requires every listed permission (`resource.action`, D-090/D-091). Checked by `PermissionGuard` after
 * authentication; a denial is 403 `auth.forbidden` and an audit row. The permissions also appear in the contract as
 * `x-required-permissions` so the web can hide what a user cannot do, and in docs/rbac.md (endpoints table).
 */
export const Can = (...permissions: PermissionKey[]) => {
  for (const p of permissions)
    if (!KNOWN.has(p)) throw new Error(`@Can: unknown permission "${p}" (catalogue.ts)`);
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS, permissions),
    ApiExtension('x-required-permissions', permissions),
  );
};
