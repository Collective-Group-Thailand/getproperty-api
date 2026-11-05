import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { permissionsOf } from '@core/tenancy/access.service';
import { type Account, type BankStatementLine, type WithholdingCertificate } from '@generated/prisma/client';
import { AccountingReportsService } from '@modules/ops-juristic/accounting/accounting-reports.service';
import {
  type BankStatementRow,
  BankStatementsService,
} from '@modules/ops-juristic/accounting/bank-statements.service';
import {
  type CertificateItem,
  type ExpenseRow,
  ExpensesService,
} from '@modules/ops-juristic/accounting/expenses.service';
import {
  FundsService,
  type FundTransferRow,
  type FundView,
  type PettyCashView,
} from '@modules/ops-juristic/accounting/funds.service';
import { type JournalRow, LedgerService } from '@modules/ops-juristic/accounting/ledger.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';

import { isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import { EXPORT_EXAMPLE, exportDto } from './documents.controller';
import { ExportJobDto, type ExportKindName, type ExportStatusName } from './documents.dto';
import {
  AccountCreateDto,
  AccountDto,
  AccountListDto,
  AccountListQuery,
  type AccountTypeName,
  AccountUpdateDto,
  type ApproverRoleName,
  AsOfQuery,
  BackPostResultDto,
  BalanceSheetDto,
  type BankFormatKeyName,
  BankLineListQuery,
  BankLineMatchDto,
  type BankLineMatchName,
  type BankMatchKindName,
  BankStatementDto,
  BankStatementImportDto,
  BankStatementImportResultDto,
  BankStatementLineDetailDto,
  BankStatementLineDto,
  BankStatementListQuery,
  ExpenseAttachDto,
  type ExpenseAttachmentKindName,
  ExpenseCreateDto,
  type ExpenseDecisionName,
  type ExpenseKindName,
  ExpenseListQuery,
  ExpensePayDto,
  type ExpensePaymentMethodName,
  ExpenseRequestDto,
  type ExpenseStateName,
  ExpenseUpdateDto,
  FundCreateDto,
  FundDto,
  type FundKindName,
  FundLedgerLineDto,
  FundListDto,
  FundListQuery,
  FundTransferCreateDto,
  type FundTransferDirectionName,
  FundTransferDto,
  FundTransferListQuery,
  type FundTransferStateName,
  FundUpdateDto,
  IncomeStatementDto,
  IncomeStatementQuery,
  JournalDto,
  JournalListQuery,
  JournalReverseDto,
  type JournalSourceName,
  LedgerExportCreateDto,
  LedgerReceivablesDto,
  ManualJournalCreateDto,
  PettyCashCountCreateDto,
  PettyCashCreateDto,
  PettyCashDetailDto,
  PettyCashDto,
  type PettyCashEntryKindName,
  PettyCashListDto,
  PettyCashSpendDto,
  type ReportGranularityName,
  TrialBalanceDto,
  WhtCertificateDto,
  WhtCertificateListQuery,
  type WhtFormName,
} from './juristic-accounting.dto';
import { CaseReasonDto, StepDecisionDto } from './juristic-receivables.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
const permsOf = (ctx: TenantContext): ReadonlySet<string> => permissionsOf(ctx.role ? [ctx.role] : []);
const me = () => userIdOf(RequestContext.actor());

// ------------------------------------------------------------------------------------------- mappers

export const accountDto = (a: Account & { used: boolean }): AccountDto => ({
  id: a.id,
  code: a.code,
  nameTh: a.nameTh,
  nameEn: a.nameEn,
  type: a.type as AccountTypeName,
  role: a.role,
  fundId: a.fundId,
  bankAccountId: a.bankAccountId,
  isSystem: a.isSystem,
  isActive: a.isActive,
  used: a.used,
  version: a.version,
});

export function journalDto(j: JournalRow): JournalDto {
  return {
    id: j.id,
    buildingId: j.buildingId,
    buildingName: j.building.name,
    postedOn: day(j.postedOn),
    sourceType: j.sourceType as JournalSourceName,
    sourceId: j.sourceId,
    memo: j.memo,
    reversesJournalId: j.reversesJournalId,
    reversedByJournalId: j.reversedBy[0]?.id ?? null,
    resolutionId: j.resolutionId,
    fundId: j.fundId,
    total: j.lines.reduce((s, l) => s.plus(l.debit.toString()), new Decimal(0)).toFixed(2),
    lines: j.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountName: l.account.nameTh,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      unitId: l.unitId,
      unitNo: l.unit?.unitNo ?? null,
      partyId: l.partyId,
      partyName: l.party?.displayName ?? null,
      memo: l.memo,
    })),
    createdAt: toBangkokIso(j.createdAt),
  };
}

function expenseActions(ctx: TenantContext, r: ExpenseRow): string[] {
  const perms = permsOf(ctx);
  const out: string[] = [];
  const mine = r.requestedBy === me();
  if (r.state === 'draft' && perms.has('juristic.expense.request')) out.push('edit', 'submit', 'cancel');
  if (r.state === 'submitted') {
    if (perms.has('juristic.expense.request')) out.push('cancel');
    if (
      perms.has('juristic.expense.approve') &&
      !mine &&
      ctx.role &&
      r.approverRoles.includes(ctx.role) &&
      !r.approvals.some((a) => a.approverUserId === me())
    )
      out.push('approve', 'reject');
  }
  if (r.state === 'approved') {
    if (perms.has('juristic.expense.pay')) out.push('pay');
    if (perms.has('juristic.expense.request')) out.push('cancel');
  }
  if (r.state !== 'cancelled' && r.state !== 'rejected' && perms.has('juristic.expense.request'))
    out.push('attach');
  return out;
}

export function expenseDto(ctx: TenantContext, r: ExpenseRow): ExpenseRequestDto {
  const band = r.band as {
    key: string;
    upTo: string | null;
    roles: ApproverRoleName[];
    approvals: number;
  } | null;
  return {
    id: r.id,
    number: r.number,
    buildingId: r.buildingId,
    buildingName: r.building.name,
    kind: r.kind as ExpenseKindName,
    title: r.title,
    payeePartyId: r.payeePartyId,
    payeeName: r.payeeName,
    pettyCashId: r.pettyCashId,
    fundId: r.fundId,
    resolutionId: r.resolutionId,
    state: r.state as ExpenseStateName,
    amount: r.amount.toFixed(2),
    whtAmount: r.whtAmount.toFixed(2),
    netAmount: r.netAmount.toFixed(2),
    band: band ? { key: band.key, upTo: band.upTo, roles: band.roles, approvals: band.approvals } : null,
    approvalsRequired: r.approvalsRequired,
    approvalsGiven: r.approvals.filter((a) => a.decision === 'approved').length,
    requestedBy: r.requestedBy,
    submittedAt: isoOrNull(r.submittedAt),
    approvedAt: isoOrNull(r.approvedAt),
    rejectedAt: isoOrNull(r.rejectedAt),
    decisionReason: r.decisionReason,
    cancelledAt: isoOrNull(r.cancelledAt),
    cancelReason: r.cancelReason,
    paidAt: isoOrNull(r.paidAt),
    paidOn: r.paidOn ? day(r.paidOn) : null,
    paymentMethod: r.paymentMethod as ExpensePaymentMethodName | null,
    paymentReference: r.paymentReference,
    paidFromAccountId: r.paidFromAccountId,
    journalId: r.journalId,
    note: r.note,
    lines: r.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountName: l.account.nameTh,
      description: l.description,
      amount: l.amount.toFixed(2),
      vatAmount: l.vatAmount.toFixed(2),
      whtKey: l.whtKey,
      whtIncomeType: l.whtIncomeType,
      whtRatePct: l.whtRate ? l.whtRate.toFixed(2) : null,
      whtAmount: l.whtAmount.toFixed(2),
    })),
    attachments: r.attachments.map((a) => ({
      documentId: a.documentId,
      kind: a.kind as ExpenseAttachmentKindName,
      createdAt: toBangkokIso(a.createdAt),
    })),
    approvals: r.approvals.map((a) => ({
      approverUserId: a.approverUserId,
      role: a.role as ApproverRoleName,
      decision: a.decision as ExpenseDecisionName,
      reason: a.reason,
      createdAt: toBangkokIso(a.createdAt),
    })),
    certificate: r.certificate
      ? {
          id: r.certificate.id,
          number: r.certificate.number,
          documentId: r.certificate.documentId,
          tax: r.certificate.tax.toFixed(2),
        }
      : null,
    nextActions: expenseActions(ctx, r),
    createdAt: toBangkokIso(r.createdAt),
    version: r.version,
  };
}

