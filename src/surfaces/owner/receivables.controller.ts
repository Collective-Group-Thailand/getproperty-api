import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { type AgingBuckets } from '@modules/ops-receivables/aging';
import { DashboardService } from '@modules/ops-receivables/dashboard.service';
import { DunningService } from '@modules/ops-receivables/dunning.service';
import { type BalanceRow, ReceivablesService } from '@modules/ops-receivables/receivables.service';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type AgingDto,
  DashboardDto,
  DashboardQuery,
  DunningReminderDto,
  InvoiceRemindersDto,
  type PenaltyStatusName,
  ReceivableEntryDto,
  ReceivableEntryQuery,
  type ReceivableEntryTypeName,
  ReceivableListDto,
  ReceivableListQuery,
  type ReminderStatusName,
  type ReminderTriggerName,
} from './receivables.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const m2 = (d: { toFixed(n: number): string }) => d.toFixed(2);
const ZERO_AGING: AgingDto = { current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90p: '0.00' };

function receivableDto(r: BalanceRow) {
  return {
    partyId: r.partyId,
    partyName: r.party.displayName,
    unitId: r.unitId,
    unitNo: r.unit?.unitNo ?? null,
    buildingId: r.buildingId,
    buildingName: r.building.name,
    balance: m2(r.balance),
    creditBalance: m2(r.creditBalance),
    openInvoicesCount: r.openInvoicesCount,
    oldestDueDate: r.oldestDueDate ? r.oldestDueDate.toISOString().slice(0, 10) : null,
    daysOverdue: r.daysOverdue,
    aging: { ...ZERO_AGING, ...(r.aging as unknown as AgingBuckets) },
    updatedAt: iso(r.updatedAt),
  };
}

const AGING_EXAMPLE: AgingDto = {
  current: '0.00',
  d1_30: '5344.00',
  d31_60: '0.00',
  d61_90: '0.00',
  d90p: '0.00',
};
const RECEIVABLE_EXAMPLE = {
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  buildingId: FAKE.uuid,
  buildingName: 'อาคาร A',
  balance: '5344.00',
  creditBalance: '0.00',
  openInvoicesCount: 1,
  oldestDueDate: '2026-11-05',
  daysOverdue: 12,
  aging: AGING_EXAMPLE,
  updatedAt: FAKE.dateTime,
};

