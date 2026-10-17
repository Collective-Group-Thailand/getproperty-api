import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { type DeviceKind, type DeviceOwnership } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { readableCode } from '../identity/crypto/secrets';

/** Provisioning codes are valid for 72 hours (printed on the gateway QR by the field engineer, D-033). */
export const PROVISIONING_CODE_TTL_HOURS = 72;

/**
 * The B1.3 slice of the device registry (D-033; B3.1 completes it): the platform registers a gateway, assigns it
 * to a tenant's building and issues a one-time provisioning code for `POST /v1/device/bootstrap`. Runs as
 * gp_platform (`/v1/admin`); codes are stored as HMACs and shown once.
 */
@Injectable()
export class DeviceRegistryService {
  constructor(
    private readonly db: TenantTx,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  codeHash(code: string) {
    return this.hasher.secret('provisioning', code.trim().toUpperCase());
  }

  async register(input: {
    serial: string;
    kind: DeviceKind;
    model: string;
    vendor: string;
    ownership: DeviceOwnership;
    tenantId?: string | null;
    buildingId?: string | null;
  }) {
    return this.db.platform(async (tx) => {
      if (input.buildingId) {
        const building = await tx.building.findFirst({
          where: { id: input.buildingId, operatorTenantId: input.tenantId ?? undefined, deletedAt: null },
        });
        if (!building || !input.tenantId) throw new DomainException('http.not_found');
      }
      const existing = await tx.device.findUnique({ where: { serial: input.serial } });
      if (existing) throw new DomainException('http.conflict');
      const assigned = Boolean(input.tenantId && input.buildingId);
      const device = await tx.device.create({
        data: {
          serial: input.serial,
          kind: input.kind,
          model: input.model,
          vendor: input.vendor,
          ownership: input.ownership,
          tenantId: input.tenantId ?? null,
          buildingId: input.buildingId ?? null,
          status: assigned ? 'assigned' : 'inventory',
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'device.registered',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: device.id,
        after: { serial: device.serial, kind: device.kind, status: device.status },
      });
      return device;
    });
  }

  /** A fresh code for an assigned gateway; earlier unused codes of the device stop working. */
  async issueProvisioningCode(
    deviceId: string,
  ): Promise<{ code: string; expiresAt: Date; deviceId: string }> {
    const now = this.clock.now();
    const code = readableCode(4);
    const expiresAt = new Date(now.getTime() + PROVISIONING_CODE_TTL_HOURS * 3_600_000);
    await this.db.platform(async (tx) => {
      const device = await tx.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new DomainException('http.not_found');
      if (device.kind !== 'gateway' || !device.tenantId || !device.buildingId || device.status === 'retired')
        throw new DomainException('device.invalid_state');
      await tx.provisioningCode.deleteMany({ where: { deviceId, consumedAt: null } });
      await tx.provisioningCode.create({
        data: {
          deviceId,
          tenantId: device.tenantId,
          buildingId: device.buildingId,
          codeHash: this.codeHash(code),
          expiresAt,
          issuedBy: userIdOf(RequestContext.actor()),
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'device.provisioning_code_issued',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: device.id,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
    });
    return { code, expiresAt, deviceId };
  }
}
