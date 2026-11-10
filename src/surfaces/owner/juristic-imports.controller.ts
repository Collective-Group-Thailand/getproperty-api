import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
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
import { type Page } from '@common/pagination/pagination.dto';
import { permissionsOf } from '@core/tenancy/access.service';
import { type ImportCycleDifference } from '@generated/prisma/client';
import { JuristicFullExportService } from '@modules/ops-juristic/imports/full-export.service';
import { type ReconcileItem } from '@modules/ops-juristic/imports/import-plan';
import {
  type Issue,
  issueMessage,
  type Language,
  template,
} from '@modules/ops-juristic/imports/import-sheets';
import {
  type ImportJobRow,
  ImportsService,
  type StoredTotals,
} from '@modules/ops-juristic/imports/imports.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { EXPORT_EXAMPLE, exportDto } from './documents.controller';
import { ExportJobDto, type ExportKindName, type ExportStatusName } from './documents.dto';
import {
  type ImportFormatName,
  ImportSheetName,
  type ImportStateName,
  type JuristicCycleDifferenceDto,
  JuristicImportBadRowsQuery,
  JuristicImportCommitDto,
  JuristicImportCreateDto,
  JuristicImportDifferenceExplainDto,
  type JuristicImportFileDto,
  JuristicImportFileUploadDto,
  JuristicImportGoLiveDto,
  JuristicImportJobDto,
  JuristicImportListQuery,
  JuristicImportParallelCycleDto,
  JuristicImportPreviewDto,
  JuristicImportReconcileDto,
  JuristicImportRollbackDto,
  JuristicImportRowDto,
  JuristicImportRowsQuery,
  JuristicImportTemplateQuery,
  type JuristicImportTotalsDto,
  JuristicParallelCycleReportDto,
  type ReconcileAccountTypeName,
  type ReconcileKindName,
  type ReconcileStatusName,
} from './juristic-imports.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const READ = ['validation.failed', 'http.not_found', ...T] as const;
const FILE_ERRORS = [
  'import.file_invalid',
  'document.not_uploaded',
  'document.scan_pending',
  'document.infected',
  'document.type_not_allowed',
] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------- mappers

const TOTAL_KEYS = [
  'units',
  'unitsNew',
  'unitsAttached',
  'floorsNew',
  'parties',
  'partiesNew',
  'partiesAttached',
  'ownerships',
  'unitsIncomplete',
  'billTos',
  'openingInvoices',
  'unitsInArrears',
  'principal',
  'surcharge',
  'receivables',
  'historyCount',
  'historyAmount',
  'bankOperating',
  'bankFund',
  'errors',
  'warnings',
] as const;

function totalsDto(t: StoredTotals): JuristicImportTotalsDto | null {
  if (!t.planHash) return null;
  return Object.fromEntries(TOTAL_KEYS.map((k) => [k, t[k]])) as unknown as JuristicImportTotalsDto;
}

function nextActions(ctx: TenantContext, job: ImportJobRow): string[] {
  const perms = permissionsOf(ctx.role ? [ctx.role] : []);
  if (!perms.has('juristic.import.manage')) return [];
  switch (job.state) {
    case 'draft':
      return ['upload', 'validate', 'cancel'];
    case 'validated':
      return ['upload', 'validate', 'reconcile', 'cancel'];
    case 'reconciled':
      return ['upload', 'validate', 'reconcile', 'commit', 'cancel'];
    case 'committed':
      return ['parallel_cycle', 'rollback', 'go_live'];
    default:
      return [];
  }
}

