import { createHash } from 'node:crypto';

import { InvalidationBus } from '@common/cache/invalidation-bus';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../events/domain-events';

interface Snapshot {
  at: number;
  flags: { id: string; key: string; defaultEnabled: boolean; rolloutPct: number }[];
  overrides: Map<string, Map<string, boolean>>;
}

const TTL_MS = 60_000;
export const FLAGS_TOPIC = 'feature_flags';

/**
 * Feature flags: a tenant override wins; otherwise the flag is on for `rollout_pct` % of tenants (stable hash of
 * tenant id + key) or for everyone when `default_enabled`. Cached for a minute and invalidated on change.
 */
@Injectable()
export class FeatureFlagsService implements OnModuleInit {
  private snapshot: Snapshot | undefined;

  constructor(
    private readonly db: TenantTx,
    private readonly bus: InvalidationBus,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  list() {
    return this.db.platform((tx) =>
      tx.featureFlag.findMany({
        include: { overrides: { orderBy: { createdAt: 'asc' } } },
        orderBy: { key: 'asc' },
      }),
    );
  }

  /**
   * Platform admin changes a flag default / rollout, or sets (`enabled` boolean) / clears (`null`) a tenant override.
   * Audited and evented; caches drop through the outbox (`feature_flag.changed` → cache-invalidation subscriber).
   */
  async change(
    key: string,
    input: {
      defaultEnabled?: boolean;
      rolloutPct?: number;
      tenantId?: string;
      enabled?: boolean | null;
      reason: string;
    },
  ) {
    const actor = userIdOf(RequestContext.actor());
    return this.db.platform(async (tx) => {
      const flag = await tx.featureFlag.findUnique({ where: { key }, include: { overrides: true } });
      if (!flag) throw new DomainException('http.not_found');
      const before = {
        defaultEnabled: flag.defaultEnabled,
        rolloutPct: flag.rolloutPct,
        overrides: flag.overrides.length,
      };
      if (input.defaultEnabled !== undefined || input.rolloutPct !== undefined)
        await tx.featureFlag.update({
          where: { id: flag.id },
          data: { defaultEnabled: input.defaultEnabled, rolloutPct: input.rolloutPct, updatedBy: actor },
        });
      if (input.tenantId) {
        const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, deletedAt: null } });
        if (!tenant) throw new DomainException('http.not_found');
        if (input.enabled === null)
          await tx.featureFlagOverride.deleteMany({
            where: { featureFlagId: flag.id, tenantId: input.tenantId },
          });
        else if (input.enabled !== undefined)
          await tx.featureFlagOverride.upsert({
            where: { featureFlagId_tenantId: { featureFlagId: flag.id, tenantId: input.tenantId } },
            create: {
              featureFlagId: flag.id,
              tenantId: input.tenantId,
              enabled: input.enabled,
              reason: input.reason,
              createdBy: actor,
              updatedBy: actor,
            },
            update: { enabled: input.enabled, reason: input.reason, updatedBy: actor },
          });
      }
      const after = await tx.featureFlag.findUniqueOrThrow({
        where: { id: flag.id },
        include: { overrides: { orderBy: { createdAt: 'asc' } } },
      });
      await this.audit.record(tx, {
        action: 'feature_flag.changed',
        tenantId: input.tenantId ?? null,
        subjectType: 'platform.feature_flag',
        subjectId: flag.id,
        before,
        after: {
          defaultEnabled: after.defaultEnabled,
          rolloutPct: after.rolloutPct,
          tenantId: input.tenantId ?? null,
          enabled: input.enabled ?? null,
        },
        metadata: { reason: input.reason },
      });
      await this.events.record(tx, {
        type: 'feature_flag.changed',
        aggregateType: 'platform.feature_flag',
        aggregateId: flag.id,
        tenantId: input.tenantId ?? null,
        payload: { key, tenantId: input.tenantId ?? null },
      });
      return after;
    });
  }

  onModuleInit(): void {
    this.bus.on(FLAGS_TOPIC, () => (this.snapshot = undefined));
  }

  private async load(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.at < TTL_MS) return this.snapshot;
    const [flags, overrides] = await this.db.platform(async (tx) => [
      await tx.featureFlag.findMany({
        select: { id: true, key: true, defaultEnabled: true, rolloutPct: true },
      }),
      await tx.featureFlagOverride.findMany({
        select: { featureFlagId: true, tenantId: true, enabled: true },
      }),
    ]);
    const byTenant = new Map<string, Map<string, boolean>>();
    for (const o of overrides) {
      const m = byTenant.get(o.tenantId) ?? new Map<string, boolean>();
      m.set(o.featureFlagId, o.enabled);
      byTenant.set(o.tenantId, m);
    }
    this.snapshot = { at: Date.now(), flags, overrides: byTenant };
    return this.snapshot;
  }

  async forTenant(tenantId: string | null): Promise<Record<string, boolean>> {
    const s = await this.load();
    return Object.fromEntries(
      s.flags.map((f) => {
        const override = tenantId ? s.overrides.get(tenantId)?.get(f.id) : undefined;
        if (override !== undefined) return [f.key, override];
        if (f.defaultEnabled) return [f.key, true];
        if (!tenantId || f.rolloutPct <= 0) return [f.key, false];
        const bucket = createHash('sha256').update(`${tenantId}|${f.key}`).digest().readUInt16BE(0) % 100;
        return [f.key, bucket < f.rolloutPct];
      }),
    );
  }

  async isEnabled(key: string, tenantId: string | null): Promise<boolean> {
    return (await this.forTenant(tenantId))[key] === true;
  }

  async invalidate(): Promise<void> {
    this.snapshot = undefined;
    await this.bus.publish(FLAGS_TOPIC, '*');
  }
}
