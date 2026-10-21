import { type TLSSocket } from 'node:tls';

import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { TenantTx } from '@database/tenant-tx';
import { type Device } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Request } from 'express';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SessionService } from '../identity/session.service';
import { SubjectService } from '../identity/subjects.service';
import { TokenService } from '../identity/token.service';
import { DeviceCaService } from './device-ca.service';

/** The client certificate presented on `/v1/device/*`: its SHA-256 fingerprint, and the PEM when available. */
export interface ClientCertificate {
  fingerprint: Buffer;
  pem: string | null;
}

/**
 * Reads the gateway's mTLS client certificate (device protocol §1, CR-002) according to `DEVICE_MTLS_SOURCE`:
 * the TLS socket of this process, the URL-encoded PEM forwarded by a trusted proxy, or the proxy's SHA-256
 * fingerprint header. Returns null when none was presented.
 */
export function clientCertificateOf(
  req: Request,
  source: 'socket' | 'pem_header' | 'sha256_header',
  header: string,
  fingerprintOf: (pem: string) => Buffer,
): ClientCertificate | null {
  if (source === 'socket') {
    const socket = req.socket as TLSSocket;
    if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function' || !socket.authorized)
      return null;
    const peer = socket.getPeerCertificate(false);
    if (!peer?.raw) return null;
    const pem = `-----BEGIN CERTIFICATE-----\n${peer.raw.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    return { fingerprint: fingerprintOf(pem), pem };
  }
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (source === 'pem_header') {
    let pem: string;
    try {
      pem = decodeURIComponent(value);
    } catch {
      return null;
    }
    if (!pem.includes('BEGIN CERTIFICATE')) return null;
    try {
      return { fingerprint: fingerprintOf(pem), pem };
    } catch {
      return null;
    }
  }
  // sha256_header — for proxies that forward only a fingerprint (hex or base64 accepted). On AWS the device ALB forwards
  // the leaf PEM (`pem_header`, D-230).
  const trimmed = value.trim().replace(/^:|:$/g, '');
  const fingerprint = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  return fingerprint.length === 32 ? { fingerprint, pem: null } : null;
}

/** A gateway's MQTT endpoints (device protocol §1). */
export interface MqttEndpoint {
  url: string;
  wsUrl?: string;
}

/**
 * The MQTT endpoints a gateway may use right now (D-239, edge CR-013 / CR-015, D-249): always the mTLS listener;
 * the WebSocket fallback only when the platform publishes one **and** the platform admin enabled it for this very
 * gateway. Shared by the bootstrap answer and every `POST /v1/device/token` answer so both always agree.
 */
export function mqttEndpointOf(
  device: Pick<Device, 'mqttWsFallback'>,
  publicUrl: string,
  publicWsUrl: string | undefined,
): MqttEndpoint {
  const wsUrl = device.mqttWsFallback && publicWsUrl ? publicWsUrl : undefined;
  return wsUrl ? { url: publicUrl, wsUrl } : { url: publicUrl };
}

/**
 * Device identity after bootstrap (CR-002, CR-003): `POST /v1/device/token` mints a short-lived device JWT from the
 * mTLS client certificate alone; `POST /v1/device/certificate/renew` signs a new CSR for the authenticated gateway
 * (the old certificate stays valid until it expires); every bearer call can also be bound to the presented
 * certificate (`assertCertificateOf`). Certificates are looked up by fingerprint in `smart.device_certificate`:
 * revoked, expired or retired → 401 `device.certificate_invalid`.
 */
@Injectable()
export class DeviceIdentityService {
  private readonly logger = new Logger(DeviceIdentityService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly ca: DeviceCaService,
    private readonly sessions: SessionService,
    private readonly subjects: SubjectService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  presented(req: Request): ClientCertificate | null {
    return clientCertificateOf(
      req,
      this.config.get('DEVICE_MTLS_SOURCE'),
      this.config.get('DEVICE_MTLS_HEADER'),
      (pem) => this.ca.fingerprintOf(pem),
    );
  }

  /** The device of a valid (issued here, not revoked, not expired) certificate; 401 otherwise. */
  async deviceOf(cert: ClientCertificate | null): Promise<Device> {
    if (!cert) throw new DomainException('device.certificate_invalid');
    if (cert.pem && !(await this.ca.issued(cert.pem).catch(() => false)))
      throw new DomainException('device.certificate_invalid');
    const now = this.clock.now();
    const row = await this.db.platform((tx) =>
      tx.deviceCertificate.findUnique({
        where: { fingerprintSha256: new Uint8Array(cert.fingerprint) },
        include: { device: true },
      }),
    );
    if (
      !row ||
      row.revokedAt ||
      row.notAfter.getTime() <= now.getTime() ||
      row.notBefore.getTime() > now.getTime() ||
      row.device.status === 'retired' ||
      !row.device.tenantId ||
      !row.device.buildingId
    )
      throw new DomainException('device.certificate_invalid');
    return row.device;
  }

  /** A bearer call that also presents a certificate must present one of the same device. */
  async assertCertificateOf(req: Request, deviceId: string): Promise<void> {
    const cert = this.presented(req);
    if (!cert) return;
    const device = await this.deviceOf(cert);
    if (device.id !== deviceId) throw new DomainException('device.certificate_invalid');
  }

  /** The current MQTT endpoints of a gateway (see `mqttEndpointOf`). */
  mqttEndpoint(device: Pick<Device, 'mqttWsFallback'>): MqttEndpoint {
    return mqttEndpointOf(
      device,
      this.config.get('MQTT_PUBLIC_URL'),
      this.config.get('MQTT_PUBLIC_WS_URL') || undefined,
    );
  }

  /**
   * `POST /v1/device/token`: an access token for the certificate's device, in its current session family, plus the
   * gateway's current MQTT endpoints read from the same device row (edge CR-015, D-249) — so switching the WebSocket
   * fallback on or off reaches an already-provisioned gateway at its next refresh, without a new bootstrap.
   */
  async token(
    req: Request,
  ): Promise<{ accessToken: string; expiresAt: Date; deviceId: string; mqtt: MqttEndpoint }> {
    const device = await this.deviceOf(this.presented(req));
    const subject = this.subjects.device({
      id: device.id,
      tenantId: device.tenantId!,
      buildingId: device.buildingId!,
    });
    const familyId = await this.db.platform(async (tx) => {
      const active = await tx.authSession.findFirst({
        where: { deviceId: device.id, revokedAt: null },
        orderBy: { issuedAt: 'desc' },
        select: { familyId: true },
      });
      if (active) return active.familyId;
      const started = await this.sessions.start(tx, {
        audience: 'device',
        deviceId: device.id,
        scopes: subject.scopes,
      });
      return started.session.familyId;
    });
    const access = this.tokens.issue({
      sub: device.id,
      aud: 'device',
      sid: familyId,
      scopes: subject.scopes,
      amr: ['mtls'],
      tid: device.tenantId!,
      bid: device.buildingId!,
    });
    await this.db.platform((tx) =>
      tx.device.update({ where: { id: device.id }, data: { lastSeenAt: this.clock.now() } }),
    );
    return {
      accessToken: access.token,
      expiresAt: access.expiresAt,
      deviceId: device.id,
      mqtt: this.mqttEndpoint(device),
    };
  }

  /** `POST /v1/device/certificate/renew`: a new certificate for the calling gateway (old one valid until expiry). */
  async renew(
    req: Request,
    csrPem: string,
  ): Promise<{ certificatePem: string; caChainPem: string; notAfter: Date }> {
    const deviceId = this.currentDeviceId();
    await this.assertCertificateOf(req, deviceId);
    const now = this.clock.now();
    const cert = await this.ca.sign(csrPem, deviceId, now);
    await this.db.platform(async (tx) => {
      const device = await tx.device.findUnique({ where: { id: deviceId } });
      if (!device || device.status === 'retired') throw new DomainException('device.certificate_invalid');
      await tx.deviceCertificate.create({
        data: {
          deviceId,
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
      await tx.device.update({
        where: { id: deviceId },
        data: {
          certFingerprint: new Uint8Array(cert.fingerprintSha256),
          certNotAfter: cert.notAfter,
          certSerial: cert.serialNumber,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'device.certificate_renewed',
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        subjectType: 'smart.device',
        subjectId: deviceId,
        metadata: { certificateSerial: cert.serialNumber, notAfter: cert.notAfter.toISOString() },
      });
      await this.events.record(tx, {
        type: 'device.certificate_renewed',
        aggregateType: 'device',
        aggregateId: deviceId,
        tenantId: device.tenantId,
        buildingId: device.buildingId,
        payload: { deviceId, certificateSerial: cert.serialNumber, notAfter: cert.notAfter.toISOString() },
      });
    });
    this.logger.log({ event: 'device_certificate_renewed', deviceId }, 'device certificate renewed');
    return { certificatePem: cert.certificatePem, caChainPem: this.ca.caChainPem, notAfter: cert.notAfter };
  }

  /** The gateway behind the device bearer token of this request. */
  currentDeviceId(): string {
    const actor = RequestContext.actor();
    if (actor?.type !== 'device') throw new DomainException('auth.unauthenticated');
    return actor.publicId;
  }

  /** The gateway row of the bearer token, refused when retired or unassigned. */
  async currentDevice(): Promise<Device & { tenantId: string; buildingId: string }> {
    const id = this.currentDeviceId();
    const device = await this.db.platform((tx) => tx.device.findUnique({ where: { id } }));
    if (!device || device.status === 'retired' || !device.tenantId || !device.buildingId)
      throw new DomainException('auth.unauthenticated');
    return device as Device & { tenantId: string; buildingId: string };
  }
}
