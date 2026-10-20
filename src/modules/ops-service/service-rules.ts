import {
  type ServiceRequestStatus,
  type WorkOrderKind,
  type WorkOrderStatus,
} from '@generated/prisma/client';

/**
 * Pure rules of B5.1 service requests and work orders (D-072, D-153, D-159) — no I/O, unit-tested.
 * The request's lifecycle runs on the workflow engine (definition `service_request`); its `status` column mirrors the
 * workflow state for queries and the API (`referred` — a warranty referral to getbuild — shows as `triaged`).
 */

/** Workflow state of definition `service_request` → `ops.service_request.status`. */
export function requestStatusOf(state: string): ServiceRequestStatus {
  switch (state) {
    case 'new':
    case 'triaged':
    case 'assigned':
    case 'in_progress':
    case 'waiting_parts':
    case 'done':
    case 'closed':
    case 'cancelled':
      return state;
    case 'referred':
      return 'triaged';
    default:
      throw new Error(`service_request: unknown workflow state ${state}`);
  }
}

export const OPEN_REQUEST_STATUSES: readonly ServiceRequestStatus[] = [
  'new',
  'triaged',
  'assigned',
  'in_progress',
  'waiting_parts',
];

/** Work orders still being worked on (they keep the request from being done). */
export const ACTIVE_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = [
  'open',
  'assigned',
  'accepted',
  'in_progress',
];

/** Work orders a technician token covers (`work_order:<id>` scopes): assigned to them and not yet verified. */
export const TECHNICIAN_VISIBLE_STATUSES: readonly WorkOrderStatus[] = [
  'assigned',
  'accepted',
  'in_progress',
  'done',
];

/** Owner/staff actions on a request (`…/actions/{name}`), from the workflow events allowed now. */
export function requestOperatorActions(
  status: ServiceRequestStatus,
  allowedEvents: readonly string[],
  inWarranty: boolean,
): string[] {
  const out: string[] = [];
  if (allowedEvents.includes('triage')) out.push('triage');
  if (allowedEvents.includes('assign') && !inWarranty) out.push('create-work-order');
  if (allowedEvents.includes('close')) out.push('close');
  if (allowedEvents.includes('reopen')) out.push('reopen');
  if (allowedEvents.includes('cancel')) out.push('cancel');
  if (status === 'done') out.push('rate');
  return out;
}

/** Resident actions: cancel before work starts, rate once the work is done. */
export function requestResidentActions(status: ServiceRequestStatus, rated: boolean): string[] {
  if (status === 'new' || status === 'triaged') return ['cancel'];
  if (status === 'done' && !rated) return ['rate'];
  return [];
}

export type WorkOrderAction =
  'assign' | 'accept' | 'check-in' | 'wait-parts' | 'resume' | 'complete' | 'verify' | 'cancel';

/** Allowed work-order transitions (status machine; the request follows through the workflow). */
const WO_TRANSITIONS: Record<WorkOrderAction, readonly WorkOrderStatus[]> = {
  assign: ['open', 'assigned', 'accepted'],
  accept: ['assigned'],
  'check-in': ['assigned', 'accepted'],
  'wait-parts': ['in_progress'],
  resume: ['in_progress'],
  complete: ['assigned', 'accepted', 'in_progress'],
  verify: ['done'],
  cancel: ['open', 'assigned', 'accepted', 'in_progress'],
};

export function canWorkOrder(action: WorkOrderAction, status: WorkOrderStatus): boolean {
  return WO_TRANSITIONS[action].includes(status);
}

/** Actions of a work order for an audience (operators assign/verify/cancel; the assignee does the field steps). */
export function workOrderActions(
  status: WorkOrderStatus,
  audience: 'operator' | 'assignee',
  waitingParts = false,
): WorkOrderAction[] {
  const field: WorkOrderAction[] = ['accept', 'check-in', 'complete'];
  const all = (Object.keys(WO_TRANSITIONS) as WorkOrderAction[]).filter((a) => canWorkOrder(a, status));
  const filtered = all.filter((a) => {
    if (a === 'wait-parts') return !waitingParts;
    if (a === 'resume') return waitingParts;
    return true;
  });
  if (audience === 'assignee')
    return filtered.filter((a) => field.includes(a) || a === 'wait-parts' || a === 'resume');
  return filtered.filter((a) => a !== 'accept');
}

