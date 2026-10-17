import { InvalidationBus } from '@common/cache/invalidation-bus';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { type SettingDef, SETTINGS, type SettingScope } from './catalogue';
import { settingValueProblems } from './setting-values';

export interface SettingValueAt {
  key: string;
  value: unknown;
  scope: SettingScope;
  versionId: string;
  effectiveFrom: Date;
}

interface Version {
  id: string;
  value: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

interface CacheEntry {
  versions: Version[];
  loadedAt: number;
}

/** Local cache lifetime; invalidation by `setting.changed` normally arrives long before. */
const CACHE_TTL_MS = 60_000;
/** ADR-0004: no backdating (the database CHECK allows the same 5 minutes of clock skew). */
const BACKDATE_TOLERANCE_MS = 5 * 60_000;
export const SETTINGS_TOPIC = 'settings';

/**
 * Effective-dated settings (ADR-0004, D-144): `at(key, date, {tenantId, propertyId})` — the most specific scope
 * wins (property → tenant → platform) among the versions in force at `date` (schema-design §4.1). Version lists are
 * cached per key and scope; every write invalidates them locally and, through the outbox (`setting.changed`) and
 * Redis pub/sub, in every process. Writes create a new version (never an update), audited, with the editing
 * permission named by the catalogue (`editableBy`).
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defs = new Map(SETTINGS.map((d) => [d.key, d]));

  constructor(
    private readonly db: TenantTx,
    private readonly bus: InvalidationBus,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on(SETTINGS_TOPIC, (key) => this.invalidate(key));
  }

  definition(key: string): SettingDef {
    const def = this.defs.get(key);
    if (!def) throw new DomainException('settings.unknown_key', { params: { key } });
    return def;
  }

  catalogue(): readonly SettingDef[] {
    return SETTINGS;
  }

  /** Drops every cached version list of `key` (all scopes). */
  invalidate(key: string): void {
    for (const k of [...this.cache.keys()]) if (k.endsWith(`|${key}`)) this.cache.delete(k);
  }

  async at(
    key: string,
    at: Date,
    scope: { tenantId?: string | null; propertyId?: string | null } = {},
  ): Promise<SettingValueAt | null> {
    this.definition(key);
    const t = at.getTime();
    const pick = (versions: Version[]) =>
      versions.find((v) => v.effectiveFrom.getTime() <= t && (!v.effectiveTo || v.effectiveTo.getTime() > t));
    if (scope.propertyId && scope.tenantId) {
      const v = pick(await this.versions('property', key, scope.tenantId, scope.propertyId));
      if (v)
        return { key, value: v.value, scope: 'property', versionId: v.id, effectiveFrom: v.effectiveFrom };
    }
    if (scope.tenantId) {
      const v = pick(await this.versions('tenant', key, scope.tenantId));
      if (v) return { key, value: v.value, scope: 'tenant', versionId: v.id, effectiveFrom: v.effectiveFrom };
    }
    const v = pick(await this.versions('platform', key));
    return v
      ? { key, value: v.value, scope: 'platform', versionId: v.id, effectiveFrom: v.effectiveFrom }
      : null;
  }

  /** `at()` that fails loudly when a catalogue setting has no value (seed missing). */
  async valueAt<T>(
    key: string,
    at: Date,
    scope: { tenantId?: string | null; propertyId?: string | null } = {},
  ) {
    const found = await this.at(key, at, scope);
    if (!found) throw new Error(`setting ${key} has no version in force at ${at.toISOString()}`);
    return found.value as T;
  }