export function importJobDto(
  ctx: TenantContext,
  job: ImportJobRow,
  created: Record<string, number> = {},
): JuristicImportJobDto {
  const rec = job.reconciliation as unknown as {
    items: ReconcileItem[];
    explanationRequired: boolean;
  } | null;
  return {
    id: job.id,
    number: job.number,
    buildingId: job.buildingId,
    buildingName: job.building.name,
    state: job.state as ImportStateName,
    asOfDate: day(job.asOfDate),
    note: job.note,
    files: job.files.map((f): JuristicImportFileDto => ({
      sheet: f.sheet as ImportSheetName,
      documentId: f.documentId,
      fileName: f.fileName,
      format: f.format as ImportFormatName,
      rowCount: f.rowCount,
      errorCount: f.errorCount,
      warningCount: f.warningCount,
      uploadedAt: iso(f.uploadedAt),
    })),
    totals: totalsDto(job.computedTotals as StoredTotals),
    reconciliation:
      rec && job.reconciledAt
        ? {
            items: rec.items.map((i) => ({
              ...i,
              kind: i.kind as ReconcileKindName,
              status: i.status as ReconcileStatusName,
              accountType: (i.accountType ?? null) as ReconcileAccountTypeName | null,
              last4: i.last4 ?? null,
              fundName: i.fundName ?? null,
            })),
            explanationRequired: rec.explanationRequired,
            declaredReceivables: job.declaredReceivables?.toFixed(2) ?? '0.00',
            note: job.reconciliationNote,
            documentId: job.reconciliationDocumentId,
            reconciledAt: iso(job.reconciledAt),
          }
        : null,
    created,
    committedAt: isoOrNull(job.committedAt),
    liveAt: isoOrNull(job.liveAt),
    rolledBackAt: isoOrNull(job.rolledBackAt),
    rollbackReason: job.rollbackReason,
    cancelledAt: isoOrNull(job.cancelledAt),
    parallelCycleId: job.parallelCycleId,
    parallelRunAt: isoOrNull(job.parallelRunAt),
    nextActions: nextActions(ctx, job),
    createdAt: iso(job.createdAt),
    version: job.version,
  };
}

const issueDto = (lang: Language) => (i: Issue) => ({
  column: i.column,
  code: i.code,
  message: issueMessage(i, lang),
});

const differenceDto = (d: ImportCycleDifference): JuristicCycleDifferenceDto => ({
  id: d.id,
  unitId: d.unitId,
  unitNo: d.unitNo,
  computed: d.computed.toFixed(2),
  legacy: d.legacy.toFixed(2),
  difference: d.difference.toFixed(2),
  explanation: d.explanation,
  explainedAt: isoOrNull(d.explainedAt),
});

function reportDto(r: Awaited<ReturnType<ImportsService['parallelReport']>>): JuristicParallelCycleReportDto {
  return {
    importJobId: r.job.id,
    billingCycleId: r.cycle?.id ?? null,
    periodKey: r.cycle?.periodKey ?? null,
    runAt: isoOrNull(r.runAt),
    summary: r.summary,
    differences: r.rows.map(differenceDto),
  };
}

function send(res: Response, f: { fileName: string; mimeType: string; body: Buffer }): void {
  res.setHeader('Content-Type', f.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(f.body);
}

const ApiFile = (description: string) =>
  ApiResponse({
    status: 200,
    description,
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: { type: 'string', format: 'binary' },
        example: 'UEsDBBQABgAIAAAAIQ… (xlsx bytes)',
      },
      'text/csv': {
        schema: { type: 'string' },
        example: '\uFEFFเลขที่ห้อง / แปลง (unit_no) *,ชื่อเจ้าของ (owner_name) *\r\n',
      },
    },
  });

const TOTALS_EXAMPLE: JuristicImportTotalsDto = {
  units: 500,
  unitsNew: 500,
  unitsAttached: 0,
  floorsNew: 25,
  parties: 530,
  partiesNew: 530,
  partiesAttached: 0,
  ownerships: 512,
  unitsIncomplete: 0,
  billTos: 6,
  openingInvoices: 120,
  unitsInArrears: 120,
  principal: '812000.00',
  surcharge: '33210.50',
  receivables: '845210.50',
  historyCount: 4800,
  historyAmount: '5123400.00',
  bankOperating: '152300.55',
  bankFund: '880000.00',
  errors: 0,
  warnings: 3,
};

