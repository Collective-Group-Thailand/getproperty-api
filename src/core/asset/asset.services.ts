import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type BuildingType,
  type IdDocumentType,
  type PartyType,
  type Prisma,
  type UnitStatus,
  type UnitType,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { TenantDataKeys } from '../tenancy/data-keys.service';

const by = () => userIdOf(RequestContext.actor());

/** Asset core primitives over the collective-asset-core tables (B1.3; endpoints arrive in B2.1/B2.2). */
@Injectable()
export class PropertyService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  create(
    ctx: TenantContext,
    input: { code: string; name: string; address?: Prisma.InputJsonValue; provinceCode?: string },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const p = await tx.property.create({
        data: {
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
          address: input.address ?? {},
          provinceCode: input.provinceCode ?? null,
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'property.changed',
        aggregateType: 'property',
        aggregateId: p.id,
        tenantId: ctx.tenantId,
        payload: { propertyId: p.id, change: 'created' },
      });
      return p;
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.property.findFirst({ where: { id, deletedAt: null } })),
    );
  }

  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.property.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    );
  }

  update(
    ctx: TenantContext,
    id: string,
    version: number | undefined,
    patch: { name?: string; address?: Prisma.InputJsonValue },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(
        await tx.property.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }),
      );
      if (version !== undefined && current.version !== version)
        throw new DomainException('concurrency.stale');
      const p = await tx.property.update({
        where: { id },
        data: { ...patch, updatedBy: by(), version: { increment: 1 } },
      });
      await this.events.record(tx, {
        type: 'property.changed',
        aggregateType: 'property',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { propertyId: id, change: 'updated' },
      });
      return p;
    });
  }
}

