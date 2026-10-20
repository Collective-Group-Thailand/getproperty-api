import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantTx } from '@database/tenant-tx';
import { Prisma } from '@generated/prisma/client';
import { ParcelsService } from '@modules/ops-community/parcels.service';
import { InspectionsService } from '@modules/ops-deposits/inspections.service';
import { WorkOrdersService } from '@modules/ops-service/work-orders.service';
import { MeterReadingsService } from '@modules/smart-readings/meter-readings.service';
import { ReadingRequestsService } from '@modules/smart-readings/reading-requests.service';
import { Inject, Injectable } from '@nestjs/common';

import {
  bangkokDayEnd,
  groupTasks,
  STAFF_TASK_COMPLETION,
  type StaffTask,
  type StaffTaskGroup,
  type StaffTaskType,
  taskPriority,
} from './staff-task-rules';

interface ViewRow {
  type: StaffTaskType;
  id: string;
  building_id: string;
  unit_id: string | null;
  unit_no: string | null;
  floor_id: string | null;
  floor_name: string | null;
  floor_level: number | null;
  source_status: string;
  priority: string;
  due_at: Date | null;
  assignee_user_id: string | null;
  subject: string;
  asset_item_id: string | null;
  created_at: Date;
}

export interface StaffTaskCompletion {
  /** work orders, inspections */
  note?: string | null;
  /** parcels */
  pin?: string;
  staffConfirmed?: boolean;
  /** reading requests */
  photoDocumentId?: string | null;
  typedValue?: string | null;
  readAt?: string | null;
  /** inspections */
  staffSignaturePng?: string;
  residentSignaturePng?: string;
}

/**
 * Staff tasks (B5.4, D-213): the day of a building's staff from the `ops.staff_task` view — reading requests,
 * inspections, install orders (read-only: Collective's field engineers work them, D-081), work orders and parcels —
 * grouped by type and floor with a priority; completing a task writes its source aggregate through the source's own
 * service (and permission), so every rule, audit row and event of that module applies.
 */
