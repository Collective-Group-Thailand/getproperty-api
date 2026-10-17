import {
  type DeviceCommand,
  type DeviceEvent,
  type GatewayConfig,
  type IngestDeadLetter,
  type MeterChannel,
  type MeterReading,
  type OtaRelease,
  type UtilityInvoice,
} from '@generated/prisma/client';
import { type DeviceRow } from '@modules/smart-devices/fleet.service';
import { rolloutNextActions, type RolloutRow } from '@modules/smart-devices/ota.service';
import { type LossRow } from '@modules/smart-health/utility-loss.service';
import { type ReviewRow } from '@modules/smart-readings/meter-readings.service';

import { type UtilityName, type UtilityProviderName } from '../owner/money-settings.dto';
import { dateOnly, iso, isoOrNull } from './mappers';
import {
  type BilledUnitsSourceName,
  type BusTypeName,
  type CommandStatusName,
  type CommandTypeName,
  type DeadLetterDto,
  type DeviceCommandDto,
  type DeviceEventDto,
  type DeviceKindName,
  type DeviceOwnershipName,
  type DeviceStatusName,
  type FleetDeviceDto,
  type GatewayConfigVersionDto,
  type IngestChannelName,
  type IngestFailureName,
  type LossPriceBasisName,
  type LossReportDto,
  type LossSuspectKindName,
  type MeterChannelDto,
  type MeterReadingDto,
  type MeterUnitName,
  type OtaArchName,
  type OtaDeviceStatusName,
  type OtaReleaseDto,
  type OtaRingName,
  type OtaRolloutDto,
  type ReadingChannelName,
  type ReadingReviewDto,
  type ReadingReviewStateName,
  type ReadingSourceName,
  type RegisterMapName,
  type ReviewReasonName,
  type ReviewStatusName,
  type RolloutStatusName,
  type UtilityInvoiceDto,
  type UtilityInvoiceSourceName,
} from './smart.dto';

const dec = (d: { toFixed(n: number): string } | null | undefined, places: number) =>
  d === null || d === undefined ? null : d.toFixed(places);

/** Gateway operator actions (D-131); the admin also manages rings, certificates and retirement. */
export function deviceNextActions(d: DeviceRow, audience: 'operator' | 'admin'): string[] {
  const out: string[] = [];
  const live = d.kind === 'gateway' && d.status !== 'retired' && Boolean(d.mqttClientId);
  if (live) out.push('read-now', 'restart', 'identify', 'upload-logs');
  if (audience === 'admin') {
    if (d.status !== 'retired' && !d.assetItemId) out.push('assign');
    if (d.kind === 'gateway') out.push('set-ring');
    if (d.kind === 'gateway' && d.status !== 'retired') out.push('revoke-certificates');
    if (d.status !== 'retired' && d.channelsAsGateway.length === 0 && !d.assetItemId) out.push('retire');
  }
  return out;
}

export function fleetDeviceDto(d: DeviceRow, audience: 'operator' | 'admin' = 'operator'): FleetDeviceDto {
  const h = d.healthLatest;
  return {
    id: d.id,
    serial: d.serial,
    kind: d.kind as DeviceKindName,
    model: d.model,
    vendor: d.vendor,
    driver: d.driver,
    ownership: d.ownership as DeviceOwnershipName,
    status: d.status as DeviceStatusName,
    tenantId: d.tenantId,
    buildingId: d.buildingId,
    assetItemId: d.assetItemId,
    gatewayDeviceId: d.gatewayDeviceId,
    firmwareVersion: d.firmwareVersion,
    arch: d.arch,
    otaRing: d.otaRing as OtaRingName,
    lastSeenAt: isoOrNull(d.lastSeenAt),
    configAppliedVersion: d.configAppliedVersion,
    meters: d.channelsAsGateway.length,
    health: h
      ? {
          lastHeartbeatAt: isoOrNull(h.lastHeartbeatAt),
          agentVersion: h.agentVersion,
          configVersion: h.configVersion,
          bufferedReadings: h.bufferedReadings,
          link: h.link,
          rssi: h.rssi,
          missedHeartbeats: h.missedHeartbeats,
          ingestLagMs: h.ingestLagMs,
        }
      : null,
    nextActions: deviceNextActions(d, audience),
    version: d.version,
  };
}

