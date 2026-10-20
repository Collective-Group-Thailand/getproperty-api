/**
 * Pure rules of B5.4 staff tasks (D-213) — no I/O, unit-tested.
 */

export const STAFF_TASK_TYPES = ['work_order', 'inspection', 'reading', 'parcel', 'install'] as const;
export type StaffTaskType = (typeof STAFF_TASK_TYPES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The permission completing a task of each type needs (the source's own); null = not completable by staff. */
export const STAFF_TASK_COMPLETION: Readonly<Record<StaffTaskType, string | null>> = {
  work_order: 'service_request.handle',
  inspection: 'inspection.perform',
  reading: 'reading.capture',
  parcel: 'parcel.manage',
  // Collective's field engineers work install orders (D-081); tenant staff only see them
  install: null,
};

export interface StaffTask {
  type: StaffTaskType;
  id: string;
  buildingId: string;
  unitId: string | null;
  unitNo: string | null;
  floorId: string | null;
  floorName: string | null;
  floorLevel: number | null;
  sourceStatus: string;
  priority: TaskPriority;
  overdue: boolean;
  dueAt: Date | null;
  assigneeUserId: string | null;
  subject: string;
  assetItemId: string | null;
  createdAt: Date;
  completable: boolean;
}

export interface StaffTaskFloor {
  floorId: string | null;
  floorName: string | null;
  floorLevel: number | null;
  tasks: StaffTask[];
}

export interface StaffTaskGroup {
  type: StaffTaskType;
  count: number;
  floors: StaffTaskFloor[];
}

const rank = (p: string) => Math.max(0, TASK_PRIORITIES.indexOf(p as TaskPriority));

/** The source priority, raised to at least `high` once the task is overdue. */
export function taskPriority(source: string, dueAt: Date | null, now: Date): TaskPriority {
  const base = TASK_PRIORITIES[rank(source)]!;
  return dueAt && dueAt.getTime() < now.getTime() && rank(base) < rank('high') ? 'high' : base;
}

/** The instant after the last moment of a Bangkok calendar day (`YYYY-MM-DD`). */
export function bangkokDayEnd(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00+07:00`) + 86_400_000);
}

/**
 * Groups tasks by type (in `STAFF_TASK_TYPES` order) then floor (by level; building-wide tasks without a floor
 * first); inside a floor the most urgent first, then the earliest due, then the oldest.
 */
export function groupTasks(tasks: StaffTask[]): StaffTaskGroup[] {
  const groups: StaffTaskGroup[] = [];
  for (const type of STAFF_TASK_TYPES) {
    const ofType = tasks.filter((t) => t.type === type);
    if (!ofType.length) continue;
    const floors = new Map<string, StaffTaskFloor>();
    for (const t of ofType) {
      const key = t.floorId ?? '';
      if (!floors.has(key))
        floors.set(key, { floorId: t.floorId, floorName: t.floorName, floorLevel: t.floorLevel, tasks: [] });
      floors.get(key)!.tasks.push(t);
    }
    const sorted = [...floors.values()].sort(
      (a, b) =>
        (a.floorId === null ? -1 : 0) - (b.floorId === null ? -1 : 0) ||
        (a.floorLevel ?? 0) - (b.floorLevel ?? 0) ||
        (a.floorName ?? '').localeCompare(b.floorName ?? ''),
    );
    for (const f of sorted)
      f.tasks.sort(
        (a, b) =>
          rank(b.priority) - rank(a.priority) ||
          (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.unitNo ?? '').localeCompare(b.unitNo ?? ''),
      );
    groups.push({ type, count: ofType.length, floors: sorted });
  }
  return groups;
}
