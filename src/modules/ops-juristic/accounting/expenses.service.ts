import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService, type UploadedGenerated } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ExpenseAttachmentKind,
  type ExpenseKind,
  type ExpensePaymentMethod,
  type ExpenseState,
  type Prisma,
} from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { bahtText, formatThb, thaiDate } from '@modules/ops-leases/thai-text';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type ApprovalBand, bandFor, whtFormOf, whtOf, type WhtRate } from './expense-rules';
import { LedgerService } from './ledger.service';
import { type AccountKey, expenseLegs, idKey } from './posting';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const esc = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const EXPENSE_INCLUDE = {
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { account: { select: { id: true, code: true, nameTh: true, nameEn: true } } },
  },
  attachments: { orderBy: { createdAt: 'asc' } },
  approvals: { orderBy: { createdAt: 'asc' } },
  building: { select: { id: true, name: true } },
  certificate: { select: { id: true, number: true, documentId: true, tax: true } },
  vendor: { select: { id: true, name: true } },
} as const satisfies Prisma.ExpenseRequestInclude;
export type ExpenseRow = Prisma.ExpenseRequestGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

export interface ExpenseLineInput {
  accountId: string;
  description: string;
  amount: string;
  vatAmount?: string | null;
  whtKey?: string | null;
}

export interface ExpenseInput {
  buildingId: string;
  kind?: ExpenseKind;
  title: string;
  payeePartyId?: string | null;
  payeeName?: string | null;
  pettyCashId?: string | null;
  fundId?: string | null;
  resolutionId?: string | null;
  /** J2.2 (D-331): the vendor paid (payee party and name come from it), its contract, the awarded quotation round. */
  vendorId?: string | null;
  vendorContractId?: string | null;
  quotationRoundId?: string | null;
  /** J3.3 (D-334): the management contract whose period fee this request is (set by the job only, never by a DTO). */
  managementContractId?: string | null;
  note?: string | null;
  lines?: ExpenseLineInput[];
  /** Top-ups only: the amount to add to the float. */
  amount?: string | null;
}

export interface CertificateItem {
  incomeType: string;
  ratePct: string;
  base: string;
  tax: string;
}

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const OPEN_STATES: ExpenseState[] = ['draft', 'submitted', 'approved'];

/**
 * Expense requests (D-311 = D-J10, D-091, D-329): draft (lines on expense accounts, optional WHT key) → submitted
 * (gapless number `EXP`, the approval band of `juristic.approval_bands` snapshotted) → approved by enough distinct
 * users holding a band role, never the requester (maker-checker, DB trigger too) — one rejection rejects → paid
 * (method, date, reference, evidence; journal Dr expense / Cr WHT payable / Cr bank · cash · fund bank) → the 50 ทวิ
 * certificate (series `WHT`, worker PDF) when tax was withheld. A request paid from a fund names an adopted resolution
 * of the fund's building (DB CHECK). A petty cash top-up is a request of kind `petty_cash_top_up` whose payment adds to
 * the float. The committee approves but never pays (D-320).
 */
