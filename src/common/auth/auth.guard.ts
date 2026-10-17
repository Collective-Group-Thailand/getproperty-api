import { type Actor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { resolveTenantContext, TENANT_ID_HEADER } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { TokenService } from '@core/identity/token.service';
import { AccessService } from '@core/tenancy/access.service';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

import { type Audience, SURFACE_AUDIENCE, surfaceOfPath } from '../../surfaces/surfaces';
import { IS_PUBLIC, OPTIONAL_AUTH, TENANT_OPTIONAL } from './auth.decorators';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function bearerOf(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new DomainException('auth.unauthenticated');
  return token.trim();
}

/**
 * Authentication + audience + tenant context for every route (contract §2, §4, §8; ADR-0003):
 * - a bearer token is verified (EdDSA, issuer, expiry, family not revoked) and must carry the audience of the
 *   surface it calls — a token of one audience is refused on every other prefix (403 `auth.wrong_audience`);
 * - routes without `@Public()` / `@OptionalAuth()` need a token (401);
 * - on `/v1/owner` and `/v1/staff` the tenant comes from the single `tenant:` scope or `X-Tenant-Id` (which must be
 *   in the token), and the operator's membership is re-checked now: role, building limits, read-only tenant
 *   (D-082: no mutations while suspended);
 * - on `/v1/admin` the user must hold an active platform role.
 * The actor, tenant context and permission set land in the request context for guards, services and repositories.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true;
    const optional = this.reflector.getAllAndOverride<Audience>(OPTIONAL_AUTH, targets);
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    const surface = surfaceOfPath(path);
    const audience = surface ? SURFACE_AUDIENCE[surface] : null;

    const token = bearerOf(req);
    let actor: Actor | undefined;
    if (token) {
      const claims = await this.tokens.verify(token);
      if (audience && claims.aud !== audience) throw new DomainException('auth.wrong_audience');
      actor =
        claims.aud === 'device'
          ? {
              type: 'device',
              publicId: claims.sub,
              audience: 'device',
              tenantId: claims.tid ?? '',
              buildingId: claims.bid ?? '',
              scopes: claims.scp,
            }
          : {
              type: 'user',
              publicId: claims.sub,
              audience: claims.aud,
              sessionId: claims.sid,
              scopes: claims.scp,
              ...(claims.amr ? { amr: claims.amr } : {}),
            };
      RequestContext.setActor(actor);
    } else if (!isPublic && !optional && audience) {
      throw new DomainException('auth.unauthenticated');
    }

    if (audience === 'operator') {
      const tenantOptional = this.reflector.getAllAndOverride<boolean>(TENANT_OPTIONAL, targets) === true;
      let tenant;
      try {
        tenant = resolveTenantContext(
          req.headers[TENANT_ID_HEADER],
          actor && 'scopes' in actor ? actor.scopes : undefined,
        );
      } catch (error) {
        if (!(tenantOptional && error instanceof DomainException && error.code === 'tenant.context_required'))
          throw error;
      }
      if (tenant && actor?.type === 'user') {
        const access = await this.access.operator(actor.publicId, tenant.tenantId);
        if (!access) throw new DomainException('tenant.not_in_scope');
        if (access.tenantStatus === 'read_only' && !SAFE_METHODS.has(req.method))
          throw new DomainException('tenant.read_only');
        tenant.role = access.role;
        tenant.buildingIds = access.buildingIds;
        RequestContext.setPermissions(access.permissions);
      }
      RequestContext.setTenant(tenant);
    } else if (audience === 'platform' && actor?.type === 'user') {
      const access = await this.access.platform(actor.publicId);
      if (access.roles.length === 0) throw new DomainException('auth.forbidden');
      RequestContext.setPermissions(access.permissions);
    }
    return true;
  }
}
