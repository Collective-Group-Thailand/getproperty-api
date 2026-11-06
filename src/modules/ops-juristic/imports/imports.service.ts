import { createHash } from 'node:crypto';

import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Building,
  type ImportFile,
  type ImportJob,
  type ImportState,
  Prisma,
  type UnitType,
} from '@generated/prisma/client';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { UnitsService } from '@modules/ops-units/units.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { LedgerService } from '../accounting/ledger.service';
import { cr, dr, idKey } from '../accounting/posting';
import {
  cycleDifferences,
  type ExistingState,
  type ImportPlan,
  planImport,
  type PlanResult,
  type PlanTotals,
  type ReconcileItem,
  reconcileItems,
} from './import-plan';
import {
  badRowsFile,
  COMMIT_SHEETS,
  CSV_MIME,
  ImportFileError,
  isXlsx,
  type Language,
  MAX_FILE_BYTES,
  type ParsedRow,
  parseSheet,
  REQUIRED_SHEETS,
  type RowData,
  type SheetKey,
  XLSX_MIME,
} from './import-sheets';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export const PENDING_FLAG = 'opening_balance_pending_go_live';
const OPEN: readonly ImportState[] = ['draft', 'validated', 'reconciled'];

export const JOB_INCLUDE = {
  building: { select: { id: true, name: true, code: true, propertyId: true } },
  files: { orderBy: { sheet: 'asc' } },
} as const satisfies Prisma.ImportJobInclude;
export type ImportJobRow = Prisma.ImportJobGetPayload<{ include: typeof JOB_INCLUDE }>;

export interface FileInput {
  sheet: SheetKey;
  fileId?: string;
  fileName?: string;
  /** base64 */
  content?: string;
}

export interface StoredTotals extends Partial<PlanTotals> {
  planHash?: string;
  validatedAt?: string;
}

/** Rows that block a rollback (anything outside the job that refers to what it created). */
interface Blocker {
  table: string;
}

/**
 * Import wizard of a juristic building moving from a legacy system (D-313, D-332): a job per building and as-of date
 * holds one file per sheet (register, opening balances, 12 months of payment history, bank opening balances; CSV or
 * XLSX, uploaded through `files/presign` or inline); every upload re-validates the whole job row by row (field and
 * cross-file errors, Thai / English) into `juristic.import_row`; the reconciliation compares the opening receivables
 * with a declared total and the bank rows with the J2.1 bank statements (differences need a note and an attachment);
 * the commit writes the register, the opening-balance drafts and the history in one transaction and records every id
 * it created; until go-live the building issues nothing and the whole job can be rolled back (exactly what it created
 * is deleted); one parallel cycle is compared with the legacy bills; go-live issues the opening balances (series OPB)
 * and posts the bank opening journals.
 */
@Injectable()
export class ImportsService extends TenantScopedRepository {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly documents: DocumentsService,
    private readonly units: UnitsService,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly lookup: LookupHasher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  // ------------------------------------------------------------------------------------------- jobs

