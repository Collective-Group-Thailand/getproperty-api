import { createHash } from 'node:crypto';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type BankLineMatch, type BankStatementLine, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  BANK_FORMATS,
  type BankFormatKey,
  lineKeys,
  type MatchCandidate,
  parseStatement,
  rankCandidates,
  StatementParseError,
} from './bank-formats';
import { LedgerService } from './ledger.service';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const MAX_BYTES = 2 * 1024 * 1024;

export type MatchKind = 'payment' | 'expense' | 'fund_transfer';
export type LineState = 'unmatched' | 'matched' | 'ignored' | 'all';

export const STATEMENT_INCLUDE = {
  bankAccount: { select: { id: true, bankNameTh: true, accountNoMasked: true } },
  account: { select: { id: true, code: true, nameTh: true } },
} as const satisfies Prisma.BankStatementInclude;
export type BankStatementRow = Prisma.BankStatementGetPayload<{ include: typeof STATEMENT_INCLUDE }> & {
  matchedCount: number;
  unmatchedCount: number;
};

/**
 * Bank statement import and matching (D-329): a CSV of KBank / SCB / BBL / KTB is read with the bank's column map
 * (data, `bank-formats.ts`); the file's sha256 makes a re-import of the same file return the statement already
 * imported, and each line's key (date, amount, reference, description, occurrence) skips lines an overlapping file
 * already brought. New lines are matched automatically when unambiguous — money in to confirmed payments, money out to
 * paid expense requests, either to fund transfers — by amount, date (± `juristic.bank_match_days`) and a reference in
 * the bank's text; the rest wait in the unmatched queue for a manual match or an ignore with a reason.
 */
