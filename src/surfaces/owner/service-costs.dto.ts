import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export enum ServiceHandlerName {
  OwnerTechnician = 'owner_technician',
  Tenant = 'tenant',
  Partner = 'partner',
}

export enum ServiceCostBearerName {
  Owner = 'owner',
  Tenant = 'tenant',
  Shared = 'shared',
}

export enum ServiceCostKindName {
  Quotation = 'quotation',
  Receipt = 'receipt',
}

export enum ServiceCostPayerName {
  Owner = 'owner',
  Tenant = 'tenant',
}

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/** The current who-fixes / who-pays decision of a landlord's request (D-263). */
export class ServiceDecisionStateDto {
  @ApiProperty({
    enum: ServiceHandlerName,
    enumName: 'ServiceHandler',
    example: ServiceHandlerName.OwnerTechnician,
  })
  handledBy!: ServiceHandlerName;

  @ApiProperty({
    enum: ServiceCostBearerName,
    enumName: 'ServiceCostBearer',
    example: ServiceCostBearerName.Shared,
  })
  costBearer!: ServiceCostBearerName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '50.00',
    description: 'With a shared cost: the tenant’s share in percent.',
  })
  tenantSharePercent!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  decidedAt!: string;
}

export class ServiceDecisionCreateDto {
  @ApiProperty({
    enum: ServiceHandlerName,
    enumName: 'ServiceHandler',
    example: ServiceHandlerName.OwnerTechnician,
  })
  @IsEnum(ServiceHandlerName)
  handledBy!: ServiceHandlerName;

  @ApiProperty({
    enum: ServiceCostBearerName,
    enumName: 'ServiceCostBearer',
    example: ServiceCostBearerName.Shared,
  })
  @IsEnum(ServiceCostBearerName)
  costBearer!: ServiceCostBearerName;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '50',
    description: 'Required with `shared`: above 0 and below 100, at most two decimals.',
  })
  @IsOptional()
  @Matches(/^\d{1,2}(\.\d{1,2})?$/)
  tenantSharePercent?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ผู้เช่าทำท่อแตกเอง ตกลงแบ่งกันคนละครึ่ง' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;
}

export class ServiceDecisionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: ServiceHandlerName, enumName: 'ServiceHandler', example: ServiceHandlerName.Tenant })
  handledBy!: ServiceHandlerName;

  @ApiProperty({
    enum: ServiceCostBearerName,
    enumName: 'ServiceCostBearer',
    example: ServiceCostBearerName.Owner,
  })
  costBearer!: ServiceCostBearerName;

  @ApiProperty({ type: String, nullable: true, example: null })
  tenantSharePercent!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  decidedAt!: string;
}

export class ServiceCostCreateDto {
  @ApiProperty({
    enum: ServiceCostKindName,
    enumName: 'ServiceCostKind',
    example: ServiceCostKindName.Receipt,
  })
  @IsEnum(ServiceCostKindName)
  kind!: ServiceCostKindName;

  @ApiProperty({ example: 'เปลี่ยนท่อน้ำทิ้งใต้ซิงก์' })
  @IsString()
  @Length(1, 200)
  description!: string;

  @ApiProperty({ example: '1800.00', description: 'Unit: THB, decimal string (D-046).' })
  @Matches(MONEY)
  amount!: string;

  @ApiPropertyOptional({
    enum: ServiceCostPayerName,
    enumName: 'ServiceCostPayer',
    nullable: true,
    example: ServiceCostPayerName.Owner,
    description: 'Receipts only (required): who paid the vendor.',
  })
  @IsOptional()
  @IsEnum(ServiceCostPayerName)
  paidBy?: ServiceCostPayerName | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ช่างสมศักดิ์ ประปา' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  vendorName?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The quotation or receipt file (`POST /v1/owner/files/presign`, then `…/actions/complete`).',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string | null;

  @ApiProperty({ format: 'date', example: '2026-11-03', description: 'Not after today.' })
  @IsDateString({ strict: true })
  issuedOn!: string;
}

export class ServiceCostVoidDto {
  @ApiProperty({ example: 'บันทึกยอดผิด', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  reason!: string;
}

export class ServiceCostDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: ServiceCostKindName,
    enumName: 'ServiceCostKind',
    example: ServiceCostKindName.Receipt,
  })
  kind!: ServiceCostKindName;

  @ApiProperty({ example: 'เปลี่ยนท่อน้ำทิ้งใต้ซิงก์' })
  description!: string;

  @ApiProperty({ example: '1800.00', description: 'Unit: THB, decimal string (D-046).' })
  amount!: string;

  @ApiProperty({
    enum: ServiceCostPayerName,
    enumName: 'ServiceCostPayer',
    nullable: true,
    example: ServiceCostPayerName.Owner,
  })
  paidBy!: ServiceCostPayerName | null;

  @ApiProperty({ type: String, nullable: true, example: 'ช่างสมศักดิ์ ประปา' })
  vendorName!: string | null;

  @ApiProperty({ format: 'date', example: '2026-11-03' })
  issuedOn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  documentId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: '5-minute link to the file once it passed the virus scan.',
  })
  url!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  voidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  voidReason!: string | null;
}

export class ServiceSettlementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    example: '900.00',
    description:
      'Positive: billed to the tenant on the next invoice; negative: credited. THB, decimal string.',
  })
  amount!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The pending invoice charge it created.' })
  invoiceChargeId!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  settledAt!: string;
}

/** What the receipts come to and what is still to settle with the tenant. */
export class ServiceSettlementSummaryDto {
  @ApiProperty({ example: '1800.00' })
  receiptsTotal!: string;

  @ApiProperty({ example: '900.00', description: 'The owner’s share (the expense of the annual summary).' })
  ownerShare!: string;

  @ApiProperty({ example: '900.00' })
  tenantShare!: string;

  @ApiProperty({ example: '1800.00' })
  paidByOwner!: string;

  @ApiProperty({ example: '0.00' })
  paidByTenant!: string;

  @ApiProperty({
    example: '900.00',
    description: 'Positive: the tenant owes the owner; negative: the other way.',
  })
  tenantOwes!: string;

  @ApiProperty({ example: '0.00' })
  settled!: string;

  @ApiProperty({
    example: '900.00',
    description: 'Still to settle: `actions/settle` bills it (positive) or credits it (negative).',
  })
  due!: string;
}

export class ServiceCostsDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  serviceRequestId!: string;

  @ApiProperty({ type: ServiceDecisionStateDto, nullable: true })
  decision!: ServiceDecisionStateDto | null;

  @ApiProperty({ type: [ServiceDecisionDto], description: 'Every decision, oldest first.' })
  decisions!: ServiceDecisionDto[];

  @ApiProperty({ type: [ServiceCostDto] })
  costs!: ServiceCostDto[];

  @ApiProperty({ type: [ServiceSettlementDto] })
  settlements!: ServiceSettlementDto[];

  @ApiProperty({ type: ServiceSettlementSummaryDto })
  settlement!: ServiceSettlementSummaryDto;

  @ApiProperty({
    type: [String],
    example: ['decide', 'add-cost', 'settle'],
    description: 'Actions allowed now.',
  })
  nextActions!: string[];
}
