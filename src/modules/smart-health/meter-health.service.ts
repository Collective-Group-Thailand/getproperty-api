import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type MeterHealth } from '@generated/prisma/client';
import { durationMs } from '@modules/smart-ingest/telemetry-maintenance.service';
import { Inject, Injectable, Logger } from '@nestjs/common';

/** `health.stale_after` (D-034): stale per utility, silent for every meter. */
export interface StaleAfter {
  electric: string;
  water: string;
  silent: string;
}

/** ISO 8601 time durations `PT2H`, `PT30M`, `PT24H` → ms. */
export function timeDurationMs(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  return durationMs(iso);
}

/**
 * The health of one meter (D-034): `no_device` without an open channel (Lite meters read monthly by staff are not
 * expected to report), else from the newest of its last telemetry point and last accepted reading — `silent` after
 * `health.stale_after.silent`, `stale` after the utility's threshold, `ok` otherwise (`unknown` before any data).
 */
export function meterHealthOf(input: {
  hasChannel: boolean;
  utility: 'electric' | 'water';
  lastSeenAt: Date | null;
  since: Date;
  now: Date;
  rules: StaleAfter;
}): MeterHealth {
  if (!input.hasChannel) return 'no_device';
  const reference = input.lastSeenAt ?? input.since;
  const age = input.now.getTime() - reference.getTime();
  if (age > timeDurationMs(input.rules.silent)) return 'silent';
  if (age > timeDurationMs(input.rules[input.utility])) return 'stale';
  return input.lastSeenAt ? 'ok' : 'unknown';
}

/**
 * Meter health job (worker, every 5 minutes, D-034): recomputes `smart.meter_status.health` for every active
 * meter assignment of every tenant with the tenant/property `health.stale_after` in force; a change emits
 * `meter.stale`, `meter.silent` (→ owner and staff notifications, and `service.auto_request_requested` for B5) or
 * `meter.recovered`.
 */
@Injectable()
export class MeterHealthService {
  private readonly logger = new Logger(MeterHealthService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<{ checked: number; changed: number }> {
    const now = this.clock.now();
    const meters = await this.db.platform((tx) =>
      tx.meterAssignment.findMany({
        where: { validTo: null, validFrom: { lte: now } },
        include: { building: { select: { propertyId: true } } },
      }),
    );
    let changed = 0;
    const rulesCache = new Map<string, StaleAfter>();
    for (const m of meters) {
      const key = `${m.tenantId}|${m.building.propertyId}`;
      let rules = rulesCache.get(key);
      if (!rules) {
        rules = await this.settings.valueAt<StaleAfter>('health.stale_after', now, {
          tenantId: m.tenantId,
          propertyId: m.building.propertyId,
        });
        rulesCache.set(key, rules);
      }
      changed += await this.db.platform(async (tx) => {
        const channel = await tx.meterChannel.findFirst({
          where: { meterAssetItemId: m.assetItemId, validTo: null },
          select: { validFrom: true },
        });
        const status = await tx.meterStatus.findUnique({ where: { assetItemId: m.assetItemId } });
        const last =
          [status?.lastTelemetryAt, status?.lastReadingAt]
            .filter((d): d is Date => Boolean(d))
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const health = meterHealthOf({
          hasChannel: Boolean(channel),
          utility: m.utility,
          lastSeenAt: last,
          since: channel?.validFrom ?? m.validFrom,
          now,
          rules: rules,
        });
        const previous = status?.health ?? 'unknown';
        if (!status)
          await tx.meterStatus.create({
            data: {
              assetItemId: m.assetItemId,
              tenantId: m.tenantId,
              buildingId: m.buildingId,
              health,
              healthChangedAt: now,
            },
          });
        else if (previous !== health)
          await tx.meterStatus.update({
            where: { assetItemId: m.assetItemId },
            data: { health, healthChangedAt: now },
          });
        if (previous === health) return 0;
        const payload = {
          assetItemId: m.assetItemId,
          meterAssignmentId: m.id,
          unitId: m.unitId,
          code: m.code,
          utility: m.utility,
          from: previous,
          to: health,
          lastSeenAt: last?.toISOString() ?? null,
        };
        const type =
          health === 'stale'
            ? 'meter.stale'
            : health === 'silent'
              ? 'meter.silent'
              : health === 'ok' && (previous === 'stale' || previous === 'silent')
                ? 'meter.recovered'
                : null;
        if (type)
          await this.events.record(tx, {
            type,
            aggregateType: 'asset_item',
            aggregateId: m.assetItemId,
            tenantId: m.tenantId,
            buildingId: m.buildingId,
            payload,
          });
        if (health === 'silent')
          await this.events.record(tx, {
            type: 'service.auto_request_requested',
            aggregateType: 'asset_item',
            aggregateId: m.assetItemId,
            tenantId: m.tenantId,
            buildingId: m.buildingId,
            payload: { ...payload, reason: 'meter_silent', category: 'meter' },
          });
        return 1;
      });
    }
    if (changed) this.logger.log({ event: 'meter_health', checked: meters.length, changed }, 'meter health');
    return { checked: meters.length, changed };
  }
}