@Injectable()
export class BuildingService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Apartment default (§4.6): the creating tenant is owner and operator; opens the initial operator period. */
  create(
    ctx: TenantContext,
    input: {
      propertyId: string;
      code: string;
      name: string;
      type: BuildingType;
      floorsCount?: number;
      ownerTenantId?: string | null;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      this.found(
        await tx.property.findFirst({ where: this.own(ctx, { id: input.propertyId, deletedAt: null }) }),
      );
      const owner = input.ownerTenantId === undefined ? ctx.tenantId : input.ownerTenantId;
      const b = await tx.building.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: input.propertyId,
          code: input.code,
          name: input.name,
          type: input.type,
          floorsCount: input.floorsCount ?? 1,
          ownerTenantId: owner,
          operatorTenantId: ctx.tenantId,
          createdBy: by(),
        },
      });
      await tx.buildingOperatorPeriod.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: b.id,
          ownerTenantId: owner,
          operatorTenantId: ctx.tenantId,
          validFrom: this.clock.now(),
          reason: 'initial',
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'building.changed',
        aggregateType: 'building',
        aggregateId: b.id,
        tenantId: ctx.tenantId,
        buildingId: b.id,
        payload: { buildingId: b.id, change: 'created' },
      });
      return b;
    });
  }

  /** Visible buildings: own, owned/operated and granted (RLS), limited for building-scoped staff. */
  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.building.findMany({
        where: { deletedAt: null, ...(ctx.buildingIds ? { id: { in: [...ctx.buildingIds] } } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  get(ctx: TenantContext, id: string) {
    if (ctx.buildingIds && !ctx.buildingIds.includes(id)) throw new DomainException('http.not_found');
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.building.findFirst({ where: { id, deletedAt: null } })),
    );
  }

  /**
   * Operator change (§4.6; admin surface / integration events): one transaction closes the current operator period,
   * opens the next, re-points `operator_tenant_id` (and the owner when given), revokes the previous operator's
   * grants on the building — no data is copied; RLS visibility follows the new operator at once.
   */
  async changeOperator(
    buildingId: string,
    input: {
      operatorTenantId: string;
      ownerTenantId?: string | null;
      reason: 'pm_contract_start' | 'pm_contract_end' | 'juristic_formed' | 'handover' | 'other';
      sourceRef?: string | null;
    },
  ) {
    return this.db.platform(async (tx) => {
      const now = this.clock.now();
      const b = this.found(await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } }));
      const target = await tx.tenant.findFirst({ where: { id: input.operatorTenantId, deletedAt: null } });
      if (!target) throw new DomainException('http.not_found');
      const owner = input.ownerTenantId === undefined ? b.ownerTenantId : input.ownerTenantId;
      await tx.buildingOperatorPeriod.updateMany({
        where: { buildingId, validTo: null },
        data: { validTo: now },
      });
      await tx.buildingOperatorPeriod.create({
        data: {
          tenantId: b.tenantId,
          buildingId,
          ownerTenantId: owner,
          operatorTenantId: input.operatorTenantId,
          validFrom: now,
          reason: input.reason,
          sourceRef: input.sourceRef ?? null,
          createdBy: by(),
        },
      });
      const updated = await tx.building.update({
        where: { id: buildingId },
        data: {
          operatorTenantId: input.operatorTenantId,
          ownerTenantId: owner,
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      const revoked = await tx.assetAccessGrant.updateMany({
        where: { buildingId, granteeTenantId: input.operatorTenantId, revokedAt: null },
        data: { revokedAt: now, revokedBy: by(), revokeReason: 'grantee became the operator' },
      });
      await this.audit.record(tx, {
        action: 'building.operator_changed',
        tenantId: b.tenantId,
        buildingId,
        subjectType: 'core.building',
        subjectId: buildingId,
        before: { operatorTenantId: b.operatorTenantId, ownerTenantId: b.ownerTenantId },
        after: { operatorTenantId: input.operatorTenantId, ownerTenantId: owner, reason: input.reason },
        metadata: { grantsRevoked: revoked.count },
      });
      await this.events.record(tx, {
        type: 'building.operator_changed',
        aggregateType: 'building',
        aggregateId: buildingId,
        tenantId: b.tenantId,
        buildingId,
        payload: {
          buildingId,
          previousOperatorTenantId: b.operatorTenantId,
          operatorTenantId: input.operatorTenantId,
          ownerTenantId: owner,
          reason: input.reason,
        },
      });
      return updated;
    });
  }
}

@Injectable()
export class FloorService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  create(ctx: TenantContext, input: { buildingId: string; level: number; name: string; sortOrder?: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const b = this.found(await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } }));
      const f = await tx.floor.create({
        data: {
          tenantId: b.tenantId,
          buildingId: b.id,
          level: input.level,
          name: input.name,
          sortOrder: input.sortOrder ?? input.level,
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'floor.changed',
        aggregateType: 'floor',
        aggregateId: f.id,
        tenantId: b.tenantId,
        buildingId: b.id,
        payload: { floorId: f.id, change: 'created' },
      });
      return f;
    });
  }

  list(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, (tx) =>
      tx.floor.findMany({ where: { buildingId, deletedAt: null }, orderBy: { sortOrder: 'asc' } }),
    );
  }
}

@Injectable()
export class UnitService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  create(
    ctx: TenantContext,
    input: {
      buildingId: string;
      floorId?: string | null;
      unitNo: string;
      type?: UnitType;
      areaSqm?: string | null;
      baseRent?: string | null;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const b = this.found(await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } }));
      if (input.floorId)
        this.found(
          await tx.floor.findFirst({ where: { id: input.floorId, buildingId: b.id, deletedAt: null } }),
        );
      const u = await tx.unit.create({
        data: {
          tenantId: b.tenantId,
          buildingId: b.id,
          propertyId: b.propertyId,
          floorId: input.floorId ?? null,
          unitNo: input.unitNo,
          type: input.type ?? 'room',
          areaSqm: input.areaSqm ?? null,
          baseRent: input.baseRent ?? null,
          statusChangedAt: this.clock.now(),
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'unit.changed',
        aggregateType: 'unit',
        aggregateId: u.id,
        tenantId: b.tenantId,
        buildingId: b.id,
        payload: { unitId: u.id, change: 'created' },
      });
      return u;
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const u = this.found(await tx.unit.findFirst({ where: { id, deletedAt: null } }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(u.buildingId))
        throw new DomainException('http.not_found');
      return u;
    });
  }

  list(ctx: TenantContext, buildingId: string) {
    if (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)) throw new DomainException('http.not_found');
    return this.db.tenant(ctx, (tx) =>
      tx.unit.findMany({ where: { buildingId, deletedAt: null }, orderBy: { unitNo: 'asc' } }),
    );
  }

  setStatus(ctx: TenantContext, id: string, status: UnitStatus) {
    return this.db.tenant(ctx, async (tx) => {
      const u = this.found(await tx.unit.findFirst({ where: { id, deletedAt: null } }));
      const updated = await tx.unit.update({
        where: { id: u.id },
        data: { status, statusChangedAt: this.clock.now(), version: { increment: 1 }, updatedBy: by() },
      });
      await this.events.record(tx, {
        type: 'unit.changed',
        aggregateType: 'unit',
        aggregateId: u.id,
        tenantId: u.tenantId,
        buildingId: u.buildingId,
        payload: { unitId: u.id, change: 'status', status },
      });
      return updated;
    });
  }
}

