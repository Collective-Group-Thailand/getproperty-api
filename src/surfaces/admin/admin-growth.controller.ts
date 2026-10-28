import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import {
  accrualState,
  type FeeAccrualRow,
  FeeInvoicingService,
} from '@modules/platform-subscriptions/fee-invoicing.service';
import {
  type MediaOrderRow,
  MediaServicesService,
} from '@modules/platform-subscriptions/media-services.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { ReasonDto } from '../owner/governance.dto';
import { MediaServiceOrderDto, MediaServiceStateName } from '../owner/growth.dto';
import { MEDIA_ORDER_EXAMPLE, mediaOrderDto } from '../owner/growth.mappers';
import { FeeAccrualKindName, FeeBillingUnitName } from '../owner/mandates.dto';
import { MoneyOutput } from '../shared/fields';
import { FILE_EXAMPLE, fileDto } from '../shared/files.controller';
import { FilePresignedDto } from '../shared/files.dto';
import { ApiSurface, SURFACES } from '../surfaces';

// ------------------------------------------------------------------------------------------- fee accruals

export enum FeeAccrualStateName {
  Uninvoiced = 'uninvoiced',
  Invoiced = 'invoiced',
  Disputed = 'disputed',
  Credited = 'credited',
}

export class FeeAccrualListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId, description: 'The paying agency.' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: FeeAccrualStateName, enumName: 'FeeAccrualState' })
  @IsOptional()
  @IsEnum(FeeAccrualStateName)
  state?: FeeAccrualStateName;
}

export class FeeInvoiceRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'PIV-2026-00040' })
  number!: string;

  @ApiProperty({ example: 'issued', description: 'Platform invoice status.' })
  state!: string;
}

export class FeeCreditNoteRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'requested', description: 'Platform credit note status.' })
  state!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  number!: string | null;

  @MoneyOutput({ example: '1605.00', description: 'Credited amount incl. VAT.' })
  amount!: string;
}

export class AdminFeeAccrualDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The paying agency tenant.' })
  tenantId!: string;

  @ApiProperty({ example: FAKE.companyName })
  tenantName!: string;

  @ApiProperty({ format: 'uuid' })
  dealId!: string;

  @ApiProperty({ format: 'uuid' })
  leaseId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({
    enum: FeeAccrualKindName,
    enumName: 'FeeAccrualKind',
    example: FeeAccrualKindName.SuccessFee,
  })
  kind!: FeeAccrualKindName;

  @ApiProperty({
    enum: FeeBillingUnitName,
    enumName: 'FeeBillingUnit',
    example: FeeBillingUnitName.PercentOfAmount,
  })
  billingUnit!: FeeBillingUnitName;

  @ApiProperty({ example: '10.0000' })
  rate!: string;

  @MoneyOutput({ example: '15000.00', nullable: true, description: 'Base of the percentage.' })
  baseAmount!: string | null;

  @MoneyOutput({ example: '1500.00', description: 'Fee accrued (before VAT).' })
  amount!: string;

  @ApiProperty({ example: false })
  capped!: boolean;

  @ApiProperty({ format: 'date', example: FAKE.date })
  accruedOn!: string;

  @ApiProperty({
    enum: FeeAccrualStateName,
    enumName: 'FeeAccrualState',
    example: FeeAccrualStateName.Invoiced,
  })
  state!: FeeAccrualStateName;

  @ApiProperty({ type: FeeInvoiceRefDto, nullable: true })
  invoice!: FeeInvoiceRefDto | null;

  @ApiProperty({ type: FeeCreditNoteRefDto, nullable: true })
  creditNote!: FeeCreditNoteRefDto | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function adminFeeAccrualDto(a: FeeAccrualRow): AdminFeeAccrualDto {
  const inv = a.platformInvoiceLine?.invoice ?? null;
  return {
    id: a.id,
    tenantId: a.tenantId,
    tenantName: a.tenant.displayName,
    dealId: a.dealId,
    leaseId: a.deal.leaseId,
    unitNo: a.deal.unit.unitNo,
    kind: a.kind as FeeAccrualKindName,
    billingUnit: a.billingUnit as FeeBillingUnitName,
    rate: a.rate.toFixed(4),
    baseAmount: a.baseAmount?.toFixed(2) ?? null,
    amount: a.amount.toFixed(2),
    capped: a.capped,
    accruedOn: day(a.accruedOn),
    state: accrualState(a) as FeeAccrualStateName,
    invoice: inv ? { id: inv.id, number: inv.number, state: inv.state } : null,
    creditNote: a.creditNote
      ? {
          id: a.creditNote.id,
          state: a.creditNote.state,
          number: a.creditNote.number,
          amount: a.creditNote.amount.toFixed(2),
        }
      : null,
  };
}

