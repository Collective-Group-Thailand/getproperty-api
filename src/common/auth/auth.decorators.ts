import { type Actor } from '@common/context/actor';
import { type OrgContext } from '@common/context/org-context';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { ApiAuthErrors, ApiOptionalAuth, ApiOrgContext, ApiPublic } from '@common/openapi/decorators';
import { applyDecorators, createParamDecorator, SetMetadata } from '@nestjs/common';

import { type Audience } from '../../surfaces/surfaces';

export const IS_PUBLIC = 'getproperty:public';
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
 * The org this request runs in (contract §8): 400 `org.context_required` when it could not be
 * resolved. Pair with `@ApiOrgContext()` on multi-org operations so the header is documented.
 */
export const CurrentOrg = createParamDecorator((_data: unknown): OrgContext => {
  const org = RequestContext.org();
  if (!org) throw new DomainException('org.context_required');
  return org;
});

/** Documents the optional `X-Org-Id` header and its problems on an org-scoped operation. */
export const OrgScoped = () => ApiOrgContext();
