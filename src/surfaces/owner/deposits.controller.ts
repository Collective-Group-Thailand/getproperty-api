import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { depositNextActions, type DepositRow, DepositsService } from '@modules/ops-deposits/deposits.service';
import { type InspectionRow, InspectionsService } from '@modules/ops-deposits/inspections.service';
import { ResidentDepositsService } from '@modules/ops-deposits/resident-deposits.service';
import { ResidentInspectionsService } from '@modules/ops-deposits/resident-inspections.service';
import { ResidentServiceRequestsService } from '@modules/ops-service/field-access.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { inspectionActions } from '../shared/next-actions';
import { ApiSurface, type Surface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import {
  type ComparisonSideDto,
  DeductionCreateDto,
  type DeductionDto,
  type DeductionKindName,
  DepositDto,
  DepositListQuery,
  type DepositStatusName,
  DepositSummaryDto,
  DocumentDownloadDto,
  InspectionComparisonDto,
  InspectionCompleteDto,
  InspectionCreateDto,
  InspectionDto,
  InspectionItemsUpdateDto,
  InspectionListQuery,
  type InspectionStatusName,
  type InspectionTypeName,
  type ItemConditionName,
  ProposeSettlementDto,
  RecordReceiptDto,
  RecordRefundDto,
  type RefundMethodName,
  ResidentAcceptDto,
  ResidentDepositDto,
  ResidentDisputeDto,
  type ResidentResponseName,
  ResidentUploadDto,
  ResidentUploadedDto,
  ResidentUploadPurposeName,
  type SettlementDto,
  type SettlementStatusName,
} from './deposits.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;
const PNG_EXAMPLE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const money = (d: { toFixed(n: number): string } | null) => (d ? d.toFixed(2) : null);

function deductionDto(i: NonNullable<DepositRow['settlement']>['items'][number]): DeductionDto {
  return {
    id: i.id,
    kind: i.kind as DeductionKindName,
    description: i.description,
    amount: i.amount.toFixed(2),
    inspectionItemId: i.inspectionItemId,
    evidenceDocumentIds: i.evidenceDocumentIds,
    residentAccepted: i.residentAccepted,
  };
}

function settlementDto(s: NonNullable<DepositRow['settlement']>): SettlementDto {
  return {
    id: s.id,
    status: s.status as SettlementStatusName,
    moveOutAt: iso(s.moveOutAt),
    deadlineAt: iso(s.deadlineAt),
    isLate: s.isLate,
    depositHeld: s.depositHeld.toFixed(2),
    deductionsTotal: s.deductionsTotal.toFixed(2),
    utilitiesFinal: s.utilitiesFinal.toFixed(2),
    advanceRentUnused: s.advanceRentUnused.toFixed(2),
    proposedRefund: money(s.proposedRefund),
    agreedRefund: money(s.agreedRefund),
    residentResponse: s.residentResponse as ResidentResponseName | null,
    disputeReason: s.disputeReason,
    residentNote: s.residentNote,
    disputeDocumentIds: s.disputeDocumentIds,
    refundedAt: isoOrNull(s.refundedAt),
    refundAmount: money(s.refundAmount),
    refundMethod: s.refundMethod as RefundMethodName | null,
    statementNumber: s.statementNumber,
    moveOutInspectionId: s.moveOutInspectionId,
    moveInInspectionId: s.moveInInspectionId,
    items: s.items.map(deductionDto),
  };
}

export function depositDto(d: DepositRow): DepositDto {
  return {
    id: d.id,
    leaseId: d.leaseId,
    leaseNumber: d.lease.number,
    unitNo: d.lease.unit.unitNo,
    lesseeName: (d.lease.lessee as DepositRow['lease']['lessee'] | null)?.displayName ?? null,
    status: d.status as DepositStatusName,
    amountSecurity: d.amountSecurity.toFixed(2),
    amountAdvanceRent: d.amountAdvanceRent.toFixed(2),
    currency: 'THB',
    receivedAt: isoOrNull(d.receivedAt),
    receiptNumber: d.receiptNumber,
    carriedFromDepositId: d.carriedFromDepositId,
    settlement: d.settlement ? settlementDto(d.settlement) : null,
    nextActions: depositNextActions(d),
    version: d.version,
  };
}

const SETTLEMENT_EXAMPLE: SettlementDto = {
  id: FAKE.uuid,
  status: 'proposed' as SettlementStatusName,
  moveOutAt: '2026-11-30T10:00:00+07:00',
  deadlineAt: '2026-12-07T10:00:00+07:00',
  isLate: false,
  depositHeld: '4500.00',
  deductionsTotal: '800.00',
  utilitiesFinal: '350.50',
  advanceRentUnused: '0.00',
  proposedRefund: '3349.50',
  agreedRefund: null,
  residentResponse: null,
  disputeReason: null,
  residentNote: null,
  disputeDocumentIds: [],
  refundedAt: null,
  refundAmount: null,
  refundMethod: null,
  statementNumber: null,
  moveOutInspectionId: FAKE.uuid,
  moveInInspectionId: FAKE.uuid,
  items: [
    {
      id: FAKE.uuid,
      kind: 'damage' as DeductionKindName,
      description: 'ผนังเป็นรูจากการเจาะยึดชั้นวาง 3 จุด',
      amount: '800.00',
      inspectionItemId: FAKE.uuid,
      evidenceDocumentIds: [FAKE.uuid],
      residentAccepted: null,
    },
  ],
};

const DEPOSIT_EXAMPLE: DepositDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  leaseNumber: 'CTR-2026-00001',
  unitNo: FAKE.unitCode,
  lesseeName: FAKE.nameTh,
  status: 'settling' as DepositStatusName,
  amountSecurity: '4500.00',
  amountAdvanceRent: '4500.00',
  currency: 'THB',
  receivedAt: FAKE.dateTime,
  receiptNumber: 'DPR-2026-00001',
  carriedFromDepositId: null,
  settlement: SETTLEMENT_EXAMPLE,
  nextActions: ['revise'],
  version: 4,
};

