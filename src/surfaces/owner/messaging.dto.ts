import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export enum MessagingChannelStateName {
  Pending = 'pending',
  Verified = 'verified',
  Failing = 'failing',
  Revoked = 'revoked',
}

export enum MessagingLinkStateName {
  Valid = 'valid',
  Used = 'used',
  Expired = 'expired',
}

export class MessagingChannelConnectDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Only this building’s residents; omit for every building of the tenant.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({
    example: '1657000000',
    description: 'LINE Developers console → Messaging API channel → Channel ID.',
  })
  @Matches(/^\d{6,20}$/)
  lineChannelId!: string;

  @ApiProperty({
    example: '0123456789abcdef0123456789abcdef',
    description: 'Basic settings → Channel secret.',
  })
  @IsString()
  @Length(16, 128)
  channelSecret!: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiJ9.long-lived-channel-access-token',
    description:
      'Messaging API → Channel access token (long-lived). Stored encrypted (D-148), never shown again.',
  })
  @IsString()
  @Length(20, 512)
  accessToken!: string;
}

export class MessagingChannelDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ example: '1657000000' })
  lineChannelId!: string;

  @ApiProperty({
    enum: MessagingChannelStateName,
    enumName: 'MessagingChannelState',
    example: MessagingChannelStateName.Verified,
  })
  state!: MessagingChannelStateName;

  @ApiProperty({ type: String, nullable: true, example: 'หอพักสุขใจ' })
  botName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  botPictureUrl!: string | null;

  @ApiProperty({
    example: 'https://api.getproperty.co/webhooks/line/q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5',
    description:
      'Set it as the channel’s Webhook URL in the LINE Developers console and turn “Use webhook” on.',
  })
  webhookUrl!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  verifiedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastCheckedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Why the last check failed.' })
  lastError!: string | null;

  @ApiProperty({ type: 'integer', example: 12, description: 'Residents who linked this OA.' })
  linkedUsers!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class MessagingLinkDto {
  @ApiProperty({ example: 'หอพักสุขใจ', description: 'The operator asking to link.' })
  tenantName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'หอพักสุขใจ' })
  botName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  botPictureUrl!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;

  @ApiProperty({
    enum: MessagingLinkStateName,
    enumName: 'MessagingLinkState',
    example: MessagingLinkStateName.Valid,
  })
  state!: MessagingLinkStateName;
}

export class LineWebhookAckDto {
  @ApiProperty({ type: 'integer', example: 1, description: 'Events acted on (link replies, unfollows).' })
  handled!: number;
}