@Injectable()
export class ExpensesService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'juristic-wht-certificates';
  readonly eventTypes = ['juristic.withholding_certificate.issued'] as const;
  readonly timeoutMs = 60_000;
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('juristic.expense.approval_required', async (tx, e) => {
      if (!e.tenantId) return null;
      const roles = (e.payload.roles as string[] | undefined) ?? ['owner', 'manager'];
      const requester = e.payload.requestedBy as string | undefined;
      const recipients = [
        ...(roles.includes('owner') ? await operators(tx, e.tenantId, ['owner'], 'owner') : []),
        // the committee hears operator messages on the manager routes (no committee audience, D-327)
        ...(await operators(
          tx,
          e.tenantId,
          roles.filter((r) => r === 'manager' || r === 'committee'),
          'manager',
        )),
      ].filter((r) => r.id !== requester);
      return {
        recipients,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          expense: {
            number: e.payload.number ?? '',
            title: e.payload.title ?? '',
            amount: e.payload.amount ?? '0.00',
            approvals: e.payload.approvalsRequired ?? 1,
          },
        },
      };
    });
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private actorId(): string {
    const id = by();
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  // ------------------------------------------------------------------------------------------- reads

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<ExpenseRow> {
    const r = this.found(
      await tx.expenseRequest.findFirst({ where: this.own(ctx, { id }), include: EXPENSE_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(r.buildingId))
      throw new DomainException('http.not_found');
    return r;
  }

  get(ctx: TenantContext, id: string): Promise<ExpenseRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.load(tx, ctx, id);
    });
  }

  list(
    ctx: TenantContext,
    q: {
      state?: ExpenseState;
      kind?: ExpenseKind;
      buildingId?: string;
      awaitingMe?: boolean;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const me = by();
      const where: Prisma.ExpenseRequestWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
        ...(q.awaitingMe && me
          ? {
              state: 'submitted',
              requestedBy: { not: me },
              approverRoles: { has: ctx.role ?? '-' },
              approvals: { none: { approverUserId: me } },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.expenseRequest.findMany({
          where,
          include: EXPENSE_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.expenseRequest.count({ where }),
      ]);
      // Tab badges (J-CR): the same building / kind filters, per state, plus what awaits me.
      const scopeWhere: Prisma.ExpenseRequestWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
      };
      const [byState, awaitingMe] = await Promise.all([
        tx.expenseRequest.groupBy({ by: ['state'], where: scopeWhere, _count: { _all: true } }),
        me
          ? tx.expenseRequest.count({
              where: {
                ...scopeWhere,
                state: 'submitted',
                requestedBy: { not: me },
                approverRoles: { has: ctx.role ?? '-' },
                approvals: { none: { approverUserId: me } },
              },
            })
          : Promise.resolve(0),
      ]);
      const counts = {
        all: 0,
        awaitingMe,
        draft: 0,
        submitted: 0,
        approved: 0,
        rejected: 0,
        paid: 0,
        cancelled: 0,
      };
      for (const g of byState) {
        counts[g.state] = g._count._all;
        counts.all += g._count._all;
      }
      return { rows, total, counts };
    });
  }

  // ------------------------------------------------------------------------------------------- draft

  private async ownBuilding(tx: Tx, ctx: TenantContext, buildingId: string) {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
      select: { id: true, name: true },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
      throw new DomainException('http.not_found');
    return b;
  }

  private async whtRates(tenantId: string): Promise<WhtRate[]> {
    return (
      (await this.settings.valueAt<WhtRate[]>('juristic.wht_rates', this.clock.now(), { tenantId })) ?? []
    );
  }

  /** Validated lines + totals; WHT snapshotted from `juristic.wht_rates`. */
  private async linesOf(
    tx: Tx,
    ctx: TenantContext,
    kind: ExpenseKind,
    input: ExpenseInput,
    pettyAccountId: string | null,
  ) {
    if (kind === 'petty_cash_top_up') {
      const amount = input.amount ?? input.lines?.[0]?.amount ?? null;
      if (!amount || !MONEY.test(amount) || D(amount).lte(0))
        throw invalid('amount', 'money', 'a positive amount');
      return {
        lines: [
          {
            accountId: pettyAccountId!,
            description: 'เติมเงินสดย่อย',
            amount: D(amount).toFixed(2),
            vatAmount: '0.00',
            whtKey: null,
            whtIncomeType: null,
            whtRate: null,
            whtAmount: '0.00',
          },
        ],
        amount: D(amount),
        wht: D(0),
      };
    }
    const lines = input.lines ?? [];
    if (lines.length > 50) throw invalid('lines', 'count', 'at most 50 lines');
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = ids.length
      ? await tx.account.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId } })
      : [];
    if (accounts.length !== ids.length) throw new DomainException('http.not_found');
    const rates = lines.some((l) => l.whtKey) ? await this.whtRates(ctx.tenantId) : [];
    let amount = D(0);
    let wht = D(0);
    const out = lines.map((l, i) => {
      const a = accounts.find((x) => x.id === l.accountId)!;
      if (a.type !== 'expense' || !a.isActive)
        throw invalid(`lines[${i}].accountId`, 'expense_account', 'an active expense account');
      if (!MONEY.test(l.amount) || D(l.amount).lte(0))
        throw invalid(`lines[${i}].amount`, 'money', 'a positive amount');
      const vat = l.vatAmount ?? '0.00';
      if (!MONEY.test(vat) || D(vat).gt(l.amount))
        throw invalid(`lines[${i}].vatAmount`, 'money', '0 … amount');
      let rate: WhtRate | null = null;
      if (l.whtKey) {
        rate = rates.find((r) => r.key === l.whtKey) ?? null;
        if (!rate) throw invalid(`lines[${i}].whtKey`, 'unknown', 'a key of juristic.wht_rates');
      }
      const tax = rate ? D(whtOf(l.amount, vat, rate.ratePct)) : D(0);
      amount = amount.plus(l.amount);
      wht = wht.plus(tax);
      return {
        accountId: a.id,
        description: l.description,
        amount: D(l.amount).toFixed(2),
        vatAmount: D(vat).toFixed(2),
        whtKey: rate?.key ?? null,
        whtIncomeType: rate?.incomeType ?? null,
        whtRate: rate ? D(rate.ratePct).toFixed(2) : null,
        whtAmount: tax.toFixed(2),
      };
    });
    return { lines: out, amount, wht };
  }

  /**
   * J2.2 (D-331): an expense request paid to a vendor — the vendor is active, its contract (same vendor and building)
   * and the quotation round (awarded to that vendor, same building) belong to this tenant; cross-tenant ids are 404.
   */
  private async vendorLinks(
    tx: Tx,
    ctx: TenantContext,
    input: ExpenseInput,
    kind: ExpenseKind,
  ): Promise<{ partyId: string; name: string }> {
    if (kind !== 'expense') throw invalid('vendorId', 'kind', 'a top-up has no vendor');
    const v = await tx.vendor.findFirst({ where: { id: input.vendorId!, tenantId: ctx.tenantId } });
    if (!v) throw new DomainException('http.not_found');
    if (v.state !== 'active') throw new DomainException('vendor.blocked');
    if (input.vendorContractId) {
      const c = await tx.vendorContract.findFirst({
        where: { id: input.vendorContractId, tenantId: ctx.tenantId },
      });
      if (!c) throw new DomainException('http.not_found');
      if (c.vendorId !== v.id || c.buildingId !== input.buildingId)
        throw invalid('vendorContractId', 'vendor', 'a contract of the vendor for the building');
      if (c.state === 'draft') throw invalid('vendorContractId', 'state', 'an active contract');
    }
    if (input.quotationRoundId) {
      const r = await tx.quotationRound.findFirst({
        where: { id: input.quotationRoundId, tenantId: ctx.tenantId },
        include: { awardedQuotation: { select: { vendorId: true } } },
      });
      if (!r) throw new DomainException('http.not_found');
      if (r.state !== 'awarded' || r.awardedQuotation?.vendorId !== v.id || r.buildingId !== input.buildingId)
        throw invalid('quotationRoundId', 'awarded', 'a round of the building awarded to the vendor');
    }
    return { partyId: v.partyId, name: v.name };
  }

  private async header(tx: Tx, ctx: TenantContext, input: ExpenseInput, kind: ExpenseKind) {
    await this.ownBuilding(tx, ctx, input.buildingId);
    let payeeName = input.payeeName ?? null;
    if (input.vendorId) {
      const vendorPayee = await this.vendorLinks(tx, ctx, input, kind);
      if (input.payeePartyId && input.payeePartyId !== vendorPayee.partyId)
        throw invalid('payeePartyId', 'vendor', 'the vendor’s party (or leave it out)');
      input.payeePartyId = vendorPayee.partyId;
      payeeName = payeeName ?? vendorPayee.name;
    } else if (input.vendorContractId || input.quotationRoundId)
      throw invalid('vendorId', 'required', 'the vendor of the contract / quotation round');
    if (input.payeePartyId) {
      const p = await tx.party.findFirst({
        where: { id: input.payeePartyId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!p) throw new DomainException('http.not_found');
      payeeName = payeeName ?? p.displayName;
    }
    let pettyAccountId: string | null = null;
    if (kind === 'petty_cash_top_up') {
      if (!input.pettyCashId) throw invalid('pettyCashId', 'required', 'the float to top up');
      const pc = await tx.pettyCash.findFirst({ where: { id: input.pettyCashId, tenantId: ctx.tenantId } });
      if (!pc) throw new DomainException('http.not_found');
      if (pc.buildingId !== input.buildingId)
        throw invalid('pettyCashId', 'building', 'a float of the building');
      if (!pc.isActive) throw invalid('pettyCashId', 'inactive', 'an active float');
      pettyAccountId = pc.accountId;
      payeeName = payeeName ?? 'เงินสดย่อย';
      if (input.fundId) throw invalid('fundId', 'top_up', 'a top-up is not paid from a fund');
    } else if (input.pettyCashId) throw invalid('pettyCashId', 'kind', 'only a top-up names a float');
    if (input.fundId) {
      const f = await tx.fund.findFirst({ where: { id: input.fundId, tenantId: ctx.tenantId } });
      if (!f) throw new DomainException('http.not_found');
      if (f.buildingId !== input.buildingId) throw invalid('fundId', 'building', 'a fund of the building');
      await this.ledger.assertResolution(tx, ctx, input.buildingId, input.resolutionId ?? null);
    } else if (input.resolutionId)
      await this.ledger.assertResolution(tx, ctx, input.buildingId, input.resolutionId);
    if (!payeeName?.trim()) throw invalid('payeeName', 'required', 'who is paid');
    return { payeeName: payeeName.trim().slice(0, 200), pettyAccountId };
  }

  async create(ctx: TenantContext, input: ExpenseInput): Promise<ExpenseRow> {
    const requestedBy = this.actorId();
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return (await this.createIn(tx, ctx, { ...input }, requestedBy)).id;
    });
    return this.get(ctx, id);
  }

  /**
   * Drafts an expense request inside the caller's transaction (J2.2: also the vendor-contracts job and quotation
   * awards, with the requester they name — the maker of maker-checker).
   */
  async createIn(
    tx: Tx,
    ctx: TenantContext,
    input: ExpenseInput,
    requestedBy: string,
  ): Promise<{ id: string }> {
    await this.ledger.ensureChart(tx, ctx.tenantId);
    const kind = input.kind ?? 'expense';
    const h = await this.header(tx, ctx, input, kind);
    const l = await this.linesOf(tx, ctx, kind, input, h.pettyAccountId);
    const row = await tx.expenseRequest.create({
      data: {
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        kind,
        title: input.title,
        payeePartyId: input.payeePartyId ?? null,
        payeeName: h.payeeName,
        pettyCashId: input.pettyCashId ?? null,
        fundId: input.fundId ?? null,
        resolutionId: input.resolutionId ?? null,
        vendorId: input.vendorId ?? null,
        vendorContractId: input.vendorContractId ?? null,
        quotationRoundId: input.quotationRoundId ?? null,
        managementContractId: input.managementContractId ?? null,
        note: input.note ?? null,
        amount: l.amount.toFixed(2),
        whtAmount: l.wht.toFixed(2),
        netAmount: l.amount.minus(l.wht).toFixed(2),
        requestedBy,
        createdBy: by() ?? requestedBy,
        lines: {
          create: l.lines.map((x, i) => ({ tenantId: ctx.tenantId, lineNo: i + 1, ...x })),
        },
      },
    });
    await this.audit.record(tx, {
      action: 'juristic.expense_drafted',
      tenantId: ctx.tenantId,
      buildingId: input.buildingId,
      subjectType: 'juristic.expense_request',
      subjectId: row.id,
      metadata: {
        kind,
        amount: row.amount.toFixed(2),
        wht: row.whtAmount.toFixed(2),
        ...(row.vendorId ? { vendorId: row.vendorId, vendorContractId: row.vendorContractId } : {}),
      },
    });
    await this.events.record(tx, {
      type: 'juristic.expense_request.changed',
      aggregateType: 'expense_request',
      aggregateId: row.id,
      tenantId: ctx.tenantId,
      buildingId: input.buildingId,
      payload: { expenseRequestId: row.id, state: 'draft' },
    });
    return { id: row.id };
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: Partial<ExpenseInput> & { version?: number },
  ): Promise<ExpenseRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'draft')
        throw new DomainException('expense.invalid_state', { params: { state: r.state } });
      if (input.version !== undefined && input.version !== r.version)
        throw new DomainException('concurrency.stale');
      const merged: ExpenseInput = {
        buildingId: r.buildingId,
        kind: r.kind,
        title: input.title ?? r.title,
        payeePartyId:
          input.payeePartyId !== undefined
            ? input.payeePartyId
            : input.vendorId !== undefined
              ? null
              : r.payeePartyId,
        payeeName:
          input.payeeName !== undefined
            ? input.payeeName
            : input.payeePartyId !== undefined || input.vendorId !== undefined
              ? null
              : r.payeeName,
        pettyCashId: r.pettyCashId,
        fundId: input.fundId !== undefined ? input.fundId : r.fundId,
        resolutionId: input.resolutionId !== undefined ? input.resolutionId : r.resolutionId,
        vendorId: input.vendorId !== undefined ? input.vendorId : r.vendorId,
        vendorContractId: input.vendorContractId !== undefined ? input.vendorContractId : r.vendorContractId,
        quotationRoundId: input.quotationRoundId !== undefined ? input.quotationRoundId : r.quotationRoundId,
        note: input.note !== undefined ? input.note : r.note,
        lines:
          input.lines ??
          r.lines.map((l) => ({
            accountId: l.accountId,
            description: l.description,
            amount: l.amount.toFixed(2),
            vatAmount: l.vatAmount.toFixed(2),
            whtKey: l.whtKey,
          })),
        amount: input.amount ?? (r.kind === 'petty_cash_top_up' ? r.amount.toFixed(2) : null),
      };
      const h = await this.header(tx, ctx, merged, r.kind);
      const l = await this.linesOf(tx, ctx, r.kind, merged, h.pettyAccountId);
      await tx.expenseRequestLine.deleteMany({ where: { expenseRequestId: id } });
      await tx.expenseRequest.update({
        where: { id },
        data: {
          title: merged.title,
          payeePartyId: merged.payeePartyId ?? null,
          payeeName: h.payeeName,
          fundId: merged.fundId ?? null,
          resolutionId: merged.resolutionId ?? null,
          vendorId: merged.vendorId ?? null,
          vendorContractId: merged.vendorContractId ?? null,
          quotationRoundId: merged.quotationRoundId ?? null,
          note: merged.note ?? null,
          amount: l.amount.toFixed(2),
          whtAmount: l.wht.toFixed(2),
          netAmount: l.amount.minus(l.wht).toFixed(2),
          updatedBy: by(),
          version: { increment: 1 },
          lines: { create: l.lines.map((x, i) => ({ tenantId: ctx.tenantId, lineNo: i + 1, ...x })) },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.expense_updated',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.expense_request',
        subjectId: id,
        metadata: { amount: l.amount.toFixed(2), wht: l.wht.toFixed(2) },
      });
      await this.events.record(tx, {
        type: 'juristic.expense_request.changed',
        aggregateType: 'expense_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        payload: { expenseRequestId: id, state: 'draft' },
      });
    });
    return this.get(ctx, id);
  }

  private async lock(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.expense_request WHERE id = ${id}::uuid FOR UPDATE`;
  }

  async attach(
    ctx: TenantContext,
    id: string,
    input: { documentId: string; kind: ExpenseAttachmentKind },
  ): Promise<ExpenseRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const r = await this.load(tx, ctx, id);
      if (r.state === 'cancelled' || r.state === 'rejected')
        throw new DomainException('expense.invalid_state', { params: { state: r.state } });
      const doc = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new DomainException('http.not_found');
      if (r.attachments.some((a) => a.documentId === input.documentId)) return;
      await tx.expenseAttachment.create({
        data: {
          tenantId: ctx.tenantId,
          expenseRequestId: id,
          documentId: input.documentId,
          kind: input.kind,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.expense_attachment_added',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.expense_request',
        subjectId: id,
        metadata: { documentId: input.documentId, kind: input.kind },
      });
      await this.events.record(tx, {
        type: 'juristic.expense_request.changed',
        aggregateType: 'expense_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        payload: { expenseRequestId: id, state: r.state, attachment: input.kind },
      });
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- approval

  async submit(ctx: TenantContext, id: string): Promise<ExpenseRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.submitIn(tx, ctx, id);
    });
    return this.get(ctx, id);
  }

  /** Submits a draft inside the caller's transaction (J2.2: the vendor-contracts job submits instalment requests). */
  async submitIn(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await this.lock(tx, id);
    const r = await this.load(tx, ctx, id);
    if (r.state !== 'draft')
      throw new DomainException('expense.invalid_state', { params: { state: r.state } });
    if (!r.lines.length || D(r.amount).lte(0)) throw invalid('lines', 'required', 'at least one line');
    const now = this.clock.now();
    await this.assertQuotations(tx, ctx, r, now);
    const bands = await this.settings.valueAt<ApprovalBand[]>('juristic.approval_bands', now, {
      tenantId: ctx.tenantId,
    });
    const band = bandFor(bands, r.amount);
    const number = await this.numbering.next(tx, ctx.tenantId, 'expense_request', now);
    await tx.expenseRequest.update({
      where: { id },
      data: {
        state: 'submitted',
        number,
        submittedAt: now,
        band: band as unknown as Prisma.InputJsonValue,
        approvalsRequired: band.approvals,
        approverRoles: band.roles,
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: 'juristic.expense_submitted',
      tenantId: ctx.tenantId,
      buildingId: r.buildingId,
      subjectType: 'juristic.expense_request',
      subjectId: id,
      metadata: { number, amount: r.amount.toFixed(2), band: band.key, approvals: band.approvals },
    });
    const payload = {
      expenseRequestId: id,
      number,
      title: r.title,
      amount: r.amount.toFixed(2),
      roles: band.roles,
      approvalsRequired: band.approvals,
      requestedBy: r.requestedBy,
    };
    await this.events.record(tx, {
      type: 'juristic.expense_request.submitted',
      aggregateType: 'expense_request',
      aggregateId: id,
      tenantId: ctx.tenantId,
      buildingId: r.buildingId,
      payload,
    });
    await this.events.record(tx, {
      type: 'juristic.expense.approval_required',
      aggregateType: 'expense_request',
      aggregateId: id,
      tenantId: ctx.tenantId,
      buildingId: r.buildingId,
      payload,
    });
  }

  /**
   * D-310 / D-331: a vendor purchase above `juristic.quotation_threshold` (not under a contract — the contract went
   * through its own round) is submitted only with a quotation round awarded to that vendor.
   */
  private async assertQuotations(tx: Tx, ctx: TenantContext, r: ExpenseRow, now: Date): Promise<void> {
    // J3.3 (D-334): a management fee rests on the adopted resolution that appointed the manager, like a contract
    if (!r.vendorId || r.vendorContractId || r.managementContractId || r.kind !== 'expense') return;
    const threshold = await this.settings.valueAt<string>('juristic.quotation_threshold', now, {
      tenantId: ctx.tenantId,
    });
    if (!D(r.amount).gt(threshold ?? '0')) return;
    if (r.quotationRoundId) {
      const round = await tx.quotationRound.findFirst({
        where: { id: r.quotationRoundId, tenantId: ctx.tenantId, state: 'awarded' },
        include: { awardedQuotation: { select: { vendorId: true } } },
      });
      if (round?.awardedQuotation?.vendorId === r.vendorId) return;
    }
    throw new DomainException('expense.quotations_required', {
      params: { threshold: D(threshold ?? '0').toFixed(2) },
    });
  }

  /** One approval / rejection by a band role holder who is not the requester (maker-checker, D-091). */
  async decide(
    ctx: TenantContext,
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string | null,
  ): Promise<ExpenseRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'submitted')
        throw new DomainException('expense.invalid_state', { params: { state: r.state } });
      if (r.requestedBy === me) throw new DomainException('expense.maker_checker');
      if (!ctx.role || !r.approverRoles.includes(ctx.role))
        throw new DomainException('expense.not_in_band', { params: { roles: r.approverRoles.join(', ') } });
      if (r.approvals.some((a) => a.approverUserId === me))
        throw new DomainException('expense.already_decided');
      if (decision === 'rejected' && !reason?.trim())
        throw invalid('reason', 'required', 'why it is rejected');
      const band = (r.band ?? {}) as { key?: string };
      await tx.expenseApproval.create({
        data: {
          tenantId: ctx.tenantId,
          expenseRequestId: id,
          approverUserId: me,
          role: ctx.role,
          decision,
          reason: reason ?? null,
          bandKey: band.key ?? 'unknown',
        },
      });
      const approvals =
        r.approvals.filter((a) => a.decision === 'approved').length + (decision === 'approved' ? 1 : 0);
      const now = this.clock.now();
      const next: ExpenseState | null =
        decision === 'rejected' ? 'rejected' : approvals >= (r.approvalsRequired ?? 1) ? 'approved' : null;
      if (next)
        await tx.expenseRequest.update({
          where: { id },
          data: {
            state: next,
            ...(next === 'approved'
              ? { approvedAt: now }
              : { rejectedAt: now, decisionReason: reason ?? null }),
            updatedBy: me,
            version: { increment: 1 },
          },
        });
      await this.audit.record(tx, {
        action: decision === 'approved' ? 'juristic.expense_approval_given' : 'juristic.expense_rejected',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.expense_request',
        subjectId: id,
        metadata: {
          role: ctx.role,
          approvals,
          required: r.approvalsRequired,
          state: next ?? r.state,
          reason: reason ?? null,
        },
      });
      await this.events.record(tx, {
        type:
          next === 'approved'
            ? 'juristic.expense_request.approved'
            : next === 'rejected'
              ? 'juristic.expense_request.rejected'
              : 'juristic.expense_request.changed',
        aggregateType: 'expense_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        payload: { expenseRequestId: id, state: next ?? r.state, approvals, required: r.approvalsRequired },
      });
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<ExpenseRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (!OPEN_STATES.includes(r.state))
        throw new DomainException('expense.invalid_state', { params: { state: r.state } });
      await tx.expenseRequest.update({
        where: { id },
        data: {
          state: 'cancelled',
          cancelledAt: this.clock.now(),
          cancelReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.expense_cancelled',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.expense_request',
        subjectId: id,
        metadata: { reason, from: r.state },
      });
      await this.events.record(tx, {
        type: 'juristic.expense_request.cancelled',
        aggregateType: 'expense_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        payload: { expenseRequestId: id, state: 'cancelled' },
      });
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- pay

  /**
   * `POST …/expense-requests/{id}/actions/pay`: an approved request is paid — journal (expense / WHT payable / the
   * account paid from), petty cash top-up entry, 50 ทวิ certificate when tax was withheld. Evidence is required except
   * for cash.
   */
  async pay(
    ctx: TenantContext,
    id: string,
    input: {
      method: ExpensePaymentMethod;
      paidOn: string;
      reference?: string | null;
      fromAccountId?: string | null;
      evidenceDocumentId?: string | null;
    },
  ): Promise<ExpenseRow> {
    if (input.paidOn > this.today()) throw invalid('paidOn', 'future', 'not in the future');
    if (input.method !== 'cash' && !input.evidenceDocumentId)
      throw invalid('evidenceDocumentId', 'required', 'the transfer slip / cheque copy');
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'approved')
        throw new DomainException('expense.invalid_state', { params: { state: r.state } });
      if ((input.method === 'fund') !== Boolean(r.fundId))
        throw invalid(
          'method',
          'fund',
          r.fundId ? 'a request of a fund is paid from the fund' : 'no fund on this request',
        );
      if (r.kind === 'petty_cash_top_up' && input.method === 'cash')
        throw invalid('method', 'top_up', 'a top-up is paid from the bank');
      let paidFrom: AccountKey;
      let paidFromId: string;
      const roles = await this.ledger.roleAccounts(tx, ctx.tenantId);
      if (input.method === 'fund') {
        const f = await this.ledger.fundAccounts(tx, r.fundId!);
        paidFrom = 'fund_bank';
        paidFromId = f.bankAccountId;
      } else if (input.method === 'cash') {
        paidFrom = 'cash';
        paidFromId = roles.get('cash')!.id;
      } else if (input.fromAccountId) {
        const a = await tx.account.findFirst({ where: { id: input.fromAccountId, tenantId: ctx.tenantId } });
        if (!a) throw new DomainException('http.not_found');
        if (
          a.type !== 'asset' ||
          a.fundId ||
          !a.isActive ||
          (a.role && a.role !== 'bank' && a.role !== 'cash')
        )
          throw invalid('fromAccountId', 'bank', 'an active bank or cash account (not a fund)');
        paidFrom = idKey(a.id);
        paidFromId = a.id;
      } else {
        paidFrom = 'bank';
        paidFromId = roles.get('bank')!.id;
      }
      if (input.evidenceDocumentId) {
        const doc = await tx.document.findFirst({
          where: { id: input.evidenceDocumentId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!doc) throw new DomainException('http.not_found');
        if (!r.attachments.some((a) => a.documentId === doc.id))
          await tx.expenseAttachment.create({
            data: {
              tenantId: ctx.tenantId,
              expenseRequestId: id,
              documentId: doc.id,
              kind: 'payment_evidence',
              createdBy: by(),
            },
          });
      }
      // WHT: the payee and its tax id (printed on the 50 ทวิ); refused before anything is posted
      let payee: { id: string; type: string; taxId: string; displayName: string } | null = null;
      if (D(r.whtAmount).gt(0)) {
        const p = r.payeePartyId
          ? await tx.party.findFirst({ where: { id: r.payeePartyId, tenantId: ctx.tenantId } })
          : null;
        const taxId = p?.taxId?.replace(/\D/g, '') ?? '';
        if (!p || taxId.length !== 13) throw new DomainException('wht.payee_tax_id_missing');
        payee = { id: p.id, type: p.type, taxId, displayName: p.displayName };
      }
      const journal = await this.ledger.post(tx, {
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        postedOn: input.paidOn,
        sourceType: 'expense_payment',
        sourceId: r.id,
        memo: `${r.number ?? ''} ${r.title} — ${r.payeeName}`.trim(),
        legs: expenseLegs({
          lines: r.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, memo: l.description })),
          wht: r.whtAmount,
          net: r.netAmount,
          paidFrom,
          fromFund: Boolean(r.fundId),
        }),
        resolutionId: r.resolutionId,
        fundId: r.fundId,
      });
      const now = this.clock.now();
      await tx.expenseRequest.update({
        where: { id },
        data: {
          state: 'paid',
          paidAt: now,
          paidOn: asDate(input.paidOn),
          paymentMethod: input.method,
          paymentReference: input.reference ?? null,
          paidFromAccountId: paidFromId,
          paidBy: by(),
          journalId: journal.id,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (r.kind === 'petty_cash_top_up')
        await tx.pettyCashEntry.create({
          data: {
            tenantId: ctx.tenantId,
            pettyCashId: r.pettyCashId!,
            kind: 'top_up',
            amount: r.amount.toFixed(2),
            entryOn: asDate(input.paidOn),
            description: `${r.number} ${r.title}`.slice(0, 300),
            expenseRequestId: r.id,
            journalId: journal.id,
            createdBy: by(),
          },
        });
      let certificateId: string | null = null;
      if (payee) {
        const items: CertificateItem[] = [];
        for (const l of r.lines.filter((x) => x.whtRate)) {
          const base = D(l.amount).minus(l.vatAmount);
          const found = items.find(
            (i) => i.incomeType === l.whtIncomeType && i.ratePct === D(l.whtRate!).toFixed(2),
          );
          if (found) {
            found.base = D(found.base).plus(base).toFixed(2);
            found.tax = D(found.tax).plus(l.whtAmount).toFixed(2);
          } else
            items.push({
              incomeType: l.whtIncomeType ?? '',
              ratePct: D(l.whtRate!).toFixed(2),
              base: base.toFixed(2),
              tax: D(l.whtAmount).toFixed(2),
            });
        }
        const base = items.reduce((s, i) => s.plus(i.base), D(0));
        const number = await this.numbering.next(tx, ctx.tenantId, 'withholding_certificate', now);
        const cert = await tx.withholdingCertificate.create({
          data: {
            tenantId: ctx.tenantId,
            buildingId: r.buildingId,
            expenseRequestId: r.id,
            payeePartyId: payee.id,
            payeeName: payee.displayName,
            payeeTaxIdHint: payee.taxId.slice(-4),
            form: whtFormOf(payee.type),
            number,
            items: items as unknown as Prisma.InputJsonValue,
            base: base.toFixed(2),
            tax: r.whtAmount.toFixed(2),
            paidOn: asDate(input.paidOn),
            issuedAt: now,
            issuedBy: by(),
          },
        });
        certificateId = cert.id;
        await this.audit.record(tx, {
          action: 'juristic.wht_certificate_issued',
          tenantId: ctx.tenantId,
          buildingId: r.buildingId,
          subjectType: 'juristic.withholding_certificate',
          subjectId: cert.id,
          metadata: { number, tax: r.whtAmount.toFixed(2), form: cert.form },
        });
        await this.events.record(tx, {
          type: 'juristic.withholding_certificate.issued',
          aggregateType: 'withholding_certificate',
          aggregateId: cert.id,
          tenantId: ctx.tenantId,
          buildingId: r.buildingId,
          payload: { certificateId: cert.id, expenseRequestId: r.id, number },
        });
      }
      await this.audit.record(tx, {
        action: 'juristic.expense_paid',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.expense_request',
        subjectId: id,
        metadata: {
          number: r.number,
          method: input.method,
          paidOn: input.paidOn,
          net: r.netAmount.toFixed(2),
          wht: r.whtAmount.toFixed(2),
          journalId: journal.id,
          certificateId,
        },
      });
      await this.events.record(tx, {
        type: 'juristic.expense_request.paid',
        aggregateType: 'expense_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        payload: { expenseRequestId: id, journalId: journal.id, certificateId, net: r.netAmount.toFixed(2) },
      });
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- certificates

  certificates(ctx: TenantContext, q: { buildingId?: string; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.WithholdingCertificateWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
      };
      const [rows, total] = await Promise.all([
        tx.withholdingCertificate.findMany({
          where,
          orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.withholdingCertificate.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async certificate(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const c = this.found(await tx.withholdingCertificate.findFirst({ where: this.own(ctx, { id }) }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
        throw new DomainException('http.not_found');
      return c;
    });
  }

  async certificateDocument(ctx: TenantContext, id: string) {
    const c = await this.certificate(ctx, id);
    if (!c.documentId) throw new DomainException('wht.document_pending');
    return this.db.tenant(ctx, async (tx) => {
      const doc = await tx.document.findUniqueOrThrow({ where: { id: c.documentId! } });
      return { row: c, ...(await this.documents.signedUrl(doc)) };
    });
  }

  // ------------------------------------------------------------------------------------------- 50 ทวิ PDF (worker)

  async prepare(event: DomainEventEnvelope): Promise<UploadedGenerated | null> {
    const id = event.payload.certificateId as string;
    const data = await this.db.platform(async (tx) => {
      const c = await tx.withholdingCertificate.findUnique({
        where: { id },
        include: {
          tenant: { select: { legalName: true, taxId: true, address: true } },
          payeeParty: { select: { taxId: true, address: true } },
          expenseRequest: { select: { number: true, title: true } },
        },
      });
      return c;
    });
    if (!data || data.documentId) return null;
    const items = data.items as unknown as CertificateItem[];
    const addr = (a: unknown) =>
      a && typeof a === 'object'
        ? Object.values(a as Record<string, unknown>)
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .join(' ')
        : typeof a === 'string'
          ? a
          : '';
    const paidOn = day(data.paidOn);
    const title = 'หนังสือรับรองการหักภาษี ณ ที่จ่าย';
    const box = (on: boolean) => (on ? '☑' : '☐');
    const body = `<p style="border:1px solid #b45309;padding:6px;color:#b45309"><strong>ฉบับร่าง ⚖</strong> แบบและอัตราภาษีหัก ณ ที่จ่ายของนิติบุคคลอาคารชุด / หมู่บ้านจัดสรรรอการยืนยันจากผู้เชี่ยวชาญภาษี (O-041) — ตรวจสอบก่อนนำส่งกรมสรรพากร</p>
<h1>${esc(title)}</h1>
<p>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร · เลขที่ ${esc(data.number)}</p>
<h2>ผู้มีหน้าที่หักภาษี ณ ที่จ่าย</h2>
<p>${esc(data.tenant.legalName)}<br/>เลขประจำตัวผู้เสียภาษีอากร ${esc(data.tenant.taxId ?? '—')}<br/>${esc(addr(data.tenant.address))}</p>
<h2>ผู้ถูกหักภาษี ณ ที่จ่าย</h2>
<p>${esc(data.payeeName)}<br/>เลขประจำตัวผู้เสียภาษีอากร ${esc(data.payeeParty.taxId ?? '')}<br/>${esc(addr(data.payeeParty.address))}</p>
<p>${box(data.form === 'pnd3')} ภ.ง.ด.3 &nbsp; ${box(data.form === 'pnd53')} ภ.ง.ด.53</p>
<table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
<thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th>อัตรา</th><th>วันที่จ่าย</th><th>จำนวนเงินที่จ่าย</th><th>ภาษีที่หักและนำส่งไว้</th></tr></thead>
<tbody>${items
      .map(
        (i) =>
          `<tr><td>${esc(i.incomeType)}</td><td style="text-align:right">${esc(i.ratePct)}%</td><td>${esc(thaiDate(paidOn))}</td><td style="text-align:right">${esc(formatThb(i.base))}</td><td style="text-align:right">${esc(formatThb(i.tax))}</td></tr>`,
      )
      .join('')}
<tr><td colspan="3"><strong>รวม</strong></td><td style="text-align:right"><strong>${esc(formatThb(data.base.toFixed(2)))}</strong></td><td style="text-align:right"><strong>${esc(formatThb(data.tax.toFixed(2)))}</strong></td></tr></tbody></table>
<p>รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) ${esc(bahtText(data.tax.toFixed(2)))}</p>
<p>ผู้จ่ายเงิน ☑ หัก ณ ที่จ่าย · อ้างอิงคำขอเบิก ${esc(data.expenseRequest.number ?? '')} ${esc(data.expenseRequest.title)}</p>
<p>ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</p>
<p style="margin-top:36px">ลงชื่อ ........................................ ผู้จ่ายเงิน<br/>วันที่ ${esc(thaiDate(day(data.issuedAt)))}</p>`;
    const html = await this.renderer.brandedDocument(body, title, 'th');
    const pdf = await this.pdf.render(html, {
      title: `${title} ${data.number}`,
      footer: `${title} ${data.number}`,
    });
    return this.documents.uploadGenerated({
      tenantId: data.tenantId,
      kind: 'pdf_certificate',
      scopeType: 'building',
      scopeId: data.buildingId,
      buildingId: data.buildingId,
      title: `50 ทวิ ${data.number}.pdf`,
      mimeType: 'application/pdf',
      body: pdf,
    });
  }

  async handle(event: DomainEventEnvelope, tx: Tx, prepared?: unknown): Promise<void> {
    const uploaded = (prepared as UploadedGenerated | null | undefined) ?? null;
    const id = event.payload.certificateId as string;
    await tx.$queryRaw`SELECT id FROM juristic.withholding_certificate WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.withholdingCertificate.findUnique({ where: { id } });
    if (!c || c.documentId || !uploaded) return;
    const doc = await this.documents.recordGenerated(tx, uploaded);
    await tx.withholdingCertificate.update({ where: { id }, data: { documentId: doc.id } });
    await this.events.record(tx, {
      type: 'juristic.withholding_certificate.ready',
      aggregateType: 'withholding_certificate',
      aggregateId: id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { certificateId: id, number: c.number, documentId: doc.id },
    });
  }
}
