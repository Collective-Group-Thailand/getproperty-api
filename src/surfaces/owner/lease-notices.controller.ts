import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { type LeaseNotice } from '@generated/prisma/client';
import { LeaseNoticesService } from '@modules/ops-leases/lease-notices.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type LanguageName } from '../shared/common.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import { LeaseNoticeCreateDto, LeaseNoticeDto, LeaseNoticeKindName } from './lease-notices.dto';
import { type LessorReasonName } from './leases.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function leaseNoticeDto(n: LeaseNotice): LeaseNoticeDto {
  const items =
    ((n.details ?? {}) as { items?: { number: string; dueDate: string; balance: string }[] }).items ?? [];
  return {
    id: n.id,
    leaseId: n.leaseId,
    kind: n.kind as LeaseNoticeKindName,
    number: n.number,
    language: (n.language === 'en' ? 'en' : 'th') as LanguageName,
    issuedOn: day(n.issuedOn)!,
    effectiveDate: day(n.effectiveDate),
    respondBy: day(n.respondBy),
    noticeDays: n.noticeDays,
    newRent: n.newRent ? n.newRent.toFixed(2) : null,
    renewalMonths: n.renewalMonths,
    amountDue: n.amountDue ? n.amountDue.toFixed(2) : null,
    reasonCode: n.reasonCode as LessorReasonName | null,
    message: n.message,
    items: items.map((i) => ({ number: i.number, dueDate: i.dueDate, balance: i.balance })),
    documentId: n.documentId,
    sentAt: n.sentAt ? toBangkokIso(n.sentAt) : null,
  };
}

const NOTICE_EXAMPLE: LeaseNoticeDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  kind: LeaseNoticeKindName.RenewalOffer,
  number: 'NTC-2026-00001',
  language: 'th' as LanguageName,
  issuedOn: FAKE.date,
  effectiveDate: '2027-11-01',
  respondBy: '2026-11-09',
  noticeDays: 365,
  newRent: '15500.00',
  renewalMonths: 12,
  amountDue: null,
  reasonCode: null,
  message: null,
  items: [],
  documentId: FAKE.uuid,
  sentAt: FAKE.dateTime,
};

const DOWNLOAD_EXAMPLE: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'NTC-2026-00001',
  url: 'https://storage.example.com/notice.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T00:20:00+07:00',
};

@ApiTags('owner.leases')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerLeaseNoticesController {
  constructor(private readonly notices: LeaseNoticesService) {}

  @Get('leases/:leaseId/notices')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.notices',
    summary: 'Notices sent on a lease',
    description: 'Every written notice of the lease, newest first (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Notices', type: [LeaseNoticeDto], example: [NOTICE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
  ): Promise<LeaseNoticeDto[]> {
    return (await this.notices.list(ctx, leaseId)).map(leaseNoticeDto);
  }

  @Post('leases/:leaseId/notices')
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.leases.issueNotice',
    summary: 'Send a notice to the lessee',
    description:
      "A numbered letter (NTC series) in the landlord's name and language, stored as a PDF with the unit and sent to the resident in LINE (B7.5, D-253): `rent_increase` — the new rent applies only after the lease ends and at least `lease.notice.rent_increase_days` ahead (D-020: no mid-term increase); `renewal_offer` — new rent and term from the day after the lease ends, answer within `lease.notice.renewal_response_days`; `non_renewal` and `termination` — also record the lessor's notice on the lease through the D-020 rules (legal ground, notice length, evidence; warnings need an acknowledgement); `late_payment` — the overdue invoices of the lease and a pay-by date `lease.notice.late_payment_days` ahead; it never terminates the lease nor cuts a service (D-024).",
    implements: ['D-253', 'D-020', 'D-024'],
  })
  @ApiCompliance('compliance.termination_notice')
  @ApiJsonBody(LeaseNoticeCreateDto, {
    kind: LeaseNoticeKindName.RenewalOffer,
    newRent: '15500.00',
    renewalMonths: 12,
  })
  @ApiSuccess(201, { description: 'Sent', type: LeaseNoticeDto, example: NOTICE_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'lease.invalid_state',
    'lease.notice_nothing_overdue',
    'compliance.acknowledgement_required',
    'idempotency.key_required',
    ...T,
  )
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: LeaseNoticeCreateDto,
  ): Promise<LeaseNoticeDto> {
    return leaseNoticeDto(await this.notices.issue(ctx, leaseId, body));
  }

  @Get('lease-notices/:noticeId/document')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leaseNotices.document',
    summary: 'Open a notice',
    description: 'A 5-minute signed URL of the notice PDF (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.notices.document(ctx, noticeId);
    return {
      documentId: r.notice.documentId!,
      number: r.notice.number,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

@ApiTags('resident.leases')
@ApiSurface(SURFACES.resident)
@Controller('resident/leases')
export class ResidentLeaseNoticesController {
  constructor(private readonly notices: LeaseNoticesService) {}

  @Get(':leaseId/notices')
  @ApiEndpoint({
    id: 'resident.leases.notices',
    summary: 'Letters from my landlord',
    description: 'The written notices of my lease, newest first (B7.5, D-253); each also arrived in LINE.',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Notices', type: [LeaseNoticeDto], example: [NOTICE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async list(@Param('leaseId', ParseUUIDPipe) leaseId: string): Promise<LeaseNoticeDto[]> {
    return (await this.notices.residentList(leaseId)).map(leaseNoticeDto);
  }

  @Get(':leaseId/notices/:noticeId/document')
  @ApiEndpoint({
    id: 'resident.leases.noticeDocument',
    summary: 'Open a letter from my landlord',
    description: 'A 5-minute signed URL of the notice PDF (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async document(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.notices.residentDocument(leaseId, noticeId);
    return {
      documentId: r.notice.documentId!,
      number: r.notice.number,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}
