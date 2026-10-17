import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { validateAs } from '@common/validation/validation';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DeviceRegistryService } from '@core/devices/device-registry.service';
import { DomainEvents } from '@core/events/domain-events';
import { isExclusionViolation, isUniqueViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type AssetItem, type Device, type MeterAssignment, type Prisma } from '@generated/prisma/client';
import { CustomRegisterMap } from '@modules/ingest/protocol/config.dto';
import { MeterReadingsService } from '@modules/smart-readings/meter-readings.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { meterKindOf, operatedBuildingAsPlatform, tenantGateway } from './device-access';

const by = () => userIdOf(RequestContext.actor());

export interface MeterDeviceInput {
  serial: string;
  model: string;
  vendor: string;
  driver: string;
}

export interface WiringInput {
  busId: string;
  busType: 'modbus_rtu' | 'gpio' | 'lorawan' | 'nb_iot' | 'vendor_cloud';
  address?: number | null;
  pin?: number | null;
  scale?: string | null;
  litresPerPulse?: number | null;
  registerMap?: 'driver_default' | 'custom';
  customRegisterMap?: Record<string, unknown> | null;
}

export interface InstallInput {
  gatewayDeviceId: string;
  meterAssetItemId: string;
  meterDevice: MeterDeviceInput;
  wiring: WiringInput;
  installRegister: string;
  photoDocumentId: string;
  installedAt?: string | null;
}

export interface SwapInput {
  meterAssetItemId: string;
  oldFinalRegister: string;
  oldPhotoDocumentId: string;
  newMeter: { serial?: string | null; manufacturer?: string | null; model?: string | null };
  /** A new IoT device on the new meter (else: the new meter reads manually, or keeps the old channel's wiring for `newMeterDevice`). */
  newMeterDevice?: MeterDeviceInput | null;
  wiring?: WiringInput | null;
  newInitialRegister: string;
  newPhotoDocumentId: string;
  reason: string;
  swappedAt?: string | null;
}

const OPEN_DEVICE_STATES = ['inventory', 'assigned'] as const;

/**
 * Field work on meters and gateways (D-033, staff PWA): provisioning a gateway from its QR (one-time code for
 * `POST /v1/device/bootstrap`), installing a meter device on a meter position with the physical register at install
 * (photo required → first reading, `manual`, `is_install`), removing it (unbind, final photo reading) and swapping a
 * meter (closing assignment with its final register, opening the next with its initial register at the same instant,
 * both photos). Platform transactions — meter devices may still sit in the platform inventory (D-152) — with explicit
 * owner/operator checks; every change is audited and emits `meter_channel.changed` for the config compiler.
 */