const JOB_EXAMPLE: JuristicImportJobDto = {
  id: FAKE.uuid,
  number: 1,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  state: 'reconciled' as ImportStateName,
  asOfDate: '2026-10-31',
  note: null,
  files: [
    {
      sheet: 'register' as ImportSheetName,
      documentId: FAKE.uuid,
      fileName: 'register.xlsx',
      format: 'xlsx' as ImportFormatName,
      rowCount: 512,
      errorCount: 0,
      warningCount: 3,
      uploadedAt: FAKE.dateTime,
    },
  ],
  totals: TOTALS_EXAMPLE,
  reconciliation: {
    items: [
      {
        key: 'receivables',
        kind: 'receivables' as ReconcileKindName,
        label: 'receivables',
        imported: '845210.50',
        reference: '845210.50',
        difference: '0.00',
        status: 'match' as ReconcileStatusName,
        accountType: null,
        last4: null,
        fundName: null,
      },
      {
        key: 'bank:2',
        kind: 'bank' as ReconcileKindName,
        label: 'operating ••4012',
        imported: '120000.00',
        reference: '120000.00',
        difference: '0.00',
        status: 'match' as ReconcileStatusName,
        accountType: 'operating' as ReconcileAccountTypeName,
        last4: '4012',
        fundName: null,
      },
    ],
    explanationRequired: false,
    declaredReceivables: '845210.50',
    note: null,
    documentId: null,
    reconciledAt: FAKE.dateTime,
  },
  created: {},
  committedAt: null,
  liveAt: null,
  rolledBackAt: null,
  rollbackReason: null,
  cancelledAt: null,
  parallelCycleId: null,
  parallelRunAt: null,
  nextActions: ['upload', 'validate', 'reconcile', 'commit', 'cancel'],
  createdAt: FAKE.dateTime,
  version: 4,
};

const COMMITTED_EXAMPLE: JuristicImportJobDto = {
  ...JOB_EXAMPLE,
  state: 'committed' as ImportStateName,
  committedAt: FAKE.dateTime,
  created: {
    floor: 25,
    unit: 500,
    party: 530,
    unit_ownership: 512,
    bill_to: 6,
    invoice: 120,
    legacy_payment: 4800,
  },
  nextActions: ['parallel_cycle', 'rollback', 'go_live'],
  version: 5,
};

const REPORT_EXAMPLE: JuristicParallelCycleReportDto = {
  importJobId: FAKE.uuid,
  billingCycleId: FAKE.uuid,
  periodKey: '2026-11',
  runAt: FAKE.dateTime,
  summary: {
    units: 500,
    matching: 499,
    different: 1,
    unexplained: 1,
    computedTotal: '521550.00',
    legacyTotal: '521600.00',
    differenceTotal: '-50.00',
  },
  differences: [
    {
      id: FAKE.uuid,
      unitId: FAKE.uuid,
      unitNo: 'A-1201',
      computed: '1043.10',
      legacy: '1093.10',
      difference: '-50.00',
      explanation: null,
      explainedAt: null,
    },
  ],
};

// ------------------------------------------------------------------------------------------- controller