const ACCRUAL_EXAMPLE: AdminFeeAccrualDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  tenantName: FAKE.companyName,
  dealId: '0199f2a0-0000-7000-8000-0000000000f1',
  leaseId: '0199f2a0-0000-7000-8000-0000000000f2',
  unitNo: FAKE.unitCode,
  kind: FeeAccrualKindName.SuccessFee,
  billingUnit: FeeBillingUnitName.PercentOfAmount,
  rate: '10.0000',
  baseAmount: '15000.00',
  amount: '1500.00',
  capped: false,
  accruedOn: FAKE.date,
  state: FeeAccrualStateName.Invoiced,
  invoice: { id: '0199f2a0-0000-7000-8000-0000000000f3', number: 'PIV-2026-00040', state: 'issued' },
  creditNote: null,
};

/**
 * Success / co-broke fees (G5, D-287, D-293, D-297): accrued per deal by G2, put on one `purchase` platform invoice
 * per agency each month by the `growth-fees` job; Finance disputes one → a platform credit note (maker) that another
 * platform user approves or rejects with the existing credit-note actions (D-091).
 */
@ApiTags('admin.feeAccruals')
@ApiSurface(SURFACES.admin)
@Controller('admin/fee-accruals')
export class AdminFeeAccrualsController {
  constructor(private readonly fees: FeeInvoicingService) {}

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.feeAccruals.list',
    summary: 'Success / co-broke fee accruals',
    description:
      'Fees accrued per deal (D-293) with their state: `uninvoiced` (waits for the monthly invoice of its month), `invoiced`, `disputed` (credit note waiting for approval), `credited` (D-297). Newest first.',
    implements: ['D-287', 'D-293', 'D-297'],
  })
  @ApiPaginated(AdminFeeAccrualDto, { example: ACCRUAL_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: FeeAccrualListQuery): Promise<Page<AdminFeeAccrualDto>> {
    const { rows, total } = await this.fees.list({
      tenantId: query.tenantId,
      state: query.state,
      ...toSkipTake(query),
    });
    return paginated(rows.map(adminFeeAccrualDto), total, query);
  }

  @Post(':accrualId/actions/dispute')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.platform_invoice.issue')
  @ApiEndpoint({
    id: 'admin.feeAccruals.dispute',
    summary: 'Dispute a fee (request a credit note)',
    description:
      'Requests a platform credit note (maker, D-091) on the fee’s invoice for what the fee was charged incl. VAT (after a monthly cap, pro rata), never more than the unpaid part (money already paid is refunded by Finance outside the platform); linked to the accrual. Another platform user approves or rejects it (`/v1/admin/platform-invoices/credit-notes/{id}/actions/approve|reject`); a rejected dispute may be raised again. Not invoiced yet: `fee.not_invoiced`; a note waiting or issued: `fee.already_disputed`.',
    implements: ['D-091', 'D-297'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'สัญญาเช่ายกเลิกก่อนเข้าอยู่ ตกลงคืนค่าธรรมเนียม' })
  @ApiSuccess(200, {
    description: 'Disputed',
    type: AdminFeeAccrualDto,
    example: {
      ...ACCRUAL_EXAMPLE,
      state: FeeAccrualStateName.Disputed,
      creditNote: { id: FAKE.uuid, state: 'requested', number: null, amount: '1605.00' },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'fee.not_invoiced',
    'fee.already_disputed',
    'platform_invoice.invalid_state',
    'platform_invoice.amount_exceeds_open',
  )
  async dispute(
    @Param('accrualId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminFeeAccrualDto> {
    return adminFeeAccrualDto(await this.fees.dispute(id, body.reason));
  }
}

// ------------------------------------------------------------------------------------------- media services

export class AdminMediaOrderListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: MediaServiceStateName, enumName: 'MediaServiceState' })
  @IsOptional()
  @IsEnum(MediaServiceStateName)
  state?: MediaServiceStateName;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class AdminMediaServiceOrderDto extends MediaServiceOrderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.companyName })
  tenantName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'PARTNER-2026-0042' })
  partnerRef!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  scheduledAt!: string | null;
}

