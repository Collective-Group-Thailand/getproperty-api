import { RequestContext } from '@common/context/request-context';
import { sameDigest } from '@common/crypto/hashing';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { AuthService, type TokenPair } from '../identity/auth.service';
import { SessionService } from '../identity/session.service';
import { TokenService } from '../identity/token.service';
import { DeviceCaService } from './device-ca.service';
import { DeviceRegistryService } from './device-registry.service';

export interface MqttAclEntry {
  action: 'publish' | 'subscribe';
  topic: string;
}

/** Device protocol §1: publish only to gp/v1/<id>/+ (and the two-level cmd/ack), subscribe only to config and cmd. */
export function gatewayAcl(deviceId: string): MqttAclEntry[] {
  const base = `gp/v1/${deviceId}`;
  return [
    { action: 'publish', topic: `${base}/+` },
    { action: 'publish', topic: `${base}/cmd/ack` },
    { action: 'subscribe', topic: `${base}/config` },
    { action: 'subscribe', topic: `${base}/cmd` },
  ];
}

export interface BootstrapResult extends TokenPair {
  deviceId: string;
  caChainPem: string;
  tenantId: string;
  buildingId: string;
  certificatePem: string;
  caCertificatePem: string;
  certificateSerial: string;
  certificateNotAfter: Date;
  mqtt: { url: string; wsUrl: string; clientId: string; username: string; acl: MqttAclEntry[] };
}

/**
 * `POST /v1/device/bootstrap` (contract §7, D-130): one-time provisioning code + CSR → certificate signed by the
 * platform CA, the EMQX ACL rows of the gateway (`smart.mqtt_acl`), and a device session (JWT `aud=device` + refresh
 * token). One platform transaction: the code is consumed, earlier certificates/ACL rows/sessions of the device are
 * revoked (re-bootstrap after a reset), the device becomes `provisioned`; audit + `device.bootstrapped` event.
 */
@Injectable()
export class DeviceBootstrapService {
  constructor(
    private readonly db: TenantTx,
    private readonly ca: DeviceCaService,
    private readonly registry: DeviceRegistryService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async bootstrap(input: {
    /** Optional (CR-001): the single-use code identifies the gateway; when given it must match. */
    serial?: string;
    provisioningCode: string;
    csrPem: string;
    agentVersion?: string;
    hardware?: { arch?: string; hostname?: string; serial?: string };
  }): Promise<BootstrapResult> {
    const now = this.clock.now();
    const hash = this.registry.codeHash(input.provisioningCode);
    const revokedFamilies: string[] = [];
    const result = await this.db.platform(async (tx) => {
      const code = await tx.provisioningCode.findUnique({ where: { codeHash: hash } });
      const device = code ? await tx.device.findUnique({ where: { id: code.deviceId } }) : null;
      if (device && input.serial && device.serial.toLowerCase() !== input.serial.trim().toLowerCase())
        return { invalid: true as const, deviceId: device.id };
      if (
        !device ||
        !code ||
        !sameDigest(code.codeHash, hash) ||
        code.consumedAt ||
        code.expiresAt.getTime() <= now.getTime() ||
        device.status === 'retired' ||
        !device.tenantId ||
        !device.buildingId
      )
        return { invalid: true as const, deviceId: device?.id ?? null };

      const consumed = await tx.provisioningCode.updateMany({
        where: { id: code.id, consumedAt: null },
        data: { consumedAt: now, consumedFromIp: RequestContext.current()?.ip ?? null },
      });
      if (consumed.count !== 1) return { invalid: true as const, deviceId: device.id };

      const cert = await this.ca.sign(input.csrPem, device.id, now);
      await tx.deviceCertificate.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'superseded by a new bootstrap' },
      });
      await tx.deviceCertificate.create({
        data: {
          deviceId: device.id,
          serialNumber: cert.serialNumber,
          fingerprintSha256: new Uint8Array(cert.fingerprintSha256),
          subjectCn: cert.subjectCn,
          notBefore: cert.notBefore,
          notAfter: cert.notAfter,
          issuedAt: now,
          csrSha256: new Uint8Array(cert.csrSha256),
          certificatePem: cert.certificatePem,
        },
      });
      const clientId = `gw-${device.id}`;
      await tx.device.update({
        where: { id: device.id },
        data: {
          status: 'provisioned',
          statusChangedAt: now,
          certFingerprint: new Uint8Array(cert.fingerprintSha256),
          certNotAfter: cert.notAfter,
          certSerial: cert.serialNumber,
          mqttClientId: clientId,
          ...(input.agentVersion ? { firmwareVersion: input.agentVersion } : {}),
          // the OTA rollouts target gateways by architecture (B3.1)
          ...(input.hardware?.arch && ['arm64', 'x64', 'armv7'].includes(input.hardware.arch)
            ? { arch: input.hardware.arch }
            : {}),
          version: { increment: 1 },
        },
      });
      await tx.mqttAcl.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: now },
      });
      const acl = gatewayAcl(device.id);
      await tx.mqttAcl.createMany({
        data: acl.map((a) => ({
          deviceId: device.id,
          tenantId: device.tenantId!,
          username: clientId,
          action: a.action,
          topic: a.topic,
          createdAt: now,
        })),
      });
      const previous = await tx.authSession.findMany({
        where: { deviceId: device.id, revokedAt: null },
        distinct: ['familyId'],
        select: { familyId: true },
      });
      for (const p of previous) {
        await this.sessions.revokeFamily(tx, p.familyId, 'admin');
        revokedFamilies.push(p.familyId);
      }
      const pair = await this.auth.issueDevice(tx, {
        id: device.id,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
      });
      await this.events.record(tx, {
        type: 'device.bootstrapped',
        aggregateType: 'device',
        aggregateId: device.id,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        payload: {
          deviceId: device.id,
          certificateSerial: cert.serialNumber,
          notAfter: cert.notAfter.toISOString(),
          agentVersion: input.agentVersion ?? null,
          arch: input.hardware?.arch ?? null,
        },
      });
      return {
        invalid: false as const,
        value: {
          ...pair,
          deviceId: device.id,
          tenantId: device.tenantId,
          buildingId: device.buildingId,
          caChainPem: this.ca.caChainPem,
          certificatePem: cert.certificatePem,
          caCertificatePem: this.ca.caCertificatePem,
          certificateSerial: cert.serialNumber,
          certificateNotAfter: cert.notAfter,
          mqtt: {
            url: this.config.get('MQTT_PUBLIC_URL'),
            wsUrl: this.config.get('MQTT_PUBLIC_WS_URL'),
            clientId,
            username: clientId,
            acl,
          },
        } satisfies BootstrapResult,
      };
    });
    for (const f of revokedFamilies) await this.tokens.markFamilyRevoked(f);
    if (result.invalid) {
      await this.audit.recordAlone({
        action: 'auth.device_bootstrapped',
        outcome: 'denied',
        subjectType: 'smart.device',
        subjectId: result.deviceId,
        metadata: { reason: 'provisioning_code_invalid' },
      });
      throw new DomainException('device.provisioning_code_invalid');
    }
    return result.value;
  }
}
