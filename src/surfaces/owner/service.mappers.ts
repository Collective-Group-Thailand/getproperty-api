import { FAKE } from '@common/openapi/examples';
import { type ServiceMessage } from '@generated/prisma/client';
import { type PhotoLink, type ResidentRequestDetail } from '@modules/ops-service/field-access.service';
import { type MaintenancePlanRow } from '@modules/ops-service/maintenance-plans.service';
import { type EffectiveCategory } from '@modules/ops-service/service-categories.service';
import { type ServiceRequestRow } from '@modules/ops-service/service-requests.service';
import { visitConfirmation } from '@modules/ops-service/service-rules';
import { type WorkOrderRow } from '@modules/ops-service/work-orders.service';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import {
  AssigneeTypeName,
  type CostLineDto,
  type MaintenancePlanDto,
  type ResidentServiceRequestDto,
  type ServiceCategoryDto,
  type ServiceCategorySourceName,
  type ServiceMessageAuthorName,
  type ServiceMessageDto,
  type ServicePhotoDto,
  type ServicePhotoRoleName,
  type ServicePriorityName,
  type ServiceReporterKindName,
  type ServiceRequestDto,
  type ServiceRequestStatusName,
  type ServiceSlaStateName,
  type TechnicianWorkOrderDto,
  type VisitPreferenceName,
  type WorkOrderCostKindName,
  type WorkOrderDto,
  type WorkOrderKindName,
  type WorkOrderStatusName,
} from './service.dto';

export const refOf = (id: string): string => id.replace(/-/g, '').slice(-8).toUpperCase();

export function categoryDto(c: EffectiveCategory): ServiceCategoryDto {
  return {
    id: c.id,
    key: c.key,
    nameTh: c.nameTh,
    nameEn: c.nameEn,
    slaHours: c.slaHours,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    source: c.source as ServiceCategorySourceName,
  };
}

export function serviceRequestDto(
  r: ServiceRequestRow,
  photoIds: string[],
  nextActions: string[],
): ServiceRequestDto {
  return {
    nextActions,
    id: r.id,
    ref: refOf(r.id),
    status: r.status as ServiceRequestStatusName,
    priority: r.priority as ServicePriorityName,
    reporterKind: r.reporterKind as ServiceReporterKindName,
    category: {
      id: r.category.id,
      key: r.category.key,
      nameTh: r.category.nameTh,
      nameEn: r.category.nameEn,
    },
    description: r.description,
    buildingId: r.buildingId,
    unitId: r.unitId,
    unitNo: r.unit?.unitNo ?? null,
    assetItemId: r.assetItemId,
    requesterPartyId: r.requesterPartyId,
    requesterName: r.requester?.displayName ?? null,
    slaHours: r.slaHours,
    slaDueAt: isoOrNull(r.workflowInstance?.slaDueAt),
    slaBreached: !!r.workflowInstance?.slaBreachedAt,
    inWarranty: r.inWarranty,
    warrantyResolution: r.warrantyResolution,
    autoReason: r.autoReason,
    photoIds,
    workOrders: r.workOrders.map((w) => ({
      id: w.id,
      kind: w.kind as WorkOrderKindName,
      title: w.title,
      status: w.status as WorkOrderStatusName,
      assigneePartyId: w.assigneePartyId,
      assigneeUserId: w.assigneeUserId,
      scheduledAt: isoOrNull(w.scheduledAt),
      completedAt: isoOrNull(w.completedAt),
    })),
    rating: r.rating,
    ratingComment: r.ratingComment,
    preferredVisit: r.preferredVisit as VisitPreferenceName | null,
    visitConfirmedAt: isoOrNull(
      visitConfirmation(r.workOrders, { at: r.visitConfirmedAt, for: r.visitConfirmedFor }).confirmedAt,
    ),
    triagedAt: isoOrNull(r.triagedAt),
    doneAt: isoOrNull(r.doneAt),
    closedAt: isoOrNull(r.closedAt),
    cancelledAt: isoOrNull(r.cancelledAt),
    cancelReason: r.cancelReason,
    version: r.version,
    createdAt: iso(r.createdAt),
  };
}

export function photoDtos(photos: PhotoLink[]): ServicePhotoDto[] {
  return photos.map((p) => ({ id: p.id, role: p.role as ServicePhotoRoleName, url: p.url }));
}

export function serviceMessageDto(m: ServiceMessage, me: string | null): ServiceMessageDto {
  return {
    id: m.id,
    author: m.authorKind as ServiceMessageAuthorName,
    authorName: m.authorName,
    body: m.body,
    createdAt: iso(m.createdAt),
    mine: !!me && m.authorUserId === me,
  };
}