/** Platform default categories (D-072): key → names and default SLA hours (tenants override per key). */
export const DEFAULT_SERVICE_CATEGORIES: readonly {
  key: string;
  nameTh: string;
  nameEn: string;
  slaHours: number;
}[] = [
  { key: 'electrical', nameTh: 'ไฟฟ้า', nameEn: 'Electrical', slaHours: 24 },
  { key: 'plumbing', nameTh: 'ประปา', nameEn: 'Plumbing', slaHours: 24 },
  { key: 'aircon', nameTh: 'เครื่องปรับอากาศ', nameEn: 'Air conditioning', slaHours: 48 },
  { key: 'appliance', nameTh: 'เครื่องใช้ไฟฟ้า', nameEn: 'Appliance', slaHours: 72 },
  { key: 'structure', nameTh: 'โครงสร้าง ประตู หน้าต่าง', nameEn: 'Structure', slaHours: 120 },
  { key: 'pest', nameTh: 'แมลงและสัตว์รบกวน', nameEn: 'Pest control', slaHours: 72 },
  { key: 'cleaning', nameTh: 'ทำความสะอาด', nameEn: 'Cleaning', slaHours: 48 },
  { key: 'other', nameTh: 'อื่น ๆ', nameEn: 'Other', slaHours: 72 },
];

/** Category of an automatic request (D-034): electric meter / gateway / lock → electrical, water meter → plumbing. */
export function autoRequestCategory(assetCategory: string | null | undefined, utility?: unknown): string {
  if (utility === 'water' || assetCategory === 'meter_water' || assetCategory === 'pump') return 'plumbing';
  if (
    utility === 'electric' ||
    assetCategory === 'meter_electric' ||
    assetCategory === 'gateway' ||
    assetCategory === 'lock' ||
    assetCategory === 'breaker' ||
    assetCategory === 'door_controller'
  )
    return 'electrical';
  if (assetCategory === 'hvac') return 'aircon';
  if (assetCategory === 'appliance') return 'appliance';
  return 'other';
}

/** Automatic requests per asset item are deduplicated over this window (B5.1, D-034). */
export const AUTO_REQUEST_DEDUP_MS = 24 * 3_600_000;

export const AUTO_REASONS: Record<string, { th: string; en: string }> = {
  meter_stale: { th: 'มิเตอร์ไม่ส่งข้อมูลตามกำหนด', en: 'Meter stopped reporting (stale)' },
  meter_silent: { th: 'มิเตอร์เงียบเกิน 24 ชั่วโมง', en: 'Meter silent for over 24 hours' },
  gateway_offline: { th: 'เกตเวย์ออฟไลน์', en: 'Gateway offline' },
  lock_battery_low: { th: 'แบตเตอรี่กลอนประตูใกล้หมด', en: 'Door lock battery low' },
};

/**
 * The warranty decision (blueprint A4.6, D-153): a request is referred to getbuild — instead of being assigned to the
 * building's technician — when the asset item came from getbuild (`source_ref`) and its `warranty_until` has not
 * passed, or, without an asset item, when the unit came from getbuild and a `warranty` grant (developer post-sale
 * warranty) covers the unit or its building today.
 */
export function inWarranty(input: {
  today: string;
  assetItem?: { sourceRef: string | null; warrantyUntil: string | null } | null;
  unit?: { sourceRef: string | null } | null;
  warrantyGrantActive: boolean;
}): boolean {
  if (input.assetItem) {
    return (
      !!input.assetItem.sourceRef &&
      !!input.assetItem.warrantyUntil &&
      input.assetItem.warrantyUntil >= input.today
    );
  }
  return !!input.unit?.sourceRef && input.warrantyGrantActive;
}

/** Work kinds that need an asset item (preventive maintenance of equipment). */
export const ASSET_WORK_KINDS: readonly WorkOrderKind[] = ['preventive'];

/** Next due date of a maintenance plan after a work order was opened for `dueOn`. */
export function nextDueOn(dueOn: string, intervalDays: number): string {
  const d = new Date(`${dueOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + intervalDays);
  return d.toISOString().slice(0, 10);
}

/** True when a plan's next work order should be opened today (lead days before the due date). */
export function planDue(nextDue: string, leadDays: number, today: string): boolean {
  const d = new Date(`${nextDue}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - leadDays);
  return d.toISOString().slice(0, 10) <= today;
}
