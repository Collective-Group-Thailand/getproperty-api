import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type FundKind,
  type FundTransferDirection,
  type FundTransferState,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { LedgerService } from './ledger.service';
import { countDifferenceLegs, cr, dr, fundTransferLegs, idKey } from './posting';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export const TRANSFER_INCLUDE = {
  fund: { select: { id: true, name: true, kind: true } },
  counterAccount: { select: { id: true, code: true, nameTh: true, nameEn: true } },
} as const satisfies Prisma.FundTransferInclude;
export type FundTransferRow = Prisma.FundTransferGetPayload<{ include: typeof TRANSFER_INCLUDE }>;

export interface FundView {
  id: string;
  buildingId: string;
  buildingName: string;
  kind: FundKind;
  name: string;
  bankAccountId: string | null;
  bankAccountMasked: string | null;
  isActive: boolean;
  ledgerBankAccountId: string;
  ledgerEquityAccountId: string;
  bankBalance: string;
  equityBalance: string;
  version: number;
}

export interface PettyCashView {
  id: string;
  buildingId: string;
  name: string;
  custodianUserId: string;
  floatAmount: string;
  accountId: string;
  balance: string;
  isActive: boolean;
  lastCount: { countedOn: string; countedAmount: string; difference: string } | null;
  version: number;
}

/**
 * Funds and petty cash (D-311 = D-J10, D-329). A **fund** (sinking fund first) is its own ledger — a fund bank
 * account and a fund equity account — and may name the tenant bank account that holds it; money moves in or out by a
 * **fund transfer** that another user approves (maker-checker, DB CHECK); out of the fund needs an adopted resolution
 * of the fund's building (DB CHECK, and the journal trigger refuses any credit to a fund bank without one).
 * **Petty cash**: a float per building with its own account and custodian; spends need their receipt; top-ups are
 * expense requests (`petty_cash_top_up`); a count reconciles the float (a difference is posted).
 */
@Injectable()
export class FundsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private actorId(): string {
    const id = by();
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

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

  private async balanceOf(tx: Tx, accountId: string): Promise<Decimal> {
    const s = await tx.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
    return D(s._sum.debit ?? 0).minus(D(s._sum.credit ?? 0));
  }

  // ------------------------------------------------------------------------------------------- funds

  private async view(tx: Tx, fundId: string): Promise<FundView> {
    const f = await tx.fund.findUniqueOrThrow({
      where: { id: fundId },
      include: { building: { select: { name: true } }, bankAccount: { select: { accountNoMasked: true } } },
    });
    const a = await this.ledger.fundAccounts(tx, f.id);
    return {
      id: f.id,
      buildingId: f.buildingId,
      buildingName: f.building.name,
      kind: f.kind,
      name: f.name,
      bankAccountId: f.bankAccountId,
      bankAccountMasked: f.bankAccount?.accountNoMasked ?? null,
      isActive: f.isActive,
      ledgerBankAccountId: a.bankAccountId,
      ledgerEquityAccountId: a.equityAccountId,
      bankBalance: (await this.balanceOf(tx, a.bankAccountId)).toFixed(2),
      equityBalance: (await this.balanceOf(tx, a.equityAccountId)).negated().toFixed(2),
      version: f.version,
    };
  }