export function residentServiceRequestDto(
  r: ServiceRequestRow,
  photoIds: string[],
  nextActions: string[],
  detail: ResidentRequestDetail,
): ResidentServiceRequestDto {
  const visit = visitConfirmation(r.workOrders, { at: null, for: null }).visit?.scheduledAt;
  return {
    nextActions,
    id: r.id,
    ref: refOf(r.id),
    status: r.status as ServiceRequestStatusName,
    priority: r.priority as ServicePriorityName,
    category: {
      id: r.category.id,
      key: r.category.key,
      nameTh: r.category.nameTh,
      nameEn: r.category.nameEn,
    },
    description: r.description,
    unitId: r.unitId,
    unitNo: r.unit?.unitNo ?? null,
    photoIds,
    visitAt: isoOrNull(visit),
    inWarranty: r.inWarranty,
    rating: r.rating,
    ratingComment: r.ratingComment,
    createdAt: iso(r.createdAt),
    doneAt: isoOrNull(r.doneAt),
    closedAt: isoOrNull(r.closedAt),
    preferredVisit: r.preferredVisit as VisitPreferenceName | null,
    visitConfirmedAt: isoOrNull(detail.visitConfirmedAt),
    photos: photoDtos(detail.photos),
    events: detail.events.map((e) => ({ status: e.status as ServiceRequestStatusName, at: iso(e.at) })),
    sla: detail.sla
      ? { dueAt: isoOrNull(detail.sla.dueAt), state: detail.sla.state as ServiceSlaStateName }
      : null,
  };
}

export function costLineDto(l: WorkOrderRow['costLines'][number]): CostLineDto {
  return {
    id: l.id,
    kind: l.kind as WorkOrderCostKindName,
    description: l.description,
    quantity: l.quantity.toFixed(3),
    unitPrice: l.unitPrice.toFixed(2),
    amount: l.amount.toFixed(2),
    vendorPartyId: l.vendorPartyId,
    receiptDocumentId: l.receiptDocumentId,
  };
}

export function workOrderDto(
  w: WorkOrderRow,
  photos: Map<string, string[]> | undefined,
  nextActions: string[],
): WorkOrderDto {
  return {
    nextActions,
    id: w.id,
    kind: w.kind as WorkOrderKindName,
    status: w.status as WorkOrderStatusName,
    title: w.title,
    description: w.description,
    priority: w.priority as ServicePriorityName,
    buildingId: w.buildingId,
    unitId: w.unitId,
    unitNo: w.unit?.unitNo ?? null,
    serviceRequestId: w.serviceRequestId,
    assetItemId: w.assetItemId,
    maintenancePlanId: w.maintenancePlanId,
    assignee: w.assigneeUser
      ? { type: AssigneeTypeName.User, id: w.assigneeUser.id, displayName: w.assigneeUser.displayName }
      : w.assigneeParty
        ? { type: AssigneeTypeName.Party, id: w.assigneeParty.id, displayName: w.assigneeParty.displayName }
        : null,
    scheduledAt: isoOrNull(w.scheduledAt),
    scheduledUntil: isoOrNull(w.scheduledUntil),
    assignedAt: isoOrNull(w.assignedAt),
    acceptedAt: isoOrNull(w.acceptedAt),
    checkedInAt: isoOrNull(w.checkedInAt),
    completedAt: isoOrNull(w.completedAt),
    verifiedAt: isoOrNull(w.verifiedAt),
    cancelledAt: isoOrNull(w.cancelledAt),
    cancelReason: w.cancelReason,
    completionNote: w.completionNote,
    costTotal: w.costTotal.toFixed(2),
    costLines: w.costLines.map(costLineDto),
    beforePhotoIds: photos?.get('before') ?? [],
    afterPhotoIds: photos?.get('after') ?? [],
    version: w.version,
    createdAt: iso(w.createdAt),
  };
}

export interface TechnicianExtras {
  photos: PhotoLink[];
  rating: number | null;
  ratingComment: string | null;
  preferredVisit: string | null;
}

export function technicianWorkOrderDto(
  w: WorkOrderRow,
  photos: Map<string, string[]> | undefined,
  nextActions: string[],
  request: { description: string; categoryKey: string; photoIds: string[] } | null,
  extras: TechnicianExtras = { photos: [], rating: null, ratingComment: null, preferredVisit: null },
): TechnicianWorkOrderDto {
  const dto = workOrderDto(w, photos, nextActions);
  return {
    ...dto,
    // the request as the technician needs it: what is wrong and its photos (no resident name or contact)
    requestDescription: request?.description ?? null,
    categoryKey: request?.categoryKey ?? null,
    requestPhotoIds: request?.photoIds ?? [],
    buildingName: w.building.name,
    photos: photoDtos(extras.photos),
    rating: extras.rating,
    ratingComment: extras.ratingComment,
    preferredVisit: extras.preferredVisit as VisitPreferenceName | null,
  };
}

