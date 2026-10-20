import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { type ReadingQuality } from '@generated/prisma/client';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { InspectionsService } from './ops-deposits/inspections.service';
import { DeviceCommandsService } from './smart-devices/commands.service';
import { GatewayConfigService } from './smart-devices/gateway-config.service';
import { UtilityLossService } from './smart-health/utility-loss.service';
import { MeterReadingsService } from './smart-readings/meter-readings.service';

/** `reading.candidate` → `smart.meter_reading` (`source = iot`), exactly once per event (D-030, D-143). */
@Injectable()
export class ReadingCandidateSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'reading-candidate';
  readonly eventTypes = ['reading.candidate'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly readings: MeterReadingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload as {
      assetItemId: string;
      deviceId: string;
      seq: string;
      seqStream?: string;
      readAt: string;
      register: string;
      quality: ReadingQuality;
      via: 'mqtt' | 'https_batch';
    };
    await this.readings.promoteIot(tx, p);
  }
}

/**
 * Gateway configuration (B3.1): a changed meter channel recompiles the config of each affected gateway in the
 * subscriber's transaction; a compiled version is published retained after commit (QoS 1, `gp/v1/{id}/config`).
 */
@Injectable()
export class GatewayConfigSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'gateway-config';
  readonly eventTypes = ['meter_channel.changed', 'gateway_config.compiled'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly configs: GatewayConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type !== 'meter_channel.changed') return;
    for (const gatewayId of (event.payload.gatewayDeviceIds as string[] | undefined) ?? [])
      await this.configs.compile(tx, gatewayId);
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    if (event.type === 'gateway_config.compiled')
      await this.configs.publish(event.payload.configId as string);
  }
}

/** `device.command_issued` → publish on `gp/v1/{id}/cmd` after commit (retries by the worker sweep). */
@Injectable()
export class DeviceCommandSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'device-command';
  readonly eventTypes = ['device.command_issued'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly commands: DeviceCommandsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(): Promise<void> {
    // nothing transactional: the command row exists; delivery is after commit
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    await this.commands.send(event.payload.commandId as string);
  }
}

/** A created or corrected utility invoice recomputes the loss report of its period, if one was computed (D-032). */
@Injectable()
export class LossRecomputeSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'loss-recompute';
  readonly eventTypes = ['utility_invoice.changed'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly loss: UtilityLossService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(): Promise<void> {
    // recomputation runs in its own transaction after commit
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    await this.loss.recomputeFor(event.payload.utilityInvoiceId as string);
  }
}

/**
 * Meter registers recorded on a completed move-in / move-out inspection become `manual` readings (`via =
 * inspection`), in the inspection's own transaction (B2.4 hook → B3.3).
 */
@Injectable()
export class InspectionReadingsHook implements OnModuleInit {
  constructor(
    private readonly inspections: InspectionsService,
    private readonly readings: MeterReadingsService,
  ) {}

  onModuleInit(): void {
    this.inspections.onCompleted(async (tx, inspection) => {
      for (const item of inspection.items) {
        if (!item.meterAssetItemId || item.meterRegister === null) continue;
        await this.readings.fromInspection(tx, {
          assetItemId: item.meterAssetItemId,
          register: item.meterRegister.toFixed(3),
          readAt: inspection.completedAt ?? new Date(),
          photoDocumentId: item.photoDocumentIds[0] ?? null,
          inspectionId: inspection.id,
        });
      }
    });
  }
}
