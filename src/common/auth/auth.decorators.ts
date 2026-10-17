import { type Actor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { ApiAuthErrors, ApiOptionalAuth, ApiPublic, ApiTenantContext } from '@common/openapi/decorators';
import { applyDecorators, createParamDecorator, SetMetadata } from '@nestjs/common';

import { type Audience } from '../../surfaces/surfaces';

export const IS_PUBLIC = 'getproperty:public';
export const TENANT_OPTIONAL = 'getproperty:tenant-optional';
export const OPTIONAL_AUTH = 'getproperty:optional-auth';

/** No token required on a protected surface (documented as `security: []`). */
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC, true), ApiPublic());

/**
 * Anonymous callers are accepted; when a bearer token is sent it must be valid and of this audience
 * (401 `auth.unauthenticated`, 403 `auth.wrong_audience` otherwise — enforced by the audience guard
 * from B1.3; documented as `security: [{}, { <scheme>: [] }]`).
 */
export const OptionalAuth = (audience: Audience) =>
  applyDecorators(SetMetadata(OPTIONAL_AUTH, audience), ApiOptionalAuth(audience), ApiAuthErrors());

/** The authenticated actor; 401 when the route is reached without one (the guard arrives in B1.3). */
export const CurrentActor = createParamDecorator((_data: unknown): Actor => {
  const actor = RequestContext.actor();
  if (!actor) throw new DomainException('auth.unauthenticated');
  return actor;
});

/** The authenticated actor or `undefined`. */
export const OptionalActor = createParamDecorator((_data: unknown): Actor | undefined =>
  RequestContext.actor(),
);

/**
 * The tenant this request runs in (contract §8, D-151): 400 `tenant.context_required` when it could
 * not be resolved. Pair with `@TenantScoped()` so the `X-Tenant-Id` header is documented.
 */
export const CurrentTenant = createParamDecorator((_data: unknown): TenantContext => {
  const tenant = RequestContext.tenant();
  if (!tenant) throw new DomainException('tenant.context_required');
  return tenant;
});

/** Documents the optional `X-Tenant-Id` header and its problems on a tenant-scoped operation. */
export const TenantScoped = () => ApiTenantContext();

/**
 * Operator route that also answers without a tenant context when the operator belongs to several tenants and sent no
 * `X-Tenant-Id` (e.g. `/me`, which lists the tenants to choose from).
 */
export const TenantOptional = () => SetMetadata(TENANT_OPTIONAL, true);
