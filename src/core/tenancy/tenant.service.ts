import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type Tenant, type TenantLegalForm, type TenantType } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../events/domain-events';
import { TenantDataKeys } from './data-keys.service';
import { type CreatedInvitation, InvitationService } from './invitation.service';

export interface TenantCompanyData {
  displayName?: string;
  legalName?: string;
  legalForm?: TenantLegalForm;
  taxId?: string | null;
  vatRegistered?: boolean;
  address?: Prisma.InputJsonValue;
  logoDocumentId?: string | null;
  defaultLanguage?: string;
}

export interface OnboardInput extends Required<
  Pick<TenantCompanyData, 'displayName' | 'legalName' | 'legalForm'>
> {
  type: TenantType;
  slug: string;
  taxId?: string | null;
  vatRegistered?: boolean;
  address?: Prisma.InputJsonValue;
  plan?: string | null;
  defaultLanguage?: string;
  owner: { phone: string; language?: string };
}

const COMPANY_FIELDS = [
  'displayName',
  'legalName',
  'legalForm',
  'taxId',
  'vatRegistered',
  'address',
  'logoDocumentId',
  'defaultLanguage',
] as const;

/**
 * Tenants (D-150/D-151, D-161 onboarding): the platform admin creates a tenant of a type with its company data, its
 * first data key, its own legal entity as a party, and an Owner invitation sent by SMS; the Owner then maintains the
 * company data (legal name, tax id, address, VAT flag, logo) with `If-Match`. Audited and evented.
 */
@Injectable()
export class TenantService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly invitations: InvitationService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  async onboard(input: OnboardInput): Promise<{ tenant: Tenant; invitation: CreatedInvitation }> {
    const result = await this.db.platform(async (tx) => {
      if (await tx.tenant.findFirst({ where: { slug: input.slug } }))
        throw new DomainException('http.conflict');
      const id = uuidv7();
      const legalPartyId = uuidv7();
      await tx.tenant.create({
        data: {
          id,
          type: input.type,
          slug: input.slug,
          displayName: input.displayName,
          legalName: input.legalName,
          legalForm: input.legalForm,
          taxId: input.taxId ?? null,
          vatRegistered: input.vatRegistered ?? false,
          address: input.address ?? {},
          plan: input.plan ?? null,
          defaultLanguage: input.defaultLanguage ?? 'th',
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.keys.createFirst(tx, id);
      await tx.party.create({
        data: {
          id: legalPartyId,
          tenantId: id,
          type: input.legalForm === 'person' ? 'person' : 'company',
          displayName: input.legalName,
          companyName: input.legalForm === 'person' ? null : input.legalName,
          taxId: input.taxId ?? null,
        },
      });
      const tenant = await tx.tenant.update({ where: { id }, data: { legalPartyId } });
      await this.audit.record(tx, {
        action: 'tenant.created',
        tenantId: id,
        subjectType: 'core.tenant',
        subjectId: id,
        after: { type: input.type, slug: input.slug, legalForm: input.legalForm, plan: input.plan ?? null },
      });
      await this.events.record(tx, {
        type: 'tenant.created',
        aggregateType: 'tenant',
        aggregateId: id,
        tenantId: id,
        payload: { tenantId: id, type: input.type, plan: input.plan ?? null },
      });
      const invitation = await this.invitations.insert(tx, id, {
        role: 'owner',
        phone: input.owner.phone,
        channel: 'sms',
      });
      return { tenant, invitation };
    });
    await this.invitations.sendSms(
      input.owner.phone,
      result.tenant.displayName,
      result.invitation.inviteUrl,
      input.owner.language,
    );
    return result;
  }

  get(ctx: TenantContext): Promise<Tenant> {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.tenant.findFirst({ where: { id: ctx.tenantId, deletedAt: null } })),
    );
  }

  async update(
    ctx: TenantContext,
    expectedVersion: number | undefined,
    patch: TenantCompanyData,
  ): Promise<Tenant> {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(await tx.tenant.findFirst({ where: { id: ctx.tenantId, deletedAt: null } }));
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        throw new DomainException('concurrency.stale');
      if (patch.logoDocumentId) {
        const doc = await tx.document.findFirst({
          where: { id: patch.logoDocumentId, tenantId: ctx.tenantId, kind: 'logo', deletedAt: null },
        });
        if (!doc) throw new DomainException('http.not_found');
      }
      const data = Object.fromEntries(
        COMPANY_FIELDS.filter((f) => patch[f] !== undefined).map((f) => [f, patch[f]]),
      );
      const updated = await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: { ...data, updatedBy: userIdOf(RequestContext.actor()), version: { increment: 1 } },
      });
      const pick = (t: Tenant) =>
        Object.fromEntries(
          COMPANY_FIELDS.map((f) => [f, (t as unknown as Record<string, unknown>)[f] ?? null]),
        );
      await this.audit.record(tx, {
        action: 'tenant.updated',
        tenantId: ctx.tenantId,
        subjectType: 'core.tenant',
        subjectId: ctx.tenantId,
        before: pick(current),
        after: pick(updated),
      });
      await this.events.record(tx, {
        type: 'tenant.updated',
        aggregateType: 'tenant',
        aggregateId: ctx.tenantId,
        tenantId: ctx.tenantId,
        payload: { tenantId: ctx.tenantId, fields: Object.keys(data) },
      });
      return updated;
    });
  }

  /** Platform admin views. */
  list(input: { q?: string; skip: number; take: number }) {
    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      ...(input.q
        ? {
            OR: [
              { displayName: { contains: input.q, mode: 'insensitive' } },
              { slug: { contains: input.q } },
            ],
          }
        : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: input.skip,
        take: input.take,
      }),
      total: await tx.tenant.count({ where }),
    }));
  }

  getAny(tenantId: string) {
    return this.db.platform(async (tx) =>
      this.found(await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } })),
    );
  }

  /**
   * Buildings a tenant owns or operates (admin console, web F5 device assignment, D-214): company-level structure only
   * — names, the property, the number of units — no tenant business data.
   */
  async buildingsOf(tenantId: string) {
    return this.db.platform(async (tx) => {
      this.found(await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }));
      const rows = await tx.building.findMany({
        where: { deletedAt: null, OR: [{ ownerTenantId: tenantId }, { operatorTenantId: tenantId }] },
        include: { property: { select: { id: true, name: true } } },
        orderBy: [{ property: { name: 'asc' } }, { code: 'asc' }],
      });
      const counts = await tx.unit.groupBy({
        by: ['buildingId'],
        where: { buildingId: { in: rows.map((b) => b.id) }, deletedAt: null },
        _count: { _all: true },
      });
      const count = new Map(counts.map((c) => [c.buildingId, c._count._all]));
      return rows.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        propertyId: b.property.id,
        propertyName: b.property.name,
        unitCount: count.get(b.id) ?? 0,
        roles: [
          ...(b.ownerTenantId === tenantId ? (['owner'] as const) : []),
          ...(b.operatorTenantId === tenantId ? (['operator'] as const) : []),
        ],
      }));
    });
  }
}