@ApiTags('owner.juristicImports')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic')
export class OwnerJuristicImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly exporter: JuristicFullExportService,
  ) {}

  private async dto(ctx: TenantContext, id: string): Promise<JuristicImportJobDto> {
    const d = await this.imports.detail(ctx, id);
    return importJobDto(ctx, d.job, d.created);
  }

  @Get('imports/templates/:sheet')
  @ApiParam({ name: 'sheet', enum: ImportSheetName, enumName: 'ImportSheet' })
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.template',
    summary: 'Download an import template',
    description:
      'The template of a sheet — `register` (units, owners with ID type + last 4 only, shares, bill-to), `opening_balance` (principal and surcharge per unit, owner and period), `payment_history` (12 months), `bank_balance` (operating and fund accounts), `legacy_bills` (parallel cycle) — as XLSX (data sheet with two `#` example rows + an instructions sheet) or CSV (UTF-8 with BOM), headers and instructions in Thai or English (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiFile('The template')
  @ApiStandardErrors(...READ)
  async template(
    @CurrentTenant() _ctx: TenantContext,
    @Param('sheet', new ParseEnumPipe(ImportSheetName)) sheet: ImportSheetName,
    @Query() q: JuristicImportTemplateQuery,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await template(sheet, q.format ?? 'xlsx', q.language ?? 'th'));
  }

  @Post('imports')
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.create',
    summary: 'Start an import from a legacy system',
    description:
      'One job per building the juristic tenant operates (another open or committed job of the building → 409 `import.job_open`) with the as-of date of the legacy figures (today or earlier). Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportCreateDto, { buildingId: FAKE.buildingId, asOfDate: '2026-10-31' })
  @ApiSuccess(201, {
    description: 'Job',
    type: JuristicImportJobDto,
    example: { ...JOB_EXAMPLE, state: 'draft', files: [], totals: null, reconciliation: null, version: 1 },
  })
  @ApiStandardErrors('import.job_open', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: JuristicImportCreateDto,
  ): Promise<JuristicImportJobDto> {
    const job = await this.imports.create(ctx, body);
    return importJobDto(ctx, job);
  }

  @Get('imports')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.list',
    summary: 'Import jobs',
    description: 'Newest first; filters building and state (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiPaginated(JuristicImportJobDto, { example: JOB_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: JuristicImportListQuery,
  ): Promise<Page<JuristicImportJobDto>> {
    const { rows, total } = await this.imports.list(ctx, {
      buildingId: q.buildingId,
      state: q.state,
      open: q.open,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => importJobDto(ctx, r)),
      total,
      q,
    );
  }

  @Get('imports/:importId')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.get',
    summary: 'An import job',
    description:
      'Files per sheet with row / error / warning counts, the totals of the last validation, the reconciliation, what the commit created per entity, the parallel cycle and the caller’s next actions (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiSuccess(200, { description: 'Job', type: JuristicImportJobDto, example: JOB_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
  ): Promise<JuristicImportJobDto> {
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/files')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.upload',
    summary: 'Upload the file of a sheet',
    description:
      'CSV (UTF-8, `,` `;` or tab) or XLSX, ≤ 5 MB and 5,000 rows, through `files/presign` (`fileId`, kind `other`) or inline (`fileName` + base64 `content`); headers by key, Thai or English label. Replaces the sheet’s previous file and re-validates the whole job row by row against the building (field and cross-file errors; a full ID number is refused and never stored). The job is `validated` when register and opening balances are present without errors, else `draft`; a changed plan clears the reconciliation. Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportFileUploadDto, { sheet: 'register', fileId: FAKE.uuid })
  @ApiSuccess(200, { description: 'Job, re-validated', type: JuristicImportJobDto, example: JOB_EXAMPLE })
  @ApiStandardErrors('import.invalid_state', ...FILE_ERRORS, ...WRITE)
  async upload(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportFileUploadDto,
  ): Promise<JuristicImportJobDto> {
    await this.imports.upload(ctx, id, { ...body, sheet: body.sheet });
    return this.dto(ctx, id);
  }

  @Delete('imports/:importId/files/:sheet')
  @ApiParam({ name: 'sheet', enum: ImportSheetName, enumName: 'ImportSheet' })
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.removeFile',
    summary: 'Remove the file of a sheet',
    description: 'Before the commit only; the job is re-validated. Audited (D-332).',
    implements: ['D-332'],
  })
  @ApiSuccess(200, { description: 'Job, re-validated', type: JuristicImportJobDto, example: JOB_EXAMPLE })
  @ApiStandardErrors('import.invalid_state', ...FILE_ERRORS, ...WRITE)
  async removeFile(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Param('sheet', new ParseEnumPipe(ImportSheetName)) sheet: ImportSheetName,
  ): Promise<JuristicImportJobDto> {
    await this.imports.removeFile(ctx, id, sheet);
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/actions/validate')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.validate',
    summary: 'Validate again',
    description:
      'Every file re-read and the plan recomputed against the building as it is now (after adding a bank account, a fund or fixing the register). Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiSuccess(200, { description: 'Job, re-validated', type: JuristicImportJobDto, example: JOB_EXAMPLE })
  @ApiStandardErrors('import.invalid_state', ...FILE_ERRORS, ...WRITE)
  async validate(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
  ): Promise<JuristicImportJobDto> {
    await this.imports.validate(ctx, id);
    return this.dto(ctx, id);
  }

  @Get('imports/:importId/preview')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.preview',
    summary: 'Preview what the commit would write',
    description:
      'Counts (units new / attached, floors / sois to create, parties new / attached, ownerships, units with shares under 100 %, bill-to), the opening balances (Σ principal, Σ surcharge, units in arrears, largest first), the payment history and the bank opening balances — recomputed now; open jobs only (409 `import.invalid_state`) (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiSuccess(200, {
    description: 'Preview',
    type: JuristicImportPreviewDto,
    example: {
      totals: TOTALS_EXAMPLE,
      floorsToCreate: [{ level: 12, name: 'ชั้น 12' }],
      openingBalances: [
        {
          unitNo: 'A-1201',
          ownerName: 'สมชาย ใจดี',
          billedName: 'สมชาย ใจดี',
          periodStart: '2026-07-01',
          periodEnd: '2026-10-31',
          lines: 4,
          total: '4197.40',
        },
      ],
      truncated: false,
    },
  })
  @ApiStandardErrors('import.invalid_state', ...FILE_ERRORS, ...READ)
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
  ): Promise<JuristicImportPreviewDto> {
    const { result } = await this.imports.preview(ctx, id);
    const names = new Map(result.plan.parties.map((p) => [p.key, p.displayName]));
    const invoices = [...result.plan.invoices].sort((a, b) => Number(b.total) - Number(a.total));
    return {
      totals: result.totals,
      floorsToCreate: result.plan.floors.map((f) => ({ level: f.level, name: f.name })),
      openingBalances: invoices.slice(0, 200).map((i) => ({
        unitNo: i.unitNo,
        ownerName: names.get(i.ownerKey) ?? '',
        billedName: names.get(i.billedKey) ?? '',
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        lines: i.lines.length,
        total: i.total,
      })),
      truncated: invoices.length > 200,
    };
  }

  @Get('imports/:importId/rows')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.rows',
    summary: 'Rows of the import with their issues',
    description:
      'By sheet and row number; `errorsOnly` lists the rows to fix; each issue has its column, code and a message in Thai or English (`language`) (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiPaginated(JuristicImportRowDto, {
    example: {
      sheet: 'register',
      rowNo: 7,
      data: { unit_no: 'A-1201', owner_name: 'สมชาย ใจดี', id_last4: null },
      errors: [
        {
          column: 'id_last4',
          code: 'id_full_refused',
          message: 'ไม่รับเลขบัตรเต็ม (PDPA) — ใส่เฉพาะ 4 หลักท้าย ข้อมูลนี้ไม่ถูกบันทึก',
        },
      ],
      warnings: [],
    },
  })
  @ApiStandardErrors(...READ)
  async rows(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Query() q: JuristicImportRowsQuery,
  ): Promise<Page<JuristicImportRowDto>> {
    const lang = q.language ?? 'th';
    const { rows, total } = await this.imports.rows(ctx, id, {
      sheet: q.sheet,
      errorsOnly: q.errorsOnly,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => {
        const { _raw: _r, ...data } = r.data as Record<string, string | null> & { _raw?: unknown };
        return {
          sheet: r.sheet as ImportSheetName,
          rowNo: r.rowNo,
          data,
          errors: (r.errors as unknown as Issue[]).map(issueDto(lang)),
          warnings: (r.warnings as unknown as Issue[]).map(issueDto(lang)),
        };
      }),
      total,
      q,
    );
  }

  @Get('imports/:importId/bad-rows')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.badRows',
    summary: 'Download the rows with errors',
    description:
      'The rows of a sheet that have errors with their file row number and an `errors` column (Thai or English), as XLSX or CSV — fix and upload again. Refused ID numbers are never written back (D-332).',
    implements: ['D-332'],
  })
  @ApiFile('The rows with errors')
  @ApiStandardErrors(...READ)
  async badRows(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Query() q: JuristicImportBadRowsQuery,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.imports.badRows(ctx, id, q.sheet, q.format ?? 'xlsx', q.language ?? 'th'));
  }

  @Post('imports/:importId/actions/reconcile')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.reconcile',
    summary: 'Reconcile the opening figures',
    description:
      'The opening receivables (Σ principal + surcharge) against `declaredReceivables`, and every bank row against the balance of the last bank-statement line (J2.1 import) on or before the as-of date of its account (`no_statement` when there is none). When an item does not match, the commit needs the explanation: `note` (10–2000) **and** `documentId` (the attachment); both or neither. A plan changed since the validation → 409 `import.preview_stale`. Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportReconcileDto, { declaredReceivables: '845210.50' })
  @ApiSuccess(200, { description: 'Reconciled', type: JuristicImportJobDto, example: JOB_EXAMPLE })
  @ApiStandardErrors('import.invalid_state', 'import.preview_stale', ...FILE_ERRORS, ...WRITE)
  async reconcile(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportReconcileDto,
  ): Promise<JuristicImportJobDto> {
    await this.imports.reconcile(ctx, id, body);
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/actions/commit')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.commit',
    summary: 'Commit the import',
    description:
      'In one transaction, when the plan still equals the validated one (409 `import.preview_stale`) and the reconciliation is matched or explained (422 `import.reconciliation_unexplained`): floors / sois, units (existing ones attached unchanged), parties (matching ones attached), ownerships (source `import`), bill-to (needs `billToConsentDocumentId` — 422 `import.bill_to_consent_required`), one opening-balance **draft** per unit × billed party (lines `opening_balance` per period, surcharge as `late_fee`; not issuable before go-live) and the payment history as **history only** (no payment, receipt or journal). Every created id is recorded for the rollback. Until go-live the building issues no invoice (409 `import.go_live_pending`). Audited. Requires `Idempotency-Key` (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportCommitDto, { billToConsentDocumentId: FAKE.uuid })
  @ApiSuccess(200, { description: 'Committed', type: JuristicImportJobDto, example: COMMITTED_EXAMPLE })
  @ApiStandardErrors(
    'import.invalid_state',
    'import.preview_stale',
    'import.reconciliation_unexplained',
    'import.bill_to_consent_required',
    'register.shares_exceeded',
    'idempotency.key_required',
    ...FILE_ERRORS,
    ...WRITE,
  )
  async commit(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportCommitDto,
  ): Promise<JuristicImportJobDto> {
    await this.imports.commit(ctx, id, body);
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/actions/rollback')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.rollback',
    summary: 'Roll the import back',
    description:
      'Committed jobs only (before go-live): deletes, newest first, exactly what the commit created — floors, units, parties, ownerships, bill-to, opening-balance drafts, payment history — and the drafts computed meanwhile for those units or parties; nothing else. When another record now refers to them (a payment, an issued document, a lease…) → 409 `import.rollback_blocked` (with the table) and nothing is deleted. Audited. Requires `Idempotency-Key` (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportRollbackDto, { reason: 'ไฟล์ทะเบียนผิดชุด จะนำเข้าใหม่' })
  @ApiSuccess(200, {
    description: 'Rolled back',
    type: JuristicImportJobDto,
    example: { ...COMMITTED_EXAMPLE, state: 'rolled_back', rolledBackAt: FAKE.dateTime, nextActions: [] },
  })
  @ApiStandardErrors('import.invalid_state', 'import.rollback_blocked', 'idempotency.key_required', ...WRITE)
  async rollback(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportRollbackDto,
  ): Promise<JuristicImportJobDto> {
    await this.imports.rollback(ctx, id, body);
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.cancel',
    summary: 'Cancel an import before its commit',
    description: 'Draft, validated or reconciled jobs; nothing was written. Audited (D-332).',
    implements: ['D-332'],
  })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: JuristicImportJobDto,
    example: { ...JOB_EXAMPLE, state: 'cancelled', cancelledAt: FAKE.dateTime, nextActions: [] },
  })
  @ApiStandardErrors('import.invalid_state', ...WRITE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
  ): Promise<JuristicImportJobDto> {
    await this.imports.cancel(ctx, id);
    return this.dto(ctx, id);
  }

  @Post('imports/:importId/parallel-cycle')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.compareParallelCycle',
    summary: 'Compare a billing cycle with the legacy bills',
    description:
      'Committed jobs: a billing cycle of the building’s property (opened and computed by the cycle endpoints — its drafts are not issued before go-live) against the legacy bills file (unit_no, amount; CSV / XLSX) — per unit the computed amount (Σ non-void invoices of the cycle) and the legacy amount; replaces the previous run and clears an acknowledgement. Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportParallelCycleDto, { billingCycleId: FAKE.uuid, fileId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Differences',
    type: JuristicParallelCycleReportDto,
    example: REPORT_EXAMPLE,
  })
  @ApiStandardErrors('import.invalid_state', 'import.invalid_rows', ...FILE_ERRORS, ...WRITE)
  async parallelCycle(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportParallelCycleDto,
  ): Promise<JuristicParallelCycleReportDto> {
    return reportDto(await this.imports.parallelCycle(ctx, id, body));
  }

  @Get('imports/:importId/parallel-cycle')
  @TenantScoped()
  @Can('juristic.import.read')
  @ApiEndpoint({
    id: 'owner.juristicImports.parallelCycle',
    summary: 'The parallel-cycle differences',
    description:
      'Per unit: computed, legacy, difference and its explanation; the summary counts what is unexplained (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiSuccess(200, {
    description: 'Differences',
    type: JuristicParallelCycleReportDto,
    example: REPORT_EXAMPLE,
  })
  @ApiStandardErrors(...READ)
  async parallelReport(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
  ): Promise<JuristicParallelCycleReportDto> {
    return reportDto(await this.imports.parallelReport(ctx, id));
  }

  @Post('imports/:importId/parallel-cycle/differences/:differenceId/actions/explain')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.explainDifference',
    summary: 'Explain a per-unit difference',
    description:
      'A reason (5–1000) for a non-zero difference of a committed job’s parallel cycle. Audited (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportDifferenceExplainDto, { explanation: 'ระบบเดิมคิดค่าที่จอดรถรวมในค่าส่วนกลาง' })
  @ApiSuccess(200, {
    description: 'Differences',
    type: JuristicParallelCycleReportDto,
    example: REPORT_EXAMPLE,
  })
  @ApiStandardErrors('import.invalid_state', ...WRITE)
  async explain(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Param('differenceId', ParseUUIDPipe) differenceId: string,
    @Body() body: JuristicImportDifferenceExplainDto,
  ): Promise<JuristicParallelCycleReportDto> {
    return reportDto(await this.imports.explainDifference(ctx, id, differenceId, body));
  }

  @Post('imports/:importId/actions/go-live')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.import.manage')
  @ApiEndpoint({
    id: 'owner.juristicImports.goLive',
    summary: 'Go live',
    description:
      'Committed jobs: needs the parallel cycle while `juristic.import.parallel_cycle_required` (409 `import.parallel_cycle_missing`) and every difference explained — or, where `juristic.import.allow_unexplained_differences` is true, `acknowledgeDifferences: true` (recorded) — else 409 `import.differences_unexplained`. Then, in one transaction: the opening-balance drafts are issued (series **OPB**, due date by the normal rules; sent to the billed party unless `notifyOpeningBalances` is false), the bank opening journals are posted (`opening`: bank / accumulated surplus; fund bank / fund equity), the job is live and the rollback window closes; the building issues normally and the collections ladder runs on overdue opening balances. Audited. Requires `Idempotency-Key` (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiJsonBody(JuristicImportGoLiveDto, { notifyOpeningBalances: true })
  @ApiSuccess(200, {
    description: 'Live',
    type: JuristicImportJobDto,
    example: { ...COMMITTED_EXAMPLE, state: 'live', liveAt: FAKE.dateTime, nextActions: [] },
  })
  @ApiStandardErrors(
    'import.invalid_state',
    'import.parallel_cycle_missing',
    'import.differences_unexplained',
    'invoice.not_ready',
    'idempotency.key_required',
    ...WRITE,
  )
  async goLive(
    @CurrentTenant() ctx: TenantContext,
    @Param('importId', ParseUUIDPipe) id: string,
    @Body() body: JuristicImportGoLiveDto,
  ): Promise<JuristicImportJobDto> {
    await this.imports.goLive(ctx, id, body);
    return this.dto(ctx, id);
  }

  @Post('export')
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.export.run')
  @ApiAsync({ poll: 'owner.exports.get' })
  @ApiEndpoint({
    id: 'owner.juristicImports.fullExport',
    summary: 'Export everything (CSV ZIP)',
    description:
      '“You can leave any time”: queues export `juristic_full_export` — a ZIP with one CSV per table of the tenant: every table of schema `juristic` plus the register (property, building, floor, unit, party, ownership, occupancy) and billing tables (rate plans, cycles, invoices + lines, charges, notes, payments, allocations, receipts), and `manifest.csv`; encrypted / hashed columns are left out. Poll `GET /v1/owner/exports/{id}` for the link. Requires `Idempotency-Key` (D-313, D-332).',
    implements: ['D-313', 'D-332'],
  })
  @ApiSuccess(202, {
    description: 'Queued',
    type: ExportJobDto,
    example: {
      ...EXPORT_EXAMPLE,
      kind: 'juristic_full_export' as ExportKindName,
      params: {},
      status: 'queued' as ExportStatusName,
      finishedAt: null,
      download: null,
      rowCount: null,
    },
  })
  @ApiStandardErrors('idempotency.key_required', 'auth.forbidden', ...WRITE)
  async fullExport(@CurrentTenant() ctx: TenantContext): Promise<ExportJobDto> {
    return exportDto(await this.exporter.request(ctx));
  }
}