export const certificateDto = (c: WithholdingCertificate): WhtCertificateDto => ({
  id: c.id,
  number: c.number,
  buildingId: c.buildingId,
  expenseRequestId: c.expenseRequestId,
  payeePartyId: c.payeePartyId,
  payeeName: c.payeeName,
  payeeTaxIdHint: c.payeeTaxIdHint,
  form: c.form as WhtFormName,
  items: c.items as unknown as CertificateItem[],
  base: c.base.toFixed(2),
  tax: c.tax.toFixed(2),
  paidOn: day(c.paidOn),
  documentId: c.documentId,
  issuedAt: toBangkokIso(c.issuedAt),
});

export const fundDto = (f: FundView): FundDto => ({ ...f, kind: f.kind as FundKindName });

export function transferDto(ctx: TenantContext, t: FundTransferRow): FundTransferDto {
  const perms = permsOf(ctx);
  return {
    id: t.id,
    fundId: t.fundId,
    fundName: t.fund.name,
    buildingId: t.buildingId,
    direction: t.direction as FundTransferDirectionName,
    amount: t.amount.toFixed(2),
    counterAccountId: t.counterAccountId,
    counterAccountCode: t.counterAccount.code,
    transferOn: day(t.transferOn),
    resolutionId: t.resolutionId,
    reference: t.reference,
    note: t.note,
    state: t.state as FundTransferStateName,
    requestedBy: t.requestedBy,
    requestedAt: toBangkokIso(t.requestedAt),
    decidedBy: t.decidedBy,
    decidedAt: isoOrNull(t.decidedAt),
    decisionReason: t.decisionReason,
    journalId: t.journalId,
    nextActions:
      t.state === 'requested' && perms.has('juristic.fund.approve') && t.requestedBy !== me()
        ? ['approve', 'reject']
        : [],
    version: t.version,
  };
}

export const pettyDto = (p: PettyCashView): PettyCashDto => ({ ...p });

export const statementDto = (s: BankStatementRow): BankStatementDto => ({
  id: s.id,
  bankAccountId: s.bankAccountId,
  bankName: s.bankAccount.bankNameTh,
  bankAccountMasked: s.bankAccount.accountNoMasked,
  accountId: s.accountId,
  formatKey: s.formatKey as BankFormatKeyName,
  fileName: s.fileName,
  fileDocumentId: s.fileDocumentId,
  periodStart: s.periodStart ? day(s.periodStart) : null,
  periodEnd: s.periodEnd ? day(s.periodEnd) : null,
  lineCount: s.lineCount,
  duplicateCount: s.duplicateCount,
  matchedCount: s.matchedCount,
  unmatchedCount: s.unmatchedCount,
  importedAt: toBangkokIso(s.importedAt),
});

export const lineDto = (l: BankStatementLine): BankStatementLineDto => ({
  id: l.id,
  statementId: l.statementId,
  lineNo: l.lineNo,
  bookedOn: day(l.bookedOn),
  amount: l.amount.toFixed(2),
  description: l.description,
  reference: l.reference,
  balance: l.balance ? l.balance.toFixed(2) : null,
  matchKind: l.matchKind as BankLineMatchName,
  matchId: l.matchId,
  matchMethod: l.matchMethod,
  matchedAt: isoOrNull(l.matchedAt),
  ignoreReason: l.ignoreReason,
  version: l.version,
});

// ------------------------------------------------------------------------------------------- examples

const ACCOUNT_EXAMPLE: AccountDto = {
  id: FAKE.uuid,
  code: '4110',
  nameTh: 'รายได้ค่าส่วนกลาง',
  nameEn: 'Common fee income',
  type: 'income' as AccountTypeName,
  role: 'income_common_fee',
  fundId: null,
  bankAccountId: null,
  isSystem: true,
  isActive: true,
  used: true,
  version: 1,
};

const JOURNAL_EXAMPLE: JournalDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  postedOn: '2027-01-05',
  sourceType: 'invoice' as JournalSourceName,
  sourceId: FAKE.uuid,
  memo: 'ใบแจ้งหนี้ INV-2027-00012',
  reversesJournalId: null,
  reversedByJournalId: null,
  resolutionId: null,
  fundId: FAKE.uuid,
  total: '3600.00',
  lines: [
    {
      lineNo: 1,
      accountId: FAKE.uuid,
      accountCode: '1140',
      accountName: 'ลูกหนี้ค่าส่วนกลางและเงินกองทุน – เจ้าของร่วม',
      debit: '3600.00',
      credit: '0.00',
      unitId: FAKE.uuid,
      unitNo: 'A-201',
      partyId: FAKE.uuid,
      partyName: 'สมชาย ใจดี',
      memo: null,
    },
    {
      lineNo: 2,
      accountId: FAKE.uuid,
      accountCode: '2130',
      accountName: 'รายได้รับล่วงหน้า',
      debit: '0.00',
      credit: '3000.00',
      unitId: FAKE.uuid,
      unitNo: 'A-201',
      partyId: FAKE.uuid,
      partyName: 'สมชาย ใจดี',
      memo: null,
    },
    {
      lineNo: 3,
      accountId: FAKE.uuid,
      accountCode: '3110-01',
      accountName: 'เงินกองทุนอาคารชุด',
      debit: '0.00',
      credit: '600.00',
      unitId: FAKE.uuid,
      unitNo: 'A-201',
      partyId: FAKE.uuid,
      partyName: 'สมชาย ใจดี',
      memo: null,
    },
  ],
  createdAt: FAKE.dateTime,
};

const EXPENSE_EXAMPLE: ExpenseRequestDto = {
  id: FAKE.uuid,
  number: 'EXP-2027-00001',
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  kind: 'expense' as ExpenseKindName,
  title: 'ค่ารักษาความปลอดภัย มกราคม 2570',
  payeePartyId: FAKE.uuid,
  payeeName: 'บริษัท รักษาความปลอดภัย จำกัด',
  pettyCashId: null,
  fundId: null,
  resolutionId: null,
  state: 'submitted' as ExpenseStateName,
  amount: '42800.00',
  whtAmount: '1200.00',
  netAmount: '41600.00',
  band: {
    key: 'le:100000.00',
    upTo: '100000.00',
    roles: ['owner', 'manager', 'committee'] as ApproverRoleName[],
    approvals: 2,
  },
  approvalsRequired: 2,
  approvalsGiven: 1,
  requestedBy: FAKE.uuid,
  submittedAt: FAKE.dateTime,
  approvedAt: null,
  rejectedAt: null,
  decisionReason: null,
  cancelledAt: null,
  cancelReason: null,
  paidAt: null,
  paidOn: null,
  paymentMethod: null,
  paymentReference: null,
  paidFromAccountId: null,
  journalId: null,
  note: null,
  lines: [
    {
      lineNo: 1,
      accountId: FAKE.uuid,
      accountCode: '5140',
      accountName: 'ค่าจ้างบริการ (รักษาความปลอดภัย ทำความสะอาด ฯลฯ)',
      description: 'ค่าจ้างรักษาความปลอดภัย มกราคม 2570',
      amount: '42800.00',
      vatAmount: '2800.00',
      whtKey: 'service',
      whtIncomeType: '3 เตรส',
      whtRatePct: '3.00',
      whtAmount: '1200.00',
    },
  ],
  attachments: [
    { documentId: FAKE.uuid, kind: 'quotation' as ExpenseAttachmentKindName, createdAt: FAKE.dateTime },
  ],
  approvals: [
    {
      approverUserId: FAKE.uuid,
      role: 'committee' as ApproverRoleName,
      decision: 'approved' as ExpenseDecisionName,
      reason: null,
      createdAt: FAKE.dateTime,
    },
  ],
  certificate: null,
  nextActions: ['approve', 'reject'],
  createdAt: FAKE.dateTime,
  version: 3,
};

const CERT_EXAMPLE: WhtCertificateDto = {
  id: FAKE.uuid,
  number: 'WHT-2027-00001',
  buildingId: FAKE.buildingId,
  expenseRequestId: FAKE.uuid,
  payeePartyId: FAKE.uuid,
  payeeName: 'บริษัท รักษาความปลอดภัย จำกัด',
  payeeTaxIdHint: '0002',
  form: 'pnd53' as WhtFormName,
  items: [{ incomeType: '3 เตรส', ratePct: '3.00', base: '40000.00', tax: '1200.00' }],
  base: '40000.00',
  tax: '1200.00',
  paidOn: '2027-02-05',
  documentId: FAKE.uuid,
  issuedAt: FAKE.dateTime,
};

