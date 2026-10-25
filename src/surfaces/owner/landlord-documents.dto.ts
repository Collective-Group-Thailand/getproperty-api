import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { MoneyOutput } from '../shared/fields';
import { DocumentKindName } from '../shared/status.enums';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class OwnerDocumentListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only the documents of this unit.' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: DocumentKindName, enumName: 'DocumentKind' })
  @IsOptional()
  @IsEnum(DocumentKindName)
  kind?: DocumentKindName;
}

export class OwnerDocumentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: DocumentKindName, enumName: 'DocumentKind', example: DocumentKindName.Contract })
  kind!: DocumentKindName;

  @ApiProperty({ example: 'สัญญาเช่า CTR-2026-00001.pdf' })
  title!: string;

  @ApiProperty({ type: 'integer', example: 48211 })
  sizeBytes!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

/** `ops.stamp_duty_payer` (B7.5, O-019). */
export enum StampDutyPayerName {
  Lessor = 'lessor',
  Lessee = 'lessee',
  Shared = 'shared',
}

/** `ops.stamp_duty_channel`. */
export enum StampDutyChannelName {
  EStamp = 'e_stamp',
  Manual = 'manual',
}

export class StampDutyPaymentDto {
  @ApiProperty({
    enum: StampDutyChannelName,
    enumName: 'StampDutyChannel',
    example: StampDutyChannelName.Manual,
  })
  channel!: StampDutyChannelName;

  @ApiProperty({ type: String, nullable: true, example: 'ES-20261101-0001' })
  reference!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  paidAt!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The receipt; download through `GET /v1/owner/files/{fileId}`.',
  })
  documentId!: string | null;
}

export class StampDutyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @MoneyOutput({
    example: '180.00',
    description: 'Duty in baht (1 baht per 1,000 baht or fraction of the rent over the term).',
  })
  amount!: string;

  @ApiProperty({
    example: true,
    description: 'Fixed at send-for-signature; before that an estimate from the draft terms.',
  })
  fixed!: boolean;

  @ApiProperty({ enum: StampDutyPayerName, enumName: 'StampDutyPayer', example: StampDutyPayerName.Lessor })
  payer!: StampDutyPayerName;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-16',
    description: 'Due date once both parties signed (`lease.stamp_duty.due_days`).',
  })
  dueDate!: string | null;

  @ApiProperty({ type: () => StampDutyPaymentDto, nullable: true })
  paid!: StampDutyPaymentDto | null;

  @ApiProperty({ example: false, description: 'The signed lease can be stamped online through e-Stamp now.' })
  eStampAvailable!: boolean;
}

export class StampDutyRecordDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ใบเสร็จ อ.ส.4 เลขที่ 0012345',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: FAKE.date,
    description: 'Default today (Bangkok).',
  })
  @IsOptional()
  @Matches(DATE)
  paidOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The uploaded receipt (POST /v1/owner/files, kind `other`).',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string | null;
}