  private async building(tx: Tx, ctx: TenantContext, buildingId: string): Promise<Building> {
    if (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)) throw new DomainException('http.not_found');
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
    });
    if (!b) throw new DomainException('http.not_found');
    return b;
  }

  private async loadJob(tx: Tx, ctx: TenantContext, id: string, lock = false): Promise<ImportJobRow> {
    if (lock) await tx.$queryRaw`SELECT id FROM juristic.import_job WHERE id = ${id}::uuid FOR UPDATE`;
    const job = await tx.importJob.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: JOB_INCLUDE,
    });
    if (!job || (ctx.buildingIds && !ctx.buildingIds.includes(job.buildingId)))
      throw new DomainException('http.not_found');
    return job;
  }

  private state(job: ImportJob, allowed: readonly ImportState[]) {
    if (!allowed.includes(job.state))
      throw new DomainException('import.invalid_state', { params: { state: job.state } });
  }

  async create(ctx: TenantContext, input: { buildingId: string; asOfDate: string; note?: string | null }) {
    if (!DATE.test(input.asOfDate) || input.asOfDate > this.today())
      throw invalid('asOfDate', 'date', 'a date YYYY-MM-DD, today or earlier');
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const b = await this.building(tx, ctx, input.buildingId);
      const open = await tx.importJob.findFirst({
        where: { buildingId: b.id, state: { in: [...OPEN, 'committed'] } },
        select: { id: true, number: true },
      });
      if (open) throw new DomainException('import.job_open', { params: { number: open.number } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import-job:${ctx.tenantId}`}))`;
      const last = await tx.importJob.aggregate({
        where: { tenantId: ctx.tenantId },
        _max: { number: true },
      });
      const job = await tx.importJob.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: b.id,
          number: (last._max.number ?? 0) + 1,
          asOfDate: asDate(input.asOfDate),
          note: input.note?.trim() || null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.import_created',
        tenantId: ctx.tenantId,
        buildingId: b.id,
        subjectType: 'juristic.import_job',
        subjectId: job.id,
        after: { number: job.number, asOfDate: input.asOfDate },
      });
      await this.event(tx, job, 'created');
      return this.loadJob(tx, ctx, job.id);
    });
  }

  list(ctx: TenantContext, q: { buildingId?: string; state?: ImportState; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.ImportJobWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        AND: [
          ...(q.buildingId ? [{ buildingId: q.buildingId }] : []),
          ...(ctx.buildingIds ? [{ buildingId: { in: [...ctx.buildingIds] } }] : []),
        ],
      };
      const [rows, total] = await Promise.all([
        tx.importJob.findMany({
          where,
          include: JOB_INCLUDE,
          orderBy: { number: 'desc' },
          skip: q.skip,
          take: q.take,
        }),
        tx.importJob.count({ where }),
      ]);
      return { rows, total };
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.loadJob(tx, ctx, id));
  }

  private async event(
    tx: Tx,
    job: ImportJob,
    change: 'created' | 'committed' | 'rolled_back' | 'went_live' | 'cancelled',
    extra: Record<string, unknown> = {},
  ) {
    await this.events.record(tx, {
      type: `juristic.import.${change}`,
      aggregateType: 'import_job',
      aggregateId: job.id,
      tenantId: job.tenantId,
      buildingId: job.buildingId,
      payload: { importJobId: job.id, number: job.number, ...extra },
    });
  }

  // ------------------------------------------------------------------------------------------- files

  /** Stores an inline file (base64) as a document, or checks an uploaded one; returns its bytes. */
  private async fileOf(
    ctx: TenantContext,
    job: ImportJobRow,
    input: FileInput,
  ): Promise<{ documentId: string; fileName: string; body: Buffer }> {
    if (input.fileId) {
      const { document, body } = await this.documents.readBytes(ctx, input.fileId, {
        kinds: ['other'],
        mimeTypes: [XLSX_MIME, CSV_MIME, 'application/vnd.ms-excel', 'text/plain'],
        maxBytes: MAX_FILE_BYTES,
      });
      return {
        documentId: document.id,
        fileName: (document.title ?? input.fileName ?? 'file').slice(0, 200),
        body,
      };
    }
    if (!input.content || !input.fileName)
      throw invalid('fileId', 'required', 'fileId, or fileName and content (base64)');
    const body = Buffer.from(input.content, 'base64');
    if (!body.length || body.length > MAX_FILE_BYTES)
      throw invalid('content', 'size', `a base64 CSV or XLSX of at most ${MAX_FILE_BYTES} bytes`);
    const doc = await this.db.tenant(ctx, (tx) =>
      this.documents.storeGenerated(tx, {
        tenantId: ctx.tenantId,
        kind: 'other',
        scopeType: 'building',
        scopeId: job.buildingId,
        buildingId: job.buildingId,
        title: input.fileName!.slice(0, 200),
        mimeType: isXlsx(body) ? XLSX_MIME : CSV_MIME,
        body,
      }),
    );
    return { documentId: doc.id, fileName: input.fileName.slice(0, 200), body };
  }

  private async bytesOf(ctx: TenantContext, f: ImportFile): Promise<Buffer> {
    return (
      await this.documents.readBytes(ctx, f.documentId, {
        kinds: ['other'],
        mimeTypes: [XLSX_MIME, CSV_MIME, 'application/vnd.ms-excel', 'text/plain'],
        maxBytes: MAX_FILE_BYTES,
      })
    ).body;
  }

  private async parsed(body: Buffer, sheet: SheetKey) {
    try {
      return await parseSheet(body, sheet);
    } catch (error) {
      if (error instanceof ImportFileError)
        throw new DomainException('import.file_invalid', { params: { reason: error.message } });
      throw error;
    }
  }

  /** `POST …/imports/{id}/files`: the file of a sheet (replacing the previous one), then the whole job is re-validated. */
  async upload(ctx: TenantContext, id: string, input: FileInput) {
    if (!COMMIT_SHEETS.includes(input.sheet))
      throw invalid('sheet', 'isIn', 'register, opening_balance, payment_history or bank_balance');
    const job = await this.get(ctx, id);
    this.state(job, OPEN);
    const file = await this.fileOf(ctx, job, input);
    const { format } = await this.parsed(file.body, input.sheet);
    await this.db.tenant(ctx, async (tx) => {
      const locked = await this.loadJob(tx, ctx, id, true);
      this.state(locked, OPEN);
      await tx.importFile.deleteMany({ where: { jobId: id, sheet: input.sheet } });
      await tx.importFile.create({
        data: {
          tenantId: ctx.tenantId,
          jobId: id,
          sheet: input.sheet,
          documentId: file.documentId,
          fileName: file.fileName,
          format,
          sha256: new Uint8Array(createHash('sha256').update(file.body).digest()),
          uploadedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.import_file_uploaded',
        tenantId: ctx.tenantId,
        buildingId: job.buildingId,
        subjectType: 'juristic.import_job',
        subjectId: id,
        metadata: { sheet: input.sheet, documentId: file.documentId, format },
      });
    });
    return this.validate(ctx, id);
  }

  async removeFile(ctx: TenantContext, id: string, sheet: SheetKey) {
    await this.db.tenant(ctx, async (tx) => {
      const job = await this.loadJob(tx, ctx, id, true);
      this.state(job, OPEN);
      const removed = await tx.importFile.deleteMany({ where: { jobId: id, sheet: sheet } });
      if (!removed.count) throw new DomainException('http.not_found');
      await tx.importRow.deleteMany({ where: { jobId: id, sheet: sheet } });
      await this.audit.record(tx, {
        action: 'juristic.import_file_removed',
        tenantId: ctx.tenantId,
        buildingId: job.buildingId,
        subjectType: 'juristic.import_job',
        subjectId: id,
        metadata: { sheet },
      });
    });
    return this.validate(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- validation

  /** The current state of the building the plan is checked against. */
  private async existing(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    sheets: Partial<Record<SheetKey, ParsedRow[]>>,
  ) {
    const b = await this.building(tx, ctx, job.buildingId);
    const today = this.today();
    const [units, floors, accounts, funds] = await Promise.all([
      tx.unit.findMany({
        where: { buildingId: b.id, deletedAt: null },
        include: {
          ownerships: {
            where: { OR: [{ validTo: null }, { validTo: { gt: asDate(today) } }] },
            select: { id: true },
          },
        },
      }),
      tx.floor.findMany({ where: { buildingId: b.id, deletedAt: null } }),
      tx.tenantBankAccount.findMany({
        where: { tenantId: ctx.tenantId, state: { in: ['active', 'pending_otp'] }, effectiveTo: null },
        select: { id: true, accountNoMasked: true },
      }),
      tx.fund.findMany({ where: { buildingId: b.id, isActive: true } }),
    ]);
    const reg = sheets.register ?? [];
    const phones = [
      ...new Set(reg.flatMap((r) => [r.data.phone, r.data.bill_to_phone]).filter(Boolean)),
    ] as string[];
    const emails = [
      ...new Set(reg.flatMap((r) => [r.data.email, r.data.bill_to_email]).filter(Boolean)),
    ] as string[];
    const parties =
      phones.length || emails.length
        ? await tx.party.findMany({
            where: {
              tenantId: ctx.tenantId,
              deletedAt: null,
              OR: [
                ...(phones.length ? [{ phoneE164: { in: phones } }] : []),
                ...(emails.length ? [{ email: { in: emails } }] : []),
              ],
            },
            select: { id: true, displayName: true, phoneE164: true, email: true },
          })
        : [];
    const state: ExistingState = {
      building: { id: b.id, name: b.name, code: b.code, type: b.type },
      units: units.map((u) => ({
        id: u.id,
        unitNo: u.unitNo,
        type: u.type,
        areaSqm: u.areaSqm?.toFixed(2) ?? null,
        landAreaSqwa: u.landAreaSqwa?.toFixed(2) ?? null,
        plotNo: u.plotNo,
        ownershipRatio: u.ownershipRatio?.toFixed(6) ?? null,
        floorId: u.floorId,
        currentOwners: u.ownerships.length,
      })),
      floors: floors.map((f) => ({ id: f.id, level: f.level, name: f.name })),
      parties: parties.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        phone: p.phoneE164,
        email: p.email ? lc(p.email) : null,
      })),
      bankAccounts: accounts.map((a) => ({
        id: a.id,
        last4: a.accountNoMasked.replace(/\D/g, '').slice(-4),
      })),
      funds: funds.map((f) => ({ id: f.id, name: f.name, bankAccountId: f.bankAccountId })),
    };
    return { building: b, state };
  }

  /** Every file of the job read and field-validated (outside any transaction: storage reads). */
  private async readAll(ctx: TenantContext, files: readonly ImportFile[]) {
    const sheets: Partial<Record<SheetKey, ParsedRow[]>> = {};
    for (const f of files) {
      if (!COMMIT_SHEETS.includes(f.sheet)) continue;
      sheets[f.sheet] = (await this.parsed(await this.bytesOf(ctx, f), f.sheet)).rows;
    }
    return sheets;
  }

  private async planIn(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    sheets: Partial<Record<SheetKey, ParsedRow[]>>,
  ) {
    const { building, state } = await this.existing(tx, ctx, job, sheets);
    return {
      building,
      existing: state,
      result: planImport({ asOf: day(job.asOfDate), sheets, existing: state }),
    };
  }

  /** `POST …/{id}/actions/validate`: every file re-read and the plan recomputed against the building as it is now. */
  async validate(ctx: TenantContext, id: string): Promise<ImportJobRow> {
    const job = await this.get(ctx, id);
    this.state(job, OPEN);
    const sheets = await this.readAll(ctx, job.files);
    return this.db.tenant(
      ctx,
      async (tx) => {
        const locked = await this.loadJob(tx, ctx, id, true);
        this.state(locked, OPEN);
        const { result } = await this.planIn(tx, ctx, locked, sheets);
        await tx.importRow.deleteMany({ where: { jobId: id } });
        const data: Prisma.ImportRowCreateManyInput[] = [];
        for (const [sheet, rows] of Object.entries(result.rows) as [SheetKey, ParsedRow[]][])
          for (const r of rows)
            data.push({
              tenantId: ctx.tenantId,
              jobId: id,
              sheet: sheet,
              rowNo: r.rowNo,
              data: {
                ...r.data,
                ...(Object.keys(r.raw).length ? { _raw: r.raw } : {}),
              },
              errors: r.errors as unknown as Prisma.InputJsonValue,
              warnings: r.warnings as unknown as Prisma.InputJsonValue,
            });
        for (let i = 0; i < data.length; i += 1000)
          await tx.importRow.createMany({ data: data.slice(i, i + 1000) });
        for (const f of locked.files) {
          const rows = result.rows[f.sheet] ?? [];
          await tx.importFile.update({
            where: { id: f.id },
            data: {
              rowCount: rows.length,
              errorCount: rows.filter((r) => r.errors.length).length,
              warningCount: rows.filter((r) => r.warnings.length).length,
            },
          });
        }
        const present = new Set(locked.files.map((f) => f.sheet));
        const ready = REQUIRED_SHEETS.every((s) => present.has(s)) && result.totals.errors === 0;
        const prior = locked.computedTotals as StoredTotals;
        const keepReconciliation = locked.state === 'reconciled' && ready && prior.planHash === result.hash;
        const totals: StoredTotals = {
          ...result.totals,
          planHash: result.hash,
          validatedAt: this.clock.now().toISOString(),
        };
        await tx.importJob.update({
          where: { id },
          data: {
            computedTotals: totals as unknown as Prisma.InputJsonValue,
            state: keepReconciliation ? 'reconciled' : ready ? 'validated' : 'draft',
            ...(keepReconciliation
              ? {}
              : {
                  reconciliation: Prisma.DbNull,
                  declaredReceivables: null,
                  reconciliationNote: null,
                  reconciliationDocumentId: null,
                  reconciledAt: null,
                  reconciledBy: null,
                }),
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.import_validated',
          tenantId: ctx.tenantId,
          buildingId: locked.buildingId,
          subjectType: 'juristic.import_job',
          subjectId: id,
          metadata: { errors: result.totals.errors, warnings: result.totals.warnings, ready },
        });
        return this.loadJob(tx, ctx, id);
      },
      { timeout: 120_000 },
    );
  }

  /** `GET …/{id}/preview`: the plan recomputed against the building now (open jobs only). */
  async preview(ctx: TenantContext, id: string) {
    const job = await this.get(ctx, id);
    this.state(job, OPEN);
    const sheets = await this.readAll(ctx, job.files);
    return this.db.tenant(
      ctx,
      async (tx) => {
        const locked = await this.loadJob(tx, ctx, id);
        return { job: locked, result: (await this.planIn(tx, ctx, locked, sheets)).result };
      },
      { timeout: 120_000 },
    );
  }

  /** `GET …/{id}/rows`: rows of a sheet with their issues (optionally only rows with errors). */
  rows(
    ctx: TenantContext,
    id: string,
    q: { sheet?: SheetKey; errorsOnly?: boolean; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.loadJob(tx, ctx, id);
      const where: Prisma.ImportRowWhereInput = {
        jobId: id,
        ...(q.sheet ? { sheet: q.sheet } : {}),
        ...(q.errorsOnly ? { NOT: { errors: { equals: [] } } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.importRow.findMany({
          where,
          orderBy: [{ sheet: 'asc' }, { rowNo: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.importRow.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** `GET …/{id}/bad-rows`: the rows of a sheet with errors and an errors column, as CSV or XLSX. */
  async badRows(ctx: TenantContext, id: string, sheet: SheetKey, format: 'csv' | 'xlsx', lang: Language) {
    const rows = await this.db.tenant(ctx, async (tx) => {
      await this.loadJob(tx, ctx, id);
      return tx.importRow.findMany({
        where: { jobId: id, sheet: sheet },
        orderBy: { rowNo: 'asc' },
      });
    });
    return badRowsFile(
      sheet,
      rows.map((r) => {
        const { _raw, ...data } = r.data as RowData & { _raw?: Record<string, string> };
        return {
          rowNo: r.rowNo,
          data: data,
          raw: _raw ?? {},
          errors: r.errors as unknown as ParsedRow['errors'],
          warnings: r.warnings as unknown as ParsedRow['warnings'],
        };
      }),
      format,
      lang,
    );
  }

  // ------------------------------------------------------------------------------------------- reconcile

  private async statementBalances(tx: Tx, ctx: TenantContext, job: ImportJob, plan: ImportPlan) {
    const funds = await tx.fund.findMany({ where: { buildingId: job.buildingId } });
    const asOf = day(job.asOfDate);
    const out: { rowNo: number; label: string; balance: string; statementBalance: string | null }[] = [];
    for (const b of plan.bankRows) {
      const fund = b.fundId ? funds.find((f) => f.id === b.fundId) : null;
      const accountId = b.bankAccountId ?? fund?.bankAccountId ?? null;
      let statementBalance: string | null = null;
      if (accountId) {
        const line = await tx.bankStatementLine.findFirst({
          where: {
            tenantId: ctx.tenantId,
            bankAccountId: accountId,
            bookedOn: { lte: asDate(asOf) },
            balance: { not: null },
          },
          orderBy: [{ bookedOn: 'desc' }, { lineNo: 'desc' }, { id: 'desc' }],
        });
        statementBalance = line?.balance?.toFixed(2) ?? null;
      }
      out.push({
        rowNo: b.rowNo,
        label:
          b.accountType === 'operating'
            ? `operating ••${b.last4 ?? ''}`
            : `fund ${b.fundName ?? fund?.name ?? ''}${b.last4 ? ` ••${b.last4}` : ''}`.trim(),
        balance: b.balance,
        statementBalance,
      });
    }
    return out;
  }

  /**
   * `POST …/{id}/actions/reconcile`: the opening receivables against the declared total and each bank row against the
   * last J2.1 statement balance on or before the as-of date; any difference needs a note and an attachment.
   */
  async reconcile(
    ctx: TenantContext,
    id: string,
    input: { declaredReceivables: string; note?: string | null; documentId?: string | null },
  ) {
    const declared = D(input.declaredReceivables);
    if (declared.isNeg() || declared.decimalPlaces() > 2)
      throw invalid('declaredReceivables', 'money', 'an amount ≥ 0 with up to 2 decimals');
    const note = input.note?.trim() || null;
    if ((note === null) !== !input.documentId)
      throw invalid(
        note ? 'documentId' : 'note',
        'required',
        'an explanation needs both a note and an attachment',
      );
    if (note && (note.length < 10 || note.length > 2000))
      throw invalid('note', 'length', '10–2000 characters');
    const job = await this.get(ctx, id);
    this.state(job, ['validated', 'reconciled']);
    const sheets = await this.readAll(ctx, job.files);
    return this.db.tenant(
      ctx,
      async (tx) => {
        const locked = await this.loadJob(tx, ctx, id, true);
        this.state(locked, ['validated', 'reconciled']);
        const { result } = await this.planIn(tx, ctx, locked, sheets);
        if (result.hash !== (locked.computedTotals as StoredTotals).planHash || result.totals.errors)
          throw new DomainException('import.preview_stale');
        if (input.documentId) {
          const doc = await tx.document.findFirst({
            where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
          });
          if (!doc) throw new DomainException('http.not_found');
        }
        const rec = reconcileItems(
          result.totals,
          declared.toFixed(2),
          await this.statementBalances(tx, ctx, locked, result.plan),
        );
        await tx.importJob.update({
          where: { id },
          data: {
            state: 'reconciled',
            declaredReceivables: declared.toFixed(2),
            reconciliation: rec as unknown as Prisma.InputJsonValue,
            reconciliationNote: note,
            reconciliationDocumentId: input.documentId ?? null,
            reconciledAt: this.clock.now(),
            reconciledBy: by(),
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.import_reconciled',
          tenantId: ctx.tenantId,
          buildingId: locked.buildingId,
          subjectType: 'juristic.import_job',
          subjectId: id,
          metadata: {
            declaredReceivables: declared.toFixed(2),
            receivables: result.totals.receivables,
            explanationRequired: rec.explanationRequired,
            explained: note !== null,
            documentId: input.documentId ?? null,
          },
        });
        return this.loadJob(tx, ctx, id);
      },
      { timeout: 120_000 },
    );
  }

  // ------------------------------------------------------------------------------------------- commit

  /**
   * `POST …/{id}/actions/commit` (Idempotency-Key): the plan recomputed in one transaction (409 `import.preview_stale`
   * when it changed since the validation) and written — floors, units, parties, ownerships, bill-to, opening-balance
   * drafts and the payment history — with every created id recorded for the rollback.
   */
  async commit(ctx: TenantContext, id: string, input: { billToConsentDocumentId?: string | null }) {
    const job = await this.get(ctx, id);
    this.state(job, ['reconciled']);
    const sheets = await this.readAll(ctx, job.files);
    const started = Date.now();
    const out = await this.mapShares(() =>
      this.db.tenant(
        ctx,
        async (tx) => {
          const locked = await this.loadJob(tx, ctx, id, true);
          this.state(locked, ['reconciled']);
          const { building, result } = await this.planIn(tx, ctx, locked, sheets);
          if (result.hash !== (locked.computedTotals as StoredTotals).planHash || result.totals.errors)
            throw new DomainException('import.preview_stale');
          const rec = locked.reconciliation as unknown as { explanationRequired: boolean } | null;
          if (!rec) throw new DomainException('import.invalid_state', { params: { state: locked.state } });
          if (rec.explanationRequired && (!locked.reconciliationNote || !locked.reconciliationDocumentId))
            throw new DomainException('import.reconciliation_unexplained');
          let consent: string | null = null;
          if (result.plan.billTos.length) {
            if (!input.billToConsentDocumentId) throw new DomainException('import.bill_to_consent_required');
            const doc = await tx.document.findFirst({
              where: { id: input.billToConsentDocumentId, tenantId: ctx.tenantId, deletedAt: null },
              select: { id: true },
            });
            if (!doc) throw new DomainException('http.not_found');
            consent = doc.id;
          }
          const counts = await this.write(tx, ctx, locked, building, result, consent);
          const now = this.clock.now();
          await tx.importJob.update({
            where: { id },
            data: {
              state: 'committed',
              committedAt: now,
              committedBy: by(),
              billToConsentDocumentId: consent,
              updatedBy: by(),
              version: { increment: 1 },
            },
          });
          await this.audit.record(tx, {
            action: 'juristic.import_committed',
            tenantId: ctx.tenantId,
            buildingId: locked.buildingId,
            subjectType: 'juristic.import_job',
            subjectId: id,
            metadata: { ...counts, receivables: result.totals.receivables },
          });
          await this.event(tx, locked, 'committed', counts);
          return this.loadJob(tx, ctx, id);
        },
        { timeout: 300_000, maxWait: 30_000 },
      ),
    );
    this.logger.log(`import ${id} committed in ${Date.now() - started} ms`);
    return out;
  }

  private async mapShares<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (/core\.ownership_share_exceeded/.test((e as Error).message ?? ''))
        throw new DomainException('register.shares_exceeded');
      throw e;
    }
  }

  private async write(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    building: Building,
    { plan }: PlanResult,
    consentDocumentId: string | null,
  ) {
    const created: { entity: string; id: string }[] = [];
    const track = (entity: string, ids: readonly string[]) => {
      for (const x of ids) created.push({ entity, id: x });
    };
    const actor = by();
    // floors / sois
    const floorIds = new Map<string, string>();
    for (const f of plan.floors) {
      const row = await tx.floor.create({
        data: {
          tenantId: building.tenantId,
          buildingId: building.id,
          level: f.level,
          name: f.name,
          sortOrder: Math.max(-32768, Math.min(32767, f.level)),
          createdBy: actor,
        },
      });
      floorIds.set(f.key, row.id);
      track('floor', [row.id]);
    }
    // units (new ones; existing units are attached unchanged)
    const unitIds = new Map<string, string>();
    for (const u of plan.units) {
      if (u.existingId) {
        unitIds.set(lc(u.unitNo), u.existingId);
        continue;
      }
      const unit = await this.units.insertUnit(
        tx,
        ctx,
        building,
        {
          unitNo: u.unitNo,
          floorId: u.floorKey ? floorIds.get(u.floorKey)! : u.floorId,
          type: u.type as UnitType,
          areaSqm: u.areaSqm,
          landAreaSqwa: u.landAreaSqwa,
          plotNo: u.plotNo,
        },
        'import',
      );
      await tx.unit.update({
        where: { id: unit.id },
        data: { ownershipRatio: u.ownershipRatio, sourceRef: `import:${job.number}` },
      });
      unitIds.set(lc(u.unitNo), unit.id);
      track('unit', [unit.id]);
    }
    // parties (new ones; matching parties of the tenant are attached)
    const partyIds = new Map<string, string>();
    const newParties = plan.parties.filter((p) => !p.existingId);
    for (const p of plan.parties) if (p.existingId) partyIds.set(p.key, p.existingId);
    const partyRows = newParties.map((p) => ({ ...p, id: uuidv7() }));
    if (partyRows.length) {
      await tx.party.createMany({
        data: partyRows.map((p) => ({
          id: p.id,
          tenantId: ctx.tenantId,
          type: p.type,
          displayName: p.displayName,
          ...(p.type === 'company' ? { companyName: p.displayName } : {}),
          phoneE164: p.phone,
          phoneHash: p.phone ? this.hasher(ctx.tenantId, p.phone) : null,
          email: p.email,
          language: 'th',
          idDocumentType: (p.idType as Prisma.PartyCreateManyInput['idDocumentType']) ?? null,
          sourceRef: `import:${job.number}${p.ownerCode ? `:${p.ownerCode}` : ''}`.slice(0, 200),
          createdBy: actor,
        })),
      });
      for (const p of partyRows) {
        partyIds.set(p.key, p.id);
        await this.events.record(tx, {
          type: 'party.changed',
          aggregateType: 'party',
          aggregateId: p.id,
          tenantId: ctx.tenantId,
          payload: { partyId: p.id, change: 'created', source: 'import' },
        });
      }
      track(
        'party',
        partyRows.map((p) => p.id),
      );
    }
    // ownerships
    const owns = plan.ownerships.map((o) => ({
      id: uuidv7(),
      tenantId: building.tenantId,
      buildingId: building.id,
      unitId: unitIds.get(lc(o.unitNo))!,
      partyId: partyIds.get(o.partyKey)!,
      sharePct: o.sharePct,
      validFrom: asDate(o.validFrom),
      source: 'import' as const,
      createdBy: actor,
    }));
    if (owns.length) await tx.unitOwnership.createMany({ data: owns });
    track(
      'unit_ownership',
      owns.map((o) => o.id),
    );
    // bill-to (the owners' signed consents: one document for the batch)
    const bills = plan.billTos.map((b) => ({
      id: uuidv7(),
      tenantId: ctx.tenantId,
      buildingId: building.id,
      unitId: unitIds.get(lc(b.unitNo))!,
      ownerPartyId: partyIds.get(b.ownerKey)!,
      billToPartyId: partyIds.get(b.payerKey)!,
      kind: b.kind,
      consentDocumentId: consentDocumentId!,
      consentNote: `นำเข้าจากระบบเดิม (งานนำเข้า #${job.number})`,
      validFrom: asDate(b.validFrom),
      createdBy: actor,
    }));
    if (bills.length) await tx.billTo.createMany({ data: bills });
    track(
      'bill_to',
      bills.map((b) => b.id),
    );
    // opening-balance drafts (not issuable until go-live)
    const invoiceIds: string[] = [];
    for (const inv of plan.invoices) {
      const row = await tx.invoice.create({
        data: {
          tenantId: building.tenantId,
          buildingId: building.id,
          unitId: unitIds.get(lc(inv.unitNo))!,
          billedPartyId: partyIds.get(inv.billedKey)!,
          periodStart: asDate(inv.periodStart),
          periodEnd: asDate(inv.periodEnd),
          subtotal: inv.total,
          vatAmount: '0.00',
          total: inv.total,
          balance: inv.total,
          reviewFlags: [PENDING_FLAG],
          notesToPayer: `ยอดค้างชำระยกมาจากระบบเดิม ณ วันที่ ${inv.periodEnd}`,
          importJobId: job.id,
          createdBy: actor,
        },
      });
      await tx.invoiceLine.createMany({
        data: inv.lines.map((l, i) => ({
          tenantId: building.tenantId,
          invoiceId: row.id,
          lineNo: i + 1,
          sourceType: l.sourceType,
          lineKind: l.lineKind,
          sourceId: job.id,
          description: l.description,
          quantity: '1.000',
          unit: null,
          unitPrice: D(l.amount).toFixed(4),
          amount: l.amount,
          periodFrom: asDate(l.periodFrom),
          periodTo: asDate(l.periodTo),
          aboveCap: false,
          complianceRuleIds: [],
          vatApplicable: false,
        })),
      });
      invoiceIds.push(row.id);
    }
    track('invoice', invoiceIds);
    // payment history (history only)
    const pays = plan.payments.map((p) => ({
      id: uuidv7(),
      tenantId: ctx.tenantId,
      buildingId: building.id,
      jobId: job.id,
      unitId: unitIds.get(lc(p.unitNo))!,
      partyId: p.partyKey ? partyIds.get(p.partyKey)! : null,
      paidOn: asDate(p.paidOn),
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      createdBy: actor,
    }));
    for (let i = 0; i < pays.length; i += 1000)
      await tx.legacyPayment.createMany({ data: pays.slice(i, i + 1000) });
    track(
      'legacy_payment',
      pays.map((p) => p.id),
    );
    const createdRows = created.map((c, seq) => ({
      tenantId: ctx.tenantId,
      jobId: job.id,
      seq: seq + 1,
      entity: c.entity,
      entityId: c.id,
    }));
    for (let i = 0; i < createdRows.length; i += 1000)
      await tx.importCreated.createMany({ data: createdRows.slice(i, i + 1000) });
    return {
      floors: plan.floors.length,
      units: plan.units.filter((u) => !u.existingId).length,
      unitsAttached: plan.units.filter((u) => u.existingId).length,
      parties: partyRows.length,
      partiesAttached: plan.parties.length - partyRows.length,
      ownerships: owns.length,
      billTos: bills.length,
      openingInvoices: invoiceIds.length,
      legacyPayments: pays.length,
    };
  }

  private hasher(tenantId: string, phone: string): Uint8Array<ArrayBuffer> {
    return this.lookup.tenantValue(tenantId, phone);
  }

  // ------------------------------------------------------------------------------------------- rollback

  /**
   * `POST …/{id}/actions/rollback` (Idempotency-Key, committed only): deletes, newest first, exactly what the commit
   * created (and the drafts computed meanwhile for its units or parties); anything else referring to them blocks it.
   */
  async rollback(ctx: TenantContext, id: string, input: { reason: string }) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 1000) throw invalid('reason', 'length', '5–1000 characters');
    try {
      return await this.db.tenant(
        ctx,
        async (tx) => {
          const job = await this.loadJob(tx, ctx, id, true);
          this.state(job, ['committed']);
          const created = await tx.importCreated.findMany({ where: { jobId: id }, orderBy: { seq: 'desc' } });
          const ids = (entity: string) => created.filter((c) => c.entity === entity).map((c) => c.entityId);
          const units = ids('unit');
          const parties = ids('party');
          const invoices = ids('invoice');
          // drafts computed meanwhile (cycle drafts of the parallel cycle): derived, recomputed by the next compute
          const derived = await tx.invoice.deleteMany({
            where: {
              tenantId: ctx.tenantId,
              status: 'draft',
              issuedAt: null,
              importJobId: null,
              OR: [{ unitId: { in: ids('unit') } }, { billedPartyId: { in: parties } }],
            },
          });
          const issued = await tx.invoice.count({
            where: { id: { in: invoices }, NOT: { status: 'draft' } },
          });
          if (issued) throw this.blocked({ table: 'ops.invoice' });
          await tx.legacyPayment.deleteMany({ where: { id: { in: ids('legacy_payment') } } });
          await tx.invoice.deleteMany({ where: { id: { in: invoices }, status: 'draft' } });
          await tx.billTo.deleteMany({ where: { id: { in: ids('bill_to') } } });
          await tx.unitOwnership.deleteMany({ where: { id: { in: ids('unit_ownership') } } });
          await tx.importCycleDifference.updateMany({ where: { jobId: id }, data: { unitId: null } });
          await tx.unitDetail.deleteMany({ where: { unitId: { in: units } } });
          await tx.unit.deleteMany({ where: { id: { in: units } } });
          await tx.floor.deleteMany({ where: { id: { in: ids('floor') } } });
          await tx.party.deleteMany({ where: { id: { in: parties } } });
          await tx.importJob.update({
            where: { id },
            data: {
              state: 'rolled_back',
              rolledBackAt: this.clock.now(),
              rolledBackBy: by(),
              rollbackReason: reason,
              updatedBy: by(),
              version: { increment: 1 },
            },
          });
          const counts = {
            floors: ids('floor').length,
            units: units.length,
            parties: parties.length,
            ownerships: ids('unit_ownership').length,
            billTos: ids('bill_to').length,
            openingInvoices: invoices.length,
            legacyPayments: ids('legacy_payment').length,
            derivedDrafts: derived.count,
          };
          await this.audit.record(tx, {
            action: 'juristic.import_rolled_back',
            tenantId: ctx.tenantId,
            buildingId: job.buildingId,
            subjectType: 'juristic.import_job',
            subjectId: id,
            metadata: { ...counts, reason },
          });
          for (const u of units)
            await this.events.record(tx, {
              type: 'unit.changed',
              aggregateType: 'unit',
              aggregateId: u,
              tenantId: ctx.tenantId,
              buildingId: job.buildingId,
              payload: { unitId: u, change: 'deleted', source: 'import_rollback' },
            });
          await this.event(tx, job, 'rolled_back', counts);
          return this.loadJob(tx, ctx, id);
        },
        { timeout: 300_000, maxWait: 30_000 },
      );
    } catch (e) {
      const table = this.fkTable(e);
      if (table) throw this.blocked({ table });
      throw e;
    }
  }

  private blocked(b: Blocker) {
    return new DomainException('import.rollback_blocked', { params: { table: b.table } });
  }

  /** The referencing table of a foreign-key violation (PostgreSQL 23503 / Prisma P2003), else null. */
  private fkTable(e: unknown): string | null {
    const err = e as { code?: string; message?: string; meta?: Record<string, unknown> };
    const text = `${err.message ?? ''} ${JSON.stringify(err.meta ?? {})}`;
    if (err.code !== 'P2003' && !/23503|foreign key/i.test(text)) return null;
    const m =
      /on table "([^"]+)"/.exec(text) ?? /"([a-z_]+_fkey)"/.exec(text) ?? /([a-z_]+)_[a-z_]+_fkey/.exec(text);
    return m?.[1] ?? 'unknown';
  }

  // ------------------------------------------------------------------------------------------- parallel cycle

  /**
   * `POST …/{id}/parallel-cycle`: a billing cycle of the building's property against the legacy bills file — per unit
   * the cycle's computed amount (non-void invoices) and the legacy amount; the differences replace the previous run.
   */
  async parallelCycle(
    ctx: TenantContext,
    id: string,
    input: { billingCycleId: string } & Omit<FileInput, 'sheet'>,
  ) {
    const job = await this.get(ctx, id);
    this.state(job, ['committed']);
    const file = await this.fileOf(ctx, job, { ...input, sheet: 'legacy_bills' });
    const parsed = await this.parsed(file.body, 'legacy_bills');
    const bad = parsed.rows.filter((r) => r.errors.length);
    if (bad.length)
      throw new DomainException('import.invalid_rows', {
        params: { count: bad.length },
        errors: bad
          .slice(0, 50)
          .flatMap((r) =>
            r.errors.map((e) => ({ path: `rows[${r.rowNo}].${e.column}`, code: e.code, message: e.code })),
          ),
      });
    return this.db.tenant(
      ctx,
      async (tx) => {
        const locked = await this.loadJob(tx, ctx, id, true);
        this.state(locked, ['committed']);
        const cycle = await tx.billingCycle.findFirst({
          where: { id: input.billingCycleId, tenantId: ctx.tenantId, propertyId: locked.building.propertyId },
        });
        if (!cycle) throw new DomainException('http.not_found');
        const invoices = await tx.invoice.findMany({
          where: { billingCycleId: cycle.id, buildingId: locked.buildingId, status: { not: 'void' } },
          select: { unitId: true, total: true, unit: { select: { unitNo: true } } },
        });
        const computed = new Map<string, { unitId: string; unitNo: string; amount: Decimal }>();
        for (const i of invoices) {
          if (!i.unitId || !i.unit) continue;
          const k = lc(i.unit.unitNo);
          const cur = computed.get(k);
          computed.set(k, {
            unitId: i.unitId,
            unitNo: i.unit.unitNo,
            amount: (cur?.amount ?? D(0)).plus(D(i.total)),
          });
        }
        const diffs = cycleDifferences(
          computed,
          parsed.rows.map((r) => ({ unitNo: r.data.unit_no!, amount: r.data.amount! })),
        );
        const units = await tx.unit.findMany({
          where: { buildingId: locked.buildingId, deletedAt: null },
          select: { id: true, unitNo: true },
        });
        const unitByNo = new Map(units.map((u) => [lc(u.unitNo), u.id]));
        await tx.importCycleDifference.deleteMany({ where: { jobId: id } });
        await tx.importCycleDifference.createMany({
          data: diffs.map((d) => ({
            tenantId: ctx.tenantId,
            jobId: id,
            unitId: d.unitId ?? unitByNo.get(lc(d.unitNo)) ?? null,
            unitNo: d.unitNo,
            computed: d.computed,
            legacy: d.legacy,
            difference: d.difference,
          })),
        });
        await tx.importFile.deleteMany({ where: { jobId: id, sheet: 'legacy_bills' } });
        await tx.importFile.create({
          data: {
            tenantId: ctx.tenantId,
            jobId: id,
            sheet: 'legacy_bills',
            documentId: file.documentId,
            fileName: file.fileName,
            format: parsed.format,
            sha256: new Uint8Array(createHash('sha256').update(file.body).digest()),
            rowCount: parsed.rows.length,
            uploadedBy: by(),
          },
        });
        await tx.importJob.update({
          where: { id },
          data: {
            parallelCycleId: cycle.id,
            parallelRunAt: this.clock.now(),
            differencesAcknowledgedAt: null,
            differencesAcknowledgedBy: null,
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        const different = diffs.filter((d) => !D(d.difference).eq(0)).length;
        await this.audit.record(tx, {
          action: 'juristic.import_parallel_cycle_compared',
          tenantId: ctx.tenantId,
          buildingId: locked.buildingId,
          subjectType: 'juristic.import_job',
          subjectId: id,
          metadata: { billingCycleId: cycle.id, units: diffs.length, different },
        });
        return this.parallelReportIn(tx, ctx, id);
      },
      { timeout: 120_000 },
    );
  }

  private async parallelReportIn(tx: Tx, ctx: TenantContext, id: string) {
    const job = await this.loadJob(tx, ctx, id);
    const rows = await tx.importCycleDifference.findMany({
      where: { jobId: id },
      orderBy: { unitNo: 'asc' },
    });
    const cycle = job.parallelCycleId
      ? await tx.billingCycle.findUnique({
          where: { id: job.parallelCycleId },
          select: { id: true, periodKey: true, frequency: true },
        })
      : null;
    const different = rows.filter((r) => !D(r.difference).eq(0));
    return {
      job,
      cycle,
      runAt: job.parallelRunAt,
      rows,
      summary: {
        units: rows.length,
        matching: rows.length - different.length,
        different: different.length,
        unexplained: different.filter((r) => r.explanation === null).length,
        computedTotal: rows.reduce((s, r) => s.plus(D(r.computed)), D(0)).toFixed(2),
        legacyTotal: rows.reduce((s, r) => s.plus(D(r.legacy)), D(0)).toFixed(2),
        differenceTotal: rows.reduce((s, r) => s.plus(D(r.difference)), D(0)).toFixed(2),
      },
    };
  }

  parallelReport(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.parallelReportIn(tx, ctx, id));
  }

  async explainDifference(
    ctx: TenantContext,
    id: string,
    differenceId: string,
    input: { explanation: string },
  ) {
    const text = input.explanation?.trim() ?? '';
    if (text.length < 5 || text.length > 1000) throw invalid('explanation', 'length', '5–1000 characters');
    return this.db.tenant(ctx, async (tx) => {
      const job = await this.loadJob(tx, ctx, id, true);
      this.state(job, ['committed']);
      const row = await tx.importCycleDifference.findFirst({ where: { id: differenceId, jobId: id } });
      if (!row) throw new DomainException('http.not_found');
      if (D(row.difference).eq(0))
        throw new DomainException('import.invalid_state', { params: { state: 'match' } });
      await tx.importCycleDifference.update({
        where: { id: row.id },
        data: { explanation: text, explainedAt: this.clock.now(), explainedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'juristic.import_difference_explained',
        tenantId: ctx.tenantId,
        buildingId: job.buildingId,
        subjectType: 'juristic.import_cycle_difference',
        subjectId: row.id,
        metadata: { unitNo: row.unitNo, difference: row.difference.toFixed(2) },
      });
      return this.parallelReportIn(tx, ctx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- go-live

  /**
   * `POST …/{id}/actions/go-live` (Idempotency-Key, committed only): the parallel-cycle gate, then the opening drafts
   * issued (series OPB, normal due date; silently when `notifyOpeningBalances` is false), the bank opening journals
   * posted and the job live — the rollback window closes, the building issues normally, the ladder takes over.
   */
  async goLive(
    ctx: TenantContext,
    id: string,
    input: { notifyOpeningBalances?: boolean; acknowledgeDifferences?: boolean },
  ) {
    const notify = input.notifyOpeningBalances ?? true;
    return this.db.tenant(
      ctx,
      async (tx) => {
        const job = await this.loadJob(tx, ctx, id, true);
        this.state(job, ['committed']);
        const now = this.clock.now();
        const scope = { tenantId: ctx.tenantId };
        const required = await this.settings.valueAt<boolean>(
          'juristic.import.parallel_cycle_required',
          now,
          scope,
        );
        const allow = await this.settings.valueAt<boolean>(
          'juristic.import.allow_unexplained_differences',
          now,
          scope,
        );
        if (required !== false && !job.parallelRunAt)
          throw new DomainException('import.parallel_cycle_missing');
        const unexplained = await tx.importCycleDifference.count({
          where: { jobId: id, explanation: null, NOT: { difference: 0 } },
        });
        let acknowledged = false;
        if (unexplained) {
          if (allow !== true || input.acknowledgeDifferences !== true)
            throw new DomainException('import.differences_unexplained', {
              params: { count: unexplained, allowed: allow === true ? 'yes' : 'no' },
            });
          acknowledged = true;
        }
        const drafts = await tx.invoice.findMany({
          where: { importJobId: id, status: 'draft' },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        let issued = 0;
        for (const d of drafts) {
          await tx.invoice.update({ where: { id: d.id }, data: { reviewFlags: [], updatedBy: by() } });
          await this.invoices.issueInTx(tx, ctx, d.id, {
            ackId: null,
            throwOnRefusal: true,
            docType: 'opening_balance',
            notify,
          });
          issued += 1;
        }
        const journals = await this.postBankOpenings(tx, ctx, job);
        await tx.importJob.update({
          where: { id },
          data: {
            state: 'live',
            liveAt: now,
            liveBy: by(),
            notifyOpeningBalances: notify,
            ...(acknowledged ? { differencesAcknowledgedAt: now, differencesAcknowledgedBy: by() } : {}),
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        const counts = { openingInvoices: issued, journals, notify, differencesAcknowledged: acknowledged };
        await this.audit.record(tx, {
          action: 'juristic.import_went_live',
          tenantId: ctx.tenantId,
          buildingId: job.buildingId,
          subjectType: 'juristic.import_job',
          subjectId: id,
          metadata: { ...counts, unexplained },
        });
        await this.event(tx, job, 'went_live', counts);
        return this.loadJob(tx, ctx, id);
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
  }

  /** One `opening` journal per bank row: Dr the bank account (fund bank) / Cr accumulated surplus (fund equity). */
  private async postBankOpenings(tx: Tx, ctx: TenantContext, job: ImportJobRow): Promise<number> {
    const rows = await tx.importRow.findMany({
      where: { jobId: job.id, sheet: 'bank_balance' },
      orderBy: { rowNo: 'asc' },
    });
    if (!rows.length) return 0;
    await this.ledger.ensureChart(tx, ctx.tenantId);
    const accounts = await tx.tenantBankAccount.findMany({
      where: { tenantId: ctx.tenantId, state: { in: ['active', 'pending_otp'] }, effectiveTo: null },
      select: { id: true, accountNoMasked: true },
    });
    const funds = await tx.fund.findMany({ where: { buildingId: job.buildingId, isActive: true } });
    const asOf = day(job.asOfDate);
    let n = 0;
    for (const r of rows) {
      const d = r.data as Record<string, string | null>;
      const amount = D(d.balance ?? '0');
      if (amount.lte(0)) continue;
      const ba = d.bank_account_last4
        ? accounts.find((a) => a.accountNoMasked.replace(/\D/g, '').slice(-4) === d.bank_account_last4)
        : undefined;
      if (d.account_type === 'operating') {
        const key = await this.ledger.bankKey(tx, ctx.tenantId, ba?.id ?? null);
        await this.ledger.post(tx, {
          tenantId: ctx.tenantId,
          buildingId: job.buildingId,
          postedOn: asOf,
          sourceType: 'opening',
          sourceId: r.id,
          memo: `ยอดยกมาบัญชีธนาคาร (งานนำเข้า #${job.number})`,
          legs: [dr(key, amount), cr('accumulated_surplus', amount)],
        });
      } else {
        const fund = d.fund_name ? funds.find((f) => lc(f.name) === lc(d.fund_name)) : undefined;
        const fa = fund
          ? await this.ledger.fundAccounts(tx, fund.id)
          : await this.ledger.defaultFund(tx, ctx.tenantId, job.buildingId);
        await this.ledger.post(tx, {
          tenantId: ctx.tenantId,
          buildingId: job.buildingId,
          postedOn: asOf,
          sourceType: 'opening',
          sourceId: r.id,
          memo: `ยอดยกมาบัญชีกองทุน (งานนำเข้า #${job.number})`,
          fundId: fa.fundId,
          legs: [dr(idKey(fa.bankAccountId), amount), cr(idKey(fa.equityAccountId), amount)],
        });
      }
      n += 1;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------- cancel, purge

  async cancel(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const job = await this.loadJob(tx, ctx, id, true);
      this.state(job, OPEN);
      await tx.importJob.update({
        where: { id },
        data: {
          state: 'cancelled',
          cancelledAt: this.clock.now(),
          cancelledBy: by(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.import_cancelled',
        tenantId: ctx.tenantId,
        buildingId: job.buildingId,
        subjectType: 'juristic.import_job',
        subjectId: id,
      });
      await this.event(tx, job, 'cancelled');
      return this.loadJob(tx, ctx, id);
    });
  }

  /** Job `juristic-imports` (daily): rows of jobs live, rolled back or cancelled more than 90 days ago are deleted. */
  async purge(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 90 * 86_400_000);
    return RequestContext.run({ actor: systemActor('juristic-imports') }, () => this.purgeBefore(cutoff));
  }

  private purgeBefore(cutoff: Date): Promise<number> {
    return this.db.platform(async (tx) => {
      const n = await tx.$executeRaw`
        DELETE FROM juristic.import_row r USING juristic.import_job j
         WHERE r.job_id = j.id
           AND ((j.state = 'live' AND j.live_at < ${cutoff})
             OR (j.state = 'rolled_back' AND j.rolled_back_at < ${cutoff})
             OR (j.state = 'cancelled' AND j.cancelled_at < ${cutoff}))`;
      if (n) this.logger.log(`import rows purged: ${n}`);
      return n;
    });
  }

  /** The created entities of a job by kind (detail view). */
  async createdCounts(tx: Tx, jobId: string): Promise<Record<string, number>> {
    const rows = await tx.importCreated.groupBy({ by: ['entity'], where: { jobId }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.entity, r._count._all]));
  }

  async detail(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const job = await this.loadJob(tx, ctx, id);
      return {
        job,
        created: await this.createdCounts(tx, id),
        reconcile: job.reconciliation as unknown as ReconcileView | null,
      };
    });
  }
}

export interface ReconcileView {
  items: ReconcileItem[];
  explanationRequired: boolean;
}