const FUND_EXAMPLE: FundDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  kind: 'sinking' as FundKindName,
  name: 'เงินกองทุนอาคารชุด',
  bankAccountId: FAKE.uuid,
  bankAccountMasked: 'xxx-x-x4321-x',
  isActive: true,
  ledgerBankAccountId: FAKE.uuid,
  ledgerEquityAccountId: FAKE.uuid,
  bankBalance: '250000.00',
  equityBalance: '310000.00',
  version: 1,
};

const TRANSFER_EXAMPLE: FundTransferDto = {
  id: FAKE.uuid,
  fundId: FAKE.uuid,
  fundName: 'เงินกองทุนอาคารชุด',
  buildingId: FAKE.buildingId,
  direction: 'out' as FundTransferDirectionName,
  amount: '120000.00',
  counterAccountId: FAKE.uuid,
  counterAccountCode: '1130',
  transferOn: '2027-03-01',
  resolutionId: FAKE.uuid,
  reference: 'SCB 0301-1204',
  note: 'ซ่อมระบบปั๊มน้ำตามมติที่ประชุมใหญ่',
  state: 'requested' as FundTransferStateName,
  requestedBy: FAKE.uuid,
  requestedAt: FAKE.dateTime,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  journalId: null,
  nextActions: ['approve', 'reject'],
  version: 1,
};

const PETTY_EXAMPLE: PettyCashDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  name: 'เงินสดย่อยสำนักงานนิติ',
  custodianUserId: FAKE.uuid,
  floatAmount: '5000.00',
  accountId: FAKE.uuid,
  balance: '4250.00',
  isActive: true,
  lastCount: { countedOn: '2027-01-31', countedAmount: '4210.00', difference: '-40.00' },
  version: 1,
};

const PETTY_DETAIL_EXAMPLE: PettyCashDetailDto = {
  ...PETTY_EXAMPLE,
  entries: [
    {
      id: FAKE.uuid,
      kind: 'spend' as PettyCashEntryKindName,
      amount: '-350.00',
      entryOn: '2027-01-12',
      description: 'ค่าหลอดไฟทางเดิน',
      accountId: FAKE.uuid,
      receiptDocumentId: FAKE.uuid,
      expenseRequestId: null,
      countId: null,
      journalId: FAKE.uuid,
      createdAt: FAKE.dateTime,
    },
  ],
  counts: [
    {
      id: FAKE.uuid,
      countedOn: '2027-01-31',
      countedAmount: '4210.00',
      bookBalance: '4250.00',
      difference: '-40.00',
      note: null,
      countedBy: FAKE.uuid,
      createdAt: FAKE.dateTime,
    },
  ],
};

const STATEMENT_EXAMPLE: BankStatementDto = {
  id: FAKE.uuid,
  bankAccountId: FAKE.uuid,
  bankName: 'ธนาคารกสิกรไทย',
  bankAccountMasked: 'xxx-x-x4321-x',
  accountId: FAKE.uuid,
  formatKey: 'kbank' as BankFormatKeyName,
  fileName: 'kbank-2027-01.csv',
  fileDocumentId: FAKE.uuid,
  periodStart: '2027-01-02',
  periodEnd: '2027-01-31',
  lineCount: 38,
  duplicateCount: 2,
  matchedCount: 30,
  unmatchedCount: 6,
  importedAt: FAKE.dateTime,
};

const LINE_EXAMPLE: BankStatementLineDto = {
  id: FAKE.uuid,
  statementId: FAKE.uuid,
  lineNo: 3,
  bookedOn: '2027-01-05',
  amount: '3600.00',
  description: 'รับโอนเงิน PromptPay',
  reference: '016027101234ABC',
  balance: '154200.00',
  matchKind: 'none' as BankLineMatchName,
  matchId: null,
  matchMethod: null,
  matchedAt: null,
  ignoreReason: null,
  version: 1,
};

const LINE_DETAIL_EXAMPLE: BankStatementLineDetailDto = {
  ...LINE_EXAMPLE,
  suggestions: [
    {
      kind: 'payment' as BankMatchKindName,
      id: FAKE.uuid,
      amount: '3600.00',
      bookedOn: '2027-01-05',
      label: 'payment transfer_slip',
      referenceHit: true,
      days: 0,
    },
  ],
};

const SECTION_EXAMPLE = {
  accounts: [
    {
      accountId: FAKE.uuid,
      code: '4110',
      nameTh: 'รายได้ค่าส่วนกลาง',
      nameEn: 'Common fee income',
      amounts: ['100000.00', '100000.00'],
      total: '200000.00',
    },
  ],
  byPeriod: ['100000.00', '100000.00'],
  total: '200000.00',
};

// ------------------------------------------------------------------------------------------- accounts