export function channelDto(
  c: MeterChannel & { meter: { id: string; name: string; unitId: string | null } },
): MeterChannelDto {
  return {
    id: c.id,
    meterAssetItemId: c.meterAssetItemId,
    meterName: c.meter.name,
    unitId: c.meter.unitId,
    meterDeviceId: c.meterDeviceId,
    gatewayDeviceId: c.gatewayDeviceId,
    busId: c.busId,
    busType: c.busType as BusTypeName,
    address: c.address,
    pin: c.pin,
    driver: c.driver,
    registerMap: c.registerMap as RegisterMapName,
    validFrom: iso(c.validFrom),
    validTo: isoOrNull(c.validTo),
    unboundReason: c.unboundReason,
  };
}

export function configVersionDto(c: GatewayConfig): GatewayConfigVersionDto {
  const doc = c.document as { meters?: unknown[] };
  return {
    id: c.id,
    version: c.version,
    compiledAt: iso(c.compiledAt),
    publishedAt: isoOrNull(c.publishedAt),
    appliedAt: isoOrNull(c.appliedAt),
    rejectedAt: isoOrNull(c.rejectedAt),
    rejectError: c.rejectError,
    driftFlaggedAt: isoOrNull(c.driftFlaggedAt),
    meters: Array.isArray(doc.meters) ? doc.meters.length : 0,
  };
}

export function deviceEventDto(e: DeviceEvent): DeviceEventDto {
  return {
    id: e.id,
    type: e.type,
    severity: e.severity,
    occurredAt: iso(e.occurredAt),
    message: e.message,
    deviceId: e.deviceId,
  };
}

export function commandDto(c: DeviceCommand): DeviceCommandDto {
  return {
    id: c.id,
    gatewayDeviceId: c.gatewayDeviceId,
    type: c.type as CommandTypeName,
    args: c.args as Record<string, unknown>,
    status: c.status as CommandStatusName,
    issuedAt: iso(c.issuedAt),
    expiresAt: iso(c.expiresAt),
    attempts: c.attempts,
    finishedAt: isoOrNull(c.finishedAt),
    result: (c.result as Record<string, unknown> | null) ?? null,
    error: c.error,
  };
}

export function releaseDto(r: OtaRelease): OtaReleaseDto {
  return {
    id: r.id,
    version: r.version,
    arch: r.arch as OtaArchName,
    channel: r.channel,
    artifactUrl: r.artifactUrl,
    sha256: Buffer.from(r.artifactSha256).toString('hex'),
    keyId: r.signatureKeyId,
    releasedAt: iso(r.releasedAt),
    deprecatedAt: isoOrNull(r.deprecatedAt),
    notes: r.releaseNotes,
  };
}