  private async loadFund(tx: Tx, ctx: TenantContext, id: string) {
    const f = this.found(await tx.fund.findFirst({ where: this.own(ctx, { id }) }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(f.buildingId))
      throw new DomainException('http.not_found');
    return f;
  }

  funds(ctx: TenantContext, q: { buildingId?: string }): Promise<FundView[]> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      if (q.buildingId) await this.ownBuilding(tx, ctx, q.buildingId);
      const rows = await tx.fund.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(q.buildingId
            ? { buildingId: q.buildingId }
            : ctx.buildingIds
              ? { buildingId: { in: [...ctx.buildingIds] } }
              : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const out: FundView[] = [];
      for (const f of rows) out.push(await this.view(tx, f.id));
      return out;
    });
  }

  fund(ctx: TenantContext, id: string): Promise<FundView> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.loadFund(tx, ctx, id);
      return this.view(tx, id);
    });
  }

  private async assertBankAccount(tx: Tx, ctx: TenantContext, bankAccountId: string | null | undefined) {
    if (!bankAccountId) return;
    const ba = await tx.tenantBankAccount.findFirst({ where: { id: bankAccountId, tenantId: ctx.tenantId } });
    if (!ba) throw new DomainException('http.not_found');
  }

  async createFund(
    ctx: TenantContext,
    input: { buildingId: string; kind: FundKind; name: string; bankAccountId?: string | null },
  ): Promise<FundView> {
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.ownBuilding(tx, ctx, input.buildingId);
      await this.assertBankAccount(tx, ctx, input.bankAccountId);
      if (
        await tx.fund.findFirst({
          where: { buildingId: input.buildingId, kind: input.kind, name: input.name },
        })
      )
        throw new DomainException('fund.name_taken');
      const f = await this.ledger.createFund(tx, { tenantId: ctx.tenantId, ...input });
      await this.audit.record(tx, {
        action: 'juristic.fund_created',
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        subjectType: 'juristic.fund',
        subjectId: f.fundId,
        metadata: { kind: input.kind, name: input.name },
      });
      await this.events.record(tx, {
        type: 'juristic.fund.changed',
        aggregateType: 'fund',
        aggregateId: f.fundId,
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        payload: { fundId: f.fundId, change: 'created' },
      });
      return f.fundId;
    });
    return this.fund(ctx, id);
  }

  async updateFund(
    ctx: TenantContext,
    id: string,
    input: { name?: string; bankAccountId?: string | null; isActive?: boolean; version?: number },
  ): Promise<FundView> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const f = await this.loadFund(tx, ctx, id);
      if (input.version !== undefined && input.version !== f.version)
        throw new DomainException('concurrency.stale');
      await this.assertBankAccount(tx, ctx, input.bankAccountId);
      if (input.name && input.name !== f.name) {
        const dup = await tx.fund.findFirst({
          where: { buildingId: f.buildingId, kind: f.kind, name: input.name },
        });
        if (dup) throw new DomainException('fund.name_taken');
      }
      await tx.fund.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.bankAccountId !== undefined ? { bankAccountId: input.bankAccountId } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (input.bankAccountId !== undefined) {
        const a = await this.ledger.fundAccounts(tx, id);
        await tx.account.update({
          where: { id: a.bankAccountId },
          data: { bankAccountId: input.bankAccountId, version: { increment: 1 } },
        });
      }
      await this.audit.record(tx, {
        action: 'juristic.fund_updated',
        tenantId: ctx.tenantId,
        buildingId: f.buildingId,
        subjectType: 'juristic.fund',
        subjectId: id,
        metadata: { changes: Object.keys(input).filter((k) => k !== 'version') },
      });
      await this.events.record(tx, {
        type: 'juristic.fund.changed',
        aggregateType: 'fund',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: f.buildingId,
        payload: { fundId: id, change: 'updated' },
      });
    });
    return this.fund(ctx, id);
  }

  /** `GET /v1/owner/juristic/funds/{id}/ledger`: the journal lines on the fund's two accounts, newest first. */
  ledgerLines(ctx: TenantContext, id: string, q: { skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.loadFund(tx, ctx, id);
      const a = await this.ledger.fundAccounts(tx, id);
      const where: Prisma.JournalLineWhereInput = { accountId: { in: [a.bankAccountId, a.equityAccountId] } };
      const [rows, total] = await Promise.all([
        tx.journalLine.findMany({
          where,
          include: {
            journal: {
              select: { id: true, postedOn: true, sourceType: true, memo: true, resolutionId: true },
            },
            account: { select: { id: true, code: true, role: true } },
          },
          orderBy: [{ journal: { postedOn: 'desc' } }, { journal: { createdAt: 'desc' } }, { lineNo: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.journalLine.count({ where }),
      ]);
      return { rows, total };
    });
  }

  // ------------------------------------------------------------------------------------------- transfers

  private async loadTransfer(tx: Tx, ctx: TenantContext, id: string): Promise<FundTransferRow> {
    const t = this.found(
      await tx.fundTransfer.findFirst({ where: this.own(ctx, { id }), include: TRANSFER_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(t.buildingId))
      throw new DomainException('http.not_found');
    return t;
  }

  transfers(
    ctx: TenantContext,
    q: { fundId?: string; state?: FundTransferState; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      if (q.fundId) await this.loadFund(tx, ctx, q.fundId);
      const where: Prisma.FundTransferWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.fundId ? { fundId: q.fundId } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.fundTransfer.findMany({
          where,
          include: TRANSFER_INCLUDE,
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.fundTransfer.count({ where }),
      ]);
      return { rows, total };
    });
  }

  transfer(ctx: TenantContext, id: string): Promise<FundTransferRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.loadTransfer(tx, ctx, id);
    });
  }

  /** A bank or cash account of the tenant (not a fund's) the money comes from / goes to; default the operating bank. */
  private async counterAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string | null | undefined,
  ): Promise<string> {
    if (!accountId) return (await this.ledger.roleAccounts(tx, ctx.tenantId)).get('bank')!.id;
    const a = await tx.account.findFirst({ where: { id: accountId, tenantId: ctx.tenantId } });
    if (!a) throw new DomainException('http.not_found');
    if (a.type !== 'asset' || a.fundId || !a.isActive || (a.role && a.role !== 'bank' && a.role !== 'cash'))
      throw invalid('counterAccountId', 'bank', 'an active bank or cash account (not a fund)');
    return a.id;
  }

  async requestTransfer(
    ctx: TenantContext,
    fundId: string,
    input: {
      direction: FundTransferDirection;
      amount: string;
      transferOn: string;
      counterAccountId?: string | null;
      resolutionId?: string | null;
      reference?: string | null;
      note?: string | null;
    },
  ): Promise<FundTransferRow> {
    if (!MONEY.test(input.amount) || D(input.amount).lte(0))
      throw invalid('amount', 'money', 'a positive amount');
    if (input.transferOn > this.today()) throw invalid('transferOn', 'future', 'not in the future');
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const f = await this.loadFund(tx, ctx, fundId);
      if (!f.isActive) throw new DomainException('fund.inactive');
      const resolutionId =
        input.direction === 'out' || input.resolutionId
          ? await this.ledger.assertResolution(tx, ctx, f.buildingId, input.resolutionId ?? null)
          : null;
      const counter = await this.counterAccount(tx, ctx, input.counterAccountId);
      const t = await tx.fundTransfer.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: f.buildingId,
          fundId,
          direction: input.direction,
          amount: D(input.amount).toFixed(2),
          counterAccountId: counter,
          transferOn: asDate(input.transferOn),
          resolutionId,
          reference: input.reference ?? null,
          note: input.note ?? null,
          requestedBy: this.actorId(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.fund_transfer_requested',
        tenantId: ctx.tenantId,
        buildingId: f.buildingId,
        subjectType: 'juristic.fund_transfer',
        subjectId: t.id,
        metadata: { direction: t.direction, amount: t.amount.toFixed(2), resolutionId },
      });
      await this.events.record(tx, {
        type: 'juristic.fund_transfer.requested',
        aggregateType: 'fund_transfer',
        aggregateId: t.id,
        tenantId: ctx.tenantId,
        buildingId: f.buildingId,
        payload: { fundTransferId: t.id, fundId, direction: t.direction, amount: t.amount.toFixed(2) },
      });
      return t.id;
    });
    return this.transfer(ctx, id);
  }

  /** Approve (posts the journal) or reject; never the requester (maker-checker, D-091; DB CHECK). */
  async decideTransfer(
    ctx: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    reason?: string | null,
  ): Promise<FundTransferRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.fund_transfer WHERE id = ${id}::uuid FOR UPDATE`;
      const t = await this.loadTransfer(tx, ctx, id);
      if (t.state !== 'requested')
        throw new DomainException('fund.invalid_state', { params: { state: t.state } });
      if (t.requestedBy === me) throw new DomainException('fund.maker_checker');
      const now = this.clock.now();
      if (decision === 'reject') {
        if (!reason?.trim()) throw invalid('reason', 'required', 'why it is rejected');
        await tx.fundTransfer.update({
          where: { id },
          data: {
            state: 'rejected',
            decidedBy: me,
            decidedAt: now,
            decisionReason: reason,
            version: { increment: 1 },
          },
        });
      } else {
        if (t.direction === 'out') {
          const f = await this.ledger.fundAccounts(tx, t.fundId);
          const balance = await this.balanceOf(tx, f.bankAccountId);
          if (balance.lt(t.amount))
            throw new DomainException('fund.insufficient', { params: { balance: balance.toFixed(2) } });
        }
        const journal = await this.ledger.post(tx, {
          tenantId: ctx.tenantId,
          buildingId: t.buildingId,
          postedOn: t.transferOn.toISOString().slice(0, 10),
          sourceType: 'fund_transfer',
          sourceId: t.id,
          memo: `${t.direction === 'in' ? 'โอนเข้า' : 'โอนออกจาก'}${t.fund.name}${t.reference ? ` (${t.reference})` : ''}`,
          legs: fundTransferLegs({
            direction: t.direction,
            amount: t.amount,
            counter: idKey(t.counterAccountId),
          }),
          resolutionId: t.resolutionId,
          fundId: t.fundId,
        });
        await tx.fundTransfer.update({
          where: { id },
          data: {
            state: 'posted',
            decidedBy: me,
            decidedAt: now,
            decisionReason: reason ?? null,
            journalId: journal.id,
            version: { increment: 1 },
          },
        });
      }
      await this.audit.record(tx, {
        action: decision === 'approve' ? 'juristic.fund_transfer_posted' : 'juristic.fund_transfer_rejected',
        tenantId: ctx.tenantId,
        buildingId: t.buildingId,
        subjectType: 'juristic.fund_transfer',
        subjectId: id,
        metadata: { direction: t.direction, amount: t.amount.toFixed(2), reason: reason ?? null },
      });
      await this.events.record(tx, {
        type: decision === 'approve' ? 'juristic.fund_transfer.posted' : 'juristic.fund_transfer.rejected',
        aggregateType: 'fund_transfer',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: t.buildingId,
        payload: {
          fundTransferId: id,
          fundId: t.fundId,
          direction: t.direction,
          amount: t.amount.toFixed(2),
        },
      });
    });
    return this.transfer(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- petty cash

  private async pettyView(tx: Tx, id: string): Promise<PettyCashView> {
    const p = await tx.pettyCash.findUniqueOrThrow({ where: { id } });
    const sum = await tx.pettyCashEntry.aggregate({ where: { pettyCashId: id }, _sum: { amount: true } });
    const last = await tx.pettyCashCount.findFirst({
      where: { pettyCashId: id },
      orderBy: [{ countedOn: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      id: p.id,
      buildingId: p.buildingId,
      name: p.name,
      custodianUserId: p.custodianUserId,
      floatAmount: p.floatAmount.toFixed(2),
      accountId: p.accountId,
      balance: D(sum._sum.amount ?? 0).toFixed(2),
      isActive: p.isActive,
      lastCount: last
        ? {
            countedOn: last.countedOn.toISOString().slice(0, 10),
            countedAmount: last.countedAmount.toFixed(2),
            difference: last.difference.toFixed(2),
          }
        : null,
      version: p.version,
    };
  }

  private async loadPetty(tx: Tx, ctx: TenantContext, id: string) {
    const p = this.found(await tx.pettyCash.findFirst({ where: this.own(ctx, { id }) }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(p.buildingId))
      throw new DomainException('http.not_found');
    return p;
  }

  pettyCashes(ctx: TenantContext, q: { buildingId?: string }): Promise<PettyCashView[]> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const rows = await tx.pettyCash.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(q.buildingId
            ? { buildingId: q.buildingId }
            : ctx.buildingIds
              ? { buildingId: { in: [...ctx.buildingIds] } }
              : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const out: PettyCashView[] = [];
      for (const p of rows) out.push(await this.pettyView(tx, p.id));
      return out;
    });
  }

  async pettyCash(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.loadPetty(tx, ctx, id);
      const entries = await tx.pettyCashEntry.findMany({
        where: { pettyCashId: id },
        orderBy: [{ entryOn: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
      const counts = await tx.pettyCashCount.findMany({
        where: { pettyCashId: id },
        orderBy: [{ countedOn: 'desc' }, { createdAt: 'desc' }],
        take: 50,
      });
      return { ...(await this.pettyView(tx, id)), entries, counts };
    });
  }

  async createPettyCash(
    ctx: TenantContext,
    input: { buildingId: string; name: string; custodianUserId: string; floatAmount: string },
  ) {
    if (!MONEY.test(input.floatAmount) || D(input.floatAmount).lte(0))
      throw invalid('floatAmount', 'money', 'a positive amount');
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.ownBuilding(tx, ctx, input.buildingId);
      await this.ledger.ensureChart(tx, ctx.tenantId);
      const member = await tx.membership.findFirst({
        where: { tenantId: ctx.tenantId, userId: input.custodianUserId, status: 'active', deletedAt: null },
      });
      if (!member || ['committee', 'auditor', 'guard'].includes(member.role))
        throw invalid('custodianUserId', 'member', 'an active staff, manager, accountant or owner');
      if (await tx.pettyCash.findFirst({ where: { buildingId: input.buildingId, name: input.name } }))
        throw new DomainException('petty_cash.name_taken');
      const codes = await tx.account.findMany({
        where: { tenantId: ctx.tenantId, code: { startsWith: '1120-' } },
        select: { code: true },
      });
      const used = new Set(codes.map((c) => c.code));
      let n = 1;
      while (used.has(`1120-${String(n).padStart(2, '0')}`)) n += 1;
      const account = await tx.account.create({
        data: {
          tenantId: ctx.tenantId,
          code: `1120-${String(n).padStart(2, '0')}`,
          nameTh: `เงินสดย่อย – ${input.name}`.slice(0, 200),
          nameEn: `Petty cash — ${input.name}`.slice(0, 200),
          type: 'asset',
          isSystem: true,
          createdBy: by(),
        },
      });
      const p = await tx.pettyCash.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId,
          name: input.name,
          custodianUserId: input.custodianUserId,
          floatAmount: D(input.floatAmount).toFixed(2),
          accountId: account.id,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.petty_cash_created',
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        subjectType: 'juristic.petty_cash',
        subjectId: p.id,
        metadata: { name: input.name, floatAmount: p.floatAmount.toFixed(2) },
      });
      await this.events.record(tx, {
        type: 'juristic.petty_cash.changed',
        aggregateType: 'petty_cash',
        aggregateId: p.id,
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        payload: { pettyCashId: p.id, change: 'created' },
      });
      return p.id;
    });
    return this.pettyCash(ctx, id);
  }

  /** A spend with its receipt (custodian, or an owner / manager): Dr expense / Cr petty cash. */
  async spend(
    ctx: TenantContext,
    id: string,
    input: {
      amount: string;
      spentOn: string;
      description: string;
      accountId: string;
      receiptDocumentId: string;
    },
  ) {
    if (!MONEY.test(input.amount) || D(input.amount).lte(0))
      throw invalid('amount', 'money', 'a positive amount');
    if (input.spentOn > this.today()) throw invalid('spentOn', 'future', 'not in the future');
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.petty_cash WHERE id = ${id}::uuid FOR UPDATE`;
      const p = await this.loadPetty(tx, ctx, id);
      if (!p.isActive) throw new DomainException('petty_cash.inactive');
      if (ctx.role === 'staff' && p.custodianUserId !== me)
        throw new DomainException('petty_cash.not_custodian');
      const a = await tx.account.findFirst({ where: { id: input.accountId, tenantId: ctx.tenantId } });
      if (!a) throw new DomainException('http.not_found');
      if (a.type !== 'expense' || !a.isActive)
        throw invalid('accountId', 'expense_account', 'an active expense account');
      const doc = await tx.document.findFirst({
        where: { id: input.receiptDocumentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new DomainException('http.not_found');
      const balance = D(
        (await tx.pettyCashEntry.aggregate({ where: { pettyCashId: id }, _sum: { amount: true } }))._sum
          .amount ?? 0,
      );
      if (balance.lt(input.amount))
        throw new DomainException('petty_cash.insufficient', { params: { balance: balance.toFixed(2) } });
      const entryId = uuidv7();
      const journal = await this.ledger.post(tx, {
        tenantId: ctx.tenantId,
        buildingId: p.buildingId,
        postedOn: input.spentOn,
        sourceType: 'petty_cash',
        sourceId: entryId,
        memo: `เงินสดย่อย ${p.name}: ${input.description}`,
        legs: [dr(idKey(a.id), input.amount), cr(idKey(p.accountId), input.amount)],
      });
      await tx.pettyCashEntry.create({
        data: {
          id: entryId,
          tenantId: ctx.tenantId,
          pettyCashId: id,
          kind: 'spend',
          amount: D(input.amount).negated().toFixed(2),
          entryOn: asDate(input.spentOn),
          description: input.description,
          accountId: a.id,
          receiptDocumentId: doc.id,
          journalId: journal.id,
          createdBy: me,
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.petty_cash_spent',
        tenantId: ctx.tenantId,
        buildingId: p.buildingId,
        subjectType: 'juristic.petty_cash',
        subjectId: id,
        metadata: { entryId, amount: D(input.amount).toFixed(2), accountId: a.id },
      });
      await this.events.record(tx, {
        type: 'juristic.petty_cash.changed',
        aggregateType: 'petty_cash',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: p.buildingId,
        payload: { pettyCashId: id, change: 'spend', entryId },
      });
    });
    return this.pettyCash(ctx, id);
  }

  /** A cash count (reconciliation): the difference with the book balance is posted (shortage expense / overage income). */
  async count(
    ctx: TenantContext,
    id: string,
    input: { countedOn: string; countedAmount: string; note?: string | null },
  ) {
    if (!MONEY.test(input.countedAmount)) throw invalid('countedAmount', 'money', 'an amount ≥ 0');
    if (input.countedOn > this.today()) throw invalid('countedOn', 'future', 'not in the future');
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.petty_cash WHERE id = ${id}::uuid FOR UPDATE`;
      const p = await this.loadPetty(tx, ctx, id);
      const book = D(
        (await tx.pettyCashEntry.aggregate({ where: { pettyCashId: id }, _sum: { amount: true } }))._sum
          .amount ?? 0,
      );
      const difference = D(input.countedAmount).minus(book);
      const c = await tx.pettyCashCount.create({
        data: {
          tenantId: ctx.tenantId,
          pettyCashId: id,
          countedOn: asDate(input.countedOn),
          countedAmount: D(input.countedAmount).toFixed(2),
          bookBalance: book.toFixed(2),
          difference: difference.toFixed(2),
          note: input.note ?? null,
          countedBy: by(),
        },
      });
      if (!difference.eq(0)) {
        const journal = await this.ledger.post(tx, {
          tenantId: ctx.tenantId,
          buildingId: p.buildingId,
          postedOn: input.countedOn,
          sourceType: 'petty_cash',
          sourceId: c.id,
          memo: `ตรวจนับเงินสดย่อย ${p.name}: ${difference.lt(0) ? 'ขาด' : 'เกิน'} ${difference.abs().toFixed(2)}`,
          legs: countDifferenceLegs(p.accountId, difference),
        });
        await tx.pettyCashEntry.create({
          data: {
            tenantId: ctx.tenantId,
            pettyCashId: id,
            kind: 'count_difference',
            amount: difference.toFixed(2),
            entryOn: asDate(input.countedOn),
            description: `ผลต่างจากการตรวจนับ ${input.countedOn}`,
            countId: c.id,
            journalId: journal.id,
            createdBy: by(),
          },
        });
      }
      await this.audit.record(tx, {
        action: 'juristic.petty_cash_counted',
        tenantId: ctx.tenantId,
        buildingId: p.buildingId,
        subjectType: 'juristic.petty_cash',
        subjectId: id,
        metadata: {
          counted: c.countedAmount.toFixed(2),
          book: book.toFixed(2),
          difference: difference.toFixed(2),
        },
      });
      await this.events.record(tx, {
        type: 'juristic.petty_cash.changed',
        aggregateType: 'petty_cash',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: p.buildingId,
        payload: { pettyCashId: id, change: 'count', countId: c.id, difference: difference.toFixed(2) },
      });
    });
    return this.pettyCash(ctx, id);
  }
}