@ApiTags('owner.juristicAccounting')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/accounts')
export class OwnerJuristicAccountsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicAccounts.list',
    summary: 'Chart of accounts',
    description:
      'The juristic chart of accounts (copied from the template of the legal form of the tenant’s oldest juristic building on first use: assets, liabilities, equity, income — common fee, fund, surcharge, other — and expenses — personnel, utilities, repairs, services, administration, insurance, taxes; Thai and English names). Fund and petty cash accounts are created with their fund / float. Juristic tenants only (404 otherwise) (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Accounts by code',
    type: AccountListDto,
    example: { data: [ACCOUNT_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: AccountListQuery): Promise<AccountListDto> {
    const rows = await this.ledger.accounts(ctx, {
      type: q.type,
      active: q.active,
    });
    return { data: rows.map(accountDto) };
  }

  @Post()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicAccounts.create',
    summary: 'Add an account',
    description:
      'An account of the tenant’s own (code unique: 409 `account.code_taken`); an asset account may stand for a tenant bank account (bank statements, payments received on it). Audited (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiJsonBody(AccountCreateDto, { code: '5145', nameTh: 'ค่าดูแลสวน', nameEn: 'Gardening', type: 'expense' })
  @ApiSuccess(201, {
    description: 'Created',
    type: AccountDto,
    example: {
      ...ACCOUNT_EXAMPLE,
      code: '5145',
      nameTh: 'ค่าดูแลสวน',
      nameEn: 'Gardening',
      type: 'expense',
      role: null,
      isSystem: false,
      used: false,
    },
  })
  @ApiStandardErrors('account.code_taken', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: AccountCreateDto): Promise<AccountDto> {
    return accountDto(await this.ledger.createAccount(ctx, body));
  }

  @Patch(':accountId')
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicAccounts.update',
    summary: 'Edit an account',
    description:
      'Rename (Thai / English), deactivate (not a system account: 422 `account.system`) or link a bank / fund bank account to a tenant bank account. Codes and types never change. `version` → 412 when changed meanwhile. Audited (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiJsonBody(AccountUpdateDto, { nameTh: 'ค่าจ้างดูแลสวนและภูมิทัศน์', version: 1 })
  @ApiSuccess(200, { description: 'Updated', type: AccountDto, example: ACCOUNT_EXAMPLE })
  @ApiStandardErrors('account.system', 'concurrency.stale', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Body() body: AccountUpdateDto,
  ): Promise<AccountDto> {
    return accountDto(await this.ledger.updateAccount(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- journals

@ApiTags('owner.juristicAccounting')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/journals')
export class OwnerJuristicJournalsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicJournals.list',
    summary: 'Journals',
    description:
      'Double-entry journals, newest first: posted from invoices (receivable / income, unearned for advance cycles, fund equity for fund contributions), revenue recognition, credit / debit notes, payments, refunds, expenses, petty cash, fund transfers, and by hand. Filters building, date range, source, account (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiPaginated(JournalDto, { example: JOURNAL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: JournalListQuery): Promise<Page<JournalDto>> {
    const { rows, total } = await this.ledger.journals(ctx, {
      buildingId: q.buildingId,
      from: q.from,
      to: q.to,
      sourceType: q.sourceType,
      accountId: q.accountId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(journalDto), total, q);
  }

  @Get(':journalId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicJournals.get',
    summary: 'A journal',
    description: 'One journal with its lines; balanced and immutable (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Journal', type: JournalDto, example: JOURNAL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('journalId', ParseUUIDPipe) id: string,
  ): Promise<JournalDto> {
    return journalDto(await this.ledger.journal(ctx, id));
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicJournals.create',
    summary: 'Post a manual journal',
    description:
      'Opening balances, WHT remittance, corrections: 2–200 lines, each a debit or a credit on an active account of the chart; Σ debit = Σ credit (422 `journal.unbalanced`; the database refuses an unbalanced journal at commit too); not in the future; a credit to a fund bank account needs an adopted resolution of the building (422 `fund.resolution_required`). Immutable once posted — corrections are reversals. Audited, `juristic.journal.posted`. Requires `Idempotency-Key` (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiJsonBody(ManualJournalCreateDto, {
    buildingId: FAKE.buildingId,
    postedOn: '2027-02-07',
    memo: 'นำส่งภาษีหัก ณ ที่จ่ายเดือนมกราคม 2570',
    lines: [
      { accountId: FAKE.uuid, debit: '1200.00' },
      { accountId: FAKE.uuid, credit: '1200.00' },
    ],
  })
  @ApiSuccess(201, {
    description: 'Posted',
    type: JournalDto,
    example: { ...JOURNAL_EXAMPLE, sourceType: 'manual', sourceId: null },
  })
  @ApiStandardErrors(
    'journal.unbalanced',
    'fund.resolution_required',
    'fund.resolution_invalid',
    'idempotency.key_required',
    ...WRITE,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ManualJournalCreateDto,
  ): Promise<JournalDto> {
    return journalDto(await this.ledger.createManual(ctx, body));
  }

  @Post(':journalId/actions/reverse')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicJournals.reverse',
    summary: 'Reverse a manual journal',
    description:
      'Posts the exact opposite journal (once: 409 `journal.already_reversed`); journals posted from documents are corrected by their own documents (credit note, void, reversal of a payment) — 409 `journal.not_reversible`. Returns the reversal. Audited. Requires `Idempotency-Key` (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiJsonBody(JournalReverseDto, { reason: 'บันทึกบัญชีผิดรหัส' })
  @ApiSuccess(200, {
    description: 'The reversal journal',
    type: JournalDto,
    example: { ...JOURNAL_EXAMPLE, sourceType: 'reversal', reversesJournalId: FAKE.uuid },
  })
  @ApiStandardErrors(
    'journal.not_reversible',
    'journal.already_reversed',
    'idempotency.key_required',
    ...WRITE,
  )
  async reverse(
    @CurrentTenant() ctx: TenantContext,
    @Param('journalId', ParseUUIDPipe) id: string,
    @Body() body: JournalReverseDto,
  ): Promise<JournalDto> {
    return journalDto(await this.ledger.reverse(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- ledger & reports

@ApiTags('owner.juristicAccounting')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic')
export class OwnerJuristicLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly reports: AccountingReportsService,
  ) {}

  @Post('ledger/actions/back-post')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicLedger.backPost',
    summary: 'Back-post the ledger now',
    description:
      'Runs the `juristic-ledger` job for this tenant at once: posts every issued invoice, void, credit / debit note, payment, reversal and refund that has no journal yet (idempotent by source) and recognises the advance-billed revenue due this month. Audited. Requires `Idempotency-Key` (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Counts', type: BackPostResultDto, example: { posted: 42, recognised: 3 } })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  backPost(@CurrentTenant() ctx: TenantContext): Promise<BackPostResultDto> {
    return this.ledger.backPost(ctx);
  }

  @Post('ledger/exports')
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicLedger.export',
    summary: 'Export journals',
    description:
      'Queues the journal lines of a range (≤ 3 years, optionally one building) as `csv` (getproperty layout, UTF-8 BOM), `express` (Express Accounting GL import, tab separated, Buddhist-era dates) or `flowaccount` (FlowAccount journal import) — column maps are data (`accounting/export-formats.ts`); the Express / FlowAccount layouts are unverified against the live import screens (O-043). Poll `GET /v1/owner/exports/{id}`. Requires `Idempotency-Key` (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiJsonBody(LedgerExportCreateDto, { format: 'express', from: '2027-01-01', to: '2027-12-31' })
  @ApiAsync({ poll: 'owner.exports.get' })
  @ApiSuccess(202, {
    description: 'Queued',
    type: ExportJobDto,
    example: {
      ...EXPORT_EXAMPLE,
      kind: 'juristic_journal_express' as ExportKindName,
      status: 'queued' as ExportStatusName,
    },
  })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  async export(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: LedgerExportCreateDto,
  ): Promise<ExportJobDto> {
    return exportDto(await this.reports.requestExport(ctx, body));
  }

  @Get('reports/income-statement')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.incomeStatement',
    summary: 'Income and expense statement',
    description:
      'Income and expense accounts by month, quarter or year from the journals (`from` … `to`, ≤ 3 years, optionally one building), totals and the surplus; the annual totals equal the ledger sums (invariant) (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Statement',
    type: IncomeStatementDto,
    example: {
      from: '2027-01-01',
      to: '2027-02-28',
      buildingId: null,
      granularity: 'month' as ReportGranularityName,
      periods: ['2027-01', '2027-02'],
      income: SECTION_EXAMPLE,
      expense: { ...SECTION_EXAMPLE, total: '191000.00', byPeriod: ['88000.00', '103000.00'] },
      surplusByPeriod: ['12000.00', '-3000.00'],
      surplus: '9000.00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async incomeStatement(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: IncomeStatementQuery,
  ): Promise<IncomeStatementDto> {
    const r = await this.reports.incomeStatement(ctx, q);
    return { ...r, granularity: r.granularity as ReportGranularityName };
  }

  @Get('reports/balance-sheet')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.balanceSheet',
    summary: 'Balance sheet',
    description:
      'Assets, liabilities and equity as of a day (default today), equity including the surplus to date (the light GL has no year-end closing); `balanced` = assets = liabilities + equity (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Balance sheet',
    type: BalanceSheetDto,
    example: {
      asOf: '2027-12-31',
      buildingId: null,
      assets: {
        accounts: [
          {
            accountId: FAKE.uuid,
            code: '1130',
            nameTh: 'เงินฝากธนาคาร – บัญชีดำเนินงาน',
            nameEn: 'Bank — operating account',
            balance: '154200.00',
          },
        ],
        total: '154200.00',
      },
      liabilities: {
        accounts: [
          {
            accountId: FAKE.uuid,
            code: '2130',
            nameTh: 'รายได้รับล่วงหน้า',
            nameEn: 'Unearned revenue (billed in advance)',
            balance: '25200.00',
          },
        ],
        total: '25200.00',
      },
      equity: {
        accounts: [
          {
            accountId: FAKE.uuid,
            code: '3110-01',
            nameTh: 'เงินกองทุนอาคารชุด',
            nameEn: 'Fund — เงินกองทุนอาคารชุด',
            balance: '120000.00',
          },
        ],
        surplusToDate: '9000.00',
        total: '129000.00',
      },
      balanced: true,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  balanceSheet(@CurrentTenant() ctx: TenantContext, @Query() q: AsOfQuery): Promise<BalanceSheetDto> {
    return this.reports.balanceSheet(ctx, q);
  }

  @Get('reports/trial-balance')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.trialBalance',
    summary: 'Trial balance',
    description:
      'Σ debits, Σ credits and the balance of every account with lines up to a day (D-312, D-329).',
    implements: ['D-312', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Trial balance',
    type: TrialBalanceDto,
    example: {
      asOf: '2027-12-31',
      buildingId: null,
      accounts: [
        {
          accountId: FAKE.uuid,
          code: '1140',
          nameTh: 'ลูกหนี้ค่าส่วนกลางและเงินกองทุน – เจ้าของร่วม',
          nameEn: 'Receivables — co-owners (common fees and fund)',
          type: 'asset' as AccountTypeName,
          debit: '43200.00',
          credit: '39600.00',
          balance: '3600.00',
        },
      ],
      totalDebit: '512000.00',
      totalCredit: '512000.00',
      balanced: true,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async trialBalance(@CurrentTenant() ctx: TenantContext, @Query() q: AsOfQuery): Promise<TrialBalanceDto> {
    const r = await this.reports.trialBalance(ctx, q);
    return { ...r, accounts: r.accounts.map((a) => ({ ...a, type: a.type as AccountTypeName })) };
  }

  @Get('reports/ledger-receivables')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.ledgerReceivables',
    summary: 'Receivables: ledger vs collections',
    description:
      'Per building the receivable account of the journals against the receivables figures (open invoice balances − payer credit + payment-plan amounts not invoiced yet); `difference` is 0 once every document is posted — a non-zero difference means a document is waiting for the ledger job (D-312, D-326, D-329).',
    implements: ['D-312', 'D-326', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Comparison',
    type: LedgerReceivablesDto,
    example: {
      asOf: '2027-06-30',
      perBuilding: [
        {
          buildingId: FAKE.buildingId,
          name: 'อาคาร A',
          ledgerReceivable: '45200.00',
          openInvoices: '46000.00',
          payerCredit: '800.00',
          planNotInvoiced: '0.00',
          expected: '45200.00',
          difference: '0.00',
        },
      ],
      total: {
        ledgerReceivable: '45200.00',
        openInvoices: '46000.00',
        payerCredit: '800.00',
        planNotInvoiced: '0.00',
        expected: '45200.00',
        difference: '0.00',
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  ledgerReceivables(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: FundListQuery,
  ): Promise<LedgerReceivablesDto> {
    return this.reports.ledgerReceivables(ctx, q);
  }
}

// ------------------------------------------------------------------------------------------- expenses

const EXPENSE_ERRORS = ['expense.invalid_state', 'idempotency.key_required', ...WRITE] as const;

@ApiTags('owner.juristicExpenses')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/expense-requests')
export class OwnerExpenseRequestsController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.expense.read')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.list',
    summary: 'Expense requests',
    description:
      'Newest first; filters state, kind (expense · petty_cash_top_up), building and `awaitingMe` (submitted requests the caller’s role may approve, not requested nor decided by the caller) (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiPaginated(ExpenseRequestDto, { example: EXPENSE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ExpenseListQuery,
  ): Promise<Page<ExpenseRequestDto>> {
    const { rows, total } = await this.expenses.list(ctx, {
      state: q.state,
      kind: q.kind,
      buildingId: q.buildingId,
      awaitingMe: q.awaitingMe === true,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => expenseDto(ctx, r)),
      total,
      q,
    );
  }

  @Get(':expenseRequestId')
  @TenantScoped()
  @Can('juristic.expense.read')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.get',
    summary: 'An expense request',
    description:
      'Lines, attachments, approvals, the band, the payment and the 50 ทวิ certificate (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Expense request', type: ExpenseRequestDto, example: EXPENSE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.get(ctx, id));
  }

  @Post()
  @TenantScoped()
  @Can('juristic.expense.request')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.create',
    summary: 'Draft an expense request',
    description:
      'A draft with lines on active expense accounts (amount incl. VAT, VAT part, optional WHT key of `juristic.wht_rates` — the rate is snapshotted, ⚖ O-041) or, kind `petty_cash_top_up`, an amount for a float. Paid from a fund only with an adopted resolution of the fund’s building (422 `fund.resolution_required`; also a DB CHECK). Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(ExpenseCreateDto, {
    buildingId: FAKE.buildingId,
    title: 'ค่ารักษาความปลอดภัย มกราคม 2570',
    payeePartyId: FAKE.uuid,
    lines: [
      {
        accountId: FAKE.uuid,
        description: 'ค่าจ้างรักษาความปลอดภัย มกราคม 2570',
        amount: '42800.00',
        vatAmount: '2800.00',
        whtKey: 'service',
      },
    ],
  })
  @ApiSuccess(201, {
    description: 'Draft',
    type: ExpenseRequestDto,
    example: {
      ...EXPENSE_EXAMPLE,
      number: null,
      state: 'draft',
      band: null,
      approvalsRequired: null,
      approvalsGiven: 0,
      submittedAt: null,
      approvals: [],
      nextActions: ['edit', 'submit', 'cancel', 'attach'],
      version: 1,
    },
  })
  @ApiStandardErrors('fund.resolution_required', 'fund.resolution_invalid', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ExpenseCreateDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.create(ctx, body));
  }

  @Patch(':expenseRequestId')
  @TenantScoped()
  @Can('juristic.expense.request')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.update',
    summary: 'Edit a draft',
    description:
      'Drafts only (409 `expense.invalid_state`); `lines` replaces every line. `version` → 412 when changed meanwhile. Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(ExpenseUpdateDto, { title: 'ค่ารักษาความปลอดภัย มกราคม 2570 (แก้ไข)', version: 1 })
  @ApiSuccess(200, {
    description: 'Draft',
    type: ExpenseRequestDto,
    example: { ...EXPENSE_EXAMPLE, state: 'draft', number: null },
  })
  @ApiStandardErrors(
    'expense.invalid_state',
    'concurrency.stale',
    'fund.resolution_required',
    'fund.resolution_invalid',
    ...WRITE,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: ExpenseUpdateDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.update(ctx, id, body));
  }

  @Post(':expenseRequestId/attachments')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.expense.request')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.attach',
    summary: 'Attach a document',
    description:
      'A quotation, the vendor’s invoice or receipt, payment evidence or another uploaded document (`POST /v1/owner/files/presign` first); not on cancelled / rejected requests; attaching the same document again changes nothing. Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(ExpenseAttachDto, { documentId: FAKE.uuid, kind: 'receipt' })
  @ApiSuccess(200, { description: 'Expense request', type: ExpenseRequestDto, example: EXPENSE_EXAMPLE })
  @ApiStandardErrors('expense.invalid_state', ...WRITE)
  async attach(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: ExpenseAttachDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.attach(ctx, id, body));
  }

  @Post(':expenseRequestId/actions/submit')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.request')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.submit',
    summary: 'Submit for approval',
    description:
      'Gives the gapless number `EXP-YYYY-NNNNN` and snapshots the approval band of `juristic.approval_bands` for the amount (roles + approvals needed); the band’s roles hear `juristic.expense.approval_required` (in-app + LINE; the committee on the manager routes). Audited. Requires `Idempotency-Key` (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Submitted',
    type: ExpenseRequestDto,
    example: { ...EXPENSE_EXAMPLE, approvalsGiven: 0, approvals: [] },
  })
  @ApiStandardErrors(...EXPENSE_ERRORS)
  async submit(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.submit(ctx, id));
  }

  @Post(':expenseRequestId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.approve')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.approve',
    summary: 'Approve',
    description:
      'One approval by a user whose role is in the request’s band (403 `expense.not_in_band`), never the requester (403 `expense.maker_checker` — D-091; the database refuses it too), once per user (409 `expense.already_decided`); the request is `approved` when the band’s number of approvals is reached. Audited. Requires `Idempotency-Key` (D-091, D-311, D-329).',
    implements: ['D-091', 'D-311', 'D-329'],
  })
  @ApiJsonBody(StepDecisionDto, { reason: 'ตรวจสอบใบเสนอราคาแล้ว' })
  @ApiSuccess(200, {
    description: 'Approval recorded',
    type: ExpenseRequestDto,
    example: {
      ...EXPENSE_EXAMPLE,
      state: 'approved',
      approvalsGiven: 2,
      nextActions: ['pay', 'cancel', 'attach'],
    },
  })
  @ApiStandardErrors(
    'expense.maker_checker',
    'expense.not_in_band',
    'expense.already_decided',
    ...EXPENSE_ERRORS,
  )
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: StepDecisionDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.decide(ctx, id, 'approved', body.reason ?? null));
  }

  @Post(':expenseRequestId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.approve')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.reject',
    summary: 'Reject',
    description:
      'A band approver (not the requester) rejects with a reason: the request is `rejected` at once. Audited. Requires `Idempotency-Key` (D-091, D-311, D-329).',
    implements: ['D-091', 'D-311', 'D-329'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ราคาสูงกว่าใบเสนอราคาอื่น ขอให้เสนอใหม่' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: ExpenseRequestDto,
    example: { ...EXPENSE_EXAMPLE, state: 'rejected', nextActions: [] },
  })
  @ApiStandardErrors(
    'expense.maker_checker',
    'expense.not_in_band',
    'expense.already_decided',
    ...EXPENSE_ERRORS,
  )
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.decide(ctx, id, 'rejected', body.reason));
  }

  @Post(':expenseRequestId/actions/cancel')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.request')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.cancel',
    summary: 'Cancel',
    description:
      'A draft, submitted or approved request (never a paid one) is cancelled with a reason. Audited. Requires `Idempotency-Key` (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ผู้รับเหมาถอนใบเสนอราคา' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: ExpenseRequestDto,
    example: { ...EXPENSE_EXAMPLE, state: 'cancelled', nextActions: [] },
  })
  @ApiStandardErrors(...EXPENSE_ERRORS)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.cancel(ctx, id, body.reason));
  }

  @Post(':expenseRequestId/actions/pay')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.pay')
  @ApiEndpoint({
    id: 'owner.juristicExpenses.pay',
    summary: 'Record the payment',
    description:
      'Money leaves: an approved request is paid by bank transfer / cheque (from the operating bank or the account given), cash, or from its fund (`fund` — the request carries the fund and its resolution). Evidence required except cash. Posts the journal (Dr expense lines / Cr WHT payable / Cr the account paid from; a fund payment also moves fund equity to the accumulated surplus); a top-up adds to its petty cash float. With WHT, the 50 ทวิ certificate is numbered `WHT-YYYY-NNNNN` (form ภ.ง.ด.53 for a company payee, ภ.ง.ด.3 for a person; the payee party needs its 13-digit tax id: 422 `wht.payee_tax_id_missing`) and its PDF is built by the worker (⚖ draft, O-041). The committee never pays (D-320). Audited. Requires `Idempotency-Key` (D-311, D-320, D-329).',
    implements: ['D-311', 'D-320', 'D-329'],
  })
  @ApiJsonBody(ExpensePayDto, {
    method: 'bank_transfer',
    paidOn: '2027-02-05',
    reference: 'KBank 0205-8812',
    evidenceDocumentId: FAKE.uuid,
  })
  @ApiSuccess(200, {
    description: 'Paid',
    type: ExpenseRequestDto,
    example: {
      ...EXPENSE_EXAMPLE,
      state: 'paid',
      approvalsGiven: 2,
      paidAt: FAKE.dateTime,
      paidOn: '2027-02-05',
      paymentMethod: 'bank_transfer',
      paymentReference: 'KBank 0205-8812',
      paidFromAccountId: FAKE.uuid,
      journalId: FAKE.uuid,
      certificate: { id: FAKE.uuid, number: 'WHT-2027-00001', documentId: null, tax: '1200.00' },
      nextActions: ['attach'],
    },
  })
  @ApiStandardErrors('wht.payee_tax_id_missing', ...EXPENSE_ERRORS)
  async pay(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseRequestId', ParseUUIDPipe) id: string,
    @Body() body: ExpensePayDto,
  ): Promise<ExpenseRequestDto> {
    return expenseDto(ctx, await this.expenses.pay(ctx, id, body));
  }
}