export interface PartyInput {
  type: PartyType;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  taxId?: string | null;
  phone?: string | null;
  email?: string | null;
  lineUserId?: string | null;
  language?: string;
  nationality?: string | null;
  idDocumentType?: IdDocumentType | null;
  idNumber?: string | null;
  idDocumentCountry?: string | null;
}

const normaliseId = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();

/**
 * Parties with per-tenant PII encryption (D-148, §4.7): the id/passport number is sealed with the tenant DEK (AAD
 * binds tenant, table, column and row id), looked up by a tenant-scoped HMAC and shown masked; revealing it
 * requires `party.pii.decrypt` and writes `pii.decrypted` to the audit log.
 */
@Injectable()
export class PartyService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  private async sealed(tx: Tx, ctx: TenantContext, id: string, input: PartyInput) {
    if (!input.idNumber) return {};
    const value = normaliseId(input.idNumber);
    return {
      idNumberEnc: await this.keys.encrypt(
        tx,
        { tenantId: ctx.tenantId, table: 'core.party', column: 'id_number', rowId: id },
        value,
      ),
      idNumberHash: this.hasher.tenantValue(ctx.tenantId, value),
    };
  }

  create(ctx: TenantContext, input: PartyInput) {
    return this.db.tenant(ctx, async (tx) => {
      const id = uuidv7();
      const party = await tx.party.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          type: input.type,
          displayName: input.displayName,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          companyName: input.companyName ?? null,
          taxId: input.taxId ?? null,
          phoneE164: input.phone ?? null,
          phoneHash: input.phone ? this.hasher.tenantValue(ctx.tenantId, input.phone) : null,
          email: input.email ?? null,
          lineUserId: input.lineUserId ?? null,
          language: input.language ?? 'th',
          nationality: input.nationality ?? null,
          idDocumentType: input.idDocumentType ?? null,
          idDocumentCountry: input.idDocumentCountry ?? null,
          ...(await this.sealed(tx, ctx, id, input)),
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'party.changed',
        aggregateType: 'party',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { partyId: id, change: 'created' },
      });
      return party;
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.party.findFirst({ where: this.own(ctx, { id, deletedAt: null }) })),
    );
  }

  findByIdNumber(ctx: TenantContext, idNumber: string) {
    const hash = this.hasher.tenantValue(ctx.tenantId, normaliseId(idNumber));
    return this.db.tenant(ctx, (tx) =>
      tx.party.findMany({ where: this.own(ctx, { idNumberHash: Buffer.from(hash), deletedAt: null }) }),
    );
  }

  /** Reveals the id number (audited `pii.decrypted`, D-148). The caller checks `party.pii.decrypt`. */
  revealIdNumber(ctx: TenantContext, id: string, purpose: string) {
    return this.db.tenant(ctx, async (tx) => {
      const party = this.found(await tx.party.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }));
      if (!party.idNumberEnc) return null;
      const value = await this.keys.decrypt(
        tx,
        { tenantId: ctx.tenantId, table: 'core.party', column: 'id_number', rowId: id },
        party.idNumberEnc,
      );
      await this.audit.record(tx, {
        action: 'pii.decrypted',
        tenantId: ctx.tenantId,
        subjectType: 'core.party',
        subjectId: id,
        metadata: { field: 'id_number', purpose },
      });
      return value;
    });
  }

  /** `•••••••••1234` — list views never decrypt. */
  static mask(last4: string | null): string | null {
    return last4 ? `${'•'.repeat(9)}${last4}` : null;
  }
}