@Injectable()
export class DeviceInstallsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly registry: DeviceRegistryService,
    private readonly readings: MeterReadingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Staff scans the gateway QR (serial) on site: a fresh provisioning code for the gateway assigned here. */
  async provision(ctx: TenantContext, input: { serial: string; buildingId: string }) {
    const deviceId = await this.db.platform(async (tx) => {
      await operatedBuildingAsPlatform(tx, ctx, input.buildingId);
      const device = await tx.device.findUnique({ where: { serial: input.serial.trim() } });
      if (!device || device.tenantId !== ctx.tenantId || device.buildingId !== input.buildingId)
        throw new DomainException('http.not_found');
      if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
      return device.id;
    });
    return this.registry.issueProvisioningCode(deviceId);
  }

  private async meterPosition(tx: Tx, ctx: TenantContext, assetItemId: string, at: Date) {
    const item = await tx.assetItem.findFirst({
      where: { id: assetItemId, deletedAt: null, category: { in: ['meter_electric', 'meter_water'] } },
    });
    if (!item || item.tenantId !== ctx.tenantId) throw new DomainException('http.not_found');
    await operatedBuildingAsPlatform(tx, ctx, item.buildingId);
    const assignment = await tx.meterAssignment.findFirst({
      where: { assetItemId, validFrom: { lte: at }, validTo: null },
    });
    if (!assignment) throw new DomainException('reading.no_assignment');
    return { item, assignment };
  }

  /** Claims (inventory / assigned, not installed) or registers the meter device for `item`. */
  private async claimMeterDevice(
    tx: Tx,
    ctx: TenantContext,
    item: AssetItem,
    gateway: Device,
    input: MeterDeviceInput,
    now: Date,
  ): Promise<Device> {
    const utility = item.category === 'meter_electric' ? 'electric' : 'water';
    const kind = meterKindOf(utility);
    const existing = await tx.device.findUnique({ where: { serial: input.serial.trim() } });
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.assetItemId ||
        !(OPEN_DEVICE_STATES as readonly string[]).includes(existing.status) ||
        (existing.tenantId && existing.tenantId !== ctx.tenantId)
      )
        throw new DomainException('device.unavailable');
      return tx.device.update({
        where: { id: existing.id },
        data: {
          tenantId: ctx.tenantId,
          buildingId: item.buildingId,
          assetItemId: item.id,
          gatewayDeviceId: gateway.id,
          driver: input.driver,
          status: 'provisioned',
          statusChangedAt: now,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
    }
    return tx.device.create({
      data: {
        serial: input.serial.trim(),
        kind,
        model: input.model,
        vendor: input.vendor,
        driver: input.driver,
        ownership: 'tenant_owned',
        tenantId: ctx.tenantId,
        buildingId: item.buildingId,
        assetItemId: item.id,
        gatewayDeviceId: gateway.id,
        status: 'provisioned',
        statusChangedAt: now,
        createdBy: by(),
      },
    });
  }

  private wiringData(w: WiringInput) {
    if (w.busType === 'modbus_rtu' && !w.address)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'wiring.address', code: 'required', message: 'Modbus meters need an address (1–247)' },
        ],
      });
    if (w.busType === 'gpio' && (w.pin === undefined || w.pin === null || !w.litresPerPulse))
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'wiring.pin', code: 'required', message: 'pulse meters need a pin and litres per pulse' },
        ],
      });
    const custom = w.registerMap === 'custom';
    if (custom !== Boolean(w.customRegisterMap))
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'wiring.customRegisterMap',
            code: 'custom',
            message: 'customRegisterMap is required exactly when registerMap is custom',
          },
        ],
      });
    return {
      busId: w.busId,
      busType: w.busType,
      address: w.busType === 'modbus_rtu' ? (w.address ?? null) : null,
      pin: w.busType === 'gpio' ? (w.pin ?? null) : null,
      scale: w.scale ?? '1',
      litresPerPulse: w.busType === 'gpio' ? String(w.litresPerPulse) : null,
      registerMap: custom ? ('custom' as const) : ('driver_default' as const),
      customRegisterMap: custom ? (w.customRegisterMap as Prisma.InputJsonValue) : undefined,
    };
  }

  private async channelChanged(tx: Tx, item: AssetItem, gatewayIds: string[], change: string) {
    await this.events.record(tx, {
      type: 'meter_channel.changed',
      aggregateType: 'asset_item',
      aggregateId: item.id,
      tenantId: item.tenantId,
      buildingId: item.buildingId,
      payload: { assetItemId: item.id, gatewayDeviceIds: [...new Set(gatewayIds)], change },
    });
  }

  /** A custom register map must be a valid protocol `CustomRegisterMap` (CR-005) before it reaches a config. */
  private async checkCustomMap(w: WiringInput | null | undefined): Promise<void> {
    if (w?.customRegisterMap)
      await validateAs(CustomRegisterMap, w.customRegisterMap, 'wiring.customRegisterMap');
  }

  /** Install a meter device on a meter position: device linked, channel opened, install reading (photo). */
  async install(ctx: TenantContext, input: InstallInput) {
    await this.checkCustomMap(input.wiring);
    const now = this.clock.now();
    const at = input.installedAt ? new Date(input.installedAt) : now;
    if (at.getTime() > now.getTime() + 600_000) throw new DomainException('validation.failed');
    try {
      return await this.db.platform(async (tx) => {
        const { item, assignment } = await this.meterPosition(tx, ctx, input.meterAssetItemId, at);
        const gateway = await tenantGateway(tx, ctx, input.gatewayDeviceId);
        if (gateway.buildingId !== item.buildingId) throw new DomainException('device.unavailable');
        await this.assertPhoto(tx, ctx, input.photoDocumentId);
        const open = await tx.meterChannel.findFirst({ where: { meterAssetItemId: item.id, validTo: null } });
        if (open) throw new DomainException('meter.channel_exists');
        const device = await this.claimMeterDevice(tx, ctx, item, gateway, input.meterDevice, now);
        const channel = await tx.meterChannel.create({
          data: {
            tenantId: item.tenantId,
            buildingId: item.buildingId,
            meterAssetItemId: item.id,
            meterDeviceId: device.id,
            gatewayDeviceId: gateway.id,
            driver: input.meterDevice.driver,
            ...this.wiringData(input.wiring),
            validFrom: at,
            boundBy: by(),
            createdBy: by(),
          },
        });
        await tx.assetItem.update({
          where: { id: item.id },
          data: {
            meta: { ...(item.meta as Record<string, unknown>), reading: 'iot' },
            serial: item.serial ?? input.meterDevice.serial,
            model: item.model ?? input.meterDevice.model,
            manufacturer: item.manufacturer ?? input.meterDevice.vendor,
            updatedBy: by(),
          },
        });
        const reading = await this.readings.insert(tx, {
          assignment,
          register: input.installRegister,
          readAt: at,
          source: 'manual',
          via: 'staff_pwa',
          deviceId: null,
          evidenceDocumentId: input.photoDocumentId,
          isInstall: true,
          confirmed: true,
          note: `install of ${device.serial}`,
        });
        await this.ensureStatus(tx, item);
        await this.audit.record(tx, {
          action: 'device.installed',
          tenantId: item.tenantId,
          buildingId: item.buildingId,
          subjectType: 'smart.device',
          subjectId: device.id,
          after: {
            meterAssetItemId: item.id,
            gatewayDeviceId: gateway.id,
            channelId: channel.id,
            installRegister: new Decimal(input.installRegister).toFixed(3),
          },
        });
        await this.events.record(tx, {
          type: 'device.installed',
          aggregateType: 'device',
          aggregateId: device.id,
          tenantId: item.tenantId,
          buildingId: item.buildingId,
          payload: {
            deviceId: device.id,
            assetItemId: item.id,
            gatewayDeviceId: gateway.id,
            readingId: reading!.id,
          },
        });
        await this.channelChanged(tx, item, [gateway.id], 'opened');
        return { device, channel, reading: reading! };
      });
    } catch (error) {
      if (isExclusionViolation(error) || isUniqueViolation(error))
        throw new DomainException('meter.channel_exists');
      throw error;
    }
  }

  /** Remove the device from a meter position: channel closed with a reason, final photo reading, meter manual again. */
  async unbind(
    ctx: TenantContext,
    input: {
      meterAssetItemId: string;
      register: string;
      photoDocumentId: string;
      reason: string;
      at?: string | null;
    },
  ) {
    const now = this.clock.now();
    const at = input.at ? new Date(input.at) : now;
    return this.db.platform(async (tx) => {
      const { item, assignment } = await this.meterPosition(tx, ctx, input.meterAssetItemId, at);
      await this.assertPhoto(tx, ctx, input.photoDocumentId);
      const channel = await tx.meterChannel.findFirst({
        where: { meterAssetItemId: item.id, validTo: null },
      });
      if (!channel) throw new DomainException('meter.no_channel');
      const reading = await this.readings.insert(tx, {
        assignment,
        register: input.register,
        readAt: at,
        source: 'manual',
        via: 'staff_pwa',
        evidenceDocumentId: input.photoDocumentId,
        confirmed: true,
        note: `device removed: ${input.reason}`,
      });
      await tx.meterChannel.update({
        where: { id: channel.id },
        data: { validTo: at, unboundReason: input.reason, updatedBy: by() },
      });
      if (channel.meterDeviceId)
        await tx.device.update({
          where: { id: channel.meterDeviceId },
          data: {
            assetItemId: null,
            gatewayDeviceId: null,
            status: 'assigned',
            statusChangedAt: now,
            version: { increment: 1 },
          },
        });
      await tx.assetItem.update({
        where: { id: item.id },
        data: { meta: { ...(item.meta as Record<string, unknown>), reading: 'manual' }, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'device.unbound',
        tenantId: item.tenantId,
        buildingId: item.buildingId,
        subjectType: 'smart.device',
        subjectId: channel.meterDeviceId,
        metadata: { meterAssetItemId: item.id, reason: input.reason, readingId: reading!.id },
      });
      if (channel.meterDeviceId)
        await this.events.record(tx, {
          type: 'device.unbound',
          aggregateType: 'device',
          aggregateId: channel.meterDeviceId,
          tenantId: item.tenantId,
          buildingId: item.buildingId,
          payload: { deviceId: channel.meterDeviceId, assetItemId: item.id, reason: input.reason },
        });
      await this.channelChanged(tx, item, [channel.gatewayDeviceId], 'closed');
      return { channelId: channel.id, reading: reading! };
    });
  }

  /**
   * Meter replacement (D-033): the old assignment closes at `swappedAt` with its final register (photo), the old
   * meter asset item is retired, a new meter asset item + assignment open at the same instant with the initial
   * register (photo); the old channel closes and, with a new device (or the old device moved), a new channel opens.
   */
  async swap(ctx: TenantContext, input: SwapInput) {
    await this.checkCustomMap(input.wiring);
    const now = this.clock.now();
    const at = input.swappedAt ? new Date(input.swappedAt) : now;
    if (at.getTime() > now.getTime() + 600_000) throw new DomainException('validation.failed');
    try {
      return await this.db.platform(async (tx) => {
        const { item: oldItem, assignment: oldAssignment } = await this.meterPosition(
          tx,
          ctx,
          input.meterAssetItemId,
          at,
        );
        await this.assertPhoto(tx, ctx, input.oldPhotoDocumentId);
        await this.assertPhoto(tx, ctx, input.newPhotoDocumentId);
        const oldChannel = await tx.meterChannel.findFirst({
          where: { meterAssetItemId: oldItem.id, validTo: null },
        });
        const swapId = uuidv7(now.getTime());

        // 1. close the old position: final reading (monotonic vs the series), channel, device, assignment, item
        const finalReading = await this.readings.insert(tx, {
          assignment: oldAssignment,
          register: input.oldFinalRegister,
          readAt: new Date(at.getTime() - 1),
          source: 'manual',
          via: 'staff_pwa',
          evidenceDocumentId: input.oldPhotoDocumentId,
          isFinal: true,
          confirmed: true,
          note: `swap: ${input.reason}`,
        });
        if (oldChannel)
          await tx.meterChannel.update({
            where: { id: oldChannel.id },
            data: { validTo: at, unboundReason: `swap: ${input.reason}`, updatedBy: by() },
          });
        if (oldChannel?.meterDeviceId)
          await tx.device.update({
            where: { id: oldChannel.meterDeviceId },
            data: {
              assetItemId: null,
              gatewayDeviceId: null,
              status: 'assigned',
              statusChangedAt: now,
              version: { increment: 1 },
            },
          });
        await tx.meterAssignment.update({
          where: { id: oldAssignment.id },
          data: {
            validTo: at,
            finalReading: new Decimal(input.oldFinalRegister).toFixed(3),
            closeReason: 'swap',
            updatedBy: by(),
          },
        });
        await tx.assetItem.update({
          where: { id: oldItem.id },
          data: {
            status: 'retired',
            retiredAt: at,
            retiredReason: `replaced: ${input.reason}`,
            updatedBy: by(),
          },
        });

        // 2. open the new position at the same instant
        const newItem = await tx.assetItem.create({
          data: {
            tenantId: oldItem.tenantId,
            buildingId: oldItem.buildingId,
            floorId: oldItem.floorId,
            unitId: oldItem.unitId,
            category: oldItem.category,
            name: oldItem.name,
            manufacturer: input.newMeter.manufacturer ?? input.newMeterDevice?.vendor ?? null,
            model: input.newMeter.model ?? input.newMeterDevice?.model ?? null,
            serial: input.newMeter.serial ?? input.newMeterDevice?.serial ?? null,
            installDate: at,
            meta: { reading: input.newMeterDevice || oldChannel ? 'iot' : 'manual', replaces: oldItem.id },
            createdBy: by(),
          },
        });
        const newAssignment = await tx.meterAssignment.create({
          data: {
            tenantId: oldAssignment.tenantId,
            buildingId: oldAssignment.buildingId,
            assetItemId: newItem.id,
            unitId: oldAssignment.unitId,
            purpose: oldAssignment.purpose,
            utility: oldAssignment.utility,
            code: oldAssignment.code,
            commonAreaLabel: oldAssignment.commonAreaLabel,
            validFrom: at,
            multiplier: oldAssignment.multiplier,
            initialReading: new Decimal(input.newInitialRegister).toFixed(3),
            rolloverAt: oldAssignment.rolloverAt,
            createdBy: by(),
          },
        });
        await tx.meterSwap.create({
          data: {
            id: swapId,
            tenantId: oldItem.tenantId,
            buildingId: oldItem.buildingId,
            unitId: oldAssignment.unitId,
            oldAssignmentId: oldAssignment.id,
            newAssignmentId: newAssignment.id,
            oldDeviceId: oldChannel?.meterDeviceId ?? null,
            oldLastRegister: new Decimal(input.oldFinalRegister).toFixed(3),
            newFirstRegister: new Decimal(input.newInitialRegister).toFixed(3),
            swappedAt: at,
            performedBy: by(),
            reason: input.reason,
            createdBy: by(),
          },
        });
        const firstReading = await this.readings.insert(tx, {
          assignment: newAssignment,
          register: input.newInitialRegister,
          readAt: at,
          source: 'manual',
          via: 'staff_pwa',
          evidenceDocumentId: input.newPhotoDocumentId,
          isInstall: true,
          confirmed: true,
          swapId,
          note: `swap: ${input.reason}`,
        });
        let newDevice: Device | null = null;
        const gatewayIds: string[] = oldChannel ? [oldChannel.gatewayDeviceId] : [];
        if (input.newMeterDevice && oldChannel) {
          const gateway = await tenantGateway(tx, ctx, oldChannel.gatewayDeviceId);
          newDevice = await this.claimMeterDevice(tx, ctx, newItem, gateway, input.newMeterDevice, now);
          const wiring: WiringInput = input.wiring ?? {
            busId: oldChannel.busId,
            busType: oldChannel.busType,
            address: oldChannel.address,
            pin: oldChannel.pin,
            scale: oldChannel.scale.toString(),
            litresPerPulse: oldChannel.litresPerPulse ? Number(oldChannel.litresPerPulse) : null,
            registerMap: oldChannel.registerMap,
            customRegisterMap: oldChannel.customRegisterMap as Record<string, unknown> | null,
          };
          await tx.meterChannel.create({
            data: {
              tenantId: newItem.tenantId,
              buildingId: newItem.buildingId,
              meterAssetItemId: newItem.id,
              meterDeviceId: newDevice.id,
              gatewayDeviceId: gateway.id,
              driver: input.newMeterDevice.driver,
              ...this.wiringData(wiring),
              validFrom: at,
              boundBy: by(),
              createdBy: by(),
            },
          });
          gatewayIds.push(gateway.id);
        }
        await tx.meterSwap.update({
          where: { id: swapId },
          data: {
            oldLastReadingId: finalReading!.id,
            newFirstReadingId: firstReading!.id,
            newDeviceId: newDevice?.id ?? null,
          },
        });
        await this.ensureStatus(tx, newItem);
        await this.audit.record(tx, {
          action: 'meter.swapped',
          tenantId: oldItem.tenantId,
          buildingId: oldItem.buildingId,
          subjectType: 'smart.meter_swap',
          subjectId: swapId,
          before: {
            assignmentId: oldAssignment.id,
            finalRegister: new Decimal(input.oldFinalRegister).toFixed(3),
          },
          after: {
            assignmentId: newAssignment.id,
            initialRegister: new Decimal(input.newInitialRegister).toFixed(3),
          },
          metadata: { reason: input.reason },
        });
        await this.events.record(tx, {
          type: 'meter.swapped',
          aggregateType: 'meter_assignment',
          aggregateId: newAssignment.id,
          tenantId: oldItem.tenantId,
          buildingId: oldItem.buildingId,
          payload: {
            swapId,
            oldAssignmentId: oldAssignment.id,
            newAssignmentId: newAssignment.id,
            oldAssetItemId: oldItem.id,
            newAssetItemId: newItem.id,
            unitId: oldAssignment.unitId,
          },
        });
        for (const [assignment, change] of [
          [oldAssignment, 'closed'],
          [newAssignment, 'opened'],
        ] as [MeterAssignment, string][])
          await this.events.record(tx, {
            type: 'meter_assignment.changed',
            aggregateType: 'meter_assignment',
            aggregateId: assignment.id,
            tenantId: assignment.tenantId,
            buildingId: assignment.buildingId,
            payload: {
              meterAssignmentId: assignment.id,
              assetItemId: assignment.assetItemId,
              unitId: assignment.unitId,
              utility: assignment.utility,
              purpose: assignment.purpose,
              change,
            },
          });
        if (gatewayIds.length) await this.channelChanged(tx, newItem, gatewayIds, 'swapped');
        return {
          swapId,
          oldAssignmentId: oldAssignment.id,
          newAssignmentId: newAssignment.id,
          newAssetItemId: newItem.id,
          newDeviceId: newDevice?.id ?? null,
          finalReadingId: finalReading!.id,
          firstReadingId: firstReading!.id,
        };
      });
    } catch (error) {
      if (isExclusionViolation(error)) throw new DomainException('meter.already_assigned');
      throw error;
    }
  }

  /** The evidence photo must be a meter photo of this tenant (D-033: every install / swap reading has one). */
  private async assertPhoto(tx: Tx, ctx: TenantContext, documentId: string): Promise<void> {
    const doc = await tx.document.findFirst({
      where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null, kind: 'meter_photo' },
    });
    if (!doc) throw new DomainException('reading.photo_required');
  }

  private async ensureStatus(tx: Tx, item: AssetItem): Promise<void> {
    await tx.meterStatus.upsert({
      where: { assetItemId: item.id },
      create: { assetItemId: item.id, tenantId: item.tenantId, buildingId: item.buildingId },
      update: {},
    });
  }
}
