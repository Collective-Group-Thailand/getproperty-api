import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { type CutoffSetting, periodOf } from './cutoff';

export interface RoundItem {
  assetItemId: string;
  meterAssignmentId: string;
  code: string;
  utility: 'electric' | 'water';
  purpose: 'unit' | 'common_area' | 'main';
  unitId: string | null;
  unitNo: string | null;
  floorId: string | null;
  iot: boolean;
  health: string | null;
  lastReading: {
    id: string;
    register: string;
    readAt: Date;
    source: string;
    photoDocumentId: string | null;
  } | null;
}

export interface RoundBuilding {
  buildingId: string;
  buildingName: string;
  periodKey: string;
  cutoffAt: Date;
  windowStart: Date;
  batchId: string | null;
  floors: { floorId: string | null; floorName: string | null; level: number | null; items: RoundItem[] }[];
  remaining: number;
  /** Meters in the round (read manually: no channel, or IoT not healthy) — web contract request, D-203. */
  total: number;
  /** Of those, read in the window (accepted or pending review), by anyone. */
  read: number;
}

/**
 * The staff PWA's main screen for Lite buildings (D-031, D-035): per building, the meters with an active assignment
 * that still need a reading before the billing cut-off — manual meters (no open channel) and IoT meters whose health
 * is stale / silent / no_device — without an accepted or pending reading in the last `readings.round_window_days`
 * days before the cut-off; grouped by floor, with the last reading and its photo. The round itself is the
 * `smart.reading_batch` of kind `staff_round` for the period (created by the first submission).
 */
@Injectable()
export class ReadingRoundsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  current(ctx: TenantContext, buildingId?: string): Promise<RoundBuilding[]> {
    const now = this.clock.now();
    return this.db.tenant(ctx, async (tx) => {
      const scope = this.buildingScope(ctx);
      if (buildingId && scope && !scope.in.includes(buildingId)) throw new DomainException('http.not_found');
      const buildings = await tx.building.findMany({
        where: {
          deletedAt: null,
          ...(buildingId ? { id: buildingId } : scope ? { id: scope } : {}),
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
        orderBy: { name: 'asc' },
      });
      if (buildingId && buildings.length === 0) throw new DomainException('http.not_found');
      const out: RoundBuilding[] = [];
      for (const b of buildings) {
        const cutoffSetting = await this.settings.valueAt<CutoffSetting>('billing.cutoff', now, {
          tenantId: ctx.tenantId,
          propertyId: b.propertyId,
        });
        const days = await this.settings.valueAt<number>('readings.round_window_days', now, {
          tenantId: ctx.tenantId,
          propertyId: b.propertyId,
        });
        const period = periodOf(cutoffSetting, now);
        const windowStart = new Date(period.cutoff.getTime() - days * 86_400_000);
        const assignments = await tx.meterAssignment.findMany({
          where: { buildingId: b.id, validTo: null, validFrom: { lte: now } },
          include: {
            unit: { select: { id: true, unitNo: true, floorId: true } },
            assetItem: { select: { floorId: true } },
          },
          orderBy: { code: 'asc' },
        });
        const ids = assignments.map((a) => a.assetItemId);
        const channels = new Set(
          (
            await tx.meterChannel.findMany({
              where: { meterAssetItemId: { in: ids }, validTo: null },
              select: { meterAssetItemId: true },
            })
          ).map((c) => c.meterAssetItemId),
        );
        const statuses = new Map(
          (await tx.meterStatus.findMany({ where: { assetItemId: { in: ids } } })).map((s) => [
            s.assetItemId,
            s.health,
          ]),
        );
        const recent = new Set(
          (
            await tx.meterReading.findMany({
              where: {
                meterAssignmentId: { in: assignments.map((a) => a.id) },
                reviewState: { in: ['accepted', 'pending_review'] },
                supersededByReadingId: null,
                readAt: { gte: windowStart },
              },
              select: { meterAssignmentId: true },
            })
          ).map((r) => r.meterAssignmentId),
        );
        const floors = new Map(
          (await tx.floor.findMany({ where: { buildingId: b.id, deletedAt: null } })).map((f) => [f.id, f]),
        );
        const items: RoundItem[] = [];
        let total = 0;
        let read = 0;
        for (const a of assignments) {
          const iot = channels.has(a.assetItemId);
          const health = statuses.get(a.assetItemId) ?? null;
          const iotHealthy = iot && (health === 'ok' || health === 'unknown' || health === null);
          if (iotHealthy) continue;
          total += 1;
          if (recent.has(a.id)) {
            read += 1;
            continue;
          }
          const last = await tx.meterReading.findFirst({
            where: { meterAssignmentId: a.id, reviewState: 'accepted', supersededByReadingId: null },
            orderBy: { readAt: 'desc' },
          });
          items.push({
            assetItemId: a.assetItemId,
            meterAssignmentId: a.id,
            code: a.code,
            utility: a.utility,
            purpose: a.purpose,
            unitId: a.unitId,
            unitNo: a.unit?.unitNo ?? null,
            floorId: a.unit?.floorId ?? a.assetItem.floorId ?? null,
            iot,
            health,
            lastReading: last
              ? {
                  id: last.id,
                  register: last.register.toFixed(3),
                  readAt: last.readAt,
                  source: last.source,
                  photoDocumentId: last.evidenceDocumentId,
                }
              : null,
          });
        }
        const byFloor = new Map<string | null, RoundItem[]>();
        for (const i of items) byFloor.set(i.floorId, [...(byFloor.get(i.floorId) ?? []), i]);
        const batch = await tx.readingBatch.findFirst({
          where: { buildingId: b.id, kind: 'staff_round', periodKey: period.key },
        });
        out.push({
          buildingId: b.id,
          buildingName: b.name,
          periodKey: period.key,
          cutoffAt: period.cutoff,
          windowStart,
          batchId: batch?.id ?? null,
          remaining: items.length,
          total,
          read,
          floors: [...byFloor.entries()]
            .map(([floorId, list]) => {
              const f = floorId ? floors.get(floorId) : undefined;
              return { floorId, floorName: f?.name ?? null, level: f?.level ?? null, items: list };
            })
            .sort((x, y) => (y.level ?? -999) - (x.level ?? -999)),
        });
      }
      return out;
    });
  }
}
