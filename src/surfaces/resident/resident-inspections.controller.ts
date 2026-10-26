import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import {
  ResidentInspectionsService,
  type ResidentInspectionView,
} from '@modules/ops-deposits/resident-inspections.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBase64, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { InspectionStatusName, InspectionTypeName, ItemConditionName } from '../owner/deposits.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const PNG_EXAMPLE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class ResidentInspectionItemDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ผนังห้องนอน' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องนอน' })
  area!: string | null;

  @ApiProperty({ enum: ItemConditionName, enumName: 'ItemCondition', nullable: true, example: 'good' })
  condition!: ItemConditionName | null;

  @ApiProperty({ type: String, nullable: true, example: 'มีรอยขีดข่วนเล็กน้อยมุมขวา' })
  notes!: string | null;

  @ApiProperty({
    type: [String],
    example: ['https://storage.example.com/inspection.jpg?X-Amz-Signature=abc'],
    description: '5-minute links to the line’s photos.',
  })
  photoUrls!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Meter register read at the inspection.',
  })
  meterRegister!: string | null;
}

/** A completed move-in / move-out report of my lease (L5 5.2, D-253). */
export class ResidentInspectionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ enum: InspectionTypeName, enumName: 'InspectionType', example: 'move_in' })
  type!: InspectionTypeName;

  @ApiProperty({
    enum: InspectionStatusName,
    enumName: 'InspectionStatus',
    example: 'completed',
    description: '`completed` = the owner signed; `signed` = I signed too.',
  })
  status!: InspectionStatusName;

  @ApiProperty({ example: 'A-201' })
  unitNo!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INS-2569-00012' })
  reportNumber!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  completedAt!: string | null;

  @ApiProperty({ example: true })
  ownerSigned!: boolean;

  @ApiProperty({ example: false })
  residentSigned!: boolean;

  @ApiProperty({ example: true, description: 'I may countersign now (lessee or co-tenant, not signed yet).' })
  canCountersign!: boolean;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://storage.example.com/report.pdf?X-Amz-Signature=abc',
    description: '5-minute link to the report PDF.',
  })
  reportUrl!: string | null;

  @ApiProperty({ type: [ResidentInspectionItemDto] })
  items!: ResidentInspectionItemDto[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ResidentInspectionsQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this lease.' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;
}

export class ResidentCountersignDto {
  @ApiProperty({
    example: PNG_EXAMPLE,
    maxLength: 275_000,
    description: 'My drawn signature (PNG ≤ 200 KB, base64).',
  })
  @IsString()
  @IsBase64()
  @MaxLength(275_000)
  signaturePng!: string;
}

function inspectionDto(
  view: Pick<ResidentInspectionView, 'inspection'> & Partial<ResidentInspectionView>,
): ResidentInspectionDto {
  const i = view.inspection;
  return {
    id: i.id,
    leaseId: i.leaseId!,
    type: i.type as InspectionTypeName,
    status: i.status as InspectionStatusName,
    unitNo: i.unit.unitNo,
    reportNumber: i.reportNumber,
    completedAt: isoOrNull(i.completedAt),
    ownerSigned: i.status === 'completed' || i.status === 'signed',
    residentSigned: Boolean(i.residentSignatureDocumentId),
    canCountersign: view.canCountersign ?? false,
    notes: i.notes,
    reportUrl: view.reportUrl ?? null,
    items: i.items.map((item) => ({
      id: item.id,
      label: item.label,
      area: item.area,
      condition: (item.condition as ItemConditionName | null) ?? null,
      notes: item.notes,
      photoUrls: view.photos?.get(item.id) ?? [],
      meterRegister: item.meterRegister?.toFixed(3) ?? null,
    })),
    createdAt: iso(i.createdAt),
  };
}

const EXAMPLE: ResidentInspectionDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  type: 'move_in' as InspectionTypeName,
  status: 'completed' as InspectionStatusName,
  unitNo: 'A-201',
  reportNumber: 'INS-2569-00012',
  completedAt: FAKE.dateTime,
  ownerSigned: true,
  residentSigned: false,
  canCountersign: true,
  notes: null,
  reportUrl: 'https://storage.example.com/report.pdf?X-Amz-Signature=abc',
  items: [
    {
      id: FAKE.uuid,
      label: 'ผนังห้องนอน',
      area: 'ห้องนอน',
      condition: 'good' as ItemConditionName,
      notes: null,
      photoUrls: ['https://storage.example.com/inspection.jpg?X-Amz-Signature=abc'],
      meterRegister: null,
    },
  ],
  createdAt: FAKE.dateTime,
};

@ApiTags('resident.inspections')
@ApiSurface(SURFACES.resident)
@Controller('resident/inspections')
export class ResidentInspectionsController {
  constructor(private readonly inspections: ResidentInspectionsService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.inspections.list',
    summary: 'Move-in and move-out reports of my leases',
    description:
      'Completed reports, newest first (lines without photo links — open one for them). `completed` waits for my countersignature when the owner signed apart (L5 5.2, D-253).',
    implements: ['D-253', 'D-023'],
  })
  @ApiSuccess(200, { description: 'Reports', type: [ResidentInspectionDto], example: [EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: ResidentInspectionsQuery): Promise<ResidentInspectionDto[]> {
    return (await this.inspections.list(query.leaseId)).map((inspection) => inspectionDto({ inspection }));
  }

  @Get(':inspectionId')
  @ApiEndpoint({
    id: 'resident.inspections.get',
    summary: 'One of my move-in / move-out reports',
    description:
      'Every line with its condition, notes and 5-minute photo links, and the report PDF; 404 outside my lease scopes (D-253, D-023).',
    implements: ['D-253', 'D-023'],
  })
  @ApiSuccess(200, { description: 'The report', type: ResidentInspectionDto, example: EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('inspectionId', ParseUUIDPipe) id: string): Promise<ResidentInspectionDto> {
    return inspectionDto(await this.inspections.get(id));
  }

  @Post(':inspectionId/actions/countersign')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.inspections.countersign',
    summary: 'Countersign the report',
    description:
      'I sign a report the owner completed without my signature (lessee or co-tenant, once): it becomes `signed` and the owner hears it in LINE. The report PDF keeps its number and content (L5 5.2, D-253).',
    implements: ['D-253', 'D-023'],
  })
  @ApiJsonBody(ResidentCountersignDto, { signaturePng: PNG_EXAMPLE })
  @ApiSuccess(200, {
    description: 'Countersigned',
    type: ResidentInspectionDto,
    example: {
      ...EXAMPLE,
      status: 'signed' as InspectionStatusName,
      residentSigned: true,
      canCountersign: false,
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'inspection.invalid_state',
    'lease.not_signer',
    'lease.signature_invalid',
  )
  async countersign(
    @Param('inspectionId', ParseUUIDPipe) id: string,
    @Body() body: ResidentCountersignDto,
  ): Promise<ResidentInspectionDto> {
    return inspectionDto(await this.inspections.countersign(id, body.signaturePng));
  }
}