export function rolloutDto(r: RolloutRow): OtaRolloutDto {
  const counts: Record<string, number> = {};
  for (const d of r.devices) counts[d.status] = (counts[d.status] ?? 0) + 1;
  return {
    id: r.id,
    release: releaseDto(r.release),
    ring: r.ring as OtaRingName,
    status: r.status as RolloutStatusName,
    maxFailuresPct: r.maxFailuresPct.toFixed(2),
    startedAt: isoOrNull(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
    counts,
    devices: r.devices.map((d) => ({
      deviceId: d.deviceId,
      status: d.status as OtaDeviceStatusName,
      fromVersion: d.fromVersion,
      error: d.error,
      updatedAt: iso(d.updatedAt),
    })),
    nextActions: rolloutNextActions(r.status),
  };
}

export function deadLetterDto(d: IngestDeadLetter): DeadLetterDto {
  const bytes = Buffer.from(d.payload);
  return {
    id: d.id,
    receivedAt: iso(d.receivedAt),
    topic: d.topic,
    channel: d.channel as IngestChannelName,
    gatewayDeviceId: d.gatewayDeviceId,
    reason: d.reason as IngestFailureName,
    detail: d.detail,
    payloadBytes: bytes.length,
    payloadPreview: bytes.length ? bytes.subarray(0, 2048).toString('utf8') : null,
    replayedAt: isoOrNull(d.replayedAt),
    replayOutcome: d.replayOutcome,
  };
}

export function readingDto(
  r: MeterReading & { assignment: { code: string; utility: string } },
): MeterReadingDto {
  return {
    id: r.id,
    assetItemId: r.assetItemId,
    meterAssignmentId: r.meterAssignmentId,
    meterCode: r.assignment.code,
    utility: r.assignment.utility as UtilityName,
    unitId: r.unitId,
    register: r.register.toFixed(3),
    unit: r.unit as MeterUnitName,
    readAt: iso(r.readAt),
    source: r.source as ReadingSourceName,
    via: r.submittedVia as ReadingChannelName,
    confidence: r.confidence.toFixed(3),
    reviewState: r.reviewState as ReadingReviewStateName,
    consumption: dec(r.consumption, 3),
    isRollover: r.isRollover,
    isInstall: r.isInstall,
    isFinal: r.isFinal,
    evidenceDocumentId: r.evidenceDocumentId,
    ocrRawValue: r.ocrRawValue,
    ocrConfidence: dec(r.ocrConfidence, 3),
    typedValue: dec(r.typedValue, 3),
    reviewId: r.reviewId,
    supersededByReadingId: r.supersededByReadingId,
    readingBatchId: r.readingBatchId,
    note: r.note,
  };
}

export function reviewDto(r: ReviewRow): ReadingReviewDto {
  return {
    id: r.id,
    buildingId: r.buildingId,
    unitId: r.unitId,
    unitNo: r.unitRef?.unitNo ?? null,
    reason: r.reason as ReviewReasonName,
    bandLow: dec(r.bandLow, 3),
    bandHigh: dec(r.bandHigh, 3),
    trailingAvg: dec(r.trailingAvg, 3),
    status: r.status as ReviewStatusName,
    reading: readingDto(r.reading),
    decidedAt: isoOrNull(r.decidedAt),
    decisionNote: r.decisionNote,
    correctedRegister: dec(r.correctedRegister, 3),
    correctedReadingId: r.correctedReadingId,
    createdAt: iso(r.createdAt),
    nextActions: r.status === 'open' ? ['accept', 'correct', 'reject'] : [],
  };
}

export function utilityInvoiceDto(i: UtilityInvoice): UtilityInvoiceDto {
  return {
    id: i.id,
    buildingId: i.buildingId,
    utility: i.utility as UtilityName,
    provider: i.provider as UtilityProviderName,
    utilityAccountId: i.utilityAccountId,
    periodStart: dateOnly(i.periodStart)!,
    periodEnd: dateOnly(i.periodEnd)!,
    invoiceNo: i.invoiceNo,
    units: i.units.toFixed(3),
    amount: i.amount.toFixed(2),
    ft: dec(i.ft, 4),
    serviceCharge: dec(i.serviceCharge, 2),
    vat: dec(i.vat, 2),
    previousRegister: dec(i.previousRegister, 3),
    currentRegister: dec(i.currentRegister, 3),
    source: i.source as UtilityInvoiceSourceName,
    invoiceDocumentId: i.invoiceDocumentId,
    version: i.version,
  };
}

export function lossReportDto(r: LossRow): LossReportDto {
  return {
    id: r.id,
    buildingId: r.buildingId,
    utility: r.utility as UtilityName,
    periodKey: (r.inputsSnapshot as { periodKey?: string }).periodKey ?? dateOnly(r.periodEnd)!.slice(0, 7),
    periodStart: dateOnly(r.periodStart)!,
    periodEnd: dateOnly(r.periodEnd)!,
    invoiceUnits: r.invoiceUnits.toFixed(3),
    unitBilledUnits: r.unitBilledUnits.toFixed(3),
    commonAreaUnits: r.commonAreaUnits.toFixed(3),
    lossUnits: r.lossUnits.toFixed(3),
    lossPct: dec(r.lossPct, 4),
    lossThb: r.lossThb.toFixed(2),
    priceBasis: r.priceBasis as LossPriceBasisName,
    billedUnitsSource: r.billedUnitsSource as BilledUnitsSourceName,
    computedAt: iso(r.computedAt),
    suspects: r.suspects.map((s) => ({
      id: s.id,
      kind: s.kind as LossSuspectKindName,
      unitId: s.unitId,
      assetItemId: s.assetItemId,
      score: s.score.toFixed(2),
      detail: s.detail as Record<string, unknown>,
    })),
  };
}
