import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { CollectionReportsService } from '@modules/ops-juristic/collection-reports.service';
import { StatementsService } from '@modules/ops-juristic/statements.service';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DocumentDownloadDto } from '../owner/deposits.dto';
import { type BudgetLineKindName } from '../owner/juristic.dto';
import { statementDto } from '../owner/juristic-receivables.controller';
import { BudgetActualIncomeDto, type IncomeKindName, StatementDto } from '../owner/juristic-receivables.dto';
import { type LanguageName } from '../shared/common.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const EXAMPLE: StatementDto = {
  id: FAKE.uuid,
  number: 'STM-2027-00001',
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  period: '2027-01',
  periodStart: '2027-01-01',
  periodEnd: '2027-01-31',
  units: [{ id: FAKE.uuid, unitNo: 'A-101', building: 'อาคาร A' }],
  opening: '0.00',
  charges: '4500.00',
  credits: '0.00',
  payments: '0.00',
  closing: '4500.00',
  amountDue: '4500.00',
  openInvoices: [],
  language: 'th' as LanguageName,
  documentId: FAKE.uuid,
  deliveredVia: ['line'],
  letterBatchId: null,
  paymentIds: [],
  issuedAt: FAKE.dateTime,
};

/**
 * `/v1/resident/statements` (D-307, D-326): the owner statements of every party linked to my login, across tenants
 * (one per month across all my units of a juristic tenant). Another party's statement is a 404.
 */
@ApiTags('resident.statements')
@ApiSurface(SURFACES.resident)
@Controller('resident/statements')
export class ResidentStatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.statements.list',
    summary: 'My statements',
    description:
      'Newest month first: opening, charges, payments, closing and what I have to pay now ("ยอดที่ต้องชำระ") across my units (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiPaginated(StatementDto, { example: EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: PageQuery): Promise<Page<StatementDto>> {
    const { rows, total } = await this.statements.residentList(toSkipTake(q));
    return paginated(rows.map(statementDto), total, q);
  }

  @Get(':statementId')
  @ApiEndpoint({
    id: 'resident.statements.get',
    summary: 'One of my statements',
    description:
      'The statement a LINE message links (`/statements/{id}`); a statement of a party not linked to my login is a 404 (J-CR, D-335; D-307, D-326).',
    implements: ['D-307', 'D-326', 'D-335'],
  })
  @ApiSuccess(200, { description: 'Statement', type: StatementDto, example: EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async get(@Param('statementId', ParseUUIDPipe) id: string): Promise<StatementDto> {
    return statementDto(await this.statements.residentGet(id));
  }

  @Get(':statementId/document')
  @ApiEndpoint({
    id: 'resident.statements.document',
    summary: 'Download my statement',
    description:
      'A 5-minute link to the PDF; 409 `statement.document_pending` while it is being prepared (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: DocumentDownloadDto,
    example: {
      documentId: FAKE.uuid,
      number: 'STM-2027-00001',
      url: 'https://storage.example.com/statement.pdf?X-Amz-Signature=abc',
      expiresAt: '2027-01-31T10:05:00+07:00',
    },
  })
  @ApiStandardErrors('statement.document_pending', 'validation.failed', 'http.not_found')
  async document(@Param('statementId', ParseUUIDPipe) id: string): Promise<DocumentDownloadDto> {
    const r = await this.statements.residentDocument(id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

/**
 * D-304 / D-326: what the juristic person budgeted as income for my building this year against what it billed and
 * collected (income from billing, expenses from the journals since J2.1). Only for a unit I hold a role on today.
 */
@ApiTags('resident.statements')
@ApiSurface(SURFACES.resident)
@Controller('resident/units/:unitId')
export class ResidentBudgetController {
  constructor(private readonly reports: CollectionReportsService) {}

  @Get('budget-vs-actual')
  @ApiEndpoint({
    id: 'resident.units.budgetVsActual',
    summary: 'Budget vs actual of my building',
    description:
      'The approved budget of the unit’s building whose period contains today: its income lines against what was billed (common fee, fund, surcharge, other) and collected so far; the expense and fund lines against the journals of their accounts (J2.1). No approved budget, or no role on the unit today → 404 (D-304, D-309, D-326).',
    implements: ['D-304', 'D-309', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Income side',
    type: BudgetActualIncomeDto,
    example: {
      budgetId: FAKE.uuid,
      buildingId: FAKE.buildingId,
      fiscalYear: 2027,
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      asOf: '2027-06-30',
      budgetedIncome: '1500000.00',
      incomeLines: [{ label: 'ค่าส่วนกลาง', amount: '1500000.00' }],
      billed: '740000.00',
      billedByKind: [
        { kind: 'common_fee' as IncomeKindName, amount: '700000.00' },
        { kind: 'fund' as IncomeKindName, amount: '40000.00' },
        { kind: 'surcharge' as IncomeKindName, amount: '0.00' },
        { kind: 'other' as IncomeKindName, amount: '0.00' },
      ],
      collected: '690000.00',
      billedVsBudgetPct: '49.33',
      collectedVsBilledPct: '93.24',
      expenseSideAvailable: true,
      budgetedExpense: '1450000.00',
      actualExpense: '690000.00',
      expenseLines: [
        {
          budgetLineId: FAKE.uuid,
          kind: 'expense' as BudgetLineKindName,
          label: 'ค่าจ้างรักษาความปลอดภัย',
          accountId: FAKE.uuid,
          budgeted: '480000.00',
          actual: '236500.00',
          remaining: '243500.00',
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async budget(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<BudgetActualIncomeDto> {
    const r = await this.reports.residentBudget(unitId);
    return {
      ...r,
      billedByKind: r.billedByKind.map((k) => ({ ...k, kind: k.kind as IncomeKindName })),
      expenseLines: r.expenseLines.map((l) => ({ ...l, kind: l.kind as BudgetLineKindName })),
    };
  }
}
