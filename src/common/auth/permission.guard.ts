import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

import { REQUIRED_PERMISSIONS } from './can.decorator';

/**
 * `@Can(...permissions)` (D-091): every listed permission must be in the actor's effective set (operator role in the
 * request's tenant, or platform roles). A denial is 403 `auth.forbidden` and an `auth.permission_denied` audit row.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const actor = RequestContext.actor();
    if (!actor) throw new DomainException('auth.unauthenticated');
    const granted = RequestContext.permissions();
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length === 0) return true;
    const req = context.switchToHttp().getRequest<Request>();
    await this.audit.recordAlone({
      action: 'auth.permission_denied',
      tenantId: RequestContext.tenant()?.tenantId ?? null,
      outcome: 'denied',
      metadata: { missing, method: req.method, path: (req.originalUrl ?? req.url).split('?')[0] ?? '' },
    });
    throw new DomainException('auth.forbidden');
  }
}
