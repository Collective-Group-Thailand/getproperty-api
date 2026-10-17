import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { isUuid } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { AccessService } from '@core/tenancy/access.service';
import { SupportGrantService } from '@core/tenancy/support-grant.service';
import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension } from '@nestjs/swagger';
import { type Request } from 'express';

import { EXT } from '../openapi/decorators';

export const SUPPORT_GRANT_PARAM = 'getproperty:support-grant-param';

/**
 * A `/v1/admin` read into one tenant's data (contract §8, D-090): the `Support` role needs an active support grant
 * for the tenant named by the route parameter; `Platform admin` bypasses it. Both are audited per request
 * (`support_grant.used` / `support_grant.bypassed`). Documents 403 `support.grant_required`.
 */
export const SupportGrantRequired = (param = 'tenantId') =>
  applyDecorators(
    SetMetadata(SUPPORT_GRANT_PARAM, param),
    ApiExtension(`${EXT.errors}-support`, ['support.grant_required']),
  );

@Injectable()
export class SupportGrantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    private readonly grants: SupportGrantService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const param = this.reflector.getAllAndOverride<string>(SUPPORT_GRANT_PARAM, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!param) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const tenantId = req.params[param];
    const actor = RequestContext.actor();
    if (actor?.type !== 'user' || actor.audience !== 'platform') throw new DomainException('auth.forbidden');
    if (!isUuid(tenantId)) throw new DomainException('http.not_found');
    const access = await this.access.platform(actor.publicId);
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    if (access.roles.includes('platform_admin')) {
      await this.audit.recordAlone({
        action: 'support_grant.bypassed',
        tenantId,
        metadata: { method: req.method, path },
      });
      RequestContext.setTenant({ tenantId, source: 'path' });
      return true;
    }
    const grant = access.roles.includes('support')
      ? await this.grants.activeFor(actor.publicId, tenantId)
      : null;
    if (!grant) {
      await this.audit.recordAlone({
        action: 'support_grant.used',
        tenantId,
        outcome: 'denied',
        metadata: { method: req.method, path },
      });
      throw new DomainException('support.grant_required');
    }
    RequestContext.setActor({ ...actor, supportGrantId: grant.id });
    RequestContext.setTenant({ tenantId, source: 'path', supportGrantId: grant.id });
    await this.audit.recordAlone({
      action: 'support_grant.used',
      tenantId,
      supportGrantId: grant.id,
      metadata: { method: req.method, path },
    });
    return true;
  }
}