export function maintenancePlanDto(p: MaintenancePlanRow): MaintenancePlanDto {
  return {
    id: p.id,
    buildingId: p.buildingId,
    assetItemId: p.assetItemId,
    assetItemName: p.assetItem.name,
    categoryId: p.categoryId,
    title: p.title,
    description: p.description,
    intervalDays: p.intervalDays,
    leadDays: p.leadDays,
    nextDueOn: dateOnly(p.nextDueOn)!,
    assigneeUserId: p.assigneeUserId,
    assigneePartyId: p.assigneePartyId,
    isActive: p.isActive,
    lastWorkOrderId: p.lastWorkOrderId,
    version: p.version,
  };
}

// ------------------------------------------------------------------------------------------------- examples

export const CATEGORY_EXAMPLE = {
  id: FAKE.uuid,
  key: 'plumbing',
  nameTh: 'ประปา',
  nameEn: 'Plumbing',
  slaHours: 24,
  sortOrder: 20,
  isActive: true,
  source: 'platform',
};

export const WORK_ORDER_EXAMPLE = {
  nextActions: ['check-in', 'complete', 'cancel'],
  id: FAKE.uuid,
  kind: 'repair',
  status: 'assigned',
  title: 'เปลี่ยนก๊อกน้ำ',
  description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
  priority: 'normal',
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  serviceRequestId: FAKE.uuid,
  assetItemId: null,
  maintenancePlanId: null,
  assignee: { type: 'party', id: FAKE.uuid, displayName: FAKE.name },
  scheduledAt: FAKE.dateTime,
  scheduledUntil: '2026-11-01T12:00:00+07:00',
  assignedAt: FAKE.dateTime,
  acceptedAt: null,
  checkedInAt: null,
  completedAt: null,
  verifiedAt: null,
  cancelledAt: null,
  cancelReason: null,
  completionNote: null,
  costTotal: '350.00',
  costLines: [
    {
      id: FAKE.uuid,
      kind: 'part',
      description: 'ก๊อกน้ำ',
      quantity: '1.000',
      unitPrice: '350.00',
      amount: '350.00',
      vendorPartyId: null,
      receiptDocumentId: null,
    },
  ],
  beforePhotoIds: [FAKE.uuid],
  afterPhotoIds: [],
  version: 2,
  createdAt: FAKE.dateTime,
};

export const SERVICE_REQUEST_EXAMPLE = {
  nextActions: ['triage', 'create-work-order', 'cancel'],
  id: FAKE.uuid,
  ref: 'C566A962',
  status: 'new',
  priority: 'normal',
  reporterKind: 'resident',
  category: { id: FAKE.uuid, key: 'plumbing', nameTh: 'ประปา', nameEn: 'Plumbing' },
  description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  assetItemId: null,
  requesterPartyId: FAKE.uuid,
  requesterName: FAKE.nameTh,
  slaHours: 24,
  slaDueAt: '2026-11-02T00:15:00+07:00',
  slaBreached: false,
  inWarranty: false,
  warrantyResolution: null,
  autoReason: null,
  photoIds: [FAKE.uuid],
  workOrders: [],
  rating: null,
  ratingComment: null,
  preferredVisit: 'afternoon',
  visitConfirmedAt: null,
  triagedAt: null,
  doneAt: null,
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  createdAt: FAKE.dateTime,
};

export const RESIDENT_REQUEST_EXAMPLE = {
  nextActions: ['cancel'],
  id: FAKE.uuid,
  ref: 'C566A962',
  status: 'new',
  priority: 'normal',
  category: { id: FAKE.uuid, key: 'plumbing', nameTh: 'ประปา', nameEn: 'Plumbing' },
  description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  photoIds: [FAKE.uuid],
  visitAt: null,
  inWarranty: false,
  rating: null,
  ratingComment: null,
  createdAt: FAKE.dateTime,
  doneAt: null,
  closedAt: null,
  preferredVisit: 'afternoon',
  visitConfirmedAt: null,
  photos: [
    { id: FAKE.uuid, role: 'report', url: 'https://storage.example.com/service-photo?X-Amz-Signature=abc' },
  ],
  events: [{ status: 'new', at: FAKE.dateTime }],
  sla: { dueAt: '2026-11-02T00:15:00+07:00', state: 'on_track' },
};

export const MESSAGE_EXAMPLE = {
  id: FAKE.uuid,
  author: 'office',
  authorName: 'สมชาย (สำนักงาน)',
  body: 'ช่างจะเข้าไปพรุ่งนี้ 10 โมงนะคะ',
  createdAt: FAKE.dateTime,
  mine: false,
};

export const MAINTENANCE_PLAN_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  assetItemId: FAKE.uuid,
  assetItemName: 'ปั๊มน้ำหลัก',
  categoryId: null,
  title: 'ล้างและตรวจปั๊มน้ำ',
  description: null,
  intervalDays: 90,
  leadDays: 7,
  nextDueOn: FAKE.date,
  assigneeUserId: null,
  assigneePartyId: null,
  isActive: true,
  lastWorkOrderId: null,
  version: 1,
};