  private async versions(level: SettingScope, key: string, tenantId?: string, propertyId?: string) {
    const cacheKey = `${level}|${tenantId ?? ''}|${propertyId ?? ''}|${key}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.versions;
    const select = { id: true, value: true, effectiveFrom: true, effectiveTo: true } as const;
    const orderBy = { effectiveFrom: 'desc' } as const;
    let versions: Version[];
    if (level === 'platform') {
      versions = await this.db.platform((tx) =>
        tx.settingVersion.findMany({ where: { setting: { key } }, select, orderBy }),
      );
    } else if (level === 'tenant') {
      versions = await this.db.tenant(systemTenantContext(tenantId!), (tx) =>
        tx.tenantSettingVersion.findMany({ where: { tenantId, setting: { key } }, select, orderBy }),
      );
    } else {
      versions = await this.db.tenant(systemTenantContext(tenantId!), (tx) =>
        tx.propertySettingVersion.findMany({
          where: { tenantId, propertyId, setting: { key } },
          select,
          orderBy,
        }),
      );
    }
    this.cache.set(cacheKey, { versions, loadedAt: Date.now() });
    return versions;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Writes

  private checkWrite(def: SettingDef, scope: SettingScope, value: unknown, effectiveFrom: Date): void {
    if (!def.scopeAllowed.includes(scope))
      throw new DomainException('settings.not_editable', { params: { key: def.key, scope } });
    const granted = RequestContext.permissions();
    if (!def.editableBy.some((p) => granted.has(p)))
      throw new DomainException('settings.not_editable', { params: { key: def.key, scope } });
    const problems = settingValueProblems(def, value);
    if (problems.length)
      throw new DomainException('settings.invalid_value', {
        errors: problems.map((message) => ({ path: 'value', code: 'settingValue', message })),
      });
    if (effectiveFrom.getTime() < this.clock.now().getTime() - BACKDATE_TOLERANCE_MS)
      throw new DomainException('settings.backdated');
  }

  /** Platform default (admin, `admin.setting.manage` / `admin.compliance.manage` per catalogue). */
  async setPlatform(key: string, value: unknown, effectiveFrom: Date | undefined, reason: string) {
    const def = this.definition(key);
    const from = effectiveFrom ?? this.clock.now();
    this.checkWrite(def, 'platform', value, from);
    const version = await this.db.platform(async (tx) => {
      const setting = await tx.setting.findUniqueOrThrow({ where: { key } });
      const before = await this.at(key, from);
      const row = await tx.settingVersion.create({
        data: {
          settingId: setting.id,
          value: value as Prisma.InputJsonValue,
          effectiveFrom: from,
          reason,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.afterWrite(tx, def, 'platform', row.id, from, value, before?.value, null, null);
      return row;
    });
    await this.bus.publish(SETTINGS_TOPIC, key);
    return version;
  }

  /** Tenant value (Owner/Manager per catalogue, or the platform admin for admin-only keys via `asPlatform`). */
  async setTenant(
    ctx: TenantContext,
    key: string,
    value: unknown,
    effectiveFrom: Date | undefined,
    reason: string,
    asPlatform = false,
  ) {
    const def = this.definition(key);
    const from = effectiveFrom ?? this.clock.now();
    this.checkWrite(def, 'tenant', value, from);
    const run = asPlatform
      ? this.db.platform.bind(this.db)
      : (w: (tx: Tx) => Promise<unknown>) => this.db.tenant(ctx, w);
    const before = await this.at(key, from, { tenantId: ctx.tenantId });
    const row = (await run(async (tx: Tx) => {
      const setting = await tx.setting.findUniqueOrThrow({ where: { key } });
      const created = await tx.tenantSettingVersion.create({
        data: {
          tenantId: ctx.tenantId,
          settingId: setting.id,
          value: value as Prisma.InputJsonValue,
          effectiveFrom: from,
          reason,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.afterWrite(tx, def, 'tenant', created.id, from, value, before?.value, ctx.tenantId, null);
      return created;
    })) as { id: string; effectiveFrom: Date };
    await this.bus.publish(SETTINGS_TOPIC, key);
    return row;
  }

  /** Property override (D-031 billing cut-off, utility providers, health rules). The property must be the tenant's. */
  async setProperty(
    ctx: TenantContext,
    propertyId: string,
    key: string,
    value: unknown,
    effectiveFrom: Date | undefined,
    reason: string,
  ) {
    const def = this.definition(key);
    const from = effectiveFrom ?? this.clock.now();
    this.checkWrite(def, 'property', value, from);
    const before = await this.at(key, from, { tenantId: ctx.tenantId, propertyId });
    const row = await this.db.tenant(ctx, async (tx) => {
      const property = await tx.property.findFirst({
        where: { id: propertyId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!property) throw new DomainException('http.not_found');
      const setting = await tx.setting.findUniqueOrThrow({ where: { key } });
      const created = await tx.propertySettingVersion.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId,
          settingId: setting.id,
          value: value as Prisma.InputJsonValue,
          effectiveFrom: from,
          reason,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.afterWrite(
        tx,
        def,
        'property',
        created.id,
        from,
        value,
        before?.value,
        ctx.tenantId,
        propertyId,
      );
      return created;
    });
    await this.bus.publish(SETTINGS_TOPIC, key);
    return row;
  }

  private async afterWrite(
    tx: Tx,
    def: SettingDef,
    scope: SettingScope,
    versionId: string,
    effectiveFrom: Date,
    value: unknown,
    previous: unknown,
    tenantId: string | null,
    propertyId: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'setting.changed',
      tenantId,
      subjectType: `platform.${scope === 'platform' ? '' : scope + '_'}setting_version`,
      subjectId: versionId,
      before: { key: def.key, value: (previous ?? null) as Prisma.InputJsonValue },
      after: {
        key: def.key,
        value: value as Prisma.InputJsonValue,
        effectiveFrom: effectiveFrom.toISOString(),
      },
      metadata: { scope, propertyId },
    });
    await this.events.record(tx, {
      type: 'setting.changed',
      aggregateType: 'setting',
      aggregateId: versionId,
      tenantId,
      payload: { key: def.key, scope, propertyId, effectiveFrom: effectiveFrom.toISOString(), versionId },
    });
  }
}
