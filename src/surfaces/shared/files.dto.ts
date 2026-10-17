import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Uploadable kinds (server-produced PDFs and exports are not uploadable). */
export enum UploadKindName {
  MeterPhoto = 'meter_photo',
  InspectionPhoto = 'inspection_photo',
  ServicePhoto = 'service_photo',
  Slip = 'slip',
  IdDocument = 'id_document',
  Logo = 'logo',
  Contract = 'contract',
  UtilityInvoice = 'utility_invoice',
  FloorPlan = 'floor_plan',
  AsBuilt = 'as_built',
  Certificate = 'certificate',
  Warranty = 'warranty',
  Other = 'other',
}

export enum DocumentScopeName {
  Tenant = 'tenant',
  Property = 'property',
  Building = 'building',
  Floor = 'floor',
  Unit = 'unit',
  Party = 'party',
  AssetItem = 'asset_item',
}

export enum DocumentScanStatusName {
  Pending = 'pending',
  Clean = 'clean',
  Infected = 'infected',
  Failed = 'failed',
  Skipped = 'skipped',
}

export enum DocumentUploadStateName {
  Presigned = 'presigned',
  Uploaded = 'uploaded',
  Verified = 'verified',
  Deleted = 'deleted',
}

export class FilePresignDto {
  @ApiProperty({ enum: UploadKindName, enumName: 'UploadKind', example: UploadKindName.MeterPhoto })
  @IsEnum(UploadKindName)
  kind!: UploadKindName;

  @ApiProperty({ enum: DocumentScopeName, enumName: 'DocumentScope', example: DocumentScopeName.Unit })
  @IsEnum(DocumentScopeName)
  scopeType!: DocumentScopeName;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Id of the scope row (not for `tenant`).',
  })
  @IsOptional()
  @IsUUID()
  scopeId?: string | null;

  @ApiProperty({ example: 'meter-A-201.jpg', maxLength: 255 })
  @IsString()
  @Length(1, 255)
  fileName!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @ApiProperty({ type: 'integer', minimum: 1, example: 2_345_678 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @ApiProperty({
    example: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    description: 'Hex SHA-256 of the file.',
  })
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'มิเตอร์ห้อง A-201' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;
}

export class FileDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'meter_photo' })
  kind!: string;

  @ApiProperty({ enum: DocumentScopeName, enumName: 'DocumentScope', example: DocumentScopeName.Unit })
  scopeType!: DocumentScopeName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  scopeId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  buildingId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'มิเตอร์ห้อง A-201' })
  title!: string | null;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;

  @ApiProperty({ type: 'integer', example: 2_345_678 })
  sizeBytes!: number;

  @ApiProperty({ type: 'integer', nullable: true, example: 1920 })
  width!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1080 })
  height!: number | null;

  @ApiProperty({ example: 'meter_photo', description: 'Retention class (platform.retention_policy).' })
  retentionClass!: string;

  @ApiProperty({
    enum: DocumentScanStatusName,
    enumName: 'DocumentScanStatus',
    example: DocumentScanStatusName.Clean,
  })
  scanStatus!: DocumentScanStatusName;

  @ApiProperty({
    enum: DocumentUploadStateName,
    enumName: 'DocumentUploadState',
    example: DocumentUploadStateName.Verified,
  })
  uploadState!: DocumentUploadStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class MultipartPartDto {
  @ApiProperty({ type: 'integer', example: 1 })
  partNumber!: number;

  @ApiProperty({ example: 'https://storage.example.com/upload/part-1?X-Amz-Signature=…' })
  url!: string;
}

export class MultipartUploadDto {
  @ApiProperty({ example: 'upload-1' })
  uploadId!: string;

  @ApiProperty({ type: 'integer', example: 10_000_000 })
  partSize!: number;

  @ApiProperty({ type: [MultipartPartDto] })
  parts!: MultipartPartDto[];
}

export class FilePresignedDto {
  @ApiProperty({ type: FileDto })
  file!: FileDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://storage.example.com/upload?X-Amz-Signature=…',
    description: 'Single PUT (null for multipart).',
  })
  uploadUrl!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'image/jpeg' },
  })
  headers!: Record<string, string>;

  @ApiProperty({ type: MultipartUploadDto, nullable: true, example: null })
  multipart!: MultipartUploadDto | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}

export class CompletedPartDto {
  @ApiProperty({ type: 'integer', example: 1 })
  @IsInt()
  @Min(1)
  partNumber!: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  @IsString()
  @MaxLength(200)
  etag!: string;
}

export class FileCompleteDto {
  @ApiPropertyOptional({ example: 'upload-1', description: 'Multipart uploads only.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  uploadId?: string;

  @ApiPropertyOptional({ type: [CompletedPartDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts?: CompletedPartDto[];
}

export class FileDownloadQuery {
  @ApiPropertyOptional({
    example: 'ตรวจสอบสลิป',
    description: 'Why the file is opened (recorded for PDPA-sensitive kinds).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  purpose?: string;
}

export class FileDownloadDto {
  @ApiProperty({ type: FileDto })
  file!: FileDto;

  @ApiProperty({ example: 'https://storage.example.com/file?X-Amz-Signature=…' })
  url!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  thumbnailUrl!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}