@Injectable()
export class BankStatementsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async windowDays(tenantId: string): Promise<number> {
    return Number(
      await this.settings.valueAt<number>('juristic.bank_match_days', this.clock.now(), { tenantId }),
    );
  }

  private async withCounts(
    tx: Tx,
    rows: Prisma.BankStatementGetPayload<{ include: typeof STATEMENT_INCLUDE }>[],
  ) {
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await tx.bankStatementLine.groupBy({
          by: ['statementId', 'matchKind'],
          where: { statementId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    return rows.map((r) => {
      const of = counts.filter((c) => c.statementId === r.id);
      const unmatched = of.filter((c) => c.matchKind === 'none').reduce((s, c) => s + c._count._all, 0);
      const ignored = of.filter((c) => c.matchKind === 'ignored').reduce((s, c) => s + c._count._all, 0);
      const all = of.reduce((s, c) => s + c._count._all, 0);
      return { ...r, matchedCount: all - unmatched - ignored, unmatchedCount: unmatched };
    });
  }

  // ------------------------------------------------------------------------------------------- import

  async import(
    ctx: TenantContext,
    input: { bankAccountId: string; formatKey: BankFormatKey; fileName: string; content: string },
  ): Promise<{
    statement: BankStatementRow;
    replayed: boolean;
    imported: number;
    duplicates: number;
    autoMatched: number;
  }> {
    const format = BANK_FORMATS[input.formatKey];
    if (!format)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'formatKey', code: 'unknown', message: 'kbank, scb, bbl or ktb' }],
      });
    const file = Buffer.from(input.content, 'base64');
    if (!file.length || file.length > MAX_BYTES)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'content', code: 'size', message: 'a base64 CSV of at most 2 MB' }],
      });
    const checksum = createHash('sha256').update(file).digest();
    let parsed;
    try {
      parsed = parseStatement(file.toString('utf8'), format);
    } catch (error) {
      if (error instanceof StatementParseError)
        throw new DomainException('bank_statement.unreadable', {
          params: { reason: error.message, line: error.line ?? 0 },
        });
      throw error;
    }
    const window = await this.windowDays(ctx.tenantId);
    const out = await this.db.tenant(
      ctx,
      async (tx) => {
        await this.ledger.assertJuristic(tx, ctx.tenantId);
        const ba = await tx.tenantBankAccount.findFirst({
          where: { id: input.bankAccountId, tenantId: ctx.tenantId },
        });
        if (!ba) throw new DomainException('http.not_found');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bank-statement:${ba.id}`}))`;
        const existing = await tx.bankStatement.findFirst({
          where: { bankAccountId: ba.id, checksum: new Uint8Array(checksum) },
        });
        if (existing)
          return {
            id: existing.id,
            replayed: true,
            imported: 0,
            duplicates: existing.duplicateCount,
            autoMatched: 0,
          };
        await this.ledger.ensureChart(tx, ctx.tenantId);
        const key = await this.ledger.bankKey(tx, ctx.tenantId, ba.id);
        const glAccountId = key.startsWith('id:')
          ? key.slice(3)
          : (await this.ledger.roleAccounts(tx, ctx.tenantId)).get('bank')!.id;
        const keys = lineKeys(ba.id, parsed);
        const known = await tx.bankStatementLine.findMany({
          where: { bankAccountId: ba.id, lineKey: { in: keys.map((k) => new Uint8Array(k)) } },
          select: { lineKey: true },
        });
        const knownSet = new Set(known.map((k) => Buffer.from(k.lineKey).toString('hex')));
        const fresh = parsed
          .map((l, i) => ({ l, key: keys[i]! }))
          .filter((x) => !knownSet.has(x.key.toString('hex')));
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: ctx.tenantId,
          kind: 'other',
          scopeType: 'tenant',
          scopeId: null,
          buildingId: null,
          title: input.fileName.slice(0, 200),
          mimeType: 'text/csv',
          body: file,
        });
        const dates = parsed.map((l) => l.bookedOn).sort();
        const statement = await tx.bankStatement.create({
          data: {
            tenantId: ctx.tenantId,
            bankAccountId: ba.id,
            accountId: glAccountId,
            formatKey: format.key,
            fileName: input.fileName.slice(0, 200),
            fileDocumentId: doc.id,
            checksum: new Uint8Array(checksum),
            periodStart: dates.length ? asDate(dates[0]!) : null,
            periodEnd: dates.length ? asDate(dates[dates.length - 1]!) : null,
            lineCount: fresh.length,
            duplicateCount: parsed.length - fresh.length,
            importedBy: by(),
          },
        });
        if (fresh.length)
          await tx.bankStatementLine.createMany({
            data: fresh.map(({ l, key: k }, i) => ({
              tenantId: ctx.tenantId,
              statementId: statement.id,
              bankAccountId: ba.id,
              lineNo: i + 1,
              bookedOn: asDate(l.bookedOn),
              amount: l.amount,
              description: l.description,
              reference: l.reference,
              balance: l.balance,
              lineKey: new Uint8Array(k),
            })),
          });
        const lines = await tx.bankStatementLine.findMany({
          where: { statementId: statement.id },
          orderBy: { lineNo: 'asc' },
        });
        let autoMatched = 0;
        for (const line of lines) {
          const { auto } = rankCandidates(
            {
              bookedOn: day(line.bookedOn),
              amount: line.amount.toFixed(2),
              reference: line.reference,
              description: line.description,
            },
            await this.candidates(
              tx,
              ctx.tenantId,
              statement.bankAccountId,
              statement.accountId,
              line,
              window,
            ),
            window,
          );
          if (auto) {
            await this.setMatch(tx, line.id, auto.kind, auto.id, 'auto');
            autoMatched += 1;
          }
        }
        await this.audit.record(tx, {
          action: 'juristic.bank_statement_imported',
          tenantId: ctx.tenantId,
          subjectType: 'juristic.bank_statement',
          subjectId: statement.id,
          metadata: {
            format: format.key,
            lines: fresh.length,
            duplicates: parsed.length - fresh.length,
            autoMatched,
          },
        });
        await this.events.record(tx, {
          type: 'juristic.bank_statement.imported',
          aggregateType: 'bank_statement',
          aggregateId: statement.id,
          tenantId: ctx.tenantId,
          payload: { bankStatementId: statement.id, lines: fresh.length, autoMatched },
        });
        return {
          id: statement.id,
          replayed: false,
          imported: fresh.length,
          duplicates: parsed.length - fresh.length,
          autoMatched,
        };
      },
      { timeout: 120_000 },
    );
    return { ...out, statement: await this.statement(ctx, out.id) };
  }

  // ------------------------------------------------------------------------------------------- candidates

  /** Payments (in), paid expenses (out) and posted fund transfers of the statement's account, not matched yet. */
  private async candidates(
    tx: Tx,
    tenantId: string,
    bankAccountId: string,
    glAccountId: string,
    line: Pick<BankStatementLine, 'id' | 'bookedOn' | 'amount'>,
    window: number,
  ): Promise<MatchCandidate[]> {
    const on = day(line.bookedOn);
    const from = asDate(addCalendarDays(on, -window));
    const to = asDate(addCalendarDays(on, window + 1));
    const amount = D(line.amount);
    const taken = async (kind: BankLineMatch, ids: string[]) =>
      new Set(
        ids.length
          ? (
              await tx.bankStatementLine.findMany({
                where: { matchKind: kind, matchId: { in: ids }, NOT: { id: line.id } },
                select: { matchId: true },
              })
            ).map((m) => m.matchId!)
          : [],
      );
    const out: MatchCandidate[] = [];
    if (amount.gt(0)) {
      const payments = await tx.payment.findMany({
        where: {
          tenantId,
          confirmedAt: { not: null },
          reversedAt: null,
          method: { notIn: ['cash', 'offset'] },
          amount: amount.toFixed(2),
          paidAt: { gte: from, lt: to },
          OR: [{ bankAccountId }, { bankAccountId: null }],
        },
        include: { slipReview: { select: { transRef: true } } },
        take: 50,
      });
      const used = await taken(
        'payment',
        payments.map((p) => p.id),
      );
      for (const p of payments.filter((x) => !used.has(x.id)))
        out.push({
          kind: 'payment',
          id: p.id,
          amount: D(p.amount).toFixed(2),
          on: bangkokDate(p.paidAt),
          refs: [
            p.providerRef,
            p.slipReview?.transRef,
            // a hand-entered reference is kept in the notes ("<reference> · <note>")
            ...(p.notes ?? '').split(/[\s·,;]+/).filter((x) => x.length >= 6 && /\d/.test(x)),
          ].filter((r): r is string => Boolean(r)),
          label: `payment ${p.method}`,
        });
    } else {
      const expenses = await tx.expenseRequest.findMany({
        where: {
          tenantId,
          state: 'paid',
          paymentMethod: { in: ['bank_transfer', 'cheque'] },
          paidFromAccountId: glAccountId,
          netAmount: amount.negated().toFixed(2),
          paidOn: { gte: from, lt: to },
        },
        take: 50,
      });
      const used = await taken(
        'expense',
        expenses.map((e) => e.id),
      );
      for (const e of expenses.filter((x) => !used.has(x.id)))
        out.push({
          kind: 'expense',
          id: e.id,
          amount: D(e.netAmount).negated().toFixed(2),
          on: day(e.paidOn!),
          refs: [e.number, e.paymentReference].filter((r): r is string => Boolean(r)),
          label: `${e.number} ${e.payeeName}`,
        });
    }
    const transfers = await tx.fundTransfer.findMany({
      where: {
        tenantId,
        state: 'posted',
        amount: amount.abs().toFixed(2),
        transferOn: { gte: from, lt: to },
        OR: [{ counterAccountId: glAccountId }, { fund: { bankAccountId } }],
      },
      include: { fund: { select: { bankAccountId: true, name: true } } },
      take: 50,
    });
    const usedT = await taken(
      'fund_transfer',
      transfers.map((t) => t.id),
    );
    for (const t of transfers.filter((x) => !usedT.has(x.id))) {
      const signed = transferSigned(t, bankAccountId, glAccountId);
      if (!signed.eq(amount)) continue;
      out.push({
        kind: 'fund_transfer',
        id: t.id,
        amount: signed.toFixed(2),
        on: day(t.transferOn),
        refs: [t.reference].filter((r): r is string => Boolean(r)),
        label: `${t.direction} ${t.fund.name}`,
      });
    }
    return out;
  }

  private async setMatch(
    tx: Tx,
    lineId: string,
    kind: MatchKind,
    targetId: string,
    method: 'auto' | 'manual',
  ) {
    await tx.bankStatementLine.update({
      where: { id: lineId },
      data: {
        matchKind: kind,
        matchId: targetId,
        matchMethod: method,
        matchedBy: by(),
        matchedAt: this.clock.now(),
        ignoreReason: null,
        version: { increment: 1 },
      },
    });
  }

  // ------------------------------------------------------------------------------------------- reads

  async statements(ctx: TenantContext, q: { bankAccountId?: string; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.BankStatementWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.bankAccountId ? { bankAccountId: q.bankAccountId } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.bankStatement.findMany({
          where,
          include: STATEMENT_INCLUDE,
          orderBy: [{ importedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.bankStatement.count({ where }),
      ]);
      return { rows: await this.withCounts(tx, rows), total };
    });
  }

  async statement(ctx: TenantContext, id: string): Promise<BankStatementRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const s = this.found(
        await tx.bankStatement.findFirst({ where: this.own(ctx, { id }), include: STATEMENT_INCLUDE }),
      );
      return (await this.withCounts(tx, [s]))[0]!;
    });
  }

  async lines(
    ctx: TenantContext,
    q: { statementId?: string; state?: LineState; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      if (q.statementId)
        this.found(await tx.bankStatement.findFirst({ where: this.own(ctx, { id: q.statementId }) }));
      const state = q.state ?? 'unmatched';
      const where: Prisma.BankStatementLineWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.statementId ? { statementId: q.statementId } : {}),
        ...(state === 'unmatched'
          ? { matchKind: 'none' }
          : state === 'ignored'
            ? { matchKind: 'ignored' }
            : state === 'matched'
              ? { matchKind: { in: ['payment', 'expense', 'fund_transfer'] } }
              : {}),
      };
      const [rows, total] = await Promise.all([
        tx.bankStatementLine.findMany({
          where,
          orderBy: [{ bookedOn: 'asc' }, { statementId: 'asc' }, { lineNo: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.bankStatementLine.count({ where }),
      ]);
      return { rows, total };
    });
  }

  private async loadLine(tx: Tx, ctx: TenantContext, id: string) {
    return this.found(
      await tx.bankStatementLine.findFirst({ where: this.own(ctx, { id }), include: { statement: true } }),
    );
  }

  /** A line with its ranked suggestions (unmatched lines only). */
  async line(ctx: TenantContext, id: string) {
    const window = await this.windowDays(ctx.tenantId);
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const l = await this.loadLine(tx, ctx, id);
      const suggestions =
        l.matchKind === 'none'
          ? rankCandidates(
              {
                bookedOn: day(l.bookedOn),
                amount: l.amount.toFixed(2),
                reference: l.reference,
                description: l.description,
              },
              await this.candidates(tx, ctx.tenantId, l.bankAccountId, l.statement.accountId, l, window),
              window,
            ).suggestions
          : [];
      const { statement: _s, ...row } = l;
      return { ...row, suggestions };
    });
  }

  // ------------------------------------------------------------------------------------------- manual

  async match(ctx: TenantContext, id: string, input: { kind: MatchKind; targetId: string }) {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.bank_statement_line WHERE id = ${id}::uuid FOR UPDATE`;
      const l = await this.loadLine(tx, ctx, id);
      if (l.matchKind !== 'none')
        throw new DomainException('bank_statement.line_not_open', { params: { state: l.matchKind } });
      const amount = D(l.amount);
      // D-336 (J review A5): the same account and direction rules as the suggestions (`candidates`)
      const notThisAccount = () => new DomainException('bank_statement.account_mismatch');
      let expected: Decimal;
      if (input.kind === 'payment') {
        const p = await tx.payment.findFirst({
          where: { id: input.targetId, tenantId: ctx.tenantId, confirmedAt: { not: null }, reversedAt: null },
        });
        if (!p) throw new DomainException('http.not_found');
        if (
          p.method === 'cash' ||
          p.method === 'offset' ||
          (p.bankAccountId !== null && p.bankAccountId !== l.bankAccountId)
        )
          throw notThisAccount();
        expected = D(p.amount);
      } else if (input.kind === 'expense') {
        const e = await tx.expenseRequest.findFirst({
          where: { id: input.targetId, tenantId: ctx.tenantId, state: 'paid' },
        });
        if (!e) throw new DomainException('http.not_found');
        if (
          e.paidFromAccountId !== l.statement.accountId ||
          !(e.paymentMethod === 'bank_transfer' || e.paymentMethod === 'cheque')
        )
          throw notThisAccount();
        expected = D(e.netAmount).negated();
      } else {
        const t = await tx.fundTransfer.findFirst({
          where: { id: input.targetId, tenantId: ctx.tenantId, state: 'posted' },
          include: { fund: { select: { bankAccountId: true } } },
        });
        if (!t) throw new DomainException('http.not_found');
        if (t.counterAccountId !== l.statement.accountId && t.fund.bankAccountId !== l.bankAccountId)
          throw notThisAccount();
        expected = transferSigned(t, l.bankAccountId, l.statement.accountId);
        // the right amount the wrong way round (money into the fund is money out of the operating account)
        if (expected.negated().eq(amount)) throw notThisAccount();
      }
      if (!expected.eq(amount))
        throw new DomainException('bank_statement.amount_mismatch', {
          params: { line: amount.toFixed(2), target: expected.toFixed(2) },
        });
      const other = await tx.bankStatementLine.findFirst({
        where: { matchKind: input.kind, matchId: input.targetId },
      });
      if (other) throw new DomainException('bank_statement.already_matched');
      await this.setMatch(tx, id, input.kind, input.targetId, 'manual');
      await this.audit.record(tx, {
        action: 'juristic.bank_line_matched',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.bank_statement_line',
        subjectId: id,
        metadata: { kind: input.kind, targetId: input.targetId },
      });
      await this.events.record(tx, {
        type: 'juristic.bank_statement_line.changed',
        aggregateType: 'bank_statement_line',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { lineId: id, matchKind: input.kind, matchId: input.targetId },
      });
    });
    return this.line(ctx, id);
  }

  async ignore(ctx: TenantContext, id: string, reason: string) {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.bank_statement_line WHERE id = ${id}::uuid FOR UPDATE`;
      const l = await this.loadLine(tx, ctx, id);
      if (l.matchKind !== 'none')
        throw new DomainException('bank_statement.line_not_open', { params: { state: l.matchKind } });
      await tx.bankStatementLine.update({
        where: { id },
        data: {
          matchKind: 'ignored',
          matchMethod: 'manual',
          matchedBy: by(),
          matchedAt: this.clock.now(),
          ignoreReason: reason,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.bank_line_ignored',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.bank_statement_line',
        subjectId: id,
        metadata: { reason },
      });
      await this.events.record(tx, {
        type: 'juristic.bank_statement_line.changed',
        aggregateType: 'bank_statement_line',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { lineId: id, matchKind: 'ignored' },
      });
    });
    return this.line(ctx, id);
  }

  async unmatch(ctx: TenantContext, id: string) {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await tx.$queryRaw`SELECT id FROM juristic.bank_statement_line WHERE id = ${id}::uuid FOR UPDATE`;
      const l = await this.loadLine(tx, ctx, id);
      if (l.matchKind === 'none')
        throw new DomainException('bank_statement.line_not_open', { params: { state: l.matchKind } });
      await tx.bankStatementLine.update({
        where: { id },
        data: {
          matchKind: 'none',
          matchId: null,
          matchMethod: null,
          matchedBy: null,
          matchedAt: null,
          ignoreReason: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.bank_line_unmatched',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.bank_statement_line',
        subjectId: id,
        metadata: { was: l.matchKind, matchId: l.matchId },
      });
      await this.events.record(tx, {
        type: 'juristic.bank_statement_line.changed',
        aggregateType: 'bank_statement_line',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { lineId: id, matchKind: 'none' },
      });
    });
    return this.line(ctx, id);
  }
}

/**
 * A posted fund transfer as it shows on a bank account's statement: + on the side the money goes to. On the fund's
 * own bank account (not the counter account) `in` is money in; on the counter account `in` (to the fund) is money out.
 */
function transferSigned(
  t: {
    direction: string;
    amount: { toString(): string };
    counterAccountId: string;
    fund: { bankAccountId: string | null };
  },
  bankAccountId: string,
  glAccountId: string,
): Decimal {
  const onFundSide = t.fund.bankAccountId === bankAccountId && t.counterAccountId !== glAccountId;
  return (t.direction === 'in') === onFundSide ? D(t.amount) : D(t.amount).negated();
}
