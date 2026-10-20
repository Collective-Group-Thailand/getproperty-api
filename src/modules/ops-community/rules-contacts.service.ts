import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type BuildingRule, type Contact, type ContactKind, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { cleanTranslations, type Translations } from './community-rules';

const by = () => userIdOf(RequestContext.actor());

export interface ContactInput {
  buildingId?: string | null;
  kind: ContactKind;
  name: string;
  phone?: string | null;
  lineId?: string | null;
  partyId?: string | null;
  notes?: string | null;
  sortOrder?: number;
}

/**
 * Building rules (B5.3, D-073) — versioned per building: a new version is a new row published at once and in force
 * from its date; residents acknowledge the version in force (in the app, or when they sign a lease / confirm the rules
 * of its addendum in B2.3, which records the acknowledgement here too) — and contacts (emergency, building, vendors,
 * utilities) of a building or the whole tenant.
 */
@Injectable()
export class BuildingRulesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async building(tx: Tx, ctx: TenantContext, buildingId: string) {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
      throw new DomainException('http.not_found');
    return b;
  }

  versions(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.building(tx, ctx, buildingId);
      return tx.buildingRule.findMany({
        where: this.own(ctx, { buildingId }),
        include: { _count: { select: { acks: true } } },
        orderBy: { version: 'desc' },
      });
    });
  }

  async publish(
    ctx: TenantContext,
    buildingId: string,
    input: { title: string; bodyTh: string; translations?: Translations; effectiveFrom: string },
  ): Promise<BuildingRule> {
    return this.db.tenant(ctx, async (tx) => {
      await this.building(tx, ctx, buildingId);
      const last = await tx.buildingRule.findFirst({
        where: { buildingId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const now = this.clock.now();
      if (input.effectiveFrom < bangkokDate(now))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'effectiveFrom', code: 'backdated', message: 'rules are never backdated' }],
        });
      const rule = await tx.buildingRule.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId,
          version: (last?.version ?? 0) + 1,
          title: input.title.trim(),
          bodyTh: input.bodyTh.trim(),
          translations: cleanTranslations(input.translations) as Prisma.InputJsonValue,
          effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
          publishedAt: now,
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'building_rule.published',
        aggregateType: 'building_rule',
        aggregateId: rule.id,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { ruleId: rule.id, buildingId, version: rule.version, effectiveFrom: input.effectiveFrom },
      });
      return rule;
    });
  }

  /** The version in force on `day` (the newest published version whose date has come). */
  inForce(tx: Tx, buildingId: string, day: string): Promise<BuildingRule | null> {
    return tx.buildingRule.findFirst({
      where: { buildingId, publishedAt: { not: null }, effectiveFrom: { lte: new Date(`${day}T00:00:00Z`) } },
      orderBy: { version: 'desc' },
    });
  }

  acknowledgements(ctx: TenantContext, ruleId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const rule = this.found(await tx.buildingRule.findFirst({ where: this.own(ctx, { id: ruleId }) }));
      return tx.buildingRuleAck.findMany({
        where: { ruleId: rule.id },
        include: { party: { select: { displayName: true } } },
        orderBy: { ackedAt: 'asc' },
      });
    });
  }

  /** Records acknowledgements of the rule in force of a building (idempotent per rule × party). */
  async acknowledgeIn(
    tx: Tx,
    input: {
      tenantId: string;
      buildingId: string;
      partyIds: string[];
      leaseId: string | null;
      userId: string | null;
    },
  ): Promise<BuildingRule | null> {
    const rule = await this.inForce(tx, input.buildingId, bangkokDate(this.clock.now()));
    if (!rule) return null;
    let added = 0;
    for (const partyId of new Set(input.partyIds)) {
      const exists = await tx.buildingRuleAck.findUnique({
        where: { ruleId_partyId: { ruleId: rule.id, partyId } },
      });
      if (exists) continue;
      await tx.buildingRuleAck.create({
        data: {
          ruleId: rule.id,
          partyId,
          tenantId: rule.tenantId,
          leaseId: input.leaseId,
          userId: input.userId,
          ackedAt: this.clock.now(),
        },
      });
      added += 1;
    }
    if (added)
      await this.events.record(tx, {
        type: 'building_rule.acknowledged',
        aggregateType: 'building_rule',
        aggregateId: rule.id,
        tenantId: rule.tenantId,
        buildingId: rule.buildingId,
        payload: { ruleId: rule.id, version: rule.version, partyIds: input.partyIds, leaseId: input.leaseId },
      });
    return rule;
  }

  // ------------------------------------------------------------------------------------------------ contacts

  contacts(ctx: TenantContext, f: { buildingId?: string }): Promise<Contact[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.contact.findMany({
        where: {
          ...this.own(ctx, { deletedAt: null }),
          ...(f.buildingId ? { OR: [{ buildingId: f.buildingId }, { buildingId: null }] } : {}),
        },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async createContact(ctx: TenantContext, input: ContactInput): Promise<Contact> {
    return this.db.tenant(ctx, async (tx) => {
      if (input.buildingId) await this.building(tx, ctx, input.buildingId);
      if (!input.phone && !input.lineId && !input.partyId)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'phone', code: 'required', message: 'a phone, a LINE id or a party' }],
        });
      return tx.contact.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId ?? null,
          kind: input.kind,
          name: input.name.trim(),
          phone: input.phone ?? null,
          lineId: input.lineId ?? null,
          partyId: input.partyId ?? null,
          notes: input.notes ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdBy: by(),
        },
      });
    });
  }

  async updateContact(ctx: TenantContext, id: string, input: Partial<ContactInput>): Promise<Contact> {
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.contact.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }));
      return tx.contact.update({
        where: { id: row.id },
        data: {
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.lineId !== undefined ? { lineId: input.lineId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedBy: by(),
        },
      });
    });
  }

  async removeContact(ctx: TenantContext, id: string): Promise<void> {
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.contact.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }));
      await tx.contact.update({
        where: { id: row.id },
        data: { deletedAt: this.clock.now(), deletedBy: by() },
      });
    });
  }
}