const DOWNLOAD_EXAMPLE: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'DPS-2026-00001',
  url: 'https://storage.example.com/statement.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T00:20:00+07:00',
};

// ------------------------------------------------------------------------------------------- owner deposits

@ApiTags('owner.deposits')
@ApiSurface(SURFACES.owner)
@Controller('owner/deposits')
export class OwnerDepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get()
  @TenantScoped()
  @Can('deposit.read')
  @ApiEndpoint({
    id: 'owner.deposits.list',
    summary: 'Deposits and settlements',
    description:
      'Deposits of my leases with their settlement (D-023); filter by status, building, lease or late refunds.',
    implements: ['D-023'],
  })
  @ApiPaginated(DepositDto, { example: DEPOSIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: DepositListQuery): Promise<Page<DepositDto>> {
    const { rows, total } = await this.deposits.list(ctx, {
      status: q.status,
      buildingId: q.buildingId,
      leaseId: q.leaseId,
      late: q.late,
      ...toSkipTake(q),
    });
    return paginated(rows.map(depositDto), total, q);
  }

  @Get('summary')
  @TenantScoped()
  @Can('deposit.read')
  @ApiEndpoint({
    id: 'owner.deposits.summary',
    summary: 'Deposit dashboard counter',
    description:
      'Deposits per status, settlements due within 3 days, overdue and refunded late (D-023, D-159).',
    implements: ['D-023', 'D-159'],
  })
  @ApiSuccess(200, {
    description: 'Counters',
    type: DepositSummaryDto,
    example: {
      byStatus: {
        pending: 1,
        held: 10,
        settling: 1,
        disputed: 0,
        refunded: 4,
        forfeitedPartially: 2,
        forfeited: 0,
      },
      settlementsDueSoon: 1,
      settlementsOverdue: 0,
      lateRefunds: 0,
    },
  })
  @ApiStandardErrors(...T)
  async summary(@CurrentTenant() ctx: TenantContext): Promise<DepositSummaryDto> {
    const s = await this.deposits.summary(ctx);
    const n = (k: DepositStatusName) => s.byStatus[k] ?? 0;
    return {
      byStatus: {
        pending: n('pending' as DepositStatusName),
        held: n('held' as DepositStatusName),
        settling: n('settling' as DepositStatusName),
        disputed: n('disputed' as DepositStatusName),
        refunded: n('refunded' as DepositStatusName),
        forfeitedPartially: n('forfeited_partially' as DepositStatusName),
        forfeited: n('forfeited' as DepositStatusName),
      },
      settlementsDueSoon: s.settlementsDueSoon,
      settlementsOverdue: s.settlementsOverdue,
      lateRefunds: s.lateRefunds,
    };
  }

  @Get(':depositId')
  @TenantScoped()
  @Can('deposit.read')
  @UseEtag((d: DepositDto) => etagOf(d.id, d.version))
  @ApiEndpoint({
    id: 'owner.deposits.get',
    summary: 'One deposit with its settlement',
    description:
      'Amounts, receipt, settlement with deadline, deductions with evidence ids, resident answer and next actions (D-023).',
    implements: ['D-023'],
  })
  @ApiSuccess(200, { description: 'The deposit', type: DepositDto, example: DEPOSIT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.get(ctx, id));
  }

  @Post(':depositId/actions/record-receipt')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.recordReceipt',
    summary: 'Record the deposit as received',
    description:
      'The deposit and advance rent were paid (at signing): the receipt gets its number (`deposit_receipt` series) and PDF (D-023, D-050). Payments arrive in B4.4.',
    implements: ['D-023', 'D-050'],
  })
  @ApiJsonBody(RecordReceiptDto, { receivedAt: FAKE.dateTime, reference: 'โอนเข้าบัญชี 12 ต.ค.' })
  @ApiSuccess(200, {
    description: 'Held',
    type: DepositDto,
    example: { ...DEPOSIT_EXAMPLE, status: 'held', settlement: null, nextActions: [] },
  })
  @ApiStandardErrors('deposit.invalid_state', ...WRITE)
  async recordReceipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: RecordReceiptDto,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.recordReceipt(ctx, id, body));
  }

  @Get(':depositId/inspection-comparison')
  @TenantScoped()
  @Can('deposit.read')
  @ApiEndpoint({
    id: 'owner.deposits.inspectionComparison',
    summary: 'Move-in vs move-out, line by line',
    description:
      'The checklist lines of both inspections side by side with conditions, photos and meter registers; `changed` marks a worse condition at move-out (D-023).',
    implements: ['D-023'],
  })
  @ApiSuccess(200, {
    description: 'Comparison',
    type: InspectionComparisonDto,
    example: {
      moveInInspectionId: FAKE.uuid,
      moveOutInspectionId: FAKE.uuid,
      lines: [
        {
          itemKey: 'walls',
          label: 'ผนังและสี',
          area: 'room',
          moveIn: {
            condition: 'good',
            notes: null,
            photoDocumentIds: [],
            meterRegister: null,
            inspectionItemId: FAKE.uuid,
          },
          moveOut: {
            condition: 'damaged',
            notes: 'รูเจาะ 3 จุด',
            photoDocumentIds: [FAKE.uuid],
            meterRegister: null,
            inspectionItemId: FAKE.uuid,
          },
          changed: true,
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async comparison(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
  ): Promise<InspectionComparisonDto> {
    const c = await this.deposits.comparison(ctx, id);
    const side = (i: InspectionRow['items'][number] | null): ComparisonSideDto | null =>
      i
        ? {
            condition: i.condition as ItemConditionName | null,
            notes: i.notes,
            photoDocumentIds: i.photoDocumentIds,
            meterRegister: i.meterRegister?.toFixed(3) ?? null,
            inspectionItemId: i.id,
          }
        : null;
    return {
      moveInInspectionId: c.moveIn?.id ?? null,
      moveOutInspectionId: c.moveOut?.id ?? null,
      lines: c.lines.map((l) => ({
        itemKey: l.itemKey,
        label: l.label,
        area: l.area,
        moveIn: side(l.moveIn),
        moveOut: side(l.moveOut),
        changed: l.changed,
      })),
    };
  }

  @Post(':depositId/settlement/items')
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.addDeduction',
    summary: 'Add a deduction',
    description:
      'Itemised deductions only (D-023): damage and missing items need the move-out inspection line recorded damaged/missing and a photo (`compliance.deposit_evidence`); normal wear and tear is refused (`compliance.deposit_wear`).',
    implements: ['D-023'],
  })
  @ApiCompliance('compliance.deposit_evidence', 'compliance.deposit_wear')
  @ApiJsonBody(DeductionCreateDto, {
    kind: 'damage',
    description: 'ผนังเป็นรูจากการเจาะยึดชั้นวาง 3 จุด',
    amount: '800.00',
    inspectionItemId: FAKE.uuid,
    evidenceDocumentIds: [FAKE.uuid],
  })
  @ApiSuccess(201, {
    description: 'Added',
    type: DepositDto,
    example: { ...DEPOSIT_EXAMPLE, settlement: { ...SETTLEMENT_EXAMPLE, status: 'inspected' } },
  })
  @ApiStandardErrors('deposit.invalid_state', ...WRITE)
  async addDeduction(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: DeductionCreateDto,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.addDeduction(ctx, id, body));
  }

  @Delete(':depositId/settlement/items/:itemId')
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.removeDeduction',
    summary: 'Remove a deduction',
    description: 'Before the proposal (or after a dispute); audited (D-023).',
    implements: ['D-023'],
  })
  @ApiSuccess(200, { description: 'Removed', type: DepositDto, example: DEPOSIT_EXAMPLE })
  @ApiStandardErrors('deposit.invalid_state', ...WRITE)
  async removeDeduction(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.removeDeduction(ctx, id, itemId));
  }

  @Post(':depositId/settlement/actions/propose')
  @HttpCode(200)
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.propose',
    summary: 'Propose the settlement to the resident',
    description:
      'Refund = deposit − deductions − final utilities; every deduction must carry its evidence (`workflow.guard_failed` otherwise). The resident is notified and answers in the LIFF before the deadline (D-023, D-159).',
    implements: ['D-023', 'D-159'],
  })
  @ApiJsonBody(ProposeSettlementDto, { utilitiesFinal: '350.50' })
  @ApiSuccess(200, { description: 'Proposed', type: DepositDto, example: DEPOSIT_EXAMPLE })
  @ApiStandardErrors(
    'deposit.invalid_state',
    'workflow.guard_failed',
    'workflow.invalid_transition',
    ...WRITE,
  )
  async propose(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: ProposeSettlementDto,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.propose(ctx, id, body));
  }

  @Post(':depositId/settlement/actions/revise')
  @HttpCode(200)
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.revise',
    summary: 'Withdraw the proposal to change it',
    description: 'Only before the resident answered; the deadline keeps running (D-023).',
    implements: ['D-023'],
  })
  @ApiSuccess(200, {
    description: 'Back to inspected',
    type: DepositDto,
    example: {
      ...DEPOSIT_EXAMPLE,
      settlement: { ...SETTLEMENT_EXAMPLE, status: 'inspected', proposedRefund: null },
    },
  })
  @ApiStandardErrors('deposit.invalid_state', 'workflow.invalid_transition', ...WRITE)
  async revise(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.revise(ctx, id));
  }

  @Post(':depositId/settlement/actions/record-refund')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('deposit.settle')
  @ApiEndpoint({
    id: 'owner.deposits.recordRefund',
    summary: 'Record the refund',
    description:
      'After the resident accepted (or disputed — the undisputed refund is paid): at least the refund owed (`compliance.no_forfeiture`), a bank transfer needs its slip. Numbers and stores the statement (`deposit_statement` series); a refund after the deadline is flagged late with an audit row and a `compliance.deposit_deadline` evaluation (D-023).',
    implements: ['D-023', 'D-050'],
  })
  @ApiCompliance('compliance.no_forfeiture')
  @ApiJsonBody(RecordRefundDto, {
    amount: '3349.50',
    method: 'bank_transfer',
    reference: 'KBANK 2026-12-03 10:12',
    evidenceDocumentId: FAKE.uuid,
  })
  @ApiSuccess(200, {
    description: 'Refunded',
    type: DepositDto,
    example: {
      ...DEPOSIT_EXAMPLE,
      status: 'forfeited_partially',
      nextActions: [],
      settlement: {
        ...SETTLEMENT_EXAMPLE,
        status: 'refunded',
        agreedRefund: '3349.50',
        residentResponse: 'accepted',
        refundedAt: '2026-12-03T10:12:00+07:00',
        refundAmount: '3349.50',
        refundMethod: 'bank_transfer',
        statementNumber: 'DPS-2026-00001',
      },
    },
  })
  @ApiStandardErrors('deposit.invalid_state', 'workflow.invalid_transition', ...WRITE)
  async recordRefund(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: RecordRefundDto,
  ): Promise<DepositDto> {
    return depositDto(await this.deposits.recordRefund(ctx, id, body));
  }

  @Get(':depositId/receipt')
  @TenantScoped()
  @Can('deposit.read')
  @ApiEndpoint({
    id: 'owner.deposits.receipt',
    summary: 'Download the deposit receipt',
    description: 'A 5-minute signed URL of the receipt PDF (audited download).',
    implements: ['D-050'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: DocumentDownloadDto,
    example: { ...DOWNLOAD_EXAMPLE, number: 'DPR-2026-00001' },
  })
  @ApiStandardErrors('http.not_found', 'deposit.invalid_state', 'validation.failed', ...T)
  async receipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const { deposit, download } = await this.deposits.document(ctx, id, 'receipt');
    return {
      documentId: download.document.id,
      number: deposit.receiptNumber ?? '',
      url: download.url,
      expiresAt: iso(download.expiresAt),
    };
  }

  @Get(':depositId/statement')
  @TenantScoped()
  @Can('deposit.read')
  @ApiEndpoint({
    id: 'owner.deposits.statement',
    summary: 'Download the settlement statement',
    description:
      'A 5-minute signed URL of the statement PDF (itemised deductions, refund, deadline; audited download, D-023).',
    implements: ['D-023', 'D-050'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'deposit.invalid_state', 'validation.failed', ...T)
  async statement(
    @CurrentTenant() ctx: TenantContext,
    @Param('depositId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const { deposit, download } = await this.deposits.document(ctx, id, 'statement');
    return {
      documentId: download.document.id,
      number: deposit.settlement?.statementNumber ?? '',
      url: download.url,
      expiresAt: iso(download.expiresAt),
    };
  }
}

// ------------------------------------------------------------------------------------------- inspections

export function inspectionDto(i: InspectionRow): InspectionDto {
  return {
    nextActions: inspectionActions(i.status),
    id: i.id,
    type: i.type as InspectionTypeName,
    status: i.status as InspectionStatusName,
    unitId: i.unitId,
    unitNo: i.unit.unitNo,
    leaseId: i.leaseId,
    scheduledFor: isoOrNull(i.scheduledFor),
    startedAt: isoOrNull(i.startedAt),
    completedAt: isoOrNull(i.completedAt),
    reportNumber: i.reportNumber,
    staffSigned: Boolean(i.staffSignatureDocumentId),
    residentSigned: Boolean(i.residentSignatureDocumentId),
    notes: i.notes,
    residentNote: i.residentNote,
    residentPhotoDocumentIds: i.residentPhotoDocumentIds,
    items: i.items.map((x) => ({
      id: x.id,
      itemKey: x.itemKey,
      label: x.label,
      area: x.area,
      condition: x.condition as ItemConditionName | null,
      notes: x.notes,
      photoDocumentIds: x.photoDocumentIds,
      meterRegister: x.meterRegister?.toFixed(3) ?? null,
    })),
    version: i.version,
  };
}

const INSPECTION_EXAMPLE: InspectionDto = {
  nextActions: ['complete'],
  id: FAKE.uuid,
  type: 'move_out' as InspectionTypeName,
  status: 'in_progress' as InspectionStatusName,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  leaseId: FAKE.uuid,
  scheduledFor: null,
  startedAt: FAKE.dateTime,
  completedAt: null,
  reportNumber: null,
  staffSigned: false,
  residentSigned: false,
  notes: null,
  residentNote: null,
  residentPhotoDocumentIds: [],
  items: [
    {
      id: FAKE.uuid,
      itemKey: 'walls',
      label: 'ผนังและสี',
      area: 'room',
      condition: 'damaged' as ItemConditionName,
      notes: 'รูเจาะ 3 จุด',
      photoDocumentIds: [FAKE.uuid],
      meterRegister: null,
    },
    {
      id: FAKE.uuid,
      itemKey: 'meter:electric',
      label: 'มิเตอร์ไฟฟ้า E-A-201',
      area: 'meters',
      condition: 'good' as ItemConditionName,
      notes: null,
      photoDocumentIds: [FAKE.uuid],
      meterRegister: '1234.500',
    },
  ],
  version: 2,
};

/** Inspections for the staff PWA (contract §2) and the owner console: same operator audience. */
export function inspectionsController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.inspections`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/inspections`)
  class InspectionsController {
    constructor(readonly inspections: InspectionsService) {}

    @Get()
    @TenantScoped()
    @Can('inspection.perform')
    @ApiEndpoint({
      id: `${surface}.inspections.list`,
      summary: 'Inspections',
      description:
        'Move-in / move-out inspections of my buildings (the move-out task appears when a lease ends, D-023).',
      implements: ['D-023'],
    })
    @ApiPaginated(InspectionDto, { example: INSPECTION_EXAMPLE })
    @ApiStandardErrors('validation.failed', ...T)
    async list(
      @CurrentTenant() ctx: TenantContext,
      @Query() q: InspectionListQuery,
    ): Promise<Page<InspectionDto>> {
      const { rows, total } = await this.inspections.list(ctx, {
        leaseId: q.leaseId,
        unitId: q.unitId,
        type: q.type,
        status: q.status,
        ...toSkipTake(q),
      });
      return paginated(rows.map(inspectionDto), total, q);
    }

    @Post()
    @TenantScoped()
    @Can('inspection.perform')
    @ApiEndpoint({
      id: `${surface}.inspections.create`,
      summary: 'Start an inspection of a lease',
      description:
        'The checklist of the room type (or the platform default) plus the unit’s appliances and one register line per meter, so move-in and move-out compare line by line (D-023). One move-in and one move-out per lease.',
      implements: ['D-023'],
    })
    @ApiJsonBody(InspectionCreateDto, { leaseId: FAKE.uuid, type: 'move_in' })
    @ApiSuccess(201, {
      description: 'Created',
      type: InspectionDto,
      example: { ...INSPECTION_EXAMPLE, type: 'move_in', status: 'scheduled' },
    })
    @ApiStandardErrors('inspection.exists', 'lease.invalid_state', ...WRITE)
    async create(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: InspectionCreateDto,
    ): Promise<InspectionDto> {
      return inspectionDto(await this.inspections.create(ctx, body));
    }

    @Get(':inspectionId')
    @TenantScoped()
    @Can('inspection.perform')
    @UseEtag((i: InspectionDto) => etagOf(i.id, i.version))
    @ApiEndpoint({
      id: `${surface}.inspections.get`,
      summary: 'One inspection',
      description: 'The checklist with conditions, notes, photo ids and meter registers.',
      implements: ['D-023'],
    })
    @ApiSuccess(200, { description: 'The inspection', type: InspectionDto, example: INSPECTION_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('inspectionId', ParseUUIDPipe) id: string,
    ): Promise<InspectionDto> {
      return inspectionDto(await this.inspections.get(ctx, id));
    }

    @Patch(':inspectionId/items')
    @TenantScoped()
    @Can('inspection.perform')
    @UseEtag((i: InspectionDto) => etagOf(i.id, i.version))
    @ApiConcurrency()
    @ApiEndpoint({
      id: `${surface}.inspections.updateItems`,
      summary: 'Record conditions, photos and meter registers',
      description:
        'Upload photos first (`files/presign`, kind `inspection_photo`, scope `unit`) and pass their ids; meter registers are kept on the line until B3.3 copies them into readings. Requires `If-Match`.',
      implements: ['D-023'],
    })
    @ApiJsonBody(InspectionItemsUpdateDto, {
      items: [
        { itemKey: 'walls', condition: 'damaged', notes: 'รูเจาะ 3 จุด', photoDocumentIds: [FAKE.uuid] },
        { itemKey: 'meter:electric', condition: 'good', meterRegister: '1234.500' },
      ],
    })
    @ApiSuccess(200, { description: 'Updated', type: InspectionDto, example: INSPECTION_EXAMPLE })
    @ApiStandardErrors('inspection.invalid_state', ...WRITE)
    async updateItems(
      @CurrentTenant() ctx: TenantContext,
      @Param('inspectionId', ParseUUIDPipe) id: string,
      @IfMatch() ifMatch: string | undefined,
      @Body() body: InspectionItemsUpdateDto,
    ): Promise<InspectionDto> {
      const version = ifMatchVersion(ifMatch, await this.inspections.get(ctx, id));
      return inspectionDto(await this.inspections.updateItems(ctx, id, version, body.items));
    }

    @Post(':inspectionId/actions/complete')
    @HttpCode(200)
    @Idempotent()
    @TenantScoped()
    @Can('inspection.perform')
    @ApiEndpoint({
      id: `${surface}.inspections.complete`,
      summary: 'Complete and sign the inspection',
      description:
        'Every line needs a condition; numbers the report (`inspection_report` series), stores its PDF and the signatures (`signed` with the resident’s). A completed move-out inspection moves the deposit settlement to `inspected` (D-023).',
      implements: ['D-023', 'D-050'],
    })
    @ApiJsonBody(InspectionCompleteDto, { staffSignaturePng: PNG_EXAMPLE, residentSignaturePng: PNG_EXAMPLE })
    @ApiSuccess(200, {
      description: 'Completed',
      type: InspectionDto,
      example: {
        ...INSPECTION_EXAMPLE,
        status: 'signed',
        completedAt: FAKE.dateTime,
        reportNumber: 'INS-2026-00001',
        staffSigned: true,
        residentSigned: true,
      },
    })
    @ApiStandardErrors('inspection.invalid_state', 'lease.signature_invalid', ...WRITE)
    async complete(
      @CurrentTenant() ctx: TenantContext,
      @Param('inspectionId', ParseUUIDPipe) id: string,
      @Body() body: InspectionCompleteDto,
    ): Promise<InspectionDto> {
      return inspectionDto(await this.inspections.complete(ctx, id, body));
    }

    @Get(':inspectionId/report')
    @TenantScoped()
    @Can('inspection.perform')
    @ApiEndpoint({
      id: `${surface}.inspections.report`,
      summary: 'Download the inspection report',
      description: 'A 5-minute signed URL of the report PDF (audited download).',
      implements: ['D-023'],
    })
    @ApiSuccess(200, {
      description: 'Download',
      type: DocumentDownloadDto,
      example: { ...DOWNLOAD_EXAMPLE, number: 'INS-2026-00001' },
    })
    @ApiStandardErrors('http.not_found', 'inspection.invalid_state', 'validation.failed', ...T)
    async report(
      @CurrentTenant() ctx: TenantContext,
      @Param('inspectionId', ParseUUIDPipe) id: string,
    ): Promise<DocumentDownloadDto> {
      const { inspection, download } = await this.inspections.report(ctx, id);
      return {
        documentId: download.document.id,
        number: inspection.reportNumber ?? '',
        url: download.url,
        expiresAt: iso(download.expiresAt),
      };
    }
  }
  Object.defineProperty(InspectionsController, 'name', {
    value: `${surface.charAt(0).toUpperCase()}${surface.slice(1)}InspectionsController`,
  });
  return InspectionsController;
}

// ------------------------------------------------------------------------------------------- resident

function residentDepositDto(
  d: DepositRow,
  evidence: Map<string, string[]>,
  before: Map<string, string[]> = new Map(),
): ResidentDepositDto {
  const s = d.settlement;
  return {
    id: d.id,
    leaseId: d.leaseId,
    unitNo: d.lease.unit.unitNo,
    status: d.status as DepositStatusName,
    amountSecurity: d.amountSecurity.toFixed(2),
    amountAdvanceRent: d.amountAdvanceRent.toFixed(2),
    currency: 'THB',
    receiptNumber: d.receiptNumber,
    settlement: s ? settlementDto(s) : null,
    deductions: (s?.items ?? []).map((i) => ({
      ...deductionDto(i),
      evidenceUrls: evidence.get(i.id) ?? [],
      beforeEvidenceUrls: before.get(i.id) ?? [],
    })),
    nextActions: s?.status === 'proposed' ? ['accept', 'dispute'] : [],
  };
}

const RESIDENT_DEPOSIT_EXAMPLE: ResidentDepositDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  status: 'settling' as DepositStatusName,
  amountSecurity: '4500.00',
  amountAdvanceRent: '4500.00',
  currency: 'THB',
  receiptNumber: 'DPR-2026-00001',
  settlement: SETTLEMENT_EXAMPLE,
  deductions: SETTLEMENT_EXAMPLE.items.map((i) => ({
    ...i,
    evidenceUrls: ['https://storage.example.com/photo.jpg?X-Amz-Signature=abc'],
    beforeEvidenceUrls: ['https://storage.example.com/move-in.jpg?X-Amz-Signature=abc'],
  })),
  nextActions: ['accept', 'dispute'],
};