@ApiTags('owner.receivables')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerReceivablesController {
  constructor(
    private readonly receivables: ReceivablesService,
    private readonly dunning: DunningService,
  ) {}

  @Get('receivables')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.receivables.list',
    summary: 'Arrears and receivables',
    description:
      'What each billed party owes per unit (D-044): net balance after credit, open invoices, oldest due date, days overdue, aging buckets (not due, 1–30, 31–60, 61–90, > 90 days); filters by building, party, unit, days overdue and bucket; totals over every matching row. Default: only parties who owe something.',
    implements: ['D-044', 'D-045'],
  })
  @ApiSuccess(200, {
    description: 'One page with totals',
    type: ReceivableListDto,
    example: {
      data: [RECEIVABLE_EXAMPLE],
      meta: { page: 1, perPage: 25, total: 1 },
      totals: { count: 1, balance: '5344.00', creditBalance: '0.00', aging: AGING_EXAMPLE },
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ReceivableListQuery,
  ): Promise<ReceivableListDto> {
    const r = await this.receivables.list(ctx, {
      buildingId: q.buildingId,
      partyId: q.partyId,
      unitId: q.unitId,
      minDaysOverdue: q.minDaysOverdue,
      bucket: q.bucket,
      arrearsOnly: !q.includeSettled,
      sort: q.sortBy,
      ...toSkipTake(q),
    });
    return {
      ...paginated(r.rows.map(receivableDto), r.total, q),
      totals: { ...r.totals, aging: r.totals.aging },
    };
  }

  @Get('receivables/entries')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.receivables.entries',
    summary: 'Ledger of a billed party',
    description:
      'Every movement of what a party owes (per unit when given), oldest first with the running balance: invoices +, voids −, credit notes −, debit notes +, payments −, reversals +, refunds + (D-044).',
    implements: ['D-044'],
  })
  @ApiPaginated(ReceivableEntryDto, {
    example: {
      id: FAKE.uuid,
      entryType: 'invoice',
      refType: 'invoice',
      refId: FAKE.uuid,
      unitNo: FAKE.unitCode,
      amount: '5344.00',
      runningBalance: '5344.00',
      occurredAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async entries(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ReceivableEntryQuery,
  ): Promise<Page<ReceivableEntryDto>> {
    const r = await this.receivables.entries(ctx, { partyId: q.partyId, unitId: q.unitId, ...toSkipTake(q) });
    return paginated(
      r.rows.map((e) => ({
        id: e.id,
        entryType: e.entryType as ReceivableEntryTypeName,
        refType: e.refType,
        refId: e.refId,
        unitNo: e.unit?.unitNo ?? null,
        amount: m2(e.amount),
        runningBalance: e.runningBalance,
        occurredAt: iso(e.occurredAt),
      })),
      r.total,
      q,
    );
  }

  @Get('invoices/:invoiceId/reminders')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.invoices.reminders',
    summary: 'Reminders and late fee of an invoice',
    description:
      'The payment reminders of an invoice — the steps of `reminders.schedule` after the due date and the ones sent by the owner, with their status (sent, held for quiet hours, skipped because paid) — and its late-fee assessment, if any (D-045, ⚖ O-002).',
    implements: ['D-045', 'D-024'],
  })
  @ApiSuccess(200, {
    description: 'Reminders',
    type: InvoiceRemindersDto,
    example: {
      reminders: [
        {
          id: FAKE.uuid,
          step: 1,
          triggeredBy: 'schedule',
          status: 'sent',
          scheduledFor: FAKE.dateTime,
          sentAt: FAKE.dateTime,
        },
        {
          id: FAKE.uuid,
          step: 3,
          triggeredBy: 'schedule',
          status: 'scheduled',
          scheduledFor: FAKE.dateTime,
          sentAt: null,
        },
      ],
      penalty: null,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async reminders(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<InvoiceRemindersDto> {
    const r = await this.dunning.reminders(ctx, id);
    return {
      reminders: r.rows.map(reminderDto),
      penalty: r.penalty
        ? {
            id: r.penalty.id,
            amount: m2(r.penalty.amount),
            allowed: r.penalty.allowed,
            status: r.penalty.status as PenaltyStatusName,
            appliedInvoiceLineId: r.penalty.appliedInvoiceLineId,
          }
        : null,
    };
  }

  @Post('invoices/:invoiceId/actions/send-reminder')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoices.sendReminder',
    summary: 'Send a payment reminder now',
    description:
      'The LINE Flex reminder with the payment link (QR refreshed for what is due) goes to the billed party now — held until quiet hours end at night (D-045). Only for an open invoice with a balance (`invoice.nothing_due`). Audited.',
    implements: ['D-045', 'D-063'],
  })
  @ApiSuccess(200, {
    description: 'Sent',
    type: DunningReminderDto,
    example: {
      id: FAKE.uuid,
      step: 0,
      triggeredBy: 'owner',
      status: 'sent',
      scheduledFor: FAKE.dateTime,
      sentAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'invoice.nothing_due',
    'http.not_found',
    'validation.failed',
    'asset.read_only',
    'tenant.read_only',
    ...T,
  )
  async sendReminder(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<DunningReminderDto> {
    return reminderDto(await this.dunning.sendNow(ctx, id));
  }
}

@ApiTags('owner.dashboard')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerDashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get('dashboard')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.dashboard.get',
    summary: 'Owner dashboard',
    description:
      'First version (B4.5): income received this month, billed vs collected, arrears with aging, due today, slips and drafts waiting, overdue repair requests and parcels waiting (D-218), each property’s billing cycle, the compliance score of the month incl. above-cap lines (D-190) and the latest loss % per building and utility (B3.4). Optionally one building.',
    implements: ['D-044', 'D-045', 'D-190', 'D-032', 'D-218'],
  })
  @ApiSuccess(200, {
    description: 'Dashboard numbers',
    type: DashboardDto,
    example: {
      month: '2026-11',
      today: '2026-11-17',
      buildingId: null,
      income: {
        received: '120450.00',
        payments: 24,
        byMethod: [{ method: 'qr', amount: '102344.00', count: 19 }],
      },
      billing: {
        billed: '128000.00',
        invoices: 25,
        collected: '112000.00',
        collectedPct: '87.50',
        outstanding: '16000.00',
      },
      arrears: { balance: '16000.00', invoices: 3, parties: 3, aging: AGING_EXAMPLE, credit: '350.00' },
      dueToday: { balance: '5344.00', invoices: 1 },
      attention: { slipsToReview: 2, draftsToReview: 0, serviceRequestsOverdue: 1, parcelsWaiting: 3 },
      cycles: [
        {
          propertyId: FAKE.uuid,
          propertyName: 'หอพักตัวอย่าง',
          periodKey: '2026-10',
          status: 'issued',
          autoIssueAt: null,
          issuedAt: FAKE.dateTime,
        },
      ],
      compliance: {
        score: '96.30',
        invoicesTotal: 25,
        invoicesWithinRate: 24,
        linesAboveCap: 1,
        linesAboveCapAcknowledged: 1,
      },
      loss: [
        {
          buildingId: FAKE.uuid,
          buildingName: 'อาคาร A',
          utility: 'electric',
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          lossPct: '9.38',
          lossThb: '451.44',
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async dashboard(@CurrentTenant() ctx: TenantContext, @Query() q: DashboardQuery): Promise<DashboardDto> {
    return await this.dashboards.dashboard(ctx, q);
  }
}

function reminderDto(r: {
  id: string;
  step: number;
  triggeredBy: string;
  status: string;
  scheduledFor: Date;
  sentAt: Date | null;
}): DunningReminderDto {
  return {
    id: r.id,
    step: r.step,
    triggeredBy: r.triggeredBy as ReminderTriggerName,
    status: r.status as ReminderStatusName,
    scheduledFor: iso(r.scheduledFor),
    sentAt: isoOrNull(r.sentAt),
  };
}
