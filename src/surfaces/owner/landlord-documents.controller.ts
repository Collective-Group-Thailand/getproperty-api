import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { InvoiceDocumentsService } from '@modules/ops-documents/invoice-documents.service';
import { LeaseStampDutyService, type StampDutyView } from '@modules/ops-leases/lease-stamp-duty.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso } from '../shared/mappers';
import { type DocumentKindName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  OwnerDocumentDto,
  OwnerDocumentListQuery,
  type StampDutyChannelName,
  StampDutyDto,
  type StampDutyPayerName,
  StampDutyRecordDto,
} from './landlord-documents.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export function stampDutyDto(v: StampDutyView): StampDutyDto {
  return {
    leaseId: v.leaseId,
    amount: v.amount,
    fixed: v.fixed,
    payer: v.payer as StampDutyPayerName,
    dueDate: v.dueDate,
    paid: v.paid
      ? {
          channel: v.paid.channel as StampDutyChannelName,
          reference: v.paid.reference,
          paidAt: iso(v.paid.paidAt),
          documentId: v.paid.documentId,
        }
      : null,
    eStampAvailable: v.eStampAvailable,
  };
}

const STAMP_DUTY_EXAMPLE: StampDutyDto = {
  leaseId: FAKE.uuid,
  amount: '180.00',
  fixed: true,
  payer: 'lessor' as StampDutyPayerName,
  dueDate: '2026-11-16',
  paid: null,
  eStampAvailable: false,
};

@ApiTags('owner.documents')
@ApiSurface(SURFACES.owner)
@Controller('owner/documents')
export class OwnerUnitDocumentsController {
  constructor(private readonly docs: InvoiceDocumentsService) {}

  @Get()
  @TenantScoped()
  @Can('document.read')
  @ApiEndpoint({
    id: 'owner.documents.list',
    summary: 'Documents of my units',
    description:
      'Every PDF the platform generated for a unit — lease, deposit receipt and statement, invoices, notes, receipts, tax invoices, inspection reports, notices, certificates, annual summaries, stamp duty receipt — newest first, for one unit (`unitId`) or all units the caller sees, optionally of one kind (B7.5, D-253). Download through `GET /v1/owner/files/{fileId}`.',
    implements: ['D-253', 'D-050'],
  })
  @ApiPaginated(OwnerDocumentDto, {
    example: {
      id: FAKE.uuid,
      kind: 'contract' as DocumentKindName,
      title: 'สัญญาเช่า CTR-2026-00001.pdf',
      sizeBytes: 48211,
      unitId: FAKE.uuid,
      createdAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: OwnerDocumentListQuery,
  ): Promise<Page<OwnerDocumentDto>> {
    const { rows, total } = await this.docs.ofUnits(ctx, {
      unitId: q.unitId,
      kind: q.kind,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((d) => ({
        id: d.id,
        kind: d.kind as DocumentKindName,
        title: d.title ?? d.id,
        sizeBytes: Number(d.sizeBytes ?? 0),
        unitId: d.scopeId,
        createdAt: iso(d.createdAt),
      })),
      total,
      q,
    );
  }
}

@ApiTags('owner.leases')
@ApiSurface(SURFACES.owner)
@Controller('owner/leases/:leaseId/stamp-duty')
export class OwnerLeaseStampDutyController {
  constructor(private readonly stampDuty: LeaseStampDutyService) {}

  @Get()
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.stampDuty',
    summary: 'Stamp duty of a lease',
    description:
      'The stamp duty on the lease (Revenue Code, 1 baht per 1,000 baht or fraction of the rent over the term — `lease.stamp_duty.baht_per_thousand`), who pays it (agreed in the lease, default the lessor), the due date once both parties signed (`lease.stamp_duty.due_days`) and the payment when recorded. An estimate until the lease is sent for signature (B7.5, D-253, O-019).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'The stamp duty', type: StampDutyDto, example: STAMP_DUTY_EXAMPLE })
  @ApiStandardErrors('http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
  ): Promise<StampDutyDto> {
    return stampDutyDto(await this.stampDuty.view(ctx, leaseId));
  }

  @Post()
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'owner.leases.recordStampDuty',
    summary: 'Record a stamp duty payment',
    description:
      'The owner paid the stamp duty at the Revenue Department (or elsewhere) and records it once, with the reference and the uploaded receipt (B7.5, O-019). Only after the lease was sent for signature (`lease.stamp_duty_not_fixed`).',
    implements: ['D-253'],
  })
  @ApiJsonBody(StampDutyRecordDto, { reference: 'อ.ส.4 0012345', paidOn: FAKE.date, documentId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Recorded',
    type: StampDutyDto,
    example: {
      ...STAMP_DUTY_EXAMPLE,
      paid: {
        channel: 'manual' as StampDutyChannelName,
        reference: 'อ.ส.4 0012345',
        paidAt: FAKE.dateTime,
        documentId: FAKE.uuid,
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'lease.invalid_state',
    'lease.stamp_duty_not_fixed',
    'lease.stamp_duty_paid',
    'idempotency.key_required',
    ...T,
  )
  async record(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: StampDutyRecordDto,
  ): Promise<StampDutyDto> {
    return stampDutyDto(
      await this.stampDuty.record(ctx, leaseId, {
        reference: body.reference ?? null,
        paidOn: body.paidOn,
        documentId: body.documentId ?? null,
      }),
    );
  }

  @Post('actions/pay-online')
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'owner.leases.payStampDuty',
    summary: 'Pay the stamp duty through e-Stamp',
    description:
      'Pays the stamp duty of a lease signed by both parties through the Revenue Department e-Stamp adapter and stores the receipt with the lease. Only when an adapter is configured (`eStampAvailable`; otherwise `lease.e_stamp_unavailable` — record the payment by hand), B7.5, O-019.',
    implements: ['D-253'],
  })
  @ApiSuccess(200, {
    description: 'Paid',
    type: StampDutyDto,
    example: {
      ...STAMP_DUTY_EXAMPLE,
      paid: {
        channel: 'e_stamp' as StampDutyChannelName,
        reference: 'ES-20261101-CTR2026000001',
        paidAt: FAKE.dateTime,
        documentId: FAKE.uuid,
      },
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'lease.invalid_state',
    'lease.stamp_duty_not_fixed',
    'lease.stamp_duty_paid',
    'lease.e_stamp_unavailable',
    'idempotency.key_required',
    ...T,
  )
  async payOnline(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
  ): Promise<StampDutyDto> {
    return stampDutyDto(await this.stampDuty.payOnline(ctx, leaseId));
  }
}
