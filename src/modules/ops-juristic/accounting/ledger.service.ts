import { isJuristicTenantType } from '@collective/asset-core';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Account,
  type AccountType,
  type FundKind,
  type Journal,
  type JournalSource,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { chartTemplate, defaultFundName } from './chart-templates';
import {
  type AccountKey,
  allocateCredit,
  creditNoteLegs,
  invoiceLegs,
  isRevenueKind,
  type Leg,
  paymentLegs,
  recognitionLegs,
  refundLegs,
  reversalLegs,
  toLines,
} from './posting';

/**
 * An import's opening-balance invoice (D-332): principal and surcharge brought forward are accumulated surplus (the
 * legacy books earned them), a fund contribution brought forward is the fund's equity.
 */
const openingKind = (importJobId: string | null, kind: string, sourceType: string): string =>
  importJobId === null
    ? kind
    : kind === 'opening_balance' && sourceType === 'fund'
      ? 'fund'
      : kind === 'opening_balance' || kind === 'late_fee'
        ? 'opening_balance'
        : kind;

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export interface PostInput {
  tenantId: string;
  buildingId: string;
  postedOn: string;
  sourceType: JournalSource;
  sourceId: string | null;
  memo: string;
  legs: readonly Leg[];
  resolutionId?: string | null;
  fundId?: string | null;
  reversesJournalId?: string | null;
}

export const JOURNAL_INCLUDE = {
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      account: { select: { id: true, code: true, nameTh: true, nameEn: true, type: true } },
      unit: { select: { id: true, unitNo: true } },
      party: { select: { id: true, displayName: true } },
    },
  },
  building: { select: { id: true, name: true } },
  reversedBy: { select: { id: true } },
} as const satisfies Prisma.JournalInclude;
export type JournalRow = Prisma.JournalGetPayload<{ include: typeof JOURNAL_INCLUDE }>;

export interface FundAccounts {
  fundId: string;
  bankAccountId: string;
  equityAccountId: string;
}

/**
 * The light GL of juristic tenants (D-312 = D-J11, D-329): the chart of accounts (copied once from the legal form's
 * template, then the tenant's own), double-entry journals (balanced and immutable in the database), and the posting
 * subscriber `juristic-ledger` that turns billing and payment events of **juristic tenants** into journals —
 * invoice issued (receivable / income, unearned for advance cycles, fund equity for fund contributions), void
 * (reversal), credit / debit notes, payments (bank or cash / receivable, WHT the payer withheld), reversals, refunds.
 * Every automatic journal is keyed by its source (UQ), so posting is idempotent: the job `juristic-ledger` back-posts
 * whatever has no journal yet (existing data on the first run) and recognises advance-billed revenue month by month
 * (`juristic.revenue_schedule.recognised_at`). Other tenant types post nothing.
 */
