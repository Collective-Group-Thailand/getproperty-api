import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const REQUIRED_PERMISSIONS = 'getproperty:required-permissions';

/** `resource.action` (D-091); the typed catalogue (`PermissionKey`) arrives with IAM in B1.3. */
export type PermissionKey = `${string}.${string}`;

/**
 * Requires every listed permission (`resource.action`, D-090/D-091). Checked by `PermissionGuard`
 * after authentication (B1.3); a denial is 403 `auth.forbidden` and an audit row. The permissions
 * also appear in the contract as `x-required-permissions` so the web can hide what a user cannot do.
 */
export const Can = (...permissions: PermissionKey[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS, permissions),
    ApiExtension('x-required-permissions', permissions),
  );