@ApiTags('resident.deposits')
@ApiSurface(SURFACES.resident)
@Controller('resident/deposits')
export class ResidentDepositsController {
  constructor(private readonly deposits: ResidentDepositsService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.deposits.list',
    summary: 'My deposits',
    description: 'Deposits of my leases with their settlement (D-023).',
    implements: ['D-023', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'Deposits',
    type: [ResidentDepositDto],
    example: [RESIDENT_DEPOSIT_EXAMPLE],
  })
  @ApiStandardErrors('auth.unauthenticated')
  async list(): Promise<ResidentDepositDto[]> {
    return (await this.deposits.list()).map((d) => residentDepositDto(d, new Map()));
  }

  @Get(':depositId')
  @ApiEndpoint({
    id: 'resident.deposits.get',
    summary: 'One of my deposits',
    description:
      'The settlement with each deduction, 5-minute links to its evidence photos and to the move-in photos of the same checklist item (before / after, D-023); 404 outside my lease scopes.',
    implements: ['D-023', 'D-154', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'The deposit',
    type: ResidentDepositDto,
    example: RESIDENT_DEPOSIT_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('depositId', ParseUUIDPipe) id: string): Promise<ResidentDepositDto> {
    const r = await this.deposits.get(id);
    return residentDepositDto(r.deposit, r.evidence, r.before);
  }

  @Post(':depositId/actions/accept')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.deposits.accept',
    summary: 'Accept the proposed settlement',
    description:
      'The agreed refund is the proposed one; the owner then pays it before the deadline (D-023). An optional note is kept with the acceptance and shown to the owner (D-266). Lessee or co-tenant.',
    implements: ['D-023', 'D-266'],
  })
  @ApiJsonBody(ResidentAcceptDto, { note: 'รับทราบค่าทำความสะอาดครับ' })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: ResidentDepositDto,
    example: {
      ...RESIDENT_DEPOSIT_EXAMPLE,
      settlement: {
        ...SETTLEMENT_EXAMPLE,
        status: 'agreed',
        residentResponse: 'accepted',
        residentNote: 'รับทราบค่าทำความสะอาดครับ',
        agreedRefund: '3349.50',
      },
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'deposit.invalid_state',
    'lease.not_signer',
    'workflow.invalid_transition',
  )
  async accept(
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: ResidentAcceptDto,
  ): Promise<ResidentDepositDto> {
    const r = await this.deposits.respond(id, { accept: true, reason: body?.note ?? null });
    return residentDepositDto(r.deposit, r.evidence, r.before);
  }

