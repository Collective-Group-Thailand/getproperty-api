import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type ServiceCategory } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

/** A category as the tenant sees it: its override of a platform key, or the platform default. */
export interface EffectiveCategory {
  /** The row to reference (the tenant's override when there is one). */
  id: string;
  key: string;
  nameTh: string;
  nameEn: string;
  slaHours: number;
  sortOrder: number;
  isActive: boolean;
  /** `platform` default or the tenant's own row (override or a category of its own). */
  source: 'platform' | 'tenant';
}

const effective = (c: ServiceCategory): EffectiveCategory => ({
  id: c.id,
  key: c.key,
  nameTh: c.nameTh,
  nameEn: c.nameEn,
  slaHours: c.defaultSlaHours,
  sortOrder: c.sortOrder,
  isActive: c.isActive && !c.deletedAt,
  source: c.tenantId ? 'tenant' : 'platform',
});

/**
 * Service categories (B5.1, D-072): the platform defaults (electrical, plumbing, aircon, appliance, structure, pest,
 * cleaning, other — tenant_id NULL, seeded) with their default SLA hours, and the tenant's overrides of the same key
 * (names, SLA hours, hidden) or categories of its own. A request keeps the SLA hours in force when it was reported.
 */
@Injectable()
export class ServiceCategoriesService extends TenantScopedRepository {
  constructor(private readonly db: TenantTx) {
    super();
  }

  /** Effective categories of a tenant (overrides win per key), in display order. */
  async list(tx: Tx, tenantId: string, includeInactive = false): Promise<EffectiveCategory[]> {
    const rows = await tx.serviceCategory.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }], deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    const byKey = new Map<string, ServiceCategory>();
    for (const r of rows) if (!r.tenantId) byKey.set(r.key, r);
    for (const r of rows) if (r.tenantId) byKey.set(r.key, r);
    return [...byKey.values()]
      .map(effective)
      .filter((c) => includeInactive || c.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  }

  listFor(ctx: TenantContext, includeInactive = false): Promise<EffectiveCategory[]> {
    return this.db.tenant(ctx, (tx) => this.list(tx, ctx.tenantId, includeInactive));
  }

  /**
   * The effective category of an id the client sent (a platform row or the tenant's): a platform id resolves to the
   * tenant's override of that key when one exists. 422 when unknown or hidden.
   */
  async resolve(tx: Tx, tenantId: string, id: string): Promise<EffectiveCategory> {
    const row = await tx.serviceCategory.findFirst({
      where: { id, deletedAt: null, OR: [{ tenantId: null }, { tenantId }] },
    });
    const all = row ? await this.list(tx, tenantId, true) : [];
    const found = row ? all.find((c) => c.key === row.key) : undefined;
    if (!found?.isActive)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'categoryId', code: 'unknown', message: 'a category of GET …/service-categories' }],
      });
    return found;
  }

  /** The effective category of a key (automatic requests); falls back to `other`. */
  async byKey(tx: Tx, tenantId: string, key: string): Promise<EffectiveCategory> {
    const all = await this.list(tx, tenantId, true);
    const found = all.find((c) => c.key === key && c.isActive) ?? all.find((c) => c.key === 'other');
    if (!found) throw new Error('service categories are not seeded');
    return found;
  }

  /**
   * `PUT /v1/owner/service-categories/{key}`: the tenant's version of a key — an override of a platform default (names
   * optional, SLA hours, active) or a category of its own (names required). Re-creating a removed key restores it.
   */
  async put(
    ctx: TenantContext,
    key: string,
    input: { nameTh?: string; nameEn?: string; slaHours: number; sortOrder?: number; isActive?: boolean },
  ): Promise<EffectiveCategory> {
    return this.db.tenant(ctx, async (tx) => {
      const platform = await tx.serviceCategory.findFirst({ where: { tenantId: null, key } });
      const nameTh = input.nameTh ?? platform?.nameTh;
      const nameEn = input.nameEn ?? platform?.nameEn;
      if (!nameTh || !nameEn)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'nameTh', code: 'required', message: 'names are required for a new category' }],
        });
      const by = userIdOf(RequestContext.actor());
      const row = await tx.serviceCategory.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key } },
        create: {
          tenantId: ctx.tenantId,
          key,
          nameTh,
          nameEn,
          defaultSlaHours: input.slaHours,
          sortOrder: input.sortOrder ?? platform?.sortOrder ?? 100,
          isActive: input.isActive ?? true,
          createdBy: by,
        },
        update: {
          nameTh,
          nameEn,
          defaultSlaHours: input.slaHours,
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          isActive: input.isActive ?? true,
          deletedAt: null,
          deletedBy: null,
          updatedBy: by,
        },
      });
      return effective(row);
    });
  }

  /** Removes the tenant's override (the platform default applies again) or its own category (soft). */
  async remove(ctx: TenantContext, key: string): Promise<void> {
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(
        await tx.serviceCategory.findFirst({ where: this.own(ctx, { key, deletedAt: null }) }),
      );
      await tx.serviceCategory.update({
        where: { id: row.id },
        data: { deletedAt: new Date(), deletedBy: userIdOf(RequestContext.actor()) },
      });
    });
  }
}
