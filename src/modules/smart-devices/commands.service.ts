import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type CommandType, type DeviceCommand, type Prisma } from '@generated/prisma/client';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { type CommandAck } from '@modules/ingest/protocol/command.dto';
import { CommandAckStatus } from '@modules/ingest/protocol/enums';
import { Inject, Injectable, Logger } from '@nestjs/common';

export const cmdTopic = (gatewayId: string) => `gp/v1/${gatewayId}/cmd`;

/** Command types an operator may send (D-131); `ota_apply` is the platform's (rollouts) and there is no cut-off (D-024). */
export const OPERATOR_COMMANDS: CommandType[] = ['read_now', 'restart', 'identify', 'upload_logs'];
export const ADMIN_COMMANDS: CommandType[] = [
  'read_now',
  'restart',
  'identify',
  'upload_logs',
  'set_log_level',
  'ota_apply',
];
export const MAX_ATTEMPTS = 3;
/** An unacknowledged command is re-sent after this long (protocol §4: up to 3 times). */
export const RESEND_AFTER_MS = 60_000;

/** Validates and normalises command arguments per type (protocol §2). */
export function commandArgs(
  type: CommandType,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const a = args ?? {};
  const bad = (message: string) =>
    new DomainException('validation.failed', { errors: [{ path: 'args', code: 'args', message }] });
  switch (type) {
    case 'read_now': {
      const ids = a.meterIds;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) || ids.length > 400 || !ids.every((x) => typeof x === 'string'))
      )
        throw bad('meterIds: up to 400 meter ids');
      return ids ? { meterIds: ids } : {};
    }
    case 'identify': {
      const seconds = a.seconds ?? 30;
      if (typeof seconds !== 'number' || seconds < 1 || seconds > 600) throw bad('seconds: 1–600');
      return { seconds };
    }
    case 'upload_logs': {
      const hours = a.hours ?? 24;
      if (typeof hours !== 'number' || hours < 1 || hours > 168) throw bad('hours: 1–168');
      return { hours };
    }
    case 'set_log_level': {
      if (!['error', 'warn', 'info', 'debug'].includes(String(a.level)))
        throw bad('level: error | warn | info | debug');
      return { level: a.level };
    }
    case 'ota_apply': {
      if (typeof a.manifestUrl !== 'string' || !/^https?:\/\//.test(a.manifestUrl))
        throw bad('manifestUrl: URL');
      return { manifestUrl: a.manifestUrl };
    }
    case 'restart':
      return {};
  }
}

/**
 * Gateway commands (device protocol §2, §4; D-131): issued by operators (read_now, restart, identify, upload_logs) or
 * the platform (also set_log_level, ota_apply), recorded in `smart.device_command`, published on
 * `gp/v1/<gatewayId>/cmd` by the worker (subscriber of `device.command_issued`), acknowledged on `…/cmd/ack`
 * (`accepted` then `done`/`failed`), re-sent up to 3 times while unacknowledged and expired after `ttlS`.
 */
