import { actorEnvelope, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type HaasAsset, type HaasState, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export const HAAS_INCLUDE = {
  device: { select: { id: true, serial: true, kind: true, model: true, status: true, assetItemId: true } },
  events: { orderBy: { occurredAt: 'asc' } },
} as const satisfies Prisma.HaasAssetInclude;
export type HaasRow = Prisma.HaasAssetGetPayload<{ include: typeof HAAS_INCLUDE }>;

const by = () => userIdOf(RequestContext.actor());

/** Allowed moves of a platform-owned device at a tenant (D-081). */
const NEXT: Record<HaasState, HaasState[]> = {
  allocated: ['installed', 'written_off'],
  installed: ['in_service', 'replaced', 'deinstalled', 'written_off'],
  in_service: ['replaced', 'deinstalled', 'written_off'],
  replaced: [],
  deinstalled: [],
  written_off: [],
};

/**
 * Straight-line book value of a platform asset on `day` (D-081 "depreciated over the term"): acquisition cost ×
 * (months left ÷ term), never below 0; before installation it is the full cost.
 */
export function bookValue(
  a: Pick<HaasAsset, 'acquisitionCost' | 'termMonths' | 'installedAt'>,
  day: string,
): string {
  const cost = new Decimal(a.acquisitionCost.toString());
  if (!a.installedAt) return cost.toFixed(2);
  const start = a.installedAt.toISOString().slice(0, 10);
  const [y0, m0, d0] = start.split('-').map(Number) as [number, number, number];
  const [y1, m1, d1] = day.split('-').map(Number) as [number, number, number];
  const months = Math.max(0, (y1 - y0) * 12 + (m1 - m0) - (d1 < d0 ? 1 : 0));
  const left = Math.max(0, a.termMonths - months);
  return cost.times(left).div(a.termMonths).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * The HaaS asset register (D-081, B6.1): every platform-owned device placed at a tenant (gateways, rented meters) with
 * its install date, term, monthly value, acquisition cost and straight-line book value, state history and replacement
 * chain; cancellation of the subscription attaches it to a de-install order. Platform writes only (Field engineer /
 * Finance); the tenant reads its own register.
 */
@Injectable()
export class HaasService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async event(
    tx: Tx,
    a: Pick<HaasAsset, 'id' | 'tenantId'>,
    type: string,
    data: Record<string, unknown>,
    installOrderId?: string | null,
  ) {
    await tx.haasAssetEvent.create({
      data: {
        tenantId: a.tenantId,
        haasAssetId: a.id,
        type,
        occurredAt: this.clock.now(),
        actor: actorEnvelope(RequestContext.actor()),
        data: data as Prisma.InputJsonValue,
        installOrderId: installOrderId ?? null,
      },
    });
  }

  list(filter: { tenantId?: string; state?: HaasState; skip: number; take: number }) {
    const where: Prisma.HaasAssetWhereInput = {
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.state ? { state: filter.state } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.haasAsset.findMany({
        where,
        include: HAAS_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.haasAsset.count({ where }),
    }));
  }

  /** The tenant's own register (owner surface, RLS). */
  mine(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.haasAsset.findMany({
        where: { tenantId: ctx.tenantId },
        include: HAAS_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  get(id: string) {
    return this.db.platform(async (tx) => {
      const a = await tx.haasAsset.findUnique({ where: { id }, include: HAAS_INCLUDE });
      if (!a) throw new DomainException('http.not_found');
      return a;
    });
  }

  /** Registers a platform-owned device for a tenant (`smart.device.ownership = platform_haas`). */
  register(input: {
    deviceId: string;
    tenantId: string;
    buildingId?: string | null;
    termMonths: number;
    monthlyValue: string;
    acquisitionCost: string;
  }) {
    return this.db.platform(async (tx) => {
      const device = await tx.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new DomainException('http.not_found');
      if (device.ownership !== 'platform_haas')
        throw new DomainException('haas.not_platform_owned', { params: { serial: device.serial } });
      const live = await tx.haasAsset.findFirst({
        where: { deviceId: input.deviceId, state: { notIn: ['replaced', 'deinstalled', 'written_off'] } },
      });
      if (live) throw new DomainException('http.conflict');
      if (device.tenantId && device.tenantId !== input.tenantId)
        throw new DomainException('haas.tenant_mismatch', { params: { serial: device.serial } });
      const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      const sub = await tx.subscription.findFirst({
        where: { tenantId: input.tenantId, state: { in: ['trial', 'active', 'past_due', 'suspended'] } },
      });
      const asset = await tx.haasAsset.create({
        data: {
          deviceId: input.deviceId,
          tenantId: input.tenantId,
          buildingId: input.buildingId ?? device.buildingId ?? null,
          subscriptionId: sub?.id ?? null,
          kind: device.kind,
          termMonths: input.termMonths,
          monthlyValue: input.monthlyValue,
          acquisitionCost: input.acquisitionCost,
          createdBy: by(),
        },
      });
      await this.event(tx, asset, 'allocated', { serial: device.serial, kind: device.kind });
      await this.audit.record(tx, {
        action: 'haas.registered',
        tenantId: input.tenantId,
        subjectType: 'platform.haas_asset',
        subjectId: asset.id,
        after: { serial: device.serial, termMonths: input.termMonths, monthlyValue: input.monthlyValue },
      });
      return tx.haasAsset.findUniqueOrThrow({ where: { id: asset.id }, include: HAAS_INCLUDE });
    });
  }

  /**
   * State moves of the register: install (date; the term ends after `termMonths`), in service, replace (the new
   * asset row is linked, its device takes over), de-install (with the order that removed it), write off.
   */
  transition(
    id: string,
    to: HaasState,
    input: {
      date?: string | null;
      replacementDeviceId?: string | null;
      installOrderId?: string | null;
      note?: string | null;
    },
  ) {
    return this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM platform.haas_asset WHERE id = ${id}::uuid FOR UPDATE`;
      const a = await tx.haasAsset.findUnique({ where: { id } });
      if (!a) throw new DomainException('http.not_found');
      if (!NEXT[a.state].includes(to))
        throw new DomainException('haas.invalid_transition', { params: { from: a.state, to } });
      const day = input.date ?? bangkokDate(this.clock.now());
      const data: Prisma.HaasAssetUpdateInput = { state: to, updatedBy: by(), version: { increment: 1 } };
      let replacement: HaasAsset | null = null;
      if (to === 'installed') {
        data.installedAt = new Date(`${day}T00:00:00Z`);
        const [y, m, d] = day.split('-').map(Number) as [number, number, number];
        const end = new Date(Date.UTC(y, m - 1 + a.termMonths, d));
        data.termEnd = new Date(`${addCalendarDays(end.toISOString().slice(0, 10), -1)}T00:00:00Z`);
      }
      if (to === 'replaced') {
        if (!input.replacementDeviceId)
          throw new DomainException('validation.failed', {
            errors: [
              { path: 'replacementDeviceId', code: 'required', message: 'the device that replaces it' },
            ],
          });
        const device = await tx.device.findUnique({ where: { id: input.replacementDeviceId } });
        if (!device || device.ownership !== 'platform_haas')
          throw new DomainException('haas.not_platform_owned', { params: { serial: device?.serial ?? '' } });
        replacement = await tx.haasAsset.create({
          data: {
            deviceId: device.id,
            tenantId: a.tenantId,
            buildingId: a.buildingId,
            subscriptionId: a.subscriptionId,
            kind: device.kind,
            installedAt: new Date(`${day}T00:00:00Z`),
            termMonths: a.termMonths,
            termEnd: a.termEnd,
            monthlyValue: a.monthlyValue,
            acquisitionCost: a.acquisitionCost,
            state: 'installed',
            createdBy: by(),
          },
        });
        await this.event(
          tx,
          replacement,
          'installed_as_replacement',
          { replaces: a.id, serial: device.serial },
          input.installOrderId,
        );
        data.replacedBy = { connect: { id: replacement.id } };
      }
      if (to === 'deinstalled' && input.installOrderId)
        data.deinstallOrder = { connect: { id: input.installOrderId } };
      const updated = await tx.haasAsset.update({ where: { id }, data });
      await this.event(
        tx,
        a,
        to,
        { from: a.state, date: day, note: input.note ?? null, replacementAssetId: replacement?.id ?? null },
        input.installOrderId,
      );
      await this.audit.record(tx, {
        action: 'haas.transitioned',
        tenantId: a.tenantId,
        subjectType: 'platform.haas_asset',
        subjectId: id,
        before: { state: a.state },
        after: { state: to, date: day },
      });
      await this.events.record(tx, {
        type: 'haas_asset.changed',
        aggregateType: 'haas_asset',
        aggregateId: id,
        tenantId: a.tenantId,
        buildingId: a.buildingId,
        payload: { haasAssetId: id, from: a.state, to },
      });
      return tx.haasAsset.findUniqueOrThrow({ where: { id: updated.id }, include: HAAS_INCLUDE });
    });
  }
}
