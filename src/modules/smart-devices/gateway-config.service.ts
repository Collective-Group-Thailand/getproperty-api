import { uuidv7 } from '@common/ids/uuidv7';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type GatewayConfig, type Prisma } from '@generated/prisma/client';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { type BusInput, type ChannelInput, compileGatewayConfig, configContentHash } from './config-compiler';

export const configTopic = (gatewayId: string) => `gp/v1/${gatewayId}/config`;

/**
 * GatewayConfig lifecycle (D-131, device protocol §3–§4): compile from the open channels of a gateway (a new version
 * only when the content changed), publish retained on `gp/v1/<gatewayId>/config` (worker subscriber, after commit),
 * record `config_applied` / `config_rejected` from the gateway, and flag drift when the health reports an older
 * version for longer than `health.config_drift_minutes`.
 */
@Injectable()
export class GatewayConfigService {
  private readonly logger = new Logger(GatewayConfigService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Compiles the gateway's config inside `tx`; returns the new version, or the latest when nothing changed. */
  async compile(tx: Tx, gatewayId: string): Promise<{ config: GatewayConfig; created: boolean } | null> {
    const gateway = await tx.device.findUnique({ where: { id: gatewayId } });
    if (!gateway || gateway.kind !== 'gateway' || !gateway.tenantId || !gateway.buildingId) return null;
    const now = this.clock.now();
    const channels = await tx.meterChannel.findMany({
      where: { gatewayDeviceId: gatewayId, validTo: null, meterDeviceId: { not: null } },
      include: {
        meter: { include: { meterAssignments: { where: { validTo: null }, include: { unit: true } } } },
      },
    });
    const inputs: ChannelInput[] = [];
    for (const c of channels) {
      const assignment = c.meter.meterAssignments[0];
      if (!assignment) continue;
      const install = await tx.meterReading.findFirst({
        where: {
          assetItemId: c.meterAssetItemId,
          isInstall: true,
          reviewState: 'accepted',
          supersededByReadingId: null,
        },
        orderBy: { readAt: 'desc' },
      });
      inputs.push({
        meterDeviceId: c.meterDeviceId!,
        roomCode: assignment.unit?.unitNo ?? assignment.code,
        utility: assignment.utility,
        driver: c.driver,
        busId: c.busId,
        busType: c.busType,
        address: c.address,
        pin: c.pin,
        registerMap: c.registerMap,
        customRegisterMap: (c.customRegisterMap as Record<string, unknown> | null) ?? null,
        scale: c.scale.toString(),
        litresPerPulse: c.litresPerPulse?.toString() ?? null,
        initialRegister: install ? install.register.toFixed(3) : null,
      });
    }
    const defaults = await this.settings.valueAt<{ pollIntervalS: number; heartbeatS: number }>(
      'devices.gateway_defaults',
      now,
      { tenantId: gateway.tenantId },
    );
    const latest = await tx.gatewayConfig.findFirst({
      where: { gatewayDeviceId: gatewayId },
      orderBy: { version: 'desc' },
    });
    const doc = compileGatewayConfig({
      version: (latest?.version ?? 0) + 1,
      pollIntervalS: defaults.pollIntervalS,
      heartbeatS: defaults.heartbeatS,
      configuredBuses: Array.isArray(gateway.busConfig) ? (gateway.busConfig as unknown as BusInput[]) : [],
      channels: inputs,
    });
    const hash = configContentHash(doc);
    if (latest && Buffer.from(latest.documentSha256).equals(hash)) return { config: latest, created: false };
    const config = await tx.gatewayConfig.create({
      data: {
        tenantId: gateway.tenantId,
        buildingId: gateway.buildingId,
        gatewayDeviceId: gatewayId,
        version: doc.version,
        document: doc as unknown as Prisma.InputJsonValue,
        documentSha256: new Uint8Array(hash),
        compiledAt: now,
      },
    });
    await this.events.record(tx, {
      type: 'gateway_config.compiled',
      aggregateType: 'device',
      aggregateId: gatewayId,
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      payload: {
        gatewayDeviceId: gatewayId,
        configId: config.id,
        version: config.version,
        meters: doc.meters.length,
      },
    });
    return { config, created: true };
  }

  /** Publishes a compiled version retained on the gateway's config topic and records `published_at`. */
  async publish(configId: string): Promise<void> {
    const config = await this.db.platform((tx) => tx.gatewayConfig.findUnique({ where: { id: configId } }));
    if (!config) return;
    const newer = await this.db.platform((tx) =>
      tx.gatewayConfig.count({
        where: { gatewayDeviceId: config.gatewayDeviceId, version: { gt: config.version } },
      }),
    );
    if (newer > 0) return; // a newer version supersedes this one (retained topic keeps the latest only)
    await this.mqtt.publish(configTopic(config.gatewayDeviceId), JSON.stringify(config.document), {
      qos: 1,
      retain: true,
    });
    await this.db.platform((tx) =>
      tx.gatewayConfig.update({ where: { id: configId }, data: { publishedAt: this.clock.now() } }),
    );
    this.logger.log(
      { event: 'gateway_config_published', gatewayId: config.gatewayDeviceId, version: config.version },
      'gateway config published',
    );
  }

  /** The config the gateway should run (cold start, `GET /v1/device/config`): compiled on demand when none exists. */
  async current(gatewayId: string): Promise<GatewayConfig | null> {
    return this.db.platform(async (tx) => {
      const latest = await tx.gatewayConfig.findFirst({
        where: { gatewayDeviceId: gatewayId },
        orderBy: { version: 'desc' },
      });
      if (latest) return latest;
      const compiled = await this.compile(tx, gatewayId);
      return compiled?.config ?? null;
    });
  }

  /** `config_applied` / `config_rejected` from the gateway (ingest). */
  async onGatewayReport(
    tx: Tx,
    gatewayId: string,
    version: number,
    applied: boolean,
    error: string | null,
  ): Promise<void> {
    const config = await tx.gatewayConfig.findFirst({ where: { gatewayDeviceId: gatewayId, version } });
    if (!config) return;
    const now = this.clock.now();
    if (applied) {
      await tx.gatewayConfig.update({
        where: { id: config.id },
        data: { appliedAt: config.appliedAt ?? now },
      });
      await tx.device.update({ where: { id: gatewayId }, data: { configAppliedVersion: version } });
    } else
      await tx.gatewayConfig.update({
        where: { id: config.id },
        data: { rejectedAt: now, rejectError: (error ?? 'rejected').slice(0, 500) },
      });
    await this.events.record(tx, {
      type: applied ? 'gateway_config.applied' : 'gateway_config.rejected',
      aggregateType: 'device',
      aggregateId: gatewayId,
      tenantId: config.tenantId,
      buildingId: config.buildingId,
      payload: { gatewayDeviceId: gatewayId, version, error: applied ? null : (error ?? null) },
    });
  }

  /**
   * Drift detector (worker, every minute): the latest published config of a gateway whose heartbeat still reports an
   * older version more than `health.config_drift_minutes` after publication → `config_drift` device event (once per
   * version).
   */
  async detectDrift(): Promise<number> {
    const now = this.clock.now();
    const minutes = await this.settings.valueAt<number>('health.config_drift_minutes', now);
    const before = new Date(now.getTime() - minutes * 60_000);
    return this.db.platform(async (tx) => {
      const candidates = await tx.$queryRaw<
        {
          id: string;
          gateway_device_id: string;
          version: number;
          tenant_id: string;
          building_id: string;
          reported: number | null;
        }[]
      >`
        SELECT c.id, c.gateway_device_id, c.version, c.tenant_id, c.building_id, h.config_version AS reported
          FROM smart.gateway_config c
          JOIN smart.device_health_latest h ON h.gateway_device_id = c.gateway_device_id
         WHERE c.published_at IS NOT NULL AND c.published_at < ${before} AND c.drift_flagged_at IS NULL AND c.applied_at IS NULL
           AND c.version = (SELECT max(x.version) FROM smart.gateway_config x WHERE x.gateway_device_id = c.gateway_device_id)
           AND coalesce(h.config_version, 0) < c.version AND h.computed_status <> 'offline'`;
      for (const c of candidates) {
        await tx.gatewayConfig.update({ where: { id: c.id }, data: { driftFlaggedAt: now } });
        const eventId = uuidv7(now.getTime());
        await tx.deviceEvent.create({
          data: {
            eventId,
            tenantId: c.tenant_id,
            buildingId: c.building_id,
            gatewayDeviceId: c.gateway_device_id,
            type: 'config_drift',
            severity: 'warning',
            occurredAt: now,
            receivedAt: now,
            configVersion: String(c.version),
            message: `published v${c.version}, gateway reports v${c.reported ?? 0}`,
            data: { published: c.version, reported: c.reported ?? 0 },
          },
        });
        await this.events.record(tx, {
          type: 'device.event_received',
          aggregateType: 'device',
          aggregateId: c.gateway_device_id,
          tenantId: c.tenant_id,
          buildingId: c.building_id,
          payload: {
            gatewayDeviceId: c.gateway_device_id,
            type: 'config_drift',
            severity: 'warning',
            version: c.version,
          },
        });
      }
      return candidates.length;
    });
  }
}