@ApiTags('owner.juristicExpenses')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/withholding-certificates')
export class OwnerWhtCertificatesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicWhtCertificates.list',
    summary: '50 ทวิ certificates',
    description:
      'Withholding-tax certificates issued when paying vendors, newest first (D-311, D-329, O-041 ⚖).',
    implements: ['D-311', 'D-329'],
  })
  @ApiPaginated(WhtCertificateDto, { example: CERT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: WhtCertificateListQuery,
  ): Promise<Page<WhtCertificateDto>> {
    const { rows, total } = await this.expenses.certificates(ctx, {
      buildingId: q.buildingId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(certificateDto), total, q);
  }

  @Get(':certificateId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicWhtCertificates.get',
    summary: 'A 50 ทวิ certificate',
    description: 'Payee, form, items (income type, rate, base, tax) and its PDF once built (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Certificate', type: WhtCertificateDto, example: CERT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('certificateId', ParseUUIDPipe) id: string,
  ): Promise<WhtCertificateDto> {
    return certificateDto(await this.expenses.certificate(ctx, id));
  }

  @Get(':certificateId/document')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicWhtCertificates.document',
    summary: 'Download the 50 ทวิ PDF',
    description:
      'A 5-minute signed URL of the PDF (409 `wht.document_pending` until the worker built it) (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Signed URL',
    type: DocumentDownloadDto,
    example: {
      documentId: FAKE.uuid,
      number: 'WHT-2027-00001',
      url: 'https://storage.example.com/wht.pdf?X-Amz-Signature=abc',
      expiresAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('wht.document_pending', 'validation.failed', 'http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('certificateId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.expenses.certificateDocument(ctx, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

// ------------------------------------------------------------------------------------------- funds

@ApiTags('owner.juristicFunds')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/funds')
export class OwnerFundsController {
  constructor(private readonly funds: FundsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicFunds.list',
    summary: 'Funds',
    description:
      'Funds per building (the sinking fund is created with the first fund contribution) with the balance of their own bank account and their equity (contributions billed − used) (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Funds', type: FundListDto, example: { data: [FUND_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: FundListQuery): Promise<FundListDto> {
    return { data: (await this.funds.funds(ctx, q)).map(fundDto) };
  }

  @Post()
  @TenantScoped()
  @Can('juristic.fund.manage')
  @ApiEndpoint({
    id: 'owner.juristicFunds.create',
    summary: 'Create a fund',
    description:
      'A fund of a building (sinking · reserve · other; name unique per building and kind: 409 `fund.name_taken`) with its two ledger accounts (fund bank 1160-NN, fund equity 3110-NN) and optionally the tenant bank account holding it. Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(FundCreateDto, { buildingId: FAKE.buildingId, kind: 'reserve', name: 'เงินสำรองซ่อมลิฟต์' })
  @ApiSuccess(201, {
    description: 'Created',
    type: FundDto,
    example: {
      ...FUND_EXAMPLE,
      kind: 'reserve',
      name: 'เงินสำรองซ่อมลิฟต์',
      bankBalance: '0.00',
      equityBalance: '0.00',
    },
  })
  @ApiStandardErrors('fund.name_taken', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: FundCreateDto): Promise<FundDto> {
    return fundDto(await this.funds.createFund(ctx, body));
  }

  @Get(':fundId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicFunds.get',
    summary: 'A fund',
    description: 'The fund with its balances (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Fund', type: FundDto, example: FUND_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundId', ParseUUIDPipe) id: string,
  ): Promise<FundDto> {
    return fundDto(await this.funds.fund(ctx, id));
  }

  @Patch(':fundId')
  @TenantScoped()
  @Can('juristic.fund.manage')
  @ApiEndpoint({
    id: 'owner.juristicFunds.update',
    summary: 'Edit a fund',
    description:
      'Rename, link the tenant bank account holding it, deactivate. `version` → 412. Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(FundUpdateDto, { bankAccountId: FAKE.uuid, version: 1 })
  @ApiSuccess(200, { description: 'Fund', type: FundDto, example: FUND_EXAMPLE })
  @ApiStandardErrors('fund.name_taken', 'concurrency.stale', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundId', ParseUUIDPipe) id: string,
    @Body() body: FundUpdateDto,
  ): Promise<FundDto> {
    return fundDto(await this.funds.updateFund(ctx, id, body));
  }

  @Get(':fundId/ledger')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicFunds.ledger',
    summary: 'Fund ledger',
    description: 'Journal lines on the fund’s bank and equity accounts, newest first (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiPaginated(FundLedgerLineDto, {
    example: {
      journalId: FAKE.uuid,
      postedOn: '2027-01-31',
      sourceType: 'fund_transfer',
      memo: 'โอนเข้าเงินกองทุนอาคารชุด',
      accountId: FAKE.uuid,
      accountCode: '1160-01',
      accountRole: 'fund_bank',
      debit: '20000.00',
      credit: '0.00',
      resolutionId: null,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async ledger(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundId', ParseUUIDPipe) id: string,
    @Query() q: PageQuery,
  ): Promise<Page<FundLedgerLineDto>> {
    const { rows, total } = await this.funds.ledgerLines(ctx, id, toSkipTake(q));
    return paginated(
      rows.map((l) => ({
        journalId: l.journal.id,
        postedOn: day(l.journal.postedOn),
        sourceType: l.journal.sourceType as JournalSourceName,
        memo: l.journal.memo,
        accountId: l.account.id,
        accountCode: l.account.code,
        accountRole: l.account.role ?? '',
        debit: l.debit.toFixed(2),
        credit: l.credit.toFixed(2),
        resolutionId: l.journal.resolutionId,
      })),
      total,
      q,
    );
  }

  @Post(':fundId/transfers')
  @Idempotent()
  @TenantScoped()
  @Can('juristic.fund.manage')
  @ApiEndpoint({
    id: 'owner.juristicFunds.requestTransfer',
    summary: 'Request a fund transfer',
    description:
      'Money into the fund (from a bank / cash account) or out of it — **out needs an adopted resolution of the fund’s building** (422 `fund.resolution_required` / `fund.resolution_invalid`; the database refuses it too). Waits for another user’s approval (`…/fund-transfers/{id}/actions/approve`). Audited. Requires `Idempotency-Key` (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(FundTransferCreateDto, {
    direction: 'out',
    amount: '120000.00',
    transferOn: '2027-03-01',
    resolutionId: FAKE.uuid,
  })
  @ApiSuccess(201, { description: 'Requested', type: FundTransferDto, example: TRANSFER_EXAMPLE })
  @ApiStandardErrors(
    'fund.resolution_required',
    'fund.resolution_invalid',
    'fund.inactive',
    'idempotency.key_required',
    ...WRITE,
  )
  async requestTransfer(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundId', ParseUUIDPipe) id: string,
    @Body() body: FundTransferCreateDto,
  ): Promise<FundTransferDto> {
    return transferDto(ctx, await this.funds.requestTransfer(ctx, id, body));
  }
}

@ApiTags('owner.juristicFunds')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/fund-transfers')
export class OwnerFundTransfersController {
  constructor(private readonly funds: FundsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicFundTransfers.list',
    summary: 'Fund transfers',
    description: 'Newest first; filters fund and state (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiPaginated(FundTransferDto, { example: TRANSFER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: FundTransferListQuery,
  ): Promise<Page<FundTransferDto>> {
    const { rows, total } = await this.funds.transfers(ctx, {
      fundId: q.fundId,
      state: q.state,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((t) => transferDto(ctx, t)),
      total,
      q,
    );
  }

  @Get(':fundTransferId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicFundTransfers.get',
    summary: 'A fund transfer',
    description: 'One transfer with its decision and journal (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Transfer', type: FundTransferDto, example: TRANSFER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundTransferId', ParseUUIDPipe) id: string,
  ): Promise<FundTransferDto> {
    return transferDto(ctx, await this.funds.transfer(ctx, id));
  }

  @Post(':fundTransferId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.fund.approve')
  @ApiEndpoint({
    id: 'owner.juristicFundTransfers.approve',
    summary: 'Approve and post',
    description:
      'Another user than the requester (403 `fund.maker_checker`; DB CHECK) approves: the journal is posted (in: Dr fund bank / Cr the other account; out: Dr the other account / Cr fund bank and fund equity → accumulated surplus) — out only up to the fund bank balance (422 `fund.insufficient`). Audited. Requires `Idempotency-Key` (D-091, D-311, D-329).',
    implements: ['D-091', 'D-311', 'D-329'],
  })
  @ApiJsonBody(StepDecisionDto, { reason: 'ตามมติที่ประชุมใหญ่ครั้งที่ 1/2570' })
  @ApiSuccess(200, {
    description: 'Posted',
    type: FundTransferDto,
    example: {
      ...TRANSFER_EXAMPLE,
      state: 'posted',
      decidedBy: FAKE.uuid,
      decidedAt: FAKE.dateTime,
      journalId: FAKE.uuid,
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'fund.invalid_state',
    'fund.maker_checker',
    'fund.insufficient',
    'idempotency.key_required',
    ...WRITE,
  )
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundTransferId', ParseUUIDPipe) id: string,
    @Body() body: StepDecisionDto,
  ): Promise<FundTransferDto> {
    return transferDto(ctx, await this.funds.decideTransfer(ctx, id, 'approve', body.reason ?? null));
  }

  @Post(':fundTransferId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.fund.approve')
  @ApiEndpoint({
    id: 'owner.juristicFundTransfers.reject',
    summary: 'Reject',
    description:
      'Another user than the requester rejects with a reason; nothing is posted. Audited. Requires `Idempotency-Key` (D-091, D-311, D-329).',
    implements: ['D-091', 'D-311', 'D-329'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ยังไม่มีมติที่ประชุมรองรับ' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: FundTransferDto,
    example: { ...TRANSFER_EXAMPLE, state: 'rejected', nextActions: [] },
  })
  @ApiStandardErrors('fund.invalid_state', 'fund.maker_checker', 'idempotency.key_required', ...WRITE)
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('fundTransferId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<FundTransferDto> {
    return transferDto(ctx, await this.funds.decideTransfer(ctx, id, 'reject', body.reason));
  }
}

// ------------------------------------------------------------------------------------------- petty cash

@ApiTags('owner.juristicFunds')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/petty-cash')
export class OwnerPettyCashController {
  constructor(private readonly funds: FundsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.expense.read')
  @ApiEndpoint({
    id: 'owner.juristicPettyCash.list',
    summary: 'Petty cash floats',
    description:
      'Floats per building with their balance (Σ top-ups − spends ± count differences) and last count (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Floats', type: PettyCashListDto, example: { data: [PETTY_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: FundListQuery): Promise<PettyCashListDto> {
    return { data: (await this.funds.pettyCashes(ctx, q)).map(pettyDto) };
  }

  @Post()
  @TenantScoped()
  @Can('juristic.fund.manage')
  @ApiEndpoint({
    id: 'owner.juristicPettyCash.create',
    summary: 'Create a petty cash float',
    description:
      'A float of a building with its custodian (an active staff, manager, accountant or owner) and its own ledger account (1120-NN); it starts empty — top it up with an expense request of kind `petty_cash_top_up`. Audited (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(PettyCashCreateDto, {
    buildingId: FAKE.buildingId,
    name: 'เงินสดย่อยสำนักงานนิติ',
    custodianUserId: FAKE.uuid,
    floatAmount: '5000.00',
  })
  @ApiSuccess(201, {
    description: 'Created',
    type: PettyCashDetailDto,
    example: { ...PETTY_DETAIL_EXAMPLE, balance: '0.00', lastCount: null, entries: [], counts: [] },
  })
  @ApiStandardErrors('petty_cash.name_taken', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: PettyCashCreateDto,
  ): Promise<PettyCashDetailDto> {
    return this.detail(await this.funds.createPettyCash(ctx, body));
  }

  private detail(p: Awaited<ReturnType<FundsService['pettyCash']>>): PettyCashDetailDto {
    return {
      ...pettyDto(p),
      entries: p.entries.map((e) => ({
        id: e.id,
        kind: e.kind as PettyCashEntryKindName,
        amount: e.amount.toFixed(2),
        entryOn: day(e.entryOn),
        description: e.description,
        accountId: e.accountId,
        receiptDocumentId: e.receiptDocumentId,
        expenseRequestId: e.expenseRequestId,
        countId: e.countId,
        journalId: e.journalId,
        createdAt: toBangkokIso(e.createdAt),
      })),
      counts: p.counts.map((c) => ({
        id: c.id,
        countedOn: day(c.countedOn),
        countedAmount: c.countedAmount.toFixed(2),
        bookBalance: c.bookBalance.toFixed(2),
        difference: c.difference.toFixed(2),
        note: c.note,
        countedBy: c.countedBy,
        createdAt: toBangkokIso(c.createdAt),
      })),
    };
  }

  @Get(':pettyCashId')
  @TenantScoped()
  @Can('juristic.expense.read')
  @ApiEndpoint({
    id: 'owner.juristicPettyCash.get',
    summary: 'A petty cash float',
    description: 'Balance, entries (newest 200) and counts (newest 50) (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiSuccess(200, { description: 'Float', type: PettyCashDetailDto, example: PETTY_DETAIL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('pettyCashId', ParseUUIDPipe) id: string,
  ): Promise<PettyCashDetailDto> {
    return this.detail(await this.funds.pettyCash(ctx, id));
  }

  @Post(':pettyCashId/spends')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.petty_cash.spend')
  @ApiEndpoint({
    id: 'owner.juristicPettyCash.spend',
    summary: 'Record a spend',
    description:
      'Cash spent with its receipt (required) on an expense account: Dr expense / Cr petty cash; never above the balance (422 `petty_cash.insufficient`); staff only as the float’s custodian (403 `petty_cash.not_custodian`). Audited. Requires `Idempotency-Key` (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(PettyCashSpendDto, {
    amount: '350.00',
    spentOn: '2027-01-12',
    description: 'ค่าหลอดไฟทางเดิน',
    accountId: FAKE.uuid,
    receiptDocumentId: FAKE.uuid,
  })
  @ApiSuccess(200, { description: 'Float', type: PettyCashDetailDto, example: PETTY_DETAIL_EXAMPLE })
  @ApiStandardErrors(
    'petty_cash.insufficient',
    'petty_cash.not_custodian',
    'petty_cash.inactive',
    'idempotency.key_required',
    ...WRITE,
  )
  async spend(
    @CurrentTenant() ctx: TenantContext,
    @Param('pettyCashId', ParseUUIDPipe) id: string,
    @Body() body: PettyCashSpendDto,
  ): Promise<PettyCashDetailDto> {
    return this.detail(await this.funds.spend(ctx, id, body));
  }

  @Post(':pettyCashId/counts')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.fund.manage')
  @ApiEndpoint({
    id: 'owner.juristicPettyCash.count',
    summary: 'Count the float (reconcile)',
    description:
      'Records the cash counted against the book balance; a difference is posted (shortage: Dr other expenses / Cr petty cash; overage: Dr petty cash / Cr other income) and becomes an entry. Audited. Requires `Idempotency-Key` (D-311, D-329).',
    implements: ['D-311', 'D-329'],
  })
  @ApiJsonBody(PettyCashCountCreateDto, { countedOn: '2027-01-31', countedAmount: '4210.00' })
  @ApiSuccess(200, { description: 'Float', type: PettyCashDetailDto, example: PETTY_DETAIL_EXAMPLE })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  async count(
    @CurrentTenant() ctx: TenantContext,
    @Param('pettyCashId', ParseUUIDPipe) id: string,
    @Body() body: PettyCashCountCreateDto,
  ): Promise<PettyCashDetailDto> {
    return this.detail(await this.funds.count(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- bank statements

@ApiTags('owner.juristicBankStatements')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/bank-statements')
export class OwnerBankStatementsController {
  constructor(private readonly statements: BankStatementsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicBankStatements.list',
    summary: 'Imported bank statements',
    description: 'Newest first with matched / unmatched counts; filter by tenant bank account (D-329).',
    implements: ['D-329'],
  })
  @ApiPaginated(BankStatementDto, { example: STATEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: BankStatementListQuery,
  ): Promise<Page<BankStatementDto>> {
    const { rows, total } = await this.statements.statements(ctx, {
      bankAccountId: q.bankAccountId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(statementDto), total, q);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicBankStatements.import',
    summary: 'Import a bank statement',
    description:
      'A CSV of KBank / SCB / BBL / KTB (base64, ≤ 2 MB) read with the bank’s column map (data; layouts unverified against live bank files): the same file again returns the statement already imported (`replayed: true`, sha256); lines an overlapping file already brought are skipped (`duplicates`). New lines are matched automatically when unambiguous — money in to confirmed payments, money out to paid expense requests, either to posted fund transfers — by amount, date (± `juristic.bank_match_days`) and a reference found in the bank’s text; the rest wait in the unmatched queue. Unreadable files → 422 `bank_statement.unreadable` (params `reason`, `line`). Audited. Requires `Idempotency-Key` (D-329).',
    implements: ['D-329'],
  })
  @ApiJsonBody(BankStatementImportDto, {
    bankAccountId: FAKE.uuid,
    formatKey: 'kbank',
    fileName: 'kbank-2027-01.csv',
    content: '77u/4Lin4Lix4LiZ4LiX4Li14LmILC4LmA4Lin4Lil4LiyLA==',
  })
  @ApiSuccess(201, {
    description: 'Imported',
    type: BankStatementImportResultDto,
    example: { statement: STATEMENT_EXAMPLE, replayed: false, imported: 38, duplicates: 2, autoMatched: 30 },
  })
  @ApiStandardErrors('bank_statement.unreadable', 'idempotency.key_required', ...WRITE)
  async import(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: BankStatementImportDto,
  ): Promise<BankStatementImportResultDto> {
    const r = await this.statements.import(ctx, body);
    return { ...r, statement: statementDto(r.statement) };
  }

  @Get(':statementId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicBankStatements.get',
    summary: 'An imported statement',
    description:
      'The statement with its counts; its lines are under `…/bank-statement-lines?statementId=` (D-329).',
    implements: ['D-329'],
  })
  @ApiSuccess(200, { description: 'Statement', type: BankStatementDto, example: STATEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('statementId', ParseUUIDPipe) id: string,
  ): Promise<BankStatementDto> {
    return statementDto(await this.statements.statement(ctx, id));
  }
}

@ApiTags('owner.juristicBankStatements')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/bank-statement-lines')
export class OwnerBankStatementLinesController {
  constructor(private readonly statements: BankStatementsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicBankStatementLines.list',
    summary: 'Statement lines (unmatched queue)',
    description:
      'By default the unmatched queue (oldest first); `state` matched · ignored · all; `statementId` one file (D-329).',
    implements: ['D-329'],
  })
  @ApiPaginated(BankStatementLineDto, { example: LINE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: BankLineListQuery,
  ): Promise<Page<BankStatementLineDto>> {
    const { rows, total } = await this.statements.lines(ctx, {
      statementId: q.statementId,
      state: q.state,
      ...toSkipTake(q),
    });
    return paginated(rows.map(lineDto), total, q);
  }

  @Get(':lineId')
  @TenantScoped()
  @Can('juristic.accounting.read')
  @ApiEndpoint({
    id: 'owner.juristicBankStatementLines.get',
    summary: 'A line with suggestions',
    description:
      'An unmatched line comes with ranked candidates (same amount, within the window; reference hits first) (D-329).',
    implements: ['D-329'],
  })
  @ApiSuccess(200, { description: 'Line', type: BankStatementLineDetailDto, example: LINE_DETAIL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('lineId', ParseUUIDPipe) id: string,
  ): Promise<BankStatementLineDetailDto> {
    const l = await this.statements.line(ctx, id);
    return {
      ...lineDto(l),
      suggestions: l.suggestions.map((s) => ({
        kind: s.kind as BankMatchKindName,
        id: s.id,
        amount: s.amount,
        bookedOn: s.on,
        label: s.label,
        referenceHit: s.referenceHit,
        days: s.days,
      })),
    };
  }

  @Post(':lineId/actions/match')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicBankStatementLines.match',
    summary: 'Match by hand',
    description:
      'An unmatched line (409 `bank_statement.line_not_open`) matched to a confirmed payment, a paid expense request or a posted fund transfer of the same signed amount (422 `bank_statement.amount_mismatch`) not matched to another line (409 `bank_statement.already_matched`). Audited. Requires `Idempotency-Key` (D-329).',
    implements: ['D-329'],
  })
  @ApiJsonBody(BankLineMatchDto, { kind: 'payment', targetId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Matched',
    type: BankStatementLineDetailDto,
    example: {
      ...LINE_EXAMPLE,
      matchKind: 'payment',
      matchId: FAKE.uuid,
      matchMethod: 'manual',
      matchedAt: FAKE.dateTime,
      suggestions: [],
    },
  })
  @ApiStandardErrors(
    'bank_statement.line_not_open',
    'bank_statement.amount_mismatch',
    'bank_statement.already_matched',
    'idempotency.key_required',
    ...WRITE,
  )
  async match(
    @CurrentTenant() ctx: TenantContext,
    @Param('lineId', ParseUUIDPipe) id: string,
    @Body() body: BankLineMatchDto,
  ): Promise<BankStatementLineDetailDto> {
    const l = await this.statements.match(ctx, id, body);
    return { ...lineDto(l), suggestions: [] };
  }

  @Post(':lineId/actions/ignore')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicBankStatementLines.ignore',
    summary: 'Ignore a line',
    description:
      'An unmatched line leaves the queue with a reason (bank fees booked by a manual journal, interest …). Audited. Requires `Idempotency-Key` (D-329).',
    implements: ['D-329'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ค่าธรรมเนียมธนาคาร บันทึกด้วยรายการปรับปรุง' })
  @ApiSuccess(200, {
    description: 'Ignored',
    type: BankStatementLineDetailDto,
    example: {
      ...LINE_EXAMPLE,
      matchKind: 'ignored',
      matchMethod: 'manual',
      matchedAt: FAKE.dateTime,
      ignoreReason: 'ค่าธรรมเนียมธนาคาร',
      suggestions: [],
    },
  })
  @ApiStandardErrors('bank_statement.line_not_open', 'idempotency.key_required', ...WRITE)
  async ignore(
    @CurrentTenant() ctx: TenantContext,
    @Param('lineId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<BankStatementLineDetailDto> {
    const l = await this.statements.ignore(ctx, id, body.reason);
    return { ...lineDto(l), suggestions: [] };
  }

  @Post(':lineId/actions/unmatch')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.accounting.manage')
  @ApiEndpoint({
    id: 'owner.juristicBankStatementLines.unmatch',
    summary: 'Undo a match or an ignore',
    description:
      'The line returns to the unmatched queue with its suggestions. Audited. Requires `Idempotency-Key` (D-329).',
    implements: ['D-329'],
  })
  @ApiSuccess(200, {
    description: 'Back in the queue',
    type: BankStatementLineDetailDto,
    example: LINE_DETAIL_EXAMPLE,
  })
  @ApiStandardErrors('bank_statement.line_not_open', 'idempotency.key_required', ...WRITE)
  async unmatch(
    @CurrentTenant() ctx: TenantContext,
    @Param('lineId', ParseUUIDPipe) id: string,
  ): Promise<BankStatementLineDetailDto> {
    const l = await this.statements.unmatch(ctx, id);
    return {
      ...lineDto(l),
      suggestions: l.suggestions.map((s) => ({
        kind: s.kind as BankMatchKindName,
        id: s.id,
        amount: s.amount,
        bookedOn: s.on,
        label: s.label,
        referenceHit: s.referenceHit,
        days: s.days,
      })),
    };
  }
}