@Injectable()
export class DeviceCommandsService extends TenantScopedRepository {
  private readonly logger = new Logger(DeviceCommandsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Operator command on a gateway of my tenant (RLS + Staff building scope). */
  issueForTenant(ctx: TenantContext, gatewayId: string, type: CommandType, args?: Record<string, unknown>) {
    if (!OPERATOR_COMMANDS.includes(type)) throw new DomainException('command.not_allowed');
    return this.db.tenant(ctx, async (tx) => {
      const gateway = this.found(await tx.device.findFirst({ where: { id: gatewayId } }));
      if (ctx.buildingIds && (!gateway.buildingId || !ctx.buildingIds.includes(gateway.buildingId)))
        throw new DomainException('http.not_found');
      if (gateway.kind !== 'gateway') throw new DomainException('device.not_gateway');
      if (gateway.status === 'retired' || !gateway.mqttClientId)
        throw new DomainException('device.invalid_state');
      return this.create(tx, gateway, type, commandArgs(type, args));
    });
  }

  /** Platform command (fleet view, OTA rollouts). */
  issueAsPlatform(gatewayId: string, type: CommandType, args?: Record<string, unknown>, tx?: Tx) {
    if (!ADMIN_COMMANDS.includes(type)) throw new DomainException('command.not_allowed');
    const run = async (t: Tx) => {
      const gateway = this.found(await t.device.findUnique({ where: { id: gatewayId } }));
      if (gateway.kind !== 'gateway') throw new DomainException('device.not_gateway');
      if (gateway.status === 'retired' || !gateway.mqttClientId)
        throw new DomainException('device.invalid_state');
      return this.create(t, gateway, type, commandArgs(type, args));
    };
    return tx ? run(tx) : this.db.platform(run);
  }

  private async create(
    tx: Tx,
    gateway: { id: string; tenantId: string | null; buildingId: string | null },
    type: CommandType,
    args: Record<string, unknown>,
  ): Promise<DeviceCommand> {
    const now = this.clock.now();
    const ttlS = type === 'ota_apply' ? 3600 : 300;
    const command = await tx.deviceCommand.create({
      data: {
        id: uuidv7(now.getTime()),
        tenantId: gateway.tenantId,
        buildingId: gateway.buildingId,
        gatewayDeviceId: gateway.id,
        type,
        args: args as Prisma.InputJsonValue,
        issuedAt: now,
        ttlS,
        expiresAt: new Date(now.getTime() + ttlS * 1000),
        issuedBy: userIdOf(RequestContext.actor()),
      },
    });
    await this.audit.record(tx, {
      action: 'device.command_issued',
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      subjectType: 'smart.device_command',
      subjectId: command.id,
      metadata: { gatewayDeviceId: gateway.id, type },
    });
    await this.events.record(tx, {
      type: 'device.command_issued',
      aggregateType: 'device',
      aggregateId: gateway.id,
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      payload: { commandId: command.id, gatewayDeviceId: gateway.id, type },
    });
    return command;
  }

  list(ctx: TenantContext | null, gatewayId: string, take = 50) {
    const run = (tx: Tx) =>
      tx.deviceCommand.findMany({
        where: { gatewayDeviceId: gatewayId },
        orderBy: { issuedAt: 'desc' },
        take,
      });
    return ctx ? this.db.tenant(ctx, run) : this.db.platform(run);
  }

  /** Publishes a queued or unacknowledged command (worker) and counts the attempt. */
  async send(commandId: string): Promise<boolean> {
    const now = this.clock.now();
    const command = await this.db.platform((tx) => tx.deviceCommand.findUnique({ where: { id: commandId } }));
    if (!command || !['queued', 'sent'].includes(command.status)) return false;
    if (command.expiresAt.getTime() <= now.getTime() || command.attempts >= MAX_ATTEMPTS) return false;
    const payload = {
      cmdId: command.id,
      type: command.type,
      args: command.args,
      issuedAt: command.issuedAt.toISOString(),
      ttlS: command.ttlS,
    };
    await this.mqtt.publish(cmdTopic(command.gatewayDeviceId), JSON.stringify(payload), { qos: 1 });
    await this.db.platform((tx) =>
      tx.deviceCommand.update({
        where: { id: command.id },
        data: { status: 'sent', sentAt: now, attempts: { increment: 1 } },
      }),
    );
    return true;
  }

  /** `cmd/ack` from the gateway (ingest): only the addressed gateway may acknowledge its command. */
  async ack(tx: Tx, gatewayId: string, ack: CommandAck): Promise<DeviceCommand | null> {
    const command = await tx.deviceCommand.findUnique({ where: { id: ack.cmdId } });
    if (!command || command.gatewayDeviceId !== gatewayId) return null;
    if (['done', 'failed', 'expired'].includes(command.status)) return command;
    const now = this.clock.now();
    const finished = ack.status === CommandAckStatus.Done || ack.status === CommandAckStatus.Failed;
    const updated = await tx.deviceCommand.update({
      where: { id: command.id },
      data: {
        status: ack.status,
        ackedAt: command.ackedAt ?? now,
        ...(finished
          ? {
              finishedAt: ack.finishedAt ? new Date(ack.finishedAt) : now,
              result: (ack.result ?? {}) as Prisma.InputJsonValue,
              error: ack.error?.slice(0, 500) ?? null,
            }
          : {}),
      },
    });
    if (finished)
      await this.events.record(tx, {
        type: 'device.command_finished',
        aggregateType: 'device',
        aggregateId: gatewayId,
        tenantId: command.tenantId,
        buildingId: command.buildingId,
        payload: {
          commandId: command.id,
          gatewayDeviceId: gatewayId,
          type: command.type,
          status: ack.status,
        },
      });
    return updated;
  }

  /** Worker sweep: re-send unacknowledged commands (≤ 3 attempts), expire the rest. */
  async sweep(): Promise<{ resent: number; expired: number }> {
    const now = this.clock.now();
    const due = await this.db.platform((tx) =>
      tx.deviceCommand.findMany({
        where: { status: { in: ['queued', 'sent', 'accepted'] } },
        orderBy: { issuedAt: 'asc' },
        take: 500,
      }),
    );
    let resent = 0;
    let expired = 0;
    for (const c of due) {
      const tooOld = c.expiresAt.getTime() <= now.getTime();
      const exhausted =
        c.status !== 'accepted' &&
        c.attempts >= MAX_ATTEMPTS &&
        (c.sentAt?.getTime() ?? 0) + RESEND_AFTER_MS <= now.getTime();
      if (tooOld || exhausted) {
        await this.db.platform(async (tx) => {
          await tx.deviceCommand.update({
            where: { id: c.id },
            data: { status: 'expired', error: tooOld ? 'expired' : 'no acknowledgement after 3 attempts' },
          });
          await this.events.record(tx, {
            type: 'device.command_finished',
            aggregateType: 'device',
            aggregateId: c.gatewayDeviceId,
            tenantId: c.tenantId,
            buildingId: c.buildingId,
            payload: { commandId: c.id, gatewayDeviceId: c.gatewayDeviceId, type: c.type, status: 'expired' },
          });
        });
        expired += 1;
      } else if (
        c.status === 'queued' ||
        (c.status === 'sent' && (c.sentAt?.getTime() ?? 0) + RESEND_AFTER_MS <= now.getTime())
      ) {
        if (await this.send(c.id)) resent += 1;
      }
    }
    if (resent || expired) this.logger.log({ event: 'command_sweep', resent, expired }, 'command sweep');
    return { resent, expired };
  }
}
