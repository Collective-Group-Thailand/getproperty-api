import { FAKE } from '@common/openapi/examples';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, ValidateNested } from 'class-validator';

export enum NotificationTopicName {
  Billing = 'billing',
  Lease = 'lease',
  ServiceRequests = 'service_requests',
  Announcements = 'announcements',
  Parcels = 'parcels',
}

export class NotificationTopicPreferenceDto {
  @ApiProperty({
    enum: NotificationTopicName,
    enumName: 'NotificationTopic',
    example: NotificationTopicName.Announcements,
  })
  topic!: NotificationTopicName;

  @ApiProperty({ example: true })
  line!: boolean;

  @ApiProperty({ example: false })
  sms!: boolean;

  @ApiProperty({ example: false, description: 'Always on (billing, lease); cannot be switched off.' })
  locked!: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty({ type: () => [NotificationTopicPreferenceDto] })
  items!: NotificationTopicPreferenceDto[];
}

export class NotificationTopicPreferenceInputDto {
  @ApiProperty({
    enum: NotificationTopicName,
    enumName: 'NotificationTopic',
    example: NotificationTopicName.Announcements,
  })
  @IsEnum(NotificationTopicName)
  topic!: NotificationTopicName;

  @ApiProperty({ example: true })
  @IsBoolean()
  line!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  sms!: boolean;
}

export class NotificationPreferencesUpdateDto {
  @ApiProperty({ type: () => [NotificationTopicPreferenceInputDto] })
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => NotificationTopicPreferenceInputDto)
  items!: NotificationTopicPreferenceInputDto[];
}

export enum ResidentDocumentKindName {
  LeaseContract = 'lease_contract',
  LeaseNotice = 'lease_notice',
  DepositStatement = 'deposit_statement',
  Receipt = 'receipt',
}

export class ResidentDocumentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'core.document id.' })
  id!: string;

  @ApiProperty({
    enum: ResidentDocumentKindName,
    enumName: 'ResidentDocumentKind',
    example: ResidentDocumentKindName.LeaseContract,
  })
  kind!: ResidentDocumentKindName;

  @ApiProperty({ example: 'สัญญาเช่า CTR-2026-00001 ห้อง A-201' })
  title!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;
}

export class ResidentDocumentDownloadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'สัญญาเช่า CTR-2026-00001 ห้อง A-201' })
  title!: string;

  @ApiProperty({ example: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc' })
  url!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:20:00+07:00' })
  expiresAt!: string;
}
