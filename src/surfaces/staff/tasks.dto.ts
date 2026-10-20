import { STAFF_TASK_TYPES, TASK_PRIORITIES } from '@modules/ops-tasks/staff-task-rules';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { ServicePriorityName } from '../owner/service.dto';
import { REGISTER } from '../shared/smart.dto';

const toBool = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';

export enum StaffTaskTypeName {
  WorkOrder = 'work_order',
  Inspection = 'inspection',
  Reading = 'reading',
  Parcel = 'parcel',
  Install = 'install',
}
// the DTO enums mirror the module's lists (checked at load)
if (
  JSON.stringify(Object.values(StaffTaskTypeName)) !== JSON.stringify(STAFF_TASK_TYPES) ||
  JSON.stringify(Object.values(ServicePriorityName)) !== JSON.stringify(TASK_PRIORITIES)
)
  throw new Error('staff task enums out of sync');

export class StaffTaskQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'One building (default: every building I work in).' })
  @IsOptional()
  @IsUUID()
  building?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'The Bangkok day (default: today).',
    example: '2026-11-03',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only tasks assigned to me and unassigned ones.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  mine?: boolean;
}

export class StaffTaskDto {
  @ApiProperty({ enum: StaffTaskTypeName, enumName: 'StaffTaskType' })
  type!: StaffTaskTypeName;

  @ApiProperty({
    format: 'uuid',
    description: 'The id of the source (work order, inspection, reading request, …).',
  })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'A-101' })
  unitNo!: string | null;

  @ApiProperty({
    type: String,
    description:
      'The source’s own status (work order `assigned`, inspection `scheduled`, reading request `open`, parcel `notified`, install order `open`, …).',
    example: 'assigned',
  })
  sourceStatus!: string;

  @ApiProperty({
    enum: ServicePriorityName,
    enumName: 'ServicePriority',
    description: 'Raised to `high` once overdue.',
  })
  priority!: ServicePriorityName;

  @ApiProperty()
  overdue!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Visit, scheduled inspection, reading due or install due time.',
  })
  dueAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assigneeUserId!: string | null;

  @ApiProperty({
    description:
      'Work order title, meter code, inspection type (`move_in`, `move_out`, `periodic`), parcel carrier, install order kind.',
    example: 'ก๊อกน้ำรั่ว',
  })
  subject!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The meter or equipment.' })
  assetItemId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    description: 'False for install orders (Collective’s field engineers complete them, D-081).',
  })
  completable!: boolean;
}

export class StaffTaskFloorDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Null: building-wide tasks.' })
  floorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ชั้น 1' })
  floorName!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  floorLevel!: number | null;

  @ApiProperty({ type: [StaffTaskDto] })
  tasks!: StaffTaskDto[];
}

export class StaffTaskGroupDto {
  @ApiProperty({ enum: StaffTaskTypeName, enumName: 'StaffTaskType' })
  type!: StaffTaskTypeName;

  @ApiProperty({ example: 3 })
  count!: number;

  @ApiProperty({ type: [StaffTaskFloorDto] })
  floors!: StaffTaskFloorDto[];
}

export class StaffTaskDayDto {
  @ApiProperty({ format: 'date' })
  date!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  buildingId!: string | null;

  @ApiProperty({ example: 7 })
  total!: number;

  @ApiProperty({ type: [StaffTaskGroupDto] })
  groups!: StaffTaskGroupDto[];
}

export class StaffTaskCompleteDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    description: 'Work order completion note, inspection notes.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '482913',
    description: 'Parcel: the PIN the resident shows.',
  })
  @IsOptional()
  @Matches(/^\d{6}$/)
  pin?: string;

  @ApiPropertyOptional({ description: 'Parcel: hand-over confirmed by staff without the PIN.' })
  @IsOptional()
  @IsBoolean()
  staffConfirmed?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Reading: the uploaded meter photo.' })
  @IsOptional()
  @IsUUID()
  photoDocumentId?: string;

  @ApiPropertyOptional({ type: String, pattern: REGISTER.source, description: 'Reading: the value read.' })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  typedValue?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Reading: when it was read (default now).',
  })
  @IsOptional()
  @IsDateString()
  readAt?: string;

  @ApiPropertyOptional({ description: 'Inspection: the inspector’s signature (PNG, base64).' })
  @IsOptional()
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  staffSignaturePng?: string;

  @ApiPropertyOptional({
    description: 'Inspection: the resident’s signature on the staff device (PNG, base64).',
  })
  @IsOptional()
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  residentSignaturePng?: string;
}

export class StaffTaskResultDto {
  @ApiProperty({ enum: StaffTaskTypeName, enumName: 'StaffTaskType' })
  type!: StaffTaskTypeName;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The source’s status after completion.', example: 'done' })
  sourceStatus!: string;
}
