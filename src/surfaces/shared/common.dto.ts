import { FAKE } from '@common/openapi/examples';
import { CursorQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Supported UI and message languages. */
export enum LanguageName {
  Th = 'th',
  En = 'en',
}

export enum NotificationChannelName {
  Line = 'line',
  Sms = 'sms',
  Email = 'email',
  InApp = 'in_app',
  WebPush = 'web_push',
}

export enum NotificationStateName {
  Queued = 'queued',
  HeldQuietHours = 'held_quiet_hours',
  HeldNoConsent = 'held_no_consent',
  Sent = 'sent',
  Delivered = 'delivered',
  Failed = 'failed',
  Read = 'read',
  Cancelled = 'cancelled',
}

export class InboxItemDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'support_grant.requested',
    description: 'Domain event that caused it.',
  })
  eventType!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ขอสิทธิ์เข้าถึงจากทีมซัพพอร์ต' })
  title!: string | null;

  @ApiProperty({ example: 'ทีมซัพพอร์ตขอสิทธิ์เข้าถึงข้อมูลชั่วคราว: ตรวจสอบปัญหาการแจ้งหนี้' })
  body!: string;

  @ApiProperty({
    enum: NotificationStateName,
    enumName: 'NotificationState',
    example: NotificationStateName.Delivered,
  })
  state!: NotificationStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  readAt!: string | null;
}

export class InboxQuery extends CursorQuery {}

export class PushKeysDto {
  @ApiProperty({
    example: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  })
  @IsString()
  @Length(20, 200)
  p256dh!: string;

  @ApiProperty({ example: 'tBHItJI5svbpez7KI4CCXg' })
  @IsString()
  @Length(8, 100)
  auth!: string;
}

export class PushSubscriptionCreateDto {
  @ApiProperty({ example: 'https://push.example.com/send/abc123', description: 'PushSubscription.endpoint' })
  @IsUrl({ protocols: ['https'], require_tld: false })
  @MaxLength(2000)
  endpoint!: string;

  @ApiProperty({ type: () => PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2027-01-01T00:00:00+07:00' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class PushSubscriptionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class RealtimeAuthDto {
  @ApiProperty({
    example: 'eyJzdWIiOiIuLi4ifQ.c2lnbmF0dXJl',
    description: 'Valid 60 s, only to open the stream.',
  })
  streamToken!: string;

  @ApiProperty({ example: '/v1/owner/realtime/stream?token=eyJzdWIiOiIuLi4ifQ.c2lnbmF0dXJl' })
  streamUrl!: string;

  @ApiProperty({ type: [String], example: [`tenant:${FAKE.tenantId}`, `user:${FAKE.uuid}`] })
  channels!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}

export class StreamQuery {
  @ApiProperty({ example: 'eyJzdWIiOiIuLi4ifQ.c2lnbmF0dXJl', description: 'From `realtime/auth`.' })
  @IsString()
  @Length(10, 4000)
  token!: string;
}
