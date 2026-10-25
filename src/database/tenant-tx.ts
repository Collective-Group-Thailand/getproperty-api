import { type ActorKind } from '@collective/asset-core';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { Injectable } from '@nestjs/common';

import { PrismaService, type TenantScope, type Tx, type TxOptions } from './prisma.service';

/** The `app.tenant_id` / `app.actor_*` session of a tenant transaction, from the context and the current actor. */
export function tenantScopeOf(ctx: TenantContext): TenantScope {
  const actor = RequestContext.actor();
  let actorKind: ActorKind = 'system';
  let actorId: string | null = null;
  if (actor?.type === 'user') {
    // asset-core's session kinds predate prospects (B7.3): a prospect is an outside person like a resident
    actorKind = actor.audience === 'prospect' ? 'resident' : actor.audience;
    actorId = actor.publicId;
  } else if (actor?.type === 'device') {
    actorKind = 'device';
  }
  return { tenantId: ctx.tenantId, actorId, actorKind };
}

/**
 * Transactions with the right database role (schema-design §4.5): `tenant(ctx, …)` runs as gp_app with
 * `SET LOCAL app.tenant_id` so RLS applies to every statement; `platform(…)` runs as gp_platform for identity
 * lookups, the admin surface and cross-tenant jobs. Services open one of these and pass `tx` to repositories, the
 * audit log and the outbox, so an aggregate change, its audit row and its domain event commit together.
 */
@Injectable()
export class TenantTx {
  constructor(private readonly prisma: PrismaService) {}

  tenant<T>(ctx: TenantContext, work: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.prisma.withTenant(tenantScopeOf(ctx), work, options);
  }

  platform<T>(work: (tx: Tx) => Promise<T>, options?: TxOptions & { tenantId?: string | null }): Promise<T> {
    const actor = RequestContext.actor();
    return this.prisma.withPlatform(work, {
      ...options,
      actorId: actor?.type === 'user' ? actor.publicId : null,
    });
  }
}

/**
 * Base of repositories over tenant tables (D-152, contract §8): every query carries `tenant_id` (the first line),
 * runs inside `TenantTx.tenant` (RLS, the second line), and a row that is missing *or not visible* is a 404.
 */
export abstract class TenantScopedRepository {
  /** `where` + `tenantId` of the context. */
  protected own<const W extends object>(ctx: TenantContext, where: W): W & { tenantId: string } {
    return { ...where, tenantId: ctx.tenantId };
  }

  /** Prisma filter on `buildingId` for Staff limited to buildings (D-090); undefined = no limit. */
  protected buildingScope(ctx: TenantContext): { in: string[] } | undefined {
    return ctx.buildingIds ? { in: [...ctx.buildingIds] } : undefined;
  }

  protected found<T>(row: T | null | undefined): T {
    if (row === null || row === undefined) throw new DomainException('http.not_found');
    return row;
  }
}

export type { Tx };