@Injectable()
export class LedgerService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'juristic-ledger';
  readonly eventTypes = [
    'invoice.issued',
    'invoice.voided',
    'credit_note.issued',
    'debit_note.issued',
    'payment.confirmed',
    'payment.reversed',
    'payment.refunded',
  ] as const;
  readonly timeoutMs = 30_000;
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  today(): string {
    return bangkokDate(this.clock.now());
  }

  async isJuristic(tx: Tx, tenantId: string): Promise<boolean> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { type: true } });
    return isJuristicTenantType(t?.type);
  }

  /** 404 for tenants that are not juristic (the accounting surface exists only for them). */
  async assertJuristic(tx: Tx, tenantId: string): Promise<void> {
    if (!(await this.isJuristic(tx, tenantId))) throw new DomainException('http.not_found');
  }

  // ------------------------------------------------------------------------------------------- chart

  /** The tenant's chart, copied from the template of its oldest juristic building's legal form on first use. */
  async ensureChart(tx: Tx, tenantId: string): Promise<Account[]> {
    const existing = await tx.account.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
    if (existing.some((a) => a.role === 'receivable' && !a.fundId)) return existing;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`juristic-chart:${tenantId}`}))`;
    const again = await tx.account.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
    if (again.some((a) => a.role === 'receivable' && !a.fundId)) return again;
    const [b] = await tx.$queryRaw<{ legal_form: string | null }[]>`
      SELECT legal_form::text AS legal_form FROM core.building
       WHERE (operator_tenant_id = ${tenantId}::uuid OR owner_tenant_id = ${tenantId}::uuid) AND legal_form IS NOT NULL
       ORDER BY created_at, id LIMIT 1`;
    const template = chartTemplate(b?.legal_form);
    const taken = new Set(again.map((a) => a.code));
    const roles = new Set(again.map((a) => a.role));
    const data = template.accounts
      .filter((a) => !roles.has(a.role))
      .map((a) => ({
        tenantId,
        code: taken.has(a.code) ? `${a.code}-S` : a.code,
        nameTh: a.nameTh,
        nameEn: a.nameEn,
        type: a.type,
        role: a.role,
        isSystem: true,
        sourceTemplateKey: template.key,
        createdBy: by(),
      }));
    if (data.length) await tx.account.createMany({ data });
    return tx.account.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
  }

  async roleAccounts(tx: Tx, tenantId: string): Promise<Map<string, Account>> {
    const all = await this.ensureChart(tx, tenantId);
    return new Map(all.filter((a) => a.role && !a.fundId).map((a) => [a.role!, a]));
  }

  private async nextCode(tx: Tx, tenantId: string, prefix: string): Promise<string> {
    const rows = await tx.account.findMany({
      where: { tenantId, code: { startsWith: `${prefix}-` } },
      select: { code: true },
    });
    const used = new Set(rows.map((r) => r.code));
    for (let n = 1; n < 1000; n += 1) {
      const code = `${prefix}-${String(n).padStart(2, '0')}`;
      if (!used.has(code)) return code;
    }
    throw new Error(`no free account code under ${prefix}`);
  }

  /** A new fund with its two accounts (fund bank 1160-NN, fund equity 3110-NN). */
  async createFund(
    tx: Tx,
    input: {
      tenantId: string;
      buildingId: string;
      kind: FundKind;
      name: string;
      bankAccountId?: string | null;
    },
  ): Promise<FundAccounts> {
    await this.ensureChart(tx, input.tenantId);
    const fund = await tx.fund.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        kind: input.kind,
        name: input.name,
        bankAccountId: input.bankAccountId ?? null,
        createdBy: by(),
      },
    });
    const bank = await tx.account.create({
      data: {
        tenantId: input.tenantId,
        code: await this.nextCode(tx, input.tenantId, '1160'),
        nameTh: `เงินฝากธนาคาร – ${input.name}`.slice(0, 200),
        nameEn: `Bank — ${input.name}`.slice(0, 200),
        type: 'asset',
        role: 'fund_bank',
        fundId: fund.id,
        bankAccountId: input.bankAccountId ?? null,
        isSystem: true,
        createdBy: by(),
      },
    });
    const equity = await tx.account.create({
      data: {
        tenantId: input.tenantId,
        code: await this.nextCode(tx, input.tenantId, '3110'),
        nameTh: input.name.slice(0, 200),
        nameEn: `Fund — ${input.name}`.slice(0, 200),
        type: 'equity',
        role: 'fund_equity',
        fundId: fund.id,
        isSystem: true,
        createdBy: by(),
      },
    });
    return { fundId: fund.id, bankAccountId: bank.id, equityAccountId: equity.id };
  }

  async fundAccounts(tx: Tx, fundId: string): Promise<FundAccounts> {
    const accounts = await tx.account.findMany({ where: { fundId } });
    const bank = accounts.find((a) => a.role === 'fund_bank');
    const equity = accounts.find((a) => a.role === 'fund_equity');
    if (!bank || !equity) throw new Error(`fund ${fundId} has no accounts`);
    return { fundId, bankAccountId: bank.id, equityAccountId: equity.id };
  }

  /** The building's sinking fund (its first active one); created when the first contribution is posted. */
  async defaultFund(tx: Tx, tenantId: string, buildingId: string): Promise<FundAccounts> {
    const find = () =>
      tx.fund.findFirst({
        where: { tenantId, buildingId, kind: 'sinking', isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    let fund = await find();
    if (!fund) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`juristic-fund:${buildingId}`}))`;
      fund = await find();
      if (!fund) {
        const b = await tx.building.findUniqueOrThrow({
          where: { id: buildingId },
          select: { legalForm: true },
        });
        return this.createFund(tx, {
          tenantId,
          buildingId,
          kind: 'sinking',
          name: defaultFundName(b.legalForm),
        });
      }
    }
    return this.fundAccounts(tx, fund.id);
  }

  /** The GL account of a tenant bank account (linked by `bank_account_id`), else the operating bank account. */
  async bankKey(tx: Tx, tenantId: string, bankAccountId: string | null | undefined): Promise<AccountKey> {
    if (bankAccountId) {
      const a = await tx.account.findFirst({
        where: { tenantId, bankAccountId, isActive: true, fundId: null },
        orderBy: { code: 'asc' },
      });
      if (a) return `id:${a.id}`;
    }
    return 'bank';
  }

  // ------------------------------------------------------------------------------------------- post

  /**
   * Posts one journal (idempotent per automatic source: the existing journal is returned). Accounts named by role are
   * resolved in the tenant's chart; fund roles in the journal's fund (the building's sinking fund by default).
   */
  async post(tx: Tx, input: PostInput): Promise<Journal> {
    if (input.sourceId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal:${input.sourceType}:${input.sourceId}`}))`;
      const existing = await tx.journal.findFirst({
        where: { tenantId: input.tenantId, sourceType: input.sourceType, sourceId: input.sourceId },
      });
      if (existing) return existing;
    }
    const lines = toLines(input.legs);
    if (lines.length < 2) throw new Error(`journal ${input.sourceType} needs two sides`);
    const roles = await this.roleAccounts(tx, input.tenantId);
    let fund: FundAccounts | null = null;
    const needsFund = lines.some((l) => l.account === 'fund_bank' || l.account === 'fund_equity');
    if (needsFund)
      fund = input.fundId
        ? await this.fundAccounts(tx, input.fundId)
        : await this.defaultFund(tx, input.tenantId, input.buildingId);
    const resolve = (key: AccountKey): string => {
      if (key.startsWith('id:')) return key.slice(3);
      if (key === 'fund_bank') return fund!.bankAccountId;
      if (key === 'fund_equity') return fund!.equityAccountId;
      const a = roles.get(key);
      if (!a) throw new Error(`account role ${key} missing in the chart of ${input.tenantId}`);
      return a.id;
    };
    const journal = await tx.journal.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        postedOn: asDate(input.postedOn),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo.slice(0, 500),
        reversesJournalId: input.reversesJournalId ?? null,
        resolutionId: input.resolutionId ?? null,
        fundId: input.fundId ?? fund?.fundId ?? null,
        createdBy: by(),
      },
    });
    await tx.journalLine.createMany({
      data: lines.map((l, i) => ({
        tenantId: input.tenantId,
        journalId: journal.id,
        lineNo: i + 1,
        accountId: resolve(l.account),
        debit: l.debit,
        credit: l.credit,
        unitId: l.unitId,
        partyId: l.partyId,
        memo: l.memo,
      })),
    });
    return journal;
  }

  /** The exact opposite of a journal, once (UQ on `reverses_journal_id`). */
  async reverseIn(
    tx: Tx,
    journalId: string,
    input: { postedOn: string; memo: string; sourceType?: JournalSource },
  ): Promise<Journal> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal-reversal:${journalId}`}))`;
    const done = await tx.journal.findFirst({ where: { reversesJournalId: journalId } });
    if (done) return done;
    const j = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { lines: true } });
    return this.post(tx, {
      tenantId: j.tenantId,
      buildingId: j.buildingId,
      postedOn: input.postedOn < day(j.postedOn) ? day(j.postedOn) : input.postedOn,
      sourceType: 'reversal',
      sourceId: j.id,
      memo: input.memo,
      legs: reversalLegs(j.lines),
      reversesJournalId: j.id,
      resolutionId: j.resolutionId,
      fundId: j.fundId,
    });
  }

  // ------------------------------------------------------------------------------------------- subscriber

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (!event.tenantId || !(await this.isJuristic(tx, event.tenantId))) return;
    const p = event.payload;
    switch (event.type) {
      case 'invoice.issued':
        await this.postInvoice(tx, p.invoiceId as string);
        return;
      case 'invoice.voided':
        await this.postInvoiceVoid(tx, p.invoiceId as string);
        return;
      case 'credit_note.issued':
        await this.postCreditNote(tx, p.noteId as string);
        return;
      case 'debit_note.issued':
        await this.postDebitNote(tx, p.noteId as string);
        return;
      case 'payment.confirmed':
        await this.postPayment(tx, p.paymentId as string);
        return;
      case 'payment.reversed':
        await this.postPaymentReversal(tx, p.paymentId as string);
        return;
      case 'payment.refunded':
        await this.postRefund(tx, p.refundId as string);
        return;
      default:
        return;
    }
  }

  async postInvoice(tx: Tx, invoiceId: string): Promise<Journal | null> {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { lineNo: 'asc' }, include: { revenueSchedule: { select: { id: true } } } },
      },
    });
    if (!inv?.issuedAt || inv.status === 'draft') return null;
    return this.post(tx, {
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      postedOn: bangkokDate(inv.issuedAt),
      sourceType: 'invoice',
      sourceId: inv.id,
      memo: `ใบแจ้งหนี้ ${inv.number ?? inv.id}`,
      legs: invoiceLegs({
        total: inv.total,
        vatAmount: inv.vatAmount,
        unitId: inv.unitId,
        partyId: inv.billedPartyId,
        lines: inv.lines.map((l) => ({
          kind: openingKind(inv.importJobId, l.lineKind, l.sourceType),
          amount: l.amount,
          scheduled: l.revenueSchedule.length > 0,
        })),
      }),
    });
  }

  /** A void reverses the invoice journal and every recognition of its lines; months not yet earned never will be. */
  async postInvoiceVoid(tx: Tx, invoiceId: string): Promise<void> {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.status !== 'void') return;
    const original = (await this.postInvoice(tx, invoiceId)) ?? null;
    const on = inv.voidedAt ? bangkokDate(inv.voidedAt) : this.today();
    if (original)
      await this.reverseIn(tx, original.id, {
        postedOn: on,
        memo: `ยกเลิกใบแจ้งหนี้ ${inv.number ?? inv.id}`,
      });
    const rows = await tx.revenueSchedule.findMany({
      where: { invoiceLine: { invoiceId } },
      orderBy: { month: 'asc' },
    });
    for (const r of rows) {
      if (r.journalId)
        await this.reverseIn(tx, r.journalId, {
          postedOn: on,
          memo: `ยกเลิกการรับรู้รายได้ ${inv.number ?? ''}`,
        });
      if (!r.recognisedAt)
        await tx.revenueSchedule.update({
          where: { id: r.id },
          data: { recognisedAt: this.clock.now(), recognisedAmount: '0.00' },
        });
    }
  }

  async postCreditNote(tx: Tx, noteId: string): Promise<Journal | null> {
    const note = await tx.creditNote.findUnique({
      where: { id: noteId },
      include: {
        invoice: true,
        lines: { orderBy: { lineNo: 'asc' }, include: { refInvoiceLine: { select: { sourceType: true } } } },
      },
    });
    if (!note || note.status === 'void') return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal:credit_note:${note.id}`}))`;
    const existing = await tx.journal.findFirst({
      where: { tenantId: note.tenantId, sourceType: 'credit_note', sourceId: note.id },
    });
    if (existing) return existing;
    const lines = [];
    for (const l of note.lines) {
      let fromUnearned = '0.00';
      if (
        note.reason !== 'payment_plan' &&
        l.refInvoiceLineId &&
        isRevenueKind(l.lineKind) &&
        D(l.amount).gt(0)
      ) {
        const rows = await tx.revenueSchedule.findMany({ where: { invoiceLineId: l.refInvoiceLineId } });
        if (rows.length) {
          const a = allocateCredit(
            rows.map((r) => ({
              id: r.id,
              month: day(r.month),
              amount: r.amount,
              credited: r.creditedAmount,
              recognised: r.recognisedAt !== null,
            })),
            l.amount,
          );
          for (const u of a.updates)
            await tx.revenueSchedule.update({ where: { id: u.id }, data: { creditedAmount: u.credited } });
          fromUnearned = a.fromUnearned;
        }
      }
      lines.push({
        kind: openingKind(note.invoice.importJobId, l.lineKind, l.refInvoiceLine?.sourceType ?? ''),
        amount: l.amount,
        fromUnearned,
      });
    }
    return this.post(tx, {
      tenantId: note.tenantId,
      buildingId: note.buildingId,
      postedOn: bangkokDate(note.issuedAt),
      sourceType: 'credit_note',
      sourceId: note.id,
      memo: `ใบลดหนี้ ${note.number}`,
      legs: creditNoteLegs({
        reason: note.reason,
        total: note.total,
        vatAmount: note.vatAmount,
        unitId: note.invoice.unitId,
        partyId: note.invoice.billedPartyId,
        lines,
      }),
    });
  }

  async postDebitNote(tx: Tx, noteId: string): Promise<Journal | null> {
    const note = await tx.debitNote.findUnique({
      where: { id: noteId },
      include: { invoice: true, lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!note || note.status === 'void') return null;
    return this.post(tx, {
      tenantId: note.tenantId,
      buildingId: note.buildingId,
      postedOn: bangkokDate(note.issuedAt),
      sourceType: 'debit_note',
      sourceId: note.id,
      memo: `ใบเพิ่มหนี้ ${note.number}`,
      legs: invoiceLegs({
        total: note.total,
        vatAmount: note.vatAmount,
        unitId: note.invoice.unitId,
        partyId: note.invoice.billedPartyId,
        lines: note.lines.map((l) => ({ kind: l.lineKind, amount: l.amount })),
      }),
    });
  }

  async postPayment(tx: Tx, paymentId: string): Promise<Journal | null> {
    const pay = await tx.payment.findUnique({ where: { id: paymentId } });
    // a use of the payer's credit moves no money (counted when it came in)
    if (!pay?.confirmedAt || !pay.payerPartyId || pay.method === 'offset') return null;
    return this.post(tx, {
      tenantId: pay.tenantId,
      buildingId: pay.buildingId,
      postedOn: bangkokDate(pay.paidAt),
      sourceType: 'payment',
      sourceId: pay.id,
      memo: `รับชำระ ${pay.method}${pay.providerRef ? ` ${pay.providerRef}` : ''}`,
      legs: paymentLegs({
        amount: pay.amount,
        wht: pay.whtAmount,
        into: pay.method === 'cash' ? 'cash' : await this.bankKey(tx, pay.tenantId, pay.bankAccountId),
        unitId: pay.unitId,
        partyId: pay.payerPartyId,
      }),
    });
  }

  async postPaymentReversal(tx: Tx, paymentId: string): Promise<Journal | null> {
    const pay = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!pay?.reversedAt) return null;
    const original = await this.postPayment(tx, paymentId);
    if (!original) return null;
    return this.reverseIn(tx, original.id, {
      postedOn: bangkokDate(pay.reversedAt),
      memo: `กลับรายการรับชำระ${pay.reverseReason ? ` (${pay.reverseReason})` : ''}`,
    });
  }

  async postRefund(tx: Tx, refundId: string): Promise<Journal | null> {
    const r = await tx.refund.findUnique({ where: { id: refundId } });
    if (!r) return null;
    const from: AccountKey =
      r.method === 'cash'
        ? 'cash'
        : r.method === 'offset'
          ? 'deposits'
          : await this.bankKey(tx, r.tenantId, null);
    return this.post(tx, {
      tenantId: r.tenantId,
      buildingId: r.buildingId,
      postedOn: bangkokDate(r.refundedAt),
      sourceType: 'refund',
      sourceId: r.id,
      memo: 'คืนเงินเครดิต',
      legs: refundLegs({ amount: r.amount, from, unitId: r.unitId, partyId: r.partyId }),
    });
  }

  // ------------------------------------------------------------------------------------------- recognition

  /**
   * Recognises every due revenue-schedule row of a tenant (month ≤ this Bangkok month): Dr unearned / Cr income of the
   * line's kind for `amount − credited_amount`, posted on max(month, issue day); fund lines (equity, not revenue) and
   * fully credited rows are marked recognised without a journal. Fills `recognised_at`, `recognised_amount`,
   * `journal_id`. Returns the rows recognised.
   */
  async recognise(tx: Tx, tenantId: string): Promise<number> {
    const month = `${this.today().slice(0, 7)}-01`;
    const rows = await tx.revenueSchedule.findMany({
      where: { tenantId, recognisedAt: null, month: { lte: asDate(month) } },
      include: { invoiceLine: { include: { invoice: true } } },
      orderBy: [{ month: 'asc' }, { id: 'asc' }],
      take: 2000,
    });
    let n = 0;
    for (const r of rows) {
      const inv = r.invoiceLine.invoice;
      if (inv.status === 'draft' || !inv.issuedAt) continue;
      // the invoice journal first (it put the amount on unearned)
      if (inv.status !== 'void') await this.postInvoice(tx, inv.id);
      const amount = D(r.amount).minus(D(r.creditedAmount));
      let journalId: string | null = null;
      if (inv.status !== 'void' && isRevenueKind(r.invoiceLine.lineKind) && !amount.eq(0)) {
        const issued = bangkokDate(inv.issuedAt);
        const j = await this.post(tx, {
          tenantId,
          buildingId: inv.buildingId,
          postedOn: day(r.month) < issued ? issued : day(r.month),
          sourceType: 'revenue_recognition',
          sourceId: r.id,
          memo: `รับรู้รายได้ ${day(r.month).slice(0, 7)} ${inv.number ?? ''}`.trim(),
          legs: recognitionLegs({
            kind: r.invoiceLine.lineKind,
            amount,
            unitId: inv.unitId,
            partyId: inv.billedPartyId,
          }),
        });
        journalId = j.id;
      }
      await tx.revenueSchedule.update({
        where: { id: r.id },
        data: {
          recognisedAt: this.clock.now(),
          recognisedAmount: inv.status === 'void' ? '0.00' : amount.toFixed(2),
          journalId,
        },
      });
      n += 1;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------- job

  /**
   * Job `juristic-ledger` (hourly; idempotent): for every juristic tenant, back-posts invoices, voids, credit / debit
   * notes, payments, reversals and refunds that have no journal yet (existing data on the first run), then recognises
   * the due revenue-schedule rows. One transaction per source document.
   */
  async run(): Promise<{ posted: number; recognised: number }> {
    return RequestContext.run({ actor: systemActor('juristic-ledger') }, async () => {
      const out = { posted: 0, recognised: 0 };
      const tenants = await this.db.platform(
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM core.tenant WHERE type::text IN ('juristic', 'condo_juristic') ORDER BY id`,
      );
      for (const t of tenants) {
        try {
          out.posted += await this.backfill(t.id);
          out.recognised += await this.db.tenant(
            systemTenantContext(t.id),
            (tx) => this.recognise(tx, t.id),
            {
              timeout: 120_000,
            },
          );
        } catch (error) {
          this.logger.error(`juristic ledger ${t.id}: ${(error as Error).message}`);
        }
      }
      return out;
    });
  }

  /** Missing journals of one tenant, oldest first. */
  async backfill(tenantId: string): Promise<number> {
    const missing = await this.db.platform(
      (tx) =>
        tx.$queryRaw<{ kind: string; id: string; at: Date }[]>`
        SELECT * FROM (
          SELECT 'invoice' AS kind, i.id, i.issued_at AS at FROM ops.invoice i
           WHERE i.tenant_id = ${tenantId}::uuid AND i.issued_at IS NOT NULL AND i.status <> 'draft'
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = i.tenant_id AND j.source_type = 'invoice' AND j.source_id = i.id)
          UNION ALL
          SELECT 'invoice_void', i.id, i.voided_at FROM ops.invoice i
           WHERE i.tenant_id = ${tenantId}::uuid AND i.status = 'void' AND i.issued_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = i.tenant_id AND j.source_type = 'invoice' AND j.source_id = i.id
                           AND NOT EXISTS (SELECT 1 FROM juristic.journal r WHERE r.reverses_journal_id = j.id))
          UNION ALL
          SELECT 'credit_note', n.id, n.issued_at FROM ops.credit_note n
           WHERE n.tenant_id = ${tenantId}::uuid AND n.status <> 'void'
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = n.tenant_id AND j.source_type = 'credit_note' AND j.source_id = n.id)
          UNION ALL
          SELECT 'debit_note', n.id, n.issued_at FROM ops.debit_note n
           WHERE n.tenant_id = ${tenantId}::uuid AND n.status <> 'void'
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = n.tenant_id AND j.source_type = 'debit_note' AND j.source_id = n.id)
          UNION ALL
          SELECT 'payment', p.id, p.paid_at FROM ops.payment p
           WHERE p.tenant_id = ${tenantId}::uuid AND p.confirmed_at IS NOT NULL AND p.payer_party_id IS NOT NULL AND p.method <> 'offset'
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = p.tenant_id AND j.source_type = 'payment' AND j.source_id = p.id)
          UNION ALL
          SELECT 'payment_reversal', p.id, p.reversed_at FROM ops.payment p
           WHERE p.tenant_id = ${tenantId}::uuid AND p.reversed_at IS NOT NULL AND p.confirmed_at IS NOT NULL
             AND p.payer_party_id IS NOT NULL AND p.method <> 'offset'
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j JOIN juristic.journal r ON r.reverses_journal_id = j.id
                              WHERE j.tenant_id = p.tenant_id AND j.source_type = 'payment' AND j.source_id = p.id)
          UNION ALL
          SELECT 'refund', r.id, r.refunded_at FROM ops.refund r
           WHERE r.tenant_id = ${tenantId}::uuid
             AND NOT EXISTS (SELECT 1 FROM juristic.journal j WHERE j.tenant_id = r.tenant_id AND j.source_type = 'refund' AND j.source_id = r.id)
        ) m ORDER BY at, kind, id LIMIT 5000`,
    );
    let n = 0;
    for (const m of missing) {
      try {
        await this.db.tenant(systemTenantContext(tenantId), async (tx) => {
          switch (m.kind) {
            case 'invoice':
              await this.postInvoice(tx, m.id);
              await this.postInvoiceVoid(tx, m.id);
              break;
            case 'invoice_void':
              await this.postInvoiceVoid(tx, m.id);
              break;
            case 'credit_note':
              await this.postCreditNote(tx, m.id);
              break;
            case 'debit_note':
              await this.postDebitNote(tx, m.id);
              break;
            case 'payment':
              await this.postPayment(tx, m.id);
              break;
            case 'payment_reversal':
              await this.postPaymentReversal(tx, m.id);
              break;
            case 'refund':
              await this.postRefund(tx, m.id);
              break;
          }
        });
        n += 1;
      } catch (error) {
        this.logger.error(`juristic ledger back-post ${m.kind} ${m.id}: ${(error as Error).message}`);
      }
    }
    return n;
  }

  /** `POST /v1/owner/juristic/ledger/actions/back-post`: the job for one tenant, on demand. */
  async backPost(ctx: TenantContext): Promise<{ posted: number; recognised: number }> {
    await this.db.tenant(ctx, (tx) => this.assertJuristic(tx, ctx.tenantId));
    const posted = await this.backfill(ctx.tenantId);
    const recognised = await this.db.tenant(ctx, (tx) => this.recognise(tx, ctx.tenantId), {
      timeout: 120_000,
    });
    await this.db.tenant(ctx, (tx) =>
      this.audit.record(tx, {
        action: 'juristic.ledger_back_posted',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.journal',
        subjectId: ctx.tenantId,
        metadata: { posted, recognised },
      }),
    );
    return { posted, recognised };
  }

  // ------------------------------------------------------------------------------------------- accounts API

  async accounts(ctx: TenantContext, q: { type?: AccountType; active?: boolean }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      await this.ensureChart(tx, ctx.tenantId);
      const rows = await tx.account.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(q.type ? { type: q.type } : {}),
          ...(q.active === undefined ? {} : { isActive: q.active }),
        },
        orderBy: { code: 'asc' },
      });
      const used = await tx.journalLine.groupBy({
        by: ['accountId'],
        where: { tenantId: ctx.tenantId },
        _count: { _all: true },
      });
      const usedSet = new Set(used.map((u) => u.accountId));
      return rows.map((a) => ({ ...a, used: usedSet.has(a.id) }));
    });
  }

  async createAccount(
    ctx: TenantContext,
    input: { code: string; nameTh: string; nameEn: string; type: AccountType; bankAccountId?: string | null },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      await this.ensureChart(tx, ctx.tenantId);
      if (await tx.account.findFirst({ where: { tenantId: ctx.tenantId, code: input.code } }))
        throw new DomainException('account.code_taken', { params: { code: input.code } });
      if (input.bankAccountId) {
        if (input.type !== 'asset')
          throw invalid('bankAccountId', 'asset_only', 'only an asset account holds a bank account');
        const ba = await tx.tenantBankAccount.findFirst({
          where: { id: input.bankAccountId, tenantId: ctx.tenantId },
        });
        if (!ba) throw new DomainException('http.not_found');
      }
      const a = await tx.account.create({
        data: {
          tenantId: ctx.tenantId,
          ...input,
          bankAccountId: input.bankAccountId ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.account_created',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.account',
        subjectId: a.id,
        metadata: { code: a.code, type: a.type },
      });
      await this.events.record(tx, {
        type: 'juristic.account.changed',
        aggregateType: 'account',
        aggregateId: a.id,
        tenantId: ctx.tenantId,
        payload: { accountId: a.id, change: 'created' },
      });
      return { ...a, used: false };
    });
  }

  async updateAccount(
    ctx: TenantContext,
    id: string,
    input: {
      nameTh?: string;
      nameEn?: string;
      isActive?: boolean;
      bankAccountId?: string | null;
      version?: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      const a = this.found(await tx.account.findFirst({ where: this.own(ctx, { id }) }));
      if (input.version !== undefined && input.version !== a.version)
        throw new DomainException('concurrency.stale');
      if (input.isActive === false && (a.isSystem || a.role))
        throw new DomainException('account.system', { params: { code: a.code } });
      if (input.bankAccountId !== undefined && input.bankAccountId !== null) {
        if (a.type !== 'asset' || (a.role && a.role !== 'bank' && a.role !== 'fund_bank'))
          throw invalid('bankAccountId', 'asset_only', 'only a bank account holds a bank account');
        const ba = await tx.tenantBankAccount.findFirst({
          where: { id: input.bankAccountId, tenantId: ctx.tenantId },
        });
        if (!ba) throw new DomainException('http.not_found');
      }
      const updated = await tx.account.update({
        where: { id },
        data: {
          ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}),
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.bankAccountId !== undefined ? { bankAccountId: input.bankAccountId } : {}),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.account_updated',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.account',
        subjectId: id,
        metadata: { code: a.code, changes: Object.keys(input).filter((k) => k !== 'version') },
      });
      await this.events.record(tx, {
        type: 'juristic.account.changed',
        aggregateType: 'account',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { accountId: id, change: 'updated' },
      });
      const used = await tx.journalLine.count({ where: { accountId: id } });
      return { ...updated, used: used > 0 };
    });
  }

  // ------------------------------------------------------------------------------------------- journals API

  private async ownBuilding(tx: Tx, ctx: TenantContext, buildingId: string) {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
      select: { id: true, name: true, legalForm: true },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
      throw new DomainException('http.not_found');
    return b;
  }

  async journals(
    ctx: TenantContext,
    q: {
      buildingId?: string;
      from?: string;
      to?: string;
      sourceType?: JournalSource;
      accountId?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      if (q.buildingId) await this.ownBuilding(tx, ctx, q.buildingId);
      const where: Prisma.JournalWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
        ...(q.sourceType ? { sourceType: q.sourceType } : {}),
        ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
        ...(q.from || q.to
          ? {
              postedOn: {
                ...(q.from ? { gte: asDate(q.from) } : {}),
                ...(q.to ? { lte: asDate(q.to) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.journal.findMany({
          where,
          include: JOURNAL_INCLUDE,
          orderBy: [{ postedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.journal.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async journal(ctx: TenantContext, id: string): Promise<JournalRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      const j = this.found(
        await tx.journal.findFirst({ where: this.own(ctx, { id }), include: JOURNAL_INCLUDE }),
      );
      if (ctx.buildingIds && !ctx.buildingIds.includes(j.buildingId))
        throw new DomainException('http.not_found');
      return j;
    });
  }

  /**
   * `POST /v1/owner/juristic/journals`: a manual journal (opening balances, WHT remittance, corrections) — balanced,
   * active accounts of the tenant, posted on a date not in the future; a credit to a fund bank account needs an
   * adopted resolution of the building (also enforced by the database).
   */
  async createManual(
    ctx: TenantContext,
    input: {
      buildingId: string;
      postedOn: string;
      memo: string;
      opening?: boolean;
      resolutionId?: string | null;
      lines: {
        accountId: string;
        debit?: string | null;
        credit?: string | null;
        unitId?: string | null;
        memo?: string | null;
      }[];
    },
  ): Promise<JournalRow> {
    if (input.postedOn > this.today()) throw invalid('postedOn', 'future', 'not in the future');
    if (input.lines.length < 2 || input.lines.length > 200) throw invalid('lines', 'count', '2–200 lines');
    const legs: Leg[] = input.lines.map((l, i) => {
      const d = D(l.debit ?? 0);
      const c = D(l.credit ?? 0);
      if (d.lt(0) || c.lt(0) || d.gt(0) === c.gt(0) || d.decimalPlaces() > 2 || c.decimalPlaces() > 2)
        throw invalid(`lines[${i}]`, 'side', 'a debit or a credit, positive, 2 decimals');
      return {
        account: `id:${l.accountId}`,
        amount: d.minus(c),
        unitId: l.unitId ?? null,
        memo: l.memo ?? null,
      };
    });
    const debit = input.lines.reduce((s, l) => s.plus(D(l.debit ?? 0)), D(0));
    const credit = input.lines.reduce((s, l) => s.plus(D(l.credit ?? 0)), D(0));
    if (!debit.eq(credit))
      throw new DomainException('journal.unbalanced', {
        params: { debit: debit.toFixed(2), credit: credit.toFixed(2) },
      });
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      await this.ownBuilding(tx, ctx, input.buildingId);
      await this.ensureChart(tx, ctx.tenantId);
      const ids = [...new Set(input.lines.map((l) => l.accountId))];
      const accounts = await tx.account.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId } });
      if (accounts.length !== ids.length) throw new DomainException('http.not_found');
      if (accounts.some((a) => !a.isActive)) throw invalid('lines', 'inactive', 'an account is inactive');
      const units = [...new Set(input.lines.map((l) => l.unitId).filter((u): u is string => Boolean(u)))];
      if (units.length) {
        const found = await tx.unit.count({ where: { id: { in: units }, buildingId: input.buildingId } });
        if (found !== units.length) throw new DomainException('http.not_found');
      }
      const fundCredit = accounts.filter((a) => a.role === 'fund_bank');
      const fundIds = [...new Set(accounts.filter((a) => a.fundId).map((a) => a.fundId!))];
      if (fundIds.length > 1) throw invalid('lines', 'one_fund', 'one fund per journal');
      const takesFromFund = input.lines.some(
        (l) => fundCredit.some((a) => a.id === l.accountId) && D(l.credit ?? 0).gt(0),
      );
      if (input.resolutionId || takesFromFund)
        await this.assertResolution(tx, ctx, input.buildingId, input.resolutionId ?? null);
      const j = await this.post(tx, {
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        postedOn: input.postedOn,
        sourceType: input.opening ? 'opening' : 'manual',
        sourceId: null,
        memo: input.memo,
        legs,
        resolutionId: input.resolutionId ?? null,
        fundId: fundIds[0] ?? null,
      });
      await this.audit.record(tx, {
        action: 'juristic.journal_posted',
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        subjectType: 'juristic.journal',
        subjectId: j.id,
        metadata: { sourceType: j.sourceType, amount: debit.toFixed(2), lines: input.lines.length },
      });
      await this.events.record(tx, {
        type: 'juristic.journal.posted',
        aggregateType: 'journal',
        aggregateId: j.id,
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        payload: { journalId: j.id, sourceType: j.sourceType, amount: debit.toFixed(2) },
      });
      return j.id;
    });
    return this.journal(ctx, id);
  }

  /** An adopted, not void resolution of the building (422 `fund.resolution_required` / `fund.resolution_invalid`). */
  async assertResolution(
    tx: Tx,
    ctx: TenantContext,
    buildingId: string,
    resolutionId: string | null,
  ): Promise<string> {
    if (!resolutionId) throw new DomainException('fund.resolution_required');
    const r = await tx.resolution.findFirst({ where: { id: resolutionId, tenantId: ctx.tenantId } });
    if (!r) throw new DomainException('http.not_found');
    if (r.state !== 'adopted' || r.buildingId !== buildingId)
      throw new DomainException('fund.resolution_invalid');
    return r.id;
  }

  /** `POST /v1/owner/juristic/journals/{id}/actions/reverse`: the exact opposite journal, once. */
  async reverse(
    ctx: TenantContext,
    id: string,
    input: { postedOn?: string; reason: string },
  ): Promise<JournalRow> {
    const on = input.postedOn ?? this.today();
    if (on > this.today()) throw invalid('postedOn', 'future', 'not in the future');
    const rid = await this.db.tenant(ctx, async (tx) => {
      await this.assertJuristic(tx, ctx.tenantId);
      const j = this.found(await tx.journal.findFirst({ where: this.own(ctx, { id }) }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(j.buildingId))
        throw new DomainException('http.not_found');
      if (j.sourceType !== 'manual' && j.sourceType !== 'opening')
        throw new DomainException('journal.not_reversible', { params: { sourceType: j.sourceType } });
      if (await tx.journal.findFirst({ where: { reversesJournalId: id } }))
        throw new DomainException('journal.already_reversed');
      const r = await this.reverseIn(tx, id, { postedOn: on, memo: `กลับรายการ: ${input.reason}` });
      await this.audit.record(tx, {
        action: 'juristic.journal_reversed',
        tenantId: ctx.tenantId,
        buildingId: j.buildingId,
        subjectType: 'juristic.journal',
        subjectId: id,
        metadata: { reversalId: r.id, reason: input.reason },
      });
      await this.events.record(tx, {
        type: 'juristic.journal.reversed',
        aggregateType: 'journal',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: j.buildingId,
        payload: { journalId: id, reversalId: r.id },
      });
      return r.id;
    });
    return this.journal(ctx, rid);
  }
}
