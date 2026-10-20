import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type StaffTask } from '@modules/ops-tasks/staff-task-rules';
import { StaffTasksService } from '@modules/ops-tasks/staff-tasks.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { type ServicePriorityName } from '../owner/service.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  StaffTaskCompleteDto,
  StaffTaskDayDto,
  StaffTaskDto,
  StaffTaskQuery,
  StaffTaskResultDto,
  StaffTaskTypeName,
} from './tasks.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;

const taskDto = (t: StaffTask): StaffTaskDto => ({
  type: t.type as StaffTaskTypeName,
  id: t.id,
  buildingId: t.buildingId,
  unitId: t.unitId,
  unitNo: t.unitNo,
  sourceStatus: t.sourceStatus,
  priority: t.priority as ServicePriorityName,
  overdue: t.overdue,
  dueAt: isoOrNull(t.dueAt),
  assigneeUserId: t.assigneeUserId,
  subject: t.subject,
  assetItemId: t.assetItemId,
  createdAt: iso(t.createdAt),
  completable: t.completable,
});

const TASK_EXAMPLE = {
  type: 'work_order',
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  sourceStatus: 'assigned',
  priority: 'high',
  overdue: false,
  dueAt: FAKE.dateTime,
  assigneeUserId: FAKE.uuid,
  subject: 'ก๊อกน้ำรั่ว',
  assetItemId: null,
  createdAt: FAKE.dateTime,
  completable: true,
};
const TYPE_PARAM = { name: 'type', enum: StaffTaskTypeName, enumName: 'StaffTaskType' } as const;

/** My day of tasks on the staff PWA (`/v1/staff/tasks`, B5.4, D-213). */
@ApiTags('staff.tasks')
@ApiSurface(SURFACES.staff)
@Controller('staff/tasks')
export class StaffTasksController {
  constructor(
    private readonly tasks: StaffTasksService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @TenantScoped()
  @Can('staff_task.read')
  @ApiEndpoint({
    id: 'staff.tasks.day',
    summary: 'My day of tasks',
    description:
      'Open work of the buildings I work in (D-090) due on the Bangkok day, overdue or without a date: reading requests (B3.3), move-in / move-out inspections (B2.4), work orders (B5.1), parcels waiting at the desk (B5.3) and platform install orders (B6.1, read-only) — grouped by type and floor, most urgent first; overdue tasks are at least `high`.',
    implements: ['D-213', 'D-090', 'D-072', 'D-073', 'D-081'],
  })
  @ApiSuccess(200, {
    description: 'The day',
    type: StaffTaskDayDto,
    example: {
      date: FAKE.date,
      buildingId: FAKE.buildingId,
      total: 1,
      groups: [
        {
          type: 'work_order',
          count: 1,
          floors: [{ floorId: FAKE.uuid, floorName: 'ชั้น 1', floorLevel: 1, tasks: [TASK_EXAMPLE] }],
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async day(@CurrentTenant() ctx: TenantContext, @Query() q: StaffTaskQuery): Promise<StaffTaskDayDto> {
    const date = q.date ?? bangkokDate(this.clock.now());
    const r = await this.tasks.day(ctx, { buildingId: q.building, date, mine: q.mine });
    return {
      date,
      buildingId: q.building ?? null,
      total: r.total,
      groups: r.groups.map((g) => ({
        type: g.type as StaffTaskTypeName,
        count: g.count,
        floors: g.floors.map((f) => ({
          floorId: f.floorId,
          floorName: f.floorName,
          floorLevel: f.floorLevel,
          tasks: f.tasks.map(taskDto),
        })),
      })),
    };
  }

  @Get(':type/:taskId')
  @TenantScoped()
  @Can('staff_task.read')
  @ApiEndpoint({
    id: 'staff.tasks.get',
    summary: 'One open task',
    description: 'An open task of my buildings; a finished one or one outside my buildings is 404.',
    implements: ['D-213', 'D-090'],
  })
  @ApiParam(TYPE_PARAM)
  @ApiSuccess(200, { description: 'The task', type: StaffTaskDto, example: TASK_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('type', new ParseEnumPipe(StaffTaskTypeName)) type: StaffTaskTypeName,
    @Param('taskId', ParseUUIDPipe) id: string,
  ): Promise<StaffTaskDto> {
    return taskDto(await this.tasks.get(ctx, type, id));
  }

  @Post(':type/:taskId/actions/complete')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('staff_task.read')
  @ApiEndpoint({
    id: 'staff.tasks.complete',
    summary: 'Complete a task',
    description:
      'Writes the source with its own rules and permission: a work order is completed (`note`; an after photo is required), a parcel handed over (`pin` or `staffConfirmed`), a reading request fulfilled by the reading taken now (`photoDocumentId`, `typedValue`, `readAt`; a reading sent to review fulfils it too), an inspection completed and signed (`staffSignaturePng`, `residentSignaturePng`, `note`). Install orders are completed by Collective’s field engineers (409 `staff_task.not_completable`).',
    implements: ['D-213', 'D-072', 'D-073', 'D-035', 'D-023', 'D-081'],
  })
  @ApiParam(TYPE_PARAM)
  @ApiJsonBody(StaffTaskCompleteDto, { note: 'เปลี่ยนก๊อกใหม่แล้ว' })
  @ApiSuccess(200, {
    description: 'Completed on the source',
    type: StaffTaskResultDto,
    example: { type: 'work_order', id: FAKE.uuid, sourceStatus: 'done' },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'auth.forbidden',
    'staff_task.not_completable',
    'work_order.invalid_state',
    'work_order.photo_required',
    'parcel.invalid_state',
    'parcel.pin_mismatch',
    'inspection.invalid_state',
    'reading.photo_required',
    'reading.unreadable',
    'reading.duplicate',
    'reading.non_monotonic',
    ...T,
  )
  async complete(
    @CurrentTenant() ctx: TenantContext,
    @Param('type', new ParseEnumPipe(StaffTaskTypeName)) type: StaffTaskTypeName,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Body() body: StaffTaskCompleteDto,
  ): Promise<StaffTaskResultDto> {
    const r = await this.tasks.complete(ctx, type, id, body);
    return { type: r.type as StaffTaskTypeName, id: r.id, sourceStatus: r.sourceStatus };
  }
}
