import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { PlatformInvoiceStatusName } from '../admin/platform-business.dto';

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

  @ApiPropertyOptional({
    format: 'uuid',
    example: '0199f2a0-0000-7000-8000-0000000000cc',
    description:
      'G4 (D-287): the LINE OA integration price version the owner accepts — required only while a priced version is in force for the tenant type (`messaging.addon_terms_required` tells which); see `GET /v1/owner/messaging/addons`.',
  })
  @IsOptional()
  @IsUUID()
  acceptAddonVersionId?: string;
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

/** The shared getproperty OA this month: counted messages against the free ones, and what is charged beyond. */
export class MessagingSharedUsageDto {
  @ApiProperty({
    type: 'integer',
    example: 812,
    description: 'Messages LINE counts (push; replies are free).',
  })
  counted!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 1000,
    description:
      'Free messages this month (per tenant + per unit); null while no rate is published (not charged).',
  })
  allowance!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 188 })
  left!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 81 })
  usedPercent!: number | null;

  @ApiProperty({ type: 'integer', example: 0, description: 'Counted messages beyond the free ones.' })
  chargeable!: number;

  @ApiProperty({ type: String, nullable: true, example: '0.1000', description: 'THB per counted message.' })
  pricePerMessage!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '7.00' })
  vatPercent!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0.00',
    description: 'chargeable × price, ex VAT, THB — billed on the monthly platform invoice.',
  })
  estimatedCharge!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.00' })
  estimatedVat!: string | null;
}

/** The operator's own OA this month: LINE bills the operator; shown, never charged by getproperty. */
export class MessagingOwnUsageDto {
  @ApiProperty({ type: 'integer', example: 240, description: 'Push messages LINE counts on your own OA.' })
  counted!: number;

  @ApiProperty({
    type: 'integer',
    example: 31,
    description: 'Replies (account-linking links): not counted by LINE.',
  })
  replies!: number;
}

export class MessagingUsageDto {
  @ApiProperty({ example: '2026-11', description: 'Bangkok month.' })
  month!: string;

  @ApiProperty({ type: MessagingSharedUsageDto })
  shared!: MessagingSharedUsageDto;

  @ApiProperty({ type: MessagingOwnUsageDto })
  own!: MessagingOwnUsageDto;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'LINE messages refused for quota this month (sent by SMS instead where a phone was known).',
  })
  quotaFallbacks!: number;
}

export class MessagingUsageQuery {
  @ApiPropertyOptional({ example: '2026-11', description: 'YYYY-MM (Bangkok); default this month.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

export enum MessagingRateStateName {
  Entered = 'entered',
  Published = 'published',
  Withdrawn = 'withdrawn',
}

/** A version of the shared OA's charge (platform admin, maker-checker). */
export class MessagingRateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date', example: '2026-12-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: 'integer', example: 500, description: 'Free counted messages per tenant per month.' })
  freePerTenant!: number;

  @ApiProperty({
    type: 'integer',
    example: 10,
    description: 'Free counted messages per active unit per month.',
  })
  freePerUnit!: number;

  @ApiProperty({ example: '0.1000', description: 'THB per counted message beyond the free ones.' })
  pricePerMessage!: string;

  @ApiProperty({ example: '7.00' })
  vatPercent!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({
    enum: MessagingRateStateName,
    enumName: 'MessagingRateState',
    example: MessagingRateStateName.Entered,
  })
  state!: MessagingRateStateName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  enteredBy!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  enteredAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  publishedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  publishedAt!: string | null;
}

export class MessagingRateCreateDto {
  @ApiProperty({ format: 'date', example: '2026-12-01', description: 'Today or later (Bangkok).' })
  @IsDateString({ strict: true })
  effectiveFrom!: string;

  @ApiProperty({ type: 'integer', example: 500, minimum: 0, maximum: 1000000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  freePerTenant!: number;

  @ApiPropertyOptional({ type: 'integer', example: 10, minimum: 0, maximum: 100000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  freePerUnit?: number;

  @ApiProperty({ example: '0.1000', description: 'THB, up to 4 decimals.' })
  @Matches(/^\d{1,5}(\.\d{1,4})?$/)
  pricePerMessage!: string;

  @ApiProperty({ example: '7.00' })
  @Matches(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/)
  vatPercent!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตาม LINE Pro ส.ค. 2567', maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  notes?: string | null;
}

/** What a prospect may see of the shared OA's charge (no tenant data). */
export class PublicMessagingRateDto {
  @ApiProperty({ format: 'date', example: '2026-12-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: 'integer', example: 500 })
  freePerTenant!: number;

  @ApiProperty({ type: 'integer', example: 10 })
  freePerUnit!: number;

  @ApiProperty({ example: '0.1000' })
  pricePerMessage!: string;

  @ApiProperty({ example: '7.00' })
  vatPercent!: string;

  @ApiProperty({
    example: true,
    description: 'Replies are never charged; only messages LINE counts (push) beyond the free ones.',
  })
  repliesFree!: boolean;
}

export class PublicPricingDto {
  @ApiProperty({
    type: PublicMessagingRateDto,
    nullable: true,
    description: 'The shared getproperty LINE OA in force today; null = messaging not charged.',
  })
  messaging!: PublicMessagingRateDto | null;

  @ApiProperty({
    type: PublicMessagingRateDto,
    nullable: true,
    description: 'A published change that takes effect later, if any.',
  })
  messagingNext!: PublicMessagingRateDto | null;
}

export enum MessagingAddonChargeName {
  Setup = 'setup',
  Monthly = 'monthly',
}

export class MessagingAddonOfferDto {
  @ApiProperty({ example: 'line_oa_integration' })
  planKey!: string;

  @ApiProperty({ example: 'เชื่อม LINE OA ของบริษัทนายหน้า' })
  nameTh!: string;

  @ApiProperty({ example: 'Agency LINE OA integration' })
  nameEn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  versionId!: string | null;

  @ApiProperty({
    example: false,
    description:
      'false = no published price (O-027): connecting is free and nothing is charged ("ยังไม่เปิดขาย").',
  })
  onSale!: boolean;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Monthly fee before VAT (THB).' })
  monthlyFee!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'One-time setup fee before VAT (THB).',
  })
  setupFee!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveFrom!: string | null;
}

export class MessagingAddonInvoiceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'PINV-2026-000123' })
  number!: string;

  @ApiProperty({ enum: MessagingAddonChargeName, enumName: 'MessagingAddonCharge', example: 'monthly' })
  charge!: MessagingAddonChargeName;

  @ApiProperty({ type: String, format: 'date', example: '2026-12-01' })
  periodStart!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-12-31' })
  periodEnd!: string;

  @ApiProperty({ example: '1059.30', description: 'Incl. VAT (THB).' })
  total!: string;

  @ApiProperty({ enum: PlatformInvoiceStatusName, enumName: 'PlatformInvoiceStatus', example: 'issued' })
  state!: PlatformInvoiceStatusName;
}

export class MessagingAddonsDto {
  @ApiProperty({
    type: MessagingAddonOfferDto,
    nullable: true,
    description: 'null = no OA integration add-on for this tenant type (connecting is free, D-254).',
  })
  offer!: MessagingAddonOfferDto | null;

  @ApiProperty({ example: false, description: 'The setup fee was already invoiced (it is charged once).' })
  setupCharged!: boolean;

  @ApiProperty({ type: [MessagingAddonInvoiceDto] })
  invoices!: MessagingAddonInvoiceDto[];
}
