import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SessionService } from '@core/identity/session.service';
import { TokenService } from '@core/identity/token.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type DeviceKind,
  type DeviceOwnership,
  type DeviceStatus,
  type OtaRing,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

export const DEVICE_INCLUDE = {
  healthLatest: true,
  assetItem: { select: { id: true, name: true, category: true, unitId: true } },
  channelsAsGateway: { where: { validTo: null }, select: { id: true } },
} as const satisfies Prisma.DeviceInclude;
export type DeviceRow = Prisma.DeviceGetPayload<{ include: typeof DEVICE_INCLUDE }>;

export interface DeviceFilter {
  tenantId?: string;
  buildingId?: string;
  kind?: DeviceKind;
  status?: DeviceStatus;
  q?: string;
  inventoryOnly?: boolean;
  skip: number;
  take: number;
}

export interface ImportRow {
  serial: string;
  kind: DeviceKind;
  model: string;
  vendor: string;
  driver?: string | null;
  ownership?: DeviceOwnership;
  arch?: string | null;
}

export interface ImportResult {
  created: number;
  skipped: { line: number; serial: string; reason: string }[];
  errors: { line: number; message: string }[];
}

const KINDS: DeviceKind[] = [
  'gateway',
  'electric_meter',
  'water_meter',
  'lock',
  'breaker',
  'sensor',
  'door_controller',
  'camera',
];

/** Parses the inventory CSV (`serial,kind,model,vendor[,driver,ownership,arch]`, header row required). */
export function parseInventoryCsv(text: string): {
  rows: (ImportRow & { line: number })[];
  errors: ImportResult['errors'];
} {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const errors: ImportResult['errors'] = [];
  const rows: (ImportRow & { line: number })[] = [];
  const col = (name: string) => header.indexOf(name);
  for (const required of ['serial', 'kind', 'model', 'vendor'])
    if (col(required) < 0) errors.push({ line: 1, message: `missing column ${required}` });
  if (errors.length) return { rows, errors };
  if (lines.length > 5001) return { rows, errors: [{ line: 1, message: 'at most 5,000 rows per file' }] };
  lines.slice(1).forEach((raw, i) => {
    const line = i + 2;
    if (!raw.trim()) return;
    const cells = raw.split(',').map((c) => c.trim());
    const get = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? '') : '');
    const serial = get('serial');
    const kind = get('kind') as DeviceKind;
    const ownership = (get('ownership') || 'platform_haas') as DeviceOwnership;
    const arch = get('arch') || null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(serial))
      errors.push({ line, message: 'serial: 3–64 letters, digits, . _ -' });
    else if (!KINDS.includes(kind)) errors.push({ line, message: `kind: one of ${KINDS.join(', ')}` });
    else if (!get('model') || !get('vendor')) errors.push({ line, message: 'model and vendor are required' });
    else if (!['platform_haas', 'tenant_owned'].includes(ownership))
      errors.push({ line, message: 'ownership: platform_haas | tenant_owned' });
    else if (arch && !['arm64', 'x64', 'armv7'].includes(arch))
      errors.push({ line, message: 'arch: arm64 | x64 | armv7' });
    else if (get('driver') && !/^[a-z][a-z0-9_]{1,63}$/.test(get('driver')))
      errors.push({ line, message: 'driver: snake_case' });
    else
      rows.push({
        line,
        serial,
        kind,
        model: get('model').slice(0, 100),
        vendor: get('vendor').slice(0, 100),
        driver: get('driver') || null,
        ownership,
        arch,
      });
  });
  return { rows, errors };
}

/**
 * The device fleet (D-033, D-161): the platform admin imports inventory, assigns devices to a tenant's building,
 * sets OTA rings, revokes certificates and retires devices (platform transactions, audited); tenants list the devices
 * of their buildings through RLS. Retiring or revoking also revokes the broker ACL rows and the device sessions.
 */