@Injectable()
export class StaffTasksService {
  constructor(
    private readonly db: TenantTx,
    private readonly workOrders: WorkOrdersService,
    private readonly parcels: ParcelsService,
    private readonly inspections: InspectionsService,
    private readonly readings: MeterReadingsService,
    private readonly readingRequests: ReadingRequestsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private scope(ctx: TenantContext, buildingId?: string): Prisma.Sql {
    if (buildingId && ctx.buildingIds && !ctx.buildingIds.includes(buildingId))
      throw new DomainException('http.not_found');
    const parts: Prisma.Sql[] = [Prisma.sql`t.tenant_id = ${ctx.tenantId}::uuid`];
    if (buildingId) parts.push(Prisma.sql`t.building_id = ${buildingId}::uuid`);
    if (ctx.buildingIds) parts.push(Prisma.sql`t.building_id = ANY(${[...ctx.buildingIds]}::uuid[])`);
    return Prisma.join(parts, ' AND ');
  }

  private rows(ctx: TenantContext, where: Prisma.Sql): Promise<ViewRow[]> {
    return this.db.tenant(
      ctx,
      (tx) =>
        tx.$queryRaw<ViewRow[]>`
        SELECT t.type, t.id, t.building_id, t.unit_id, u.unit_no::text AS unit_no, u.floor_id,
               f.name AS floor_name, f.level::int AS floor_level, t.source_status, t.priority, t.due_at,
               t.assignee_user_id, t.subject, t.asset_item_id, t.created_at
          FROM ops.staff_task t
          LEFT JOIN core.unit u ON u.id = t.unit_id
          LEFT JOIN core.floor f ON f.id = u.floor_id
         WHERE ${where}`,
    );
  }

  private task(r: ViewRow, now: Date): StaffTask {
    return {
      type: r.type,
      id: r.id,
      buildingId: r.building_id,
      unitId: r.unit_id,
      unitNo: r.unit_no,
      floorId: r.floor_id,
      floorName: r.floor_name,
      floorLevel: r.floor_level,
      sourceStatus: r.source_status,
      priority: taskPriority(r.priority, r.due_at, now),
      overdue: !!r.due_at && r.due_at.getTime() < now.getTime(),
      dueAt: r.due_at,
      assigneeUserId: r.assignee_user_id,
      subject: r.subject,
      assetItemId: r.asset_item_id,
      createdAt: r.created_at,
      completable: STAFF_TASK_COMPLETION[r.type] !== null,
    };
  }

  /**
   * The tasks of a Bangkok day: due that day, overdue, or without a date (parcels, unscheduled work); `mine` keeps
   * the ones assigned to me and the unassigned ones.
   */
  async day(
    ctx: TenantContext,
    f: { buildingId?: string; date: string; mine?: boolean },
  ): Promise<{ total: number; groups: StaffTaskGroup[] }> {
    const end = bangkokDayEnd(f.date);
    const me = userIdOf(RequestContext.actor());
    const where = Prisma.join(
      [
        this.scope(ctx, f.buildingId),
        Prisma.sql`(t.due_at IS NULL OR t.due_at < ${end})`,
        ...(f.mine && me
          ? [Prisma.sql`(t.assignee_user_id IS NULL OR t.assignee_user_id = ${me}::uuid)`]
          : []),
      ],
      ' AND ',
    );
    const now = this.clock.now();
    const tasks = (await this.rows(ctx, where)).map((r) => this.task(r, now));
    return { total: tasks.length, groups: groupTasks(tasks) };
  }

  async get(ctx: TenantContext, type: StaffTaskType, id: string): Promise<StaffTask> {
    const [row] = await this.rows(
      ctx,
      Prisma.join([this.scope(ctx), Prisma.sql`t.type = ${type} AND t.id = ${id}::uuid`], ' AND '),
    );
    if (!row) throw new DomainException('http.not_found');
    return this.task(row, this.clock.now());
  }

  /**
   * Completes a task on its source: a work order is completed (after photo required), a parcel handed over, a
   * reading request fulfilled by the reading taken now, an inspection completed and signed. Install orders are
   * Collective's (409 `staff_task.not_completable`). The source's permission is required (403 otherwise).
   */
  async complete(
    ctx: TenantContext,
    type: StaffTaskType,
    id: string,
    input: StaffTaskCompletion,
  ): Promise<{ type: StaffTaskType; id: string; sourceStatus: string }> {
    const task = await this.get(ctx, type, id);
    const permission = STAFF_TASK_COMPLETION[type];
    if (!permission) throw new DomainException('staff_task.not_completable', { params: { type } });
    if (!RequestContext.permissions().has(permission)) throw new DomainException('auth.forbidden');
    switch (type) {
      case 'work_order': {
        const wo = await this.workOrders.act(ctx, id, 'complete', { note: input.note ?? null });
        return { type, id, sourceStatus: wo.status };
      }
      case 'parcel': {
        if (!input.pin && !input.staffConfirmed)
          throw missing('pin', 'the PIN shown by the resident or staffConfirmed');
        const p = await this.parcels.pickUp(ctx, id, {
          pin: input.pin,
          staffConfirmed: input.staffConfirmed,
        });
        return { type, id, sourceStatus: p.status };
      }
      case 'reading': {
        if (!input.photoDocumentId) throw missing('photoDocumentId', 'the photo of the meter');
        const reading = await this.readings.submit(
          ctx,
          {
            assetItemId: task.assetItemId!,
            photoDocumentId: input.photoDocumentId,
            typedValue: input.typedValue ?? null,
            readAt: input.readAt ?? null,
          },
          'staff_pwa',
        );
        // fulfil now (the subscriber of the reading's event finds nothing left); a rejected reading fulfils nothing
        const fulfilled =
          reading.reviewState === 'rejected'
            ? null
            : await this.db.tenant(ctx, (tx) => this.readingRequests.fulfilIn(tx, reading.id));
        return { type, id, sourceStatus: fulfilled?.status ?? 'open' };
      }
      case 'inspection': {
        const i = await this.inspections.complete(ctx, id, {
          staffSignaturePng: input.staffSignaturePng,
          residentSignaturePng: input.residentSignaturePng,
          notes: input.note ?? null,
        });
        return { type, id, sourceStatus: i.status };
      }
      default:
        throw new DomainException('staff_task.not_completable', { params: { type } });
    }
  }
}

function missing(path: string, message: string): DomainException {
  return new DomainException('validation.failed', { errors: [{ path, code: 'required', message }] });
}