  @Post(':depositId/actions/dispute')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.deposits.dispute',
    summary: 'Dispute the proposed settlement',
    description:
      'With a reason and up to 6 photos I uploaded for this deposit (`POST /v1/resident/uploads`, purpose `deposit_dispute`; anything else is 422 `validation.failed`); the owner revises the deductions or pays the undisputed refund (D-023). Lessee or co-tenant.',
    implements: ['D-023', 'D-203'],
  })
  @ApiJsonBody(ResidentDisputeDto, {
    reason: 'รูบนผนังมีอยู่ก่อนเข้าอยู่ ดูภาพตอนตรวจรับห้อง',
    photoDocumentIds: [FAKE.uuid],
  })
  @ApiSuccess(200, {
    description: 'Disputed',
    type: ResidentDepositDto,
    example: {
      ...RESIDENT_DEPOSIT_EXAMPLE,
      status: 'disputed',
      settlement: {
        ...SETTLEMENT_EXAMPLE,
        status: 'disputed',
        residentResponse: 'disputed',
        disputeReason: 'รูบนผนังมีอยู่ก่อนเข้าอยู่',
        disputeDocumentIds: [FAKE.uuid],
      },
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'deposit.invalid_state',
    'lease.not_signer',
    'workflow.invalid_transition',
  )
  async dispute(
    @Param('depositId', ParseUUIDPipe) id: string,
    @Body() body: ResidentDisputeDto,
  ): Promise<ResidentDepositDto> {
    const r = await this.deposits.respond(id, {
      accept: false,
      reason: body.reason,
      photoDocumentIds: body.photoDocumentIds,
    });
    return residentDepositDto(r.deposit, r.evidence, r.before);
  }
}

@ApiTags('resident.uploads')
@ApiSurface(SURFACES.resident)
@Controller('resident/uploads')
export class ResidentUploadsController {
  constructor(
    private readonly deposits: ResidentDepositsService,
    private readonly serviceRequests: ResidentServiceRequestsService,
    private readonly inspections: ResidentInspectionsService,
  ) {}

  @Post()
  @ApiEndpoint({
    id: 'resident.uploads.presign',
    summary: 'Upload a photo',
    description:
      'Purpose `deposit_dispute` (with `depositId`): a photo for my dispute of a proposed deposit settlement — 409 `deposit.invalid_state` when the settlement is not waiting for my answer (D-023, D-203). Purpose `service_request` (with `unitId`, a unit I occupy): a photo of a problem I am about to report (B5.1, D-072). Purpose `inspection_note` (with `inspectionId`): a photo I add to a move-in / move-out report I am about to countersign — 409 `inspection.invalid_state` once signed (D-266). JPEG / PNG / WebP ≤ 10 MB with its SHA-256. Answers a 15-minute PUT URL; upload the bytes there, then send the `fileId` in `photoDocumentIds` of the dispute / request. The file is a photo of my unit, scanned like every upload.',
    implements: ['D-023', 'D-072', 'D-203', 'D-266'],
  })
  @ApiJsonBody(ResidentUploadDto, {
    purpose: 'deposit_dispute',
    depositId: FAKE.uuid,
    contentType: 'image/jpeg',
    sizeBytes: 2345678,
    sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  })
  @ApiSuccess(201, {
    description: 'Upload URL',
    type: ResidentUploadedDto,
    example: {
      fileId: FAKE.uuid,
      purpose: 'deposit_dispute',
      uploadUrl: 'https://storage.example.com/upload?X-Amz-Signature=abc',
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: '2026-11-01T00:30:00+07:00',
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'deposit.invalid_state',
    'inspection.invalid_state',
    'lease.not_signer',
    'document.type_not_allowed',
  )
  async presign(@Body() body: ResidentUploadDto): Promise<ResidentUploadedDto> {
    const r =
      body.purpose === ResidentUploadPurposeName.ServiceRequest
        ? await this.serviceRequests.presignPhoto(body.unitId!, body)
        : body.purpose === ResidentUploadPurposeName.InspectionNote
          ? await this.inspections.presignNotePhoto(body.inspectionId!, body)
          : await this.deposits.presignDisputePhoto(body.depositId!, body);
    return {
      fileId: r.document.id,
      purpose: body.purpose,
      uploadUrl: r.uploadUrl ?? '',
      method: 'PUT',
      headers: r.headers,
      expiresAt: iso(r.expiresAt),
    };
  }
}