@Injectable()
export class DeviceFleetService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private where(f: DeviceFilter): Prisma.DeviceWhereInput {
    return {
      ...(f.tenantId ? { tenantId: f.tenantId } : {}),
      ...(f.inventoryOnly ? { tenantId: null } : {}),
      ...(f.buildingId ? { buildingId: f.buildingId } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.q ? { serial: { contains: f.q, mode: 'insensitive' as const } } : {}),
    };
  }

  /** Platform fleet list (every tenant and the inventory). */
  list(f: DeviceFilter) {
    return this.db.platform(async (tx) => {
      const where = this.where(f);
      const [rows, total] = [
        await tx.device.findMany({
          where,
          include: DEVICE_INCLUDE,
          orderBy: [{ kind: 'asc' }, { serial: 'asc' }],
          skip: f.skip,
          take: f.take,
        }),
        await tx.device.count({ where }),
      ];
      return { rows, total };
    });
  }

  get(id: string) {
    return this.db.platform(async (tx) =>
      this.found(await tx.device.findUnique({ where: { id }, include: DEVICE_INCLUDE })),
    );
  }

  /** Devices of my tenant (RLS: buildings I own or operate, smart.metering grants; Staff building scope). */
  listForTenant(ctx: TenantContext, f: Omit<DeviceFilter, 'tenantId' | 'inventoryOnly'>) {
    return this.db.tenant(ctx, async (tx) => {
      const scope = this.buildingScope(ctx);
      const where: Prisma.DeviceWhereInput = {
        ...this.where(f),
        ...(scope ? { buildingId: scope } : {}),
      };
      return {
        rows: await tx.device.findMany({
          where,
          include: DEVICE_INCLUDE,
          orderBy: [{ kind: 'asc' }, { serial: 'asc' }],
          skip: f.skip,
          take: f.take,
        }),
        total: await tx.device.count({ where }),
      };
    });
  }

  getForTenant(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const device = this.found(await tx.device.findFirst({ where: { id }, include: DEVICE_INCLUDE }));
      if (ctx.buildingIds && (!device.buildingId || !ctx.buildingIds.includes(device.buildingId)))
        throw new DomainException('http.not_found');
      return device;
    });
  }

  /** Channels, configs and recent events of one gateway of my tenant (owner device page). */
  detailForTenant(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const device = this.found(await tx.device.findFirst({ where: { id }, include: DEVICE_INCLUDE }));
      if (ctx.buildingIds && (!device.buildingId || !ctx.buildingIds.includes(device.buildingId)))
        throw new DomainException('http.not_found');
      const channels = await tx.meterChannel.findMany({
        where: device.kind === 'gateway' ? { gatewayDeviceId: id } : { meterDeviceId: id },
        orderBy: [{ validTo: { sort: 'desc', nulls: 'first' } }, { validFrom: 'desc' }],
        include: { meter: { select: { id: true, name: true, unitId: true } } },
        take: 200,
      });
      const configs =
        device.kind === 'gateway'
          ? await tx.gatewayConfig.findMany({
              where: { gatewayDeviceId: id },
              orderBy: { version: 'desc' },
              take: 5,
            })
          : [];
      const events = await tx.deviceEvent.findMany({
        where: device.kind === 'gateway' ? { gatewayDeviceId: id } : { deviceId: id },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      });
      return { device, channels, configs, events };
    });
  }

  /** Fleet view: device counts per building and status, plus the platform inventory (tenant null) per kind. */
  fleet() {
    return this.db.platform(async (tx) => {
      const byBuilding = await tx.device.groupBy({
        by: ['tenantId', 'buildingId', 'kind', 'status'],
        where: { buildingId: { not: null } },
        _count: { _all: true },
      });
      const inventory = await tx.device.groupBy({
        by: ['kind'],
        where: { tenantId: null },
        _count: { _all: true },
      });
      const buildingIds = [...new Set(byBuilding.map((r) => r.buildingId!))];
      const buildings = await tx.building.findMany({
        where: { id: { in: buildingIds } },
        select: { id: true, name: true, tenant: { select: { id: true, displayName: true } } },
      });
      return { byBuilding, inventory, buildings };
    });
  }

  /** CSV import into the platform inventory: new serials are created, known serials skipped (reported). */
  async importInventory(text: string): Promise<ImportResult> {
    const { rows, errors } = parseInventoryCsv(text);
    if (errors.length) return { created: 0, skipped: [], errors };
    return this.db.platform(
      async (tx) => {
        const existing = new Set(
          (
            await tx.device.findMany({
              where: { serial: { in: rows.map((r) => r.serial) } },
              select: { serial: true },
            })
          ).map((d) => d.serial.toLowerCase()),
        );
        const skipped: ImportResult['skipped'] = [];
        const seen = new Set<string>();
        let created = 0;
        for (const r of rows) {
          const key = r.serial.toLowerCase();
          if (existing.has(key) || seen.has(key)) {
            skipped.push({
              line: r.line,
              serial: r.serial,
              reason: existing.has(key) ? 'exists' : 'duplicate in file',
            });
            continue;
          }
          seen.add(key);
          await tx.device.create({
            data: {
              serial: r.serial,
              kind: r.kind,
              model: r.model,
              vendor: r.vendor,
              driver: r.driver ?? null,
              ownership: r.ownership ?? 'platform_haas',
              arch: r.kind === 'gateway' ? (r.arch ?? null) : null,
              status: 'inventory',
              createdBy: userIdOf(RequestContext.actor()),
            },
          });
          created += 1;
        }
        await this.audit.record(tx, {
          action: 'device.imported',
          subjectType: 'smart.device',
          metadata: { created, skipped: skipped.length },
        });
        return { created, skipped, errors: [] };
      },
      { timeout: 60_000 },
    );
  }

  /** Inventory → a tenant's building (`assigned`); an assigned device may move only while not installed. */
  assign(id: string, input: { tenantId: string; buildingId: string; otaRing?: OtaRing }) {
    return this.db.platform(async (tx) => {
      const device = this.found(await tx.device.findUnique({ where: { id } }));
      if (device.status === 'retired' || device.assetItemId)
        throw new DomainException('device.invalid_state');
      if (device.kind === 'gateway' && device.mqttClientId && device.buildingId !== input.buildingId)
        throw new DomainException('device.invalid_state');
      const building = await tx.building.findFirst({
        where: {
          id: input.buildingId,
          deletedAt: null,
          OR: [{ operatorTenantId: input.tenantId }, { ownerTenantId: input.tenantId }],
        },
      });
      if (!building) throw new DomainException('http.not_found');
      const now = this.clock.now();
      const updated = await tx.device.update({
        where: { id },
        data: {
          tenantId: input.tenantId,
          buildingId: input.buildingId,
          ...(input.otaRing ? { otaRing: input.otaRing } : {}),
          ...(device.status === 'inventory' ? { status: 'assigned', statusChangedAt: now } : {}),
          updatedBy: userIdOf(RequestContext.actor()),
          version: { increment: 1 },
        },
        include: DEVICE_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'device.assigned',
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        subjectType: 'smart.device',
        subjectId: id,
        before: { tenantId: device.tenantId, buildingId: device.buildingId, status: device.status },
        after: { tenantId: input.tenantId, buildingId: input.buildingId, status: updated.status },
      });
      await this.events.record(tx, {
        type: 'device.assigned',
        aggregateType: 'device',
        aggregateId: id,
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        payload: { deviceId: id, kind: device.kind, serial: device.serial },
      });
      return updated;
    });
  }

  setRing(id: string, ring: OtaRing) {
    return this.db.platform(async (tx) => {
      const device = this.found(await tx.device.findUnique({ where: { id } }));
      if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
      const updated = await tx.device.update({
        where: { id },
        data: { otaRing: ring, version: { increment: 1 } },
        include: DEVICE_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'device.ring_changed',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: id,
        before: { otaRing: device.otaRing },
        after: { otaRing: ring },
      });
      return updated;
    });
  }

  /**
   * D-239 (O-012 resolved): the gateway may connect over EMQX ws 8083 behind Caddy with its device JWT alone — for a
   * building whose network blocks 8883. Off by default; only a gateway, never a retired one; audited with the reason;
   * the EMQX authn endpoint reads the flag on every WebSocket connect, so switching it off refuses the next one (an
   * open session ends at the latest when its JWT expires and the agent reconnects).
   */
  setMqttTransport(id: string, wsFallback: boolean, reason: string) {
    return this.db.platform(async (tx) => {
      const device = this.found(await tx.device.findUnique({ where: { id } }));
      if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
      if (device.status === 'retired') throw new DomainException('device.invalid_state');
      if (device.mqttWsFallback === wsFallback)
        return tx.device.findUniqueOrThrow({ where: { id }, include: DEVICE_INCLUDE });
      const updated = await tx.device.update({
        where: { id },
        data: { mqttWsFallback: wsFallback, version: { increment: 1 } },
        include: DEVICE_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'device.mqtt_transport_changed',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: id,
        before: { mqttWsFallback: device.mqttWsFallback },
        after: { mqttWsFallback: wsFallback },
        metadata: { reason },
      });
      await this.events.record(tx, {
        type: 'device.mqtt_transport_changed',
        aggregateType: 'device',
        aggregateId: id,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        payload: { deviceId: id, mqttWsFallback: wsFallback },
      });
      return updated;
    });
  }

  /** Revokes the gateway's certificates, broker ACL and sessions: it must bootstrap again with a new code. */
  async revokeCertificates(id: string, reason: string) {
    const families: string[] = [];
    const result = await this.db.platform(async (tx) => {
      const device = this.found(await tx.device.findUnique({ where: { id } }));
      if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
      const now = this.clock.now();
      const revoked = await this.revokeAccess(tx, id, reason, now, families);
      const updated = await tx.device.update({
        where: { id },
        data: {
          ...(['provisioned', 'online', 'degraded', 'offline'].includes(device.status)
            ? { status: 'assigned', statusChangedAt: now }
            : {}),
          certFingerprint: null,
          certNotAfter: null,
          certSerial: null,
          version: { increment: 1 },
        },
        include: DEVICE_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'device.certificate_revoked',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: id,
        metadata: { reason, certificates: revoked },
      });
      await this.events.record(tx, {
        type: 'device.certificate_revoked',
        aggregateType: 'device',
        aggregateId: id,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        payload: { deviceId: id, certificates: revoked },
      });
      return updated;
    });
    for (const f of families) await this.tokens.markFamilyRevoked(f);
    return result;
  }

  /** Retires a device for good (certificates, ACL, sessions revoked); an installed device must be unbound first. */
  async retire(id: string, reason: string) {
    const families: string[] = [];
    const result = await this.db.platform(async (tx) => {
      const device = this.found(await tx.device.findUnique({ where: { id } }));
      if (device.status === 'retired') throw new DomainException('device.invalid_state');
      const open = await tx.meterChannel.count({
        where: { validTo: null, OR: [{ gatewayDeviceId: id }, { meterDeviceId: id }] },
      });
      if (open > 0 || device.assetItemId) throw new DomainException('device.in_use');
      const now = this.clock.now();
      await this.revokeAccess(tx, id, `retired: ${reason}`, now, families);
      const updated = await tx.device.update({
        where: { id },
        data: {
          status: 'retired',
          statusChangedAt: now,
          retiredAt: now,
          retiredReason: reason,
          version: { increment: 1 },
        },
        include: DEVICE_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'device.retired',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: id,
        metadata: { reason },
      });
      await this.events.record(tx, {
        type: 'device.retired',
        aggregateType: 'device',
        aggregateId: id,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        payload: { deviceId: id, reason },
      });
      return updated;
    });
    for (const f of families) await this.tokens.markFamilyRevoked(f);
    return result;
  }

  private async revokeAccess(tx: Tx, id: string, reason: string, now: Date, families: string[]) {
    const certs = await tx.deviceCertificate.updateMany({
      where: { deviceId: id, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason.slice(0, 200) },
    });
    await tx.mqttAcl.updateMany({ where: { deviceId: id, revokedAt: null }, data: { revokedAt: now } });
    const sessions = await tx.authSession.findMany({
      where: { deviceId: id, revokedAt: null },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    for (const s of sessions) {
      await this.sessions.revokeFamily(tx, s.familyId, 'admin');
      families.push(s.familyId);
    }
    return certs.count;
  }
}
