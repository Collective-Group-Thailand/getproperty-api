import {
  type Gate,
  type GateBlacklist,
  type GateDevice,
  type GateGuard,
  type RememberedVehicle,
  type VisitEvent,
  type VisitInvite,
} from '@generated/prisma/client';
import { type HousePolicy } from '@modules/smart-gate/gate-rules';
import { type VisitRow } from '@modules/smart-gate/visits.service';

import {
  type BlacklistDto,
  type GateDeviceDto,
  type GateDeviceKindName,
  type GateDeviceStateName,
  type GateDto,
  type GateGuardDto,
  type GateGuardStateName,
  type GateKindName,
  type GatePolicyActionName,
  type GateStateName,
  type GuardVisitDto,
  type HousePolicyDto,
  type InviteVisitorKindName,
  type PlateDto,
  type RememberedVehicleDto,
  type RememberedVehicleKindName,
  type VisitActorKindName,
  type VisitDto,
  type VisitEntryBasisName,
  type VisitEventDto,
  type VisitEventKindName,
  type VisitInviteDto,
  type VisitInviteStateName,
  type VisitInviteUsageName,
  type VisitKindName,
  type VisitStateName,
} from './gate.dto';
import { iso, isoOrNull } from './mappers';

/** J4.1 gate mappers (D-315): plates and names only where the surface may see them; ID digits never to residents. */

export function plateOf(row: {
  plateCategory: string | null;
  plateNumber: string | null;
  plateProvince: string | null;
}): PlateDto | null {
  return row.plateNumber
    ? { category: row.plateCategory ?? '', number: row.plateNumber, province: row.plateProvince ?? '' }
    : null;
}

export function policyDto(p: HousePolicy & { custom: boolean }): HousePolicyDto {
  return {
    timeoutSeconds: p.timeoutSeconds,
    action: p.action as GatePolicyActionName,
    deliverySkipApproval: p.deliverySkipApproval,
    householdNote: p.householdNote,
    custom: p.custom,
  };
}

export function visitDto(v: VisitRow): VisitDto {
  return {
    id: v.id,
    gateId: v.gateId,
    gateName: v.gate.name,
    unitId: v.unitId,
    unitNo: v.unit?.unitNo ?? null,
    kind: v.kind as VisitKindName,
    state: v.state as VisitStateName,
    entryBasis: (v.entryBasis as VisitEntryBasisName | null) ?? null,
    plate: plateOf(v),
    visitorName: v.visitorName,
    hasPhoto: Boolean(v.photoDocumentId),
    respondBy: isoOrNull(v.respondBy),
    timeoutAction: (v.timeoutAction as GatePolicyActionName | null) ?? null,
    decidedAt: isoOrNull(v.decidedAt),
    decisionReason: v.decisionReason,
    callMeAt: isoOrNull(v.callMeAt),
    enteredAt: isoOrNull(v.enteredAt),
    exitedAt: isoOrNull(v.exitedAt),
    exitedBy: (v.exitedBy as VisitActorKindName | null) ?? null,
    cancelledAt: isoOrNull(v.cancelledAt),
    createdAt: iso(v.createdAt),
  };
}

export function guardVisitDto(v: VisitRow): GuardVisitDto {
  return {
    ...visitDto(v),
    clientRef: v.clientRef,
    idLast4: v.idLast4,
    note: v.note,
    recordedAt: isoOrNull(v.recordedAt),
  };
}

export function visitEventDto(
  e: Pick<VisitEvent, 'kind' | 'actorKind' | 'occurredAt' | 'payload'> & { id?: string },
): VisitEventDto {
  return {
    id: e.id ?? '',
    kind: e.kind as VisitEventKindName,
    actorKind: e.actorKind as VisitActorKindName,
    occurredAt: iso(e.occurredAt),
    payload: (e.payload ?? {}) as Record<string, unknown>,
  };
}

export function gateDto(g: Gate & { devices?: { id: string }[] }): GateDto {
  return {
    id: g.id,
    propertyId: g.propertyId,
    name: g.name,
    kind: g.kind as GateKindName,
    state: g.state as GateStateName,
    barrier: g.barrier,
    lpr: g.lpr,
    devices: g.devices?.length ?? 0,
    createdAt: iso(g.createdAt),
  };
}

export function deviceDto(d: GateDevice): GateDeviceDto {
  return {
    id: d.id,
    gateId: d.gateId,
    kind: d.kind as GateDeviceKindName,
    name: d.name,
    state: d.state as GateDeviceStateName,
    enrolExpiresAt: isoOrNull(d.enrolExpiresAt),
    enrolledAt: isoOrNull(d.enrolledAt),
    lastSeenAt: isoOrNull(d.lastSeenAt),
    revokedAt: isoOrNull(d.revokedAt),
  };
}

export function guardDto(g: GateGuard & { shifts?: { gateId: string }[] }): GateGuardDto {
  return {
    id: g.id,
    propertyId: g.propertyId,
    displayName: g.displayName,
    state: g.state as GateGuardStateName,
    pinSetAt: iso(g.pinSetAt),
    lockedUntil: isoOrNull(g.lockedUntil),
    onShiftAtGateId: g.shifts?.[0]?.gateId ?? null,
    createdAt: iso(g.createdAt),
  };
}

export function blacklistDto(b: GateBlacklist): BlacklistDto {
  return {
    id: b.id,
    propertyId: b.propertyId,
    plate: plateOf(b)!,
    reason: b.reason,
    createdAt: iso(b.createdAt),
    revokedAt: isoOrNull(b.revokedAt),
  };
}

export function inviteDto(i: VisitInvite & { unit?: { unitNo: string } | null }): VisitInviteDto {
  return {
    id: i.id,
    unitId: i.unitId,
    unitNo: i.unit?.unitNo ?? null,
    usage: i.usage as VisitInviteUsageName,
    visitorKind: i.visitorKind as InviteVisitorKindName,
    state: i.state as VisitInviteStateName,
    validFrom: iso(i.validFrom),
    validTo: iso(i.validTo),
    maxUses: i.maxUses,
    uses: i.uses,
    plate: plateOf(i),
    visitorName: i.visitorName,
    note: i.note,
    rejectReason: i.rejectReason,
    createdAt: iso(i.createdAt),
  };
}

export function vehicleDto(r: RememberedVehicle): RememberedVehicleDto {
  return {
    id: r.id,
    unitId: r.unitId,
    kind: r.kind as RememberedVehicleKindName,
    plate: plateOf(r)!,
    label: r.label,
    expiresAt: iso(r.expiresAt),
  };
}
