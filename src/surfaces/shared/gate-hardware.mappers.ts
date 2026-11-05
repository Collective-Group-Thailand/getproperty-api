import {
  type DeviceCommand,
  type IncidentEvent,
  type ResidentVehicle,
  type Visit,
} from '@generated/prisma/client';
import { type DetectionRow } from '@modules/smart-gate/gate-hardware.service';
import { plateText } from '@modules/smart-gate/gate-rules';
import { type IncidentRow } from '@modules/smart-gate/incidents.service';

import {
  type GateHwStateName,
  type VisitActorKindName,
  type VisitKindName,
  type VisitStateName,
} from './gate.dto';
import {
  type GateHardwareKindName,
  type GateOpenResultDto,
  type GuardHardwareDto,
  type IncidentDto,
  type IncidentEventDto,
  type IncidentEventKindName,
  type IncidentKindName,
  type IncidentSourceName,
  type IncidentStateName,
  type IncidentVisitDto,
  type PlateDetectionDto,
  type PlateDetectionStateName,
  type PlateMatchName,
  type ResidentVehicleDto,
} from './gate-hardware.dto';
import { iso, isoOrNull } from './mappers';

export function openResultDto(r: { gateId: string; commands: DeviceCommand[] }): GateOpenResultDto {
  return {
    gateId: r.gateId,
    commands: r.commands.map((c) => {
      const args = c.args as { deviceId?: string };
      return { commandId: c.id, gateDeviceId: args.deviceId ?? '', expiresAt: iso(c.expiresAt) };
    }),
  };
}

export function residentVehicleDto(v: ResidentVehicle): ResidentVehicleDto {
  return {
    id: v.id,
    unitId: v.unitId,
    plate: { category: v.plateCategory, number: v.plateNumber, province: v.plateProvince },
    label: v.label,
    createdAt: iso(v.createdAt),
  };
}

export function detectionDto(d: DetectionRow): PlateDetectionDto {
  return {
    id: d.id,
    gateId: d.gateId,
    plate: { category: d.plateCategory, number: d.plateNumber, province: d.plateProvince },
    confidence: d.confidence.toFixed(3),
    detectedAt: iso(d.detectedAt),
    receivedAt: iso(d.receivedAt),
    imageRef: d.imageRef,
    state: d.state as PlateDetectionStateName,
    match: d.match as PlateMatchName,
    unit: d.unit ? { id: d.unit.id, unitNo: d.unit.unitNo } : null,
    visitId: d.visitId,
  };
}

export function hardwareDto(d: {
  id: string;
  kind: string;
  name: string;
  hwState: string | null;
  hwStateAt: Date | null;
  lastSeenAt: Date | null;
}): GuardHardwareDto {
  return {
    id: d.id,
    kind: d.kind as GateHardwareKindName,
    name: d.name,
    hwState: (d.hwState as GateHwStateName | null) ?? null,
    hwStateAt: isoOrNull(d.hwStateAt),
    lastSeenAt: isoOrNull(d.lastSeenAt),
  };
}

export function incidentDto(i: IncidentRow): IncidentDto {
  return {
    id: i.id,
    propertyId: i.propertyId,
    propertyName: i.property.name,
    unit: i.unit ? { id: i.unit.id, unitNo: i.unit.unitNo } : null,
    gate: i.gate ? { id: i.gate.id, name: i.gate.name } : null,
    kind: i.kind as IncidentKindName,
    source: i.source as IncidentSourceName,
    state: i.state as IncidentStateName,
    note: i.note,
    hasPhoto: Boolean(i.photoDocumentId),
    visitCount: i.visitIds.length,
    createdAt: iso(i.createdAt),
    acknowledgedAt: isoOrNull(i.acknowledgedAt),
    resolvedAt: isoOrNull(i.resolvedAt),
    cancelledAt: isoOrNull(i.cancelledAt),
  };
}

export function incidentEventDto(e: IncidentEvent): IncidentEventDto {
  return {
    id: e.id,
    kind: e.kind as IncidentEventKindName,
    actorKind: e.actorKind as VisitActorKindName,
    occurredAt: iso(e.occurredAt),
  };
}

export function incidentVisitDto(
  v: Visit & { unit: { unitNo: string } | null; gate: { name: string } },
): IncidentVisitDto {
  return {
    id: v.id,
    unitNo: v.unit?.unitNo ?? null,
    gateName: v.gate.name,
    kind: v.kind as VisitKindName,
    state: v.state as VisitStateName,
    plate: plateText({ category: v.plateCategory, number: v.plateNumber, province: v.plateProvince }),
    visitorName: v.visitorName,
    enteredAt: isoOrNull(v.enteredAt),
    exitedAt: isoOrNull(v.exitedAt),
  };
}