export class MediaScheduleDto {
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime, description: 'The partner’s visit.' })
  @IsDateString()
  scheduledFor!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200, example: 'PARTNER-2026-0042' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partnerRef?: string | null;
}

export enum MediaDeliverableKindName {
  ListingPhoto = 'listing_photo',
  Other = 'other',
}

export class MediaDeliverableDto {
  @ApiProperty({
    enum: MediaDeliverableKindName,
    enumName: 'MediaDeliverableKind',
    example: MediaDeliverableKindName.ListingPhoto,
  })
  @IsEnum(MediaDeliverableKindName)
  kind!: MediaDeliverableKindName;

  @ApiProperty({ example: 'room-301-01.jpg', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @ApiProperty({ type: 'integer', minimum: 1, example: 2_345_678 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @ApiProperty({ example: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' })
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องนั่งเล่น' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;
}

export class MediaDeliverDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Uploaded deliverables (presigned with `POST …/deliverables`).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @IsUUID('all', { each: true })
  documentIds!: string[];
}

export function adminMediaOrderDto(o: MediaOrderRow): AdminMediaServiceOrderDto {
  return {
    ...mediaOrderDto(o),
    tenantId: o.tenantId,
    tenantName: o.tenant.displayName,
    partnerRef: o.partnerRef,
    scheduledAt: o.scheduledAt ? toBangkokIso(o.scheduledAt) : null,
  };
}

const ADMIN_ORDER_EXAMPLE: AdminMediaServiceOrderDto = {
  ...MEDIA_ORDER_EXAMPLE,
  state: MediaServiceStateName.Requested,
  requestedAt: FAKE.dateTime,
  tenantId: FAKE.tenantId,
  tenantName: FAKE.companyName,
  partnerRef: null,
  scheduledAt: null,
};

/**
 * Verified photo / 360° orders seen by the platform team (G5, D-297): a partner fulfils them (O-032). Schedule the
 * visit, upload the deliverables as documents of the ordering tenant (unit scope, counted to its quota — D-286), mark
 * the order delivered, or cancel it (money back only through a credit note, D-091).
 */
@ApiTags('admin.mediaServices')
@ApiSurface(SURFACES.admin)
@Controller('admin/media-service-orders')
export class AdminMediaServicesController {
  constructor(private readonly media: MediaServicesService) {}

  @Get()
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.list',
    summary: 'Media service orders',
    description: 'Verified photo / 360° orders of every tenant, newest first (D-297).',
    implements: ['D-297'],
  })
  @ApiPaginated(AdminMediaServiceOrderDto, { example: ADMIN_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: AdminMediaOrderListQuery): Promise<Page<AdminMediaServiceOrderDto>> {
    const { rows, total } = await this.media.list({
      state: query.state,
      tenantId: query.tenantId,
      ...toSkipTake(query),
    });
    return paginated(rows.map(adminMediaOrderDto), total, query);
  }

  @Get(':orderId')
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.get',
    summary: 'One media service order',
    description: 'A media service order with its tenant, partner reference and deliverables (D-297).',
    implements: ['D-297'],
  })
  @ApiSuccess(200, { description: 'Order', type: AdminMediaServiceOrderDto, example: ADMIN_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async get(@Param('orderId', ParseUUIDPipe) id: string): Promise<AdminMediaServiceOrderDto> {
    return adminMediaOrderDto(await this.media.get(id));
  }

  @Post(':orderId/actions/schedule')
  @HttpCode(200)
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.schedule',
    summary: 'Schedule the partner’s visit',
    description:
      'A requested (paid) order gets its visit and the partner’s reference; a scheduled one may be moved (D-297, O-032). Other states: `media_service.invalid_state`.',
    implements: ['D-297'],
  })
  @ApiJsonBody(MediaScheduleDto, { scheduledFor: FAKE.dateTime, partnerRef: 'PARTNER-2026-0042' })
  @ApiSuccess(200, {
    description: 'Scheduled',
    type: AdminMediaServiceOrderDto,
    example: {
      ...ADMIN_ORDER_EXAMPLE,
      state: MediaServiceStateName.Scheduled,
      scheduledFor: FAKE.dateTime,
      scheduledAt: FAKE.dateTime,
      partnerRef: 'PARTNER-2026-0042',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'media_service.invalid_state')
  async schedule(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: MediaScheduleDto,
  ): Promise<AdminMediaServiceOrderDto> {
    return adminMediaOrderDto(
      await this.media.schedule(id, {
        scheduledFor: new Date(body.scheduledFor),
        partnerRef: body.partnerRef,
      }),
    );
  }

  @Post(':orderId/deliverables')
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.presignDeliverable',
    summary: 'Upload a deliverable',
    description:
      'Presigns one delivered file as a document of the ordering tenant (unit scope, kind `listing_photo` or `other`) — counted to that tenant’s storage (D-286; an optional upload over a full allowance is refused with `storage.allowance_exceeded`). Upload with the returned URL, then deliver. Only for a requested or scheduled order. Audited.',
    implements: ['D-297', 'D-286'],
  })
  @ApiJsonBody(MediaDeliverableDto, {
    kind: MediaDeliverableKindName.ListingPhoto,
    fileName: 'room-301-01.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2_345_678,
    sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  })
  @ApiSuccess(201, {
    description: 'Presigned',
    type: FilePresignedDto,
    example: {
      file: { ...FILE_EXAMPLE, kind: 'listing_photo', mimeType: 'image/jpeg' },
      uploadUrl: 'https://storage.example.com/upload?X-Amz-Signature=abc',
      headers: { 'Content-Type': 'image/jpeg' },
      multipart: null,
      expiresAt: '2026-11-01T00:30:00+07:00',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'media_service.invalid_state',
    'document.type_not_allowed',
    'storage.allowance_exceeded',
  )
  async presign(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: MediaDeliverableDto,
  ): Promise<FilePresignedDto> {
    const r = await this.media.presignDeliverable(id, body);
    return {
      file: fileDto(r.document),
      uploadUrl: r.uploadUrl,
      headers: r.headers,
      multipart: r.multipart,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }

  @Post(':orderId/actions/deliver')
  @HttpCode(200)
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.deliver',
    summary: 'Mark an order delivered',
    description:
      'Finishes the uploads (object present with its size) and attaches the deliverables — documents of the ordering tenant in the order’s unit (`listing_photo` / `other`); the owner sees them on the order and may add them to the listing (D-297). Unknown or foreign document ids: 404.',
    implements: ['D-297'],
  })
  @ApiJsonBody(MediaDeliverDto, { documentIds: [FAKE.uuid] })
  @ApiSuccess(200, {
    description: 'Delivered',
    type: AdminMediaServiceOrderDto,
    example: {
      ...ADMIN_ORDER_EXAMPLE,
      state: MediaServiceStateName.Delivered,
      deliveredAt: FAKE.dateTime,
      deliverableDocumentIds: [FAKE.uuid],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'media_service.invalid_state',
    'document.not_uploaded',
    'document.size_mismatch',
  )
  async deliver(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: MediaDeliverDto,
  ): Promise<AdminMediaServiceOrderDto> {
    return adminMediaOrderDto(await this.media.deliver(id, body.documentIds));
  }

  @Post(':orderId/actions/cancel')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.mediaServices.cancel',
    summary: 'Cancel an order',
    description:
      'Cancels an open order with a reason (D-297). Money already paid comes back only through a platform credit note requested by Finance (D-091).',
    implements: ['D-297', 'D-091'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'พาร์ทเนอร์ไม่สามารถเข้าพื้นที่ได้' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: AdminMediaServiceOrderDto,
    example: {
      ...ADMIN_ORDER_EXAMPLE,
      state: MediaServiceStateName.Cancelled,
      cancelledAt: FAKE.dateTime,
      cancelReason: 'พาร์ทเนอร์ไม่สามารถเข้าพื้นที่ได้',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'media_service.invalid_state')
  async cancel(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminMediaServiceOrderDto> {
    return adminMediaOrderDto(await this.media.cancel(id, body.reason));
  }
}
