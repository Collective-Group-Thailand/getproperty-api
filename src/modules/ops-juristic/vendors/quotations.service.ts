import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type AwardBasis,
  type AwardOutcome,
  type Prisma,
  type QuotationRoundState,
  type VendorCategory,
} from '@generated/prisma/client';
import { type ApprovalBand, bandFor } from '@modules/ops-juristic/accounting/expense-rules';
import { ExpensesService } from '@modules/ops-juristic/accounting/expenses.service';
import { LedgerService } from '@modules/ops-juristic/accounting/ledger.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { quotationRule } from './vendor-rules';
import { VendorsService } from './vendors.service';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export const ROUND_INCLUDE = {
  building: { select: { id: true, name: true } },
  quotations: {
    orderBy: [{ amount: 'asc' }, { createdAt: 'asc' }],
    include: { vendor: { select: { id: true, name: true, state: true } } },
  },
  approvals: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.QuotationRoundInclude;
export type RoundRow = Prisma.QuotationRoundGetPayload<{ include: typeof ROUND_INCLUDE }>;

export interface AwardInput {
  quotationId: string;
  outcome: AwardOutcome;
  basis: AwardBasis;
  resolutionId?: string | null;
  fewerQuotationsReason?: string | null;
  /** outcome `contract`: the term of the contract draft. */
  startsOn?: string | null;
  endsOn?: string | null;
  /** outcome `expense`: the expense account of the request draft (and an optional WHT key). */
  accountId?: string | null;
  whtKey?: string | null;
}

/**
 * Quotation rounds (D-310 = D-J09, D-331): quotations per vendor (document required) while open; the award picks a
 * valid quotation, the outcome (a contract draft or an expense request draft) and the basis — an adopted resolution
 * of the building (awarded at once) or the approval band of the amount (distinct band-role users other than the
 * requester; one rejection reopens the round). Above `juristic.quotation_threshold` fewer than 3 quotations need a
 * recorded reason (service + CHECK).
 */
@Injectable()
export class QuotationsService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly vendors: VendorsService,
    private readonly expenses: ExpensesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('juristic.quotation.approval_required', async (tx, e) => {
      if (!e.tenantId) return null;
      const roles = (e.payload.roles as string[] | undefined) ?? ['owner', 'manager'];
      const requester = e.payload.requestedBy as string | undefined;
      return {
        recipients: [
          ...(roles.includes('owner') ? await operators(tx, e.tenantId, ['owner'], 'owner') : []),
          ...(await operators(
            tx,
            e.tenantId,
            roles.filter((r) => r === 'manager' || r === 'committee'),
            'manager',
          )),
        ].filter((r) => r.id !== requester),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          round: {
            title: e.payload.title ?? '',
            vendorName: e.payload.vendorName ?? '',
            amount: e.payload.amount ?? '0.00',
            quotations: e.payload.quotations ?? 0,
            approvals: e.payload.approvalsRequired ?? 1,
          },
        },
      };
    });
  }

  private actorId(): string {
    const id = by();
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<RoundRow> {
    const r = this.found(
      await tx.quotationRound.findFirst({ where: this.own(ctx, { id }), include: ROUND_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(r.buildingId))
      throw new DomainException('http.not_found');
    return r;
  }

  private async lock(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.quotation_round WHERE id = ${id}::uuid FOR UPDATE`;
  }

  get(ctx: TenantContext, id: string): Promise<RoundRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.load(tx, ctx, id);
    });
  }

  list(
    ctx: TenantContext,
    q: { state?: QuotationRoundState; buildingId?: string; awaitingMe?: boolean; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const me = by();
      const where: Prisma.QuotationRoundWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
        ...(q.awaitingMe && me
          ? {
              state: 'awaiting_approval',
              awardRequestedBy: { not: me },
              approverRoles: { has: ctx.role ?? '-' },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.quotationRound.findMany({
          where,
          include: ROUND_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.quotationRound.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async create(
    ctx: TenantContext,
    input: {
      buildingId: string;
      title: string;
      description?: string | null;
      category?: VendorCategory | null;
      estimatedAmount?: string | null;
    },
  ): Promise<RoundRow> {
    if (input.estimatedAmount && (!MONEY.test(input.estimatedAmount) || D(input.estimatedAmount).lte(0)))
      throw invalid('estimatedAmount', 'money', 'a positive amount');
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const b = await tx.building.findFirst({
        where: {
          id: input.buildingId,
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
      });
      if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
        throw new DomainException('http.not_found');
      const r = await tx.quotationRound.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: b.id,
          title: input.title.trim(),
          description: input.description ?? null,
          category: input.category ?? null,
          estimatedAmount: input.estimatedAmount ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.quotation_round_created',
        tenantId: ctx.tenantId,
        buildingId: b.id,
        subjectType: 'juristic.quotation_round',
        subjectId: r.id,
        metadata: { title: r.title, estimatedAmount: input.estimatedAmount ?? null },
      });
      await this.event(tx, ctx, r.id, b.id, 'juristic.quotation_round.changed', {
        state: 'open',
        change: 'opened',
      });
      return r.id;
    });
    return this.get(ctx, id);
  }

  private event(
    tx: Tx,
    ctx: TenantContext,
    roundId: string,
    buildingId: string,
    type: DomainEventType,
    payload: Record<string, unknown>,
  ) {
    return this.events.record(tx, {
      type,
      aggregateType: 'quotation_round',
      aggregateId: roundId,
      tenantId: ctx.tenantId,
      buildingId,
      payload: { quotationRoundId: roundId, ...payload },
    });
  }

  async addQuotation(
    ctx: TenantContext,
    id: string,
    input: {
      vendorId: string;
      amount: string;
      vatAmount?: string | null;
      validUntil: string;
      documentId: string;
      receivedOn?: string | null;
      note?: string | null;
    },
  ): Promise<RoundRow> {
    if (!MONEY.test(input.amount) || D(input.amount).lte(0))
      throw invalid('amount', 'money', 'a positive amount');
    const vat = input.vatAmount ?? '0.00';
    if (!MONEY.test(vat) || D(vat).gt(input.amount)) throw invalid('vatAmount', 'money', '0 … amount');
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'open')
        throw new DomainException('quotation_round.invalid_state', { params: { state: r.state } });
      const v = await tx.vendor.findFirst({ where: { id: input.vendorId, tenantId: ctx.tenantId } });
      if (!v) throw new DomainException('http.not_found');
      if (v.state !== 'active') throw new DomainException('vendor.blocked');
      const doc = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new DomainException('http.not_found');
      const today = bangkokDate(this.clock.now());
      const receivedOn = input.receivedOn ?? today;
      if (receivedOn > today) throw invalid('receivedOn', 'future', 'today or earlier');
      if (input.validUntil < receivedOn) throw invalid('validUntil', 'date', 'on or after the day received');
      if (r.quotations.some((q) => q.vendorId === v.id)) throw new DomainException('quotation.exists');
      const q = await tx.quotation.create({
        data: {
          tenantId: ctx.tenantId,
          roundId: id,
          vendorId: v.id,
          amount: D(input.amount).toFixed(2),
          vatAmount: D(vat).toFixed(2),
          validUntil: asDate(input.validUntil),
          documentId: input.documentId,
          receivedOn: asDate(receivedOn),
          note: input.note ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.quotation_added',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.quotation_round',
        subjectId: id,
        metadata: { quotationId: q.id, vendorId: v.id, amount: q.amount.toFixed(2) },
      });
      await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.changed', {
        state: 'open',
        change: 'quotation',
        quotations: r.quotations.length + 1,
      });
    });
    return this.get(ctx, id);
  }

  /** Award (Idempotency-Key): resolution → awarded at once; approval → awaiting the band's approvals. */
  async award(ctx: TenantContext, id: string, input: AwardInput): Promise<RoundRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'open')
        throw new DomainException('quotation_round.invalid_state', { params: { state: r.state } });
      const q = r.quotations.find((x) => x.id === input.quotationId);
      if (!q) throw new DomainException('http.not_found');
      if (q.vendor.state !== 'active') throw new DomainException('vendor.blocked');
      const now = this.clock.now();
      const today = bangkokDate(now);
      if (day(q.validUntil) < today) throw new DomainException('quotation.expired');
      const threshold =
        (await this.settings.valueAt<string>('juristic.quotation_threshold', now, {
          tenantId: ctx.tenantId,
        })) ?? '0';
      const rule = quotationRule({
        amount: q.amount,
        threshold,
        quotations: r.quotations.length,
        reason: input.fewerQuotationsReason,
      });
      if (!rule.allowed)
        throw new DomainException('quotation.minimum_not_met', {
          params: { threshold: D(threshold).toFixed(2) },
        });
      const options = await this.outcomeOptions(tx, ctx, r.buildingId, input);
      let band: (ApprovalBand & { key: string }) | null = null;
      let resolutionId: string | null = null;
      if (input.basis === 'resolution')
        resolutionId = await this.ledger.assertResolution(tx, ctx, r.buildingId, input.resolutionId ?? null);
      else {
        const bands = await this.settings.valueAt<ApprovalBand[]>('juristic.approval_bands', now, {
          tenantId: ctx.tenantId,
        });
        band = bandFor(bands, q.amount);
      }
      await tx.quotationRound.update({
        where: { id },
        data: {
          state: 'awaiting_approval',
          awardedQuotationId: q.id,
          outcome: input.outcome,
          basis: input.basis,
          resolutionId,
          fewerQuotationsReason: rule.minimumMet ? null : input.fewerQuotationsReason!.trim(),
          quotationCount: r.quotations.length,
          aboveThreshold: rule.aboveThreshold,
          threshold: D(threshold).toFixed(2),
          awardOptions: options,
          band: (band ?? undefined) as unknown as Prisma.InputJsonValue,
          approvalsRequired: band?.approvals ?? null,
          approverRoles: band?.roles ?? [],
          awardRequestedBy: me,
          awardRequestedAt: now,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.quotation_award_requested',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.quotation_round',
        subjectId: id,
        metadata: {
          quotationId: q.id,
          vendorId: q.vendorId,
          amount: q.amount.toFixed(2),
          quotations: r.quotations.length,
          aboveThreshold: rule.aboveThreshold,
          fewerQuotationsReason: rule.minimumMet ? null : input.fewerQuotationsReason,
          basis: input.basis,
          outcome: input.outcome,
          resolutionId,
          band: band?.key ?? null,
        },
      });
      if (input.basis === 'resolution') {
        await this.finalise(tx, ctx, id, me);
        return;
      }
      const payload = {
        title: r.title,
        vendorName: q.vendor.name,
        amount: q.amount.toFixed(2),
        quotations: r.quotations.length,
        roles: band!.roles,
        approvalsRequired: band!.approvals,
        requestedBy: me,
      };
      await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.award_requested', payload);
      await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation.approval_required', payload);
    });
    return this.get(ctx, id);
  }

  /** What the award creates — checked at the award, created when the round is awarded. */
  private async outcomeOptions(tx: Tx, ctx: TenantContext, buildingId: string, input: AwardInput) {
    if (input.outcome === 'contract') {
      if (!input.startsOn || !input.endsOn || input.endsOn < input.startsOn)
        throw invalid('endsOn', 'required', 'the contract term (startsOn ≤ endsOn)');
      return { startsOn: input.startsOn, endsOn: input.endsOn };
    }
    if (!input.accountId) throw invalid('accountId', 'required', 'the expense account of the request');
    const a = await tx.account.findFirst({ where: { id: input.accountId, tenantId: ctx.tenantId } });
    if (!a) throw new DomainException('http.not_found');
    if (a.type !== 'expense' || !a.isActive)
      throw invalid('accountId', 'expense_account', 'an active expense account');
    if (input.whtKey) {
      const rates =
        (await this.settings.valueAt<{ key: string }[]>('juristic.wht_rates', this.clock.now(), {
          tenantId: ctx.tenantId,
        })) ?? [];
      if (!rates.some((x) => x.key === input.whtKey))
        throw invalid('whtKey', 'unknown', 'a key of juristic.wht_rates');
    }
    void buildingId;
    return { accountId: input.accountId, whtKey: input.whtKey ?? null };
  }

  /** Awarded: the contract draft or the expense request draft (requester = whoever asked for the award). */
  private async finalise(tx: Tx, ctx: TenantContext, id: string, requester: string): Promise<void> {
    const r = await this.load(tx, ctx, id);
    const q = r.quotations.find((x) => x.id === r.awardedQuotationId)!;
    const options = (r.awardOptions ?? {}) as {
      startsOn?: string;
      endsOn?: string;
      accountId?: string;
      whtKey?: string | null;
    };
    const now = this.clock.now();
    // the round is awarded first: the outcome's links check that the round is awarded to the vendor
    await tx.quotationRound.update({ where: { id }, data: { state: 'awarded', awardedAt: now } });
    let contractId: string | null = null;
    let expenseRequestId: string | null = null;
    if (r.outcome === 'contract')
      contractId = await this.vendors.createContractIn(tx, ctx, {
        buildingId: r.buildingId,
        vendorId: q.vendorId,
        title: r.title,
        scope: r.description,
        category: r.category,
        startsOn: options.startsOn!,
        endsOn: options.endsOn!,
        value: q.amount.toFixed(2),
        quotationRoundId: r.id,
        resolutionId: r.resolutionId,
      });
    else {
      expenseRequestId = (
        await this.expenses.createIn(
          tx,
          ctx,
          {
            buildingId: r.buildingId,
            title: r.title,
            vendorId: q.vendorId,
            quotationRoundId: r.id,
            resolutionId: r.resolutionId,
            lines: [
              {
                accountId: options.accountId!,
                description: r.title,
                amount: q.amount.toFixed(2),
                vatAmount: q.vatAmount.toFixed(2),
                whtKey: options.whtKey ?? null,
              },
            ],
          },
          requester,
        )
      ).id;
      await tx.expenseAttachment.create({
        data: {
          tenantId: ctx.tenantId,
          expenseRequestId,
          documentId: q.documentId,
          kind: 'quotation',
          createdBy: requester,
        },
      });
    }
    await tx.quotationRound.update({
      where: { id },
      data: {
        outcomeContractId: contractId,
        outcomeExpenseRequestId: expenseRequestId,
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: 'juristic.quotation_round_awarded',
      tenantId: ctx.tenantId,
      buildingId: r.buildingId,
      subjectType: 'juristic.quotation_round',
      subjectId: id,
      metadata: {
        quotationId: q.id,
        vendorId: q.vendorId,
        amount: q.amount.toFixed(2),
        basis: r.basis,
        contractId,
        expenseRequestId,
      },
    });
    await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.awarded', {
      state: 'awarded',
      vendorId: q.vendorId,
      contractId,
      expenseRequestId,
    });
  }

  /** One decision on an award by a band role holder who did not ask for it (maker-checker, D-091). */
  async decide(
    ctx: TenantContext,
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string | null,
  ): Promise<RoundRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'awaiting_approval' || r.basis !== 'approval')
        throw new DomainException('quotation_round.invalid_state', { params: { state: r.state } });
      if (r.awardRequestedBy === me) throw new DomainException('quotation.maker_checker');
      if (!ctx.role || !r.approverRoles.includes(ctx.role))
        throw new DomainException('quotation.not_in_band', { params: { roles: r.approverRoles.join(', ') } });
      const current = r.approvals.filter(
        (a) => a.awardRequestedAt.getTime() === r.awardRequestedAt!.getTime(),
      );
      if (current.some((a) => a.approverUserId === me))
        throw new DomainException('quotation.already_decided');
      if (decision === 'rejected' && !reason?.trim())
        throw invalid('reason', 'required', 'why it is rejected');
      await tx.quotationApproval.create({
        data: {
          tenantId: ctx.tenantId,
          roundId: id,
          approverUserId: me,
          role: ctx.role,
          decision,
          reason: reason ?? null,
          bandKey: ((r.band ?? {}) as { key?: string }).key ?? 'unknown',
          awardRequestedAt: r.awardRequestedAt!,
        },
      });
      const approvals =
        current.filter((a) => a.decision === 'approved').length + (decision === 'approved' ? 1 : 0);
      await this.audit.record(tx, {
        action:
          decision === 'approved'
            ? 'juristic.quotation_award_approval_given'
            : 'juristic.quotation_award_rejected',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.quotation_round',
        subjectId: id,
        metadata: { role: ctx.role, approvals, required: r.approvalsRequired, reason: reason ?? null },
      });
      if (decision === 'rejected') {
        // the round reopens: another quotation may be chosen (a new award request needs fresh approvals)
        await tx.quotationRound.update({
          where: { id },
          data: {
            state: 'open',
            awardedQuotationId: null,
            outcome: null,
            basis: null,
            resolutionId: null,
            fewerQuotationsReason: null,
            quotationCount: null,
            aboveThreshold: null,
            threshold: null,
            awardOptions: undefined,
            band: undefined,
            approvalsRequired: null,
            approverRoles: [],
            updatedBy: me,
            version: { increment: 1 },
          },
        });
        await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.changed', {
          state: 'open',
          change: 'award_rejected',
        });
        return;
      }
      if (approvals >= (r.approvalsRequired ?? 1)) await this.finalise(tx, ctx, id, r.awardRequestedBy!);
      else
        await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.changed', {
          state: r.state,
          change: 'approval',
          approvals,
        });
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<RoundRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const r = await this.load(tx, ctx, id);
      if (r.state !== 'open' && r.state !== 'awaiting_approval')
        throw new DomainException('quotation_round.invalid_state', { params: { state: r.state } });
      await tx.quotationRound.update({
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
        action: 'juristic.quotation_round_cancelled',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.quotation_round',
        subjectId: id,
        metadata: { reason, from: r.state },
      });
      await this.event(tx, ctx, id, r.buildingId, 'juristic.quotation_round.cancelled', {
        state: 'cancelled',
      });
    });
    return this.get(ctx, id);
  }
}
