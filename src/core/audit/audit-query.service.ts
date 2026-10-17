import { type TenantContext } from '@common/context/tenant-context';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type AuditLog, type Prisma } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

export interface AuditQuery {
  action?: string;
  subjectId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  /** Exclusive upper bound id (UUIDv7, newest first). */
  beforeId?: string;
  limit: number;
}

/**
 * Read side of `platform.audit_log`: a tenant reads its own rows (RLS `tenant` + explicit `tenant_id`), the platform
 * reads across tenants (admin audit, D-161). Newest first, keyset on the UUIDv7 id. Rows never leave with secrets —
 * audit writers never put any in (blueprint rule 5).
 */
@Injectable()
export class AuditQueryService extends TenantScopedRepository {
  constructor(private readonly db: TenantTx) {
    super();
  }

  private where(q: AuditQuery): Prisma.AuditLogWhereInput {
    return {
      ...(q.action
        ? { action: q.action.endsWith('*') ? { startsWith: q.action.slice(0, -1) } : q.action }
        : {}),
      ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.from || q.to
        ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }
        : {}),
      ...(q.beforeId ? { id: { lt: q.beforeId } } : {}),
    };
  }

  forTenant(ctx: TenantContext, q: AuditQuery): Promise<AuditLog[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.auditLog.findMany({
        where: { ...this.where(q), tenantId: ctx.tenantId },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  forPlatform(q: AuditQuery & { tenantId?: string }): Promise<AuditLog[]> {
    return this.db.platform((tx) =>
      tx.auditLog.findMany({
        where: { ...this.where(q), ...(q.tenantId ? { tenantId: q.tenantId } : {}) },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }
}
