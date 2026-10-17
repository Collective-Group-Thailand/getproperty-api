import { Semaphore } from '@common/concurrency/semaphore';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { canonicalSha256 } from '@common/json/canonical';
import { bangkokDate, toBangkokIso } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceGate, type RuleCheck } from '@core/compliance/compliance-gate.service';
import {
  evaluateBillDisclosure,
  evaluateInvoiceLeadTime,
  evaluateLateFeePolicy,
  evaluateNoRenewalFee,
} from '@core/compliance/evaluators';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Invoice,
  type InvoiceLineKind,
  type InvoiceStatus,
  type NoteReason,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type DraftLine, type DraftResult } from './engine/invoice-draft';
import { sourceTypeOf } from './engine/line-kinds';
import { dueDateFor } from './engine/periods';
import { type MeterSegment } from './engine/readings';

const by = () => userIdOf(RequestContext.actor());
/** Late-fee wording in a lease (the same pattern the lease rules use, D-045). */
export const LATE_FEE_TERM =
  /(ค่าปรับ\s*(การ)?\s*(ชำระ)?\s*(ค่าเช่า)?\s*ล่าช้า|ค่าปรับรายวัน|late\s*(payment\s*)?fee)/i;
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const D = (v: Decimal.Value) => new Decimal(v);

export const ENGINE_VERSION = 'billing-engine@1.0.0';
/** Transaction options of an issue: concurrent issues of a tenant queue on its series row (§4.4). */
export const ISSUE_TX = { maxWait: 30_000, timeout: 60_000 } as const;
/** At most 3 issue transactions of this process at once (the pool keeps room for their setting reads). */
export const ISSUE_SLOTS = new Semaphore(3);

export const INVOICE_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' } },
  unit: { select: { id: true, unitNo: true, buildingId: true } },
  billedParty: { select: { id: true, displayName: true, type: true } },
  lease: { select: { id: true, number: true, billingDay: true } },
  creditNotes: { include: { lines: { orderBy: { lineNo: 'asc' } } }, orderBy: { issuedAt: 'asc' } },
  debitNotes: { include: { lines: { orderBy: { lineNo: 'asc' } } }, orderBy: { issuedAt: 'asc' } },
} as const satisfies Prisma.InvoiceInclude;
export type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

export interface DraftTarget {
  tenantId: string;
  buildingId: string;
  unitId: string | null;
  billedPartyId: string;
  leaseId: string | null;
  billingCycleId: string | null;
  isFinal: boolean;
  periodStart: string;
  periodEnd: string;
  replacesInvoiceId?: string | null;
}

/** Statuses an invoice moves through once issued (D-044): from its balance and what was paid or credited. */
export function statusFor(
  i: {
    status: InvoiceStatus;
    balance: Decimal.Value;
    paidTotal: Decimal.Value;
    creditedTotal: Decimal.Value;
    dueDate: Date | null;
    overdueSince: Date | null;
  },
  today: string,
): InvoiceStatus {
  if (i.status === 'draft' || i.status === 'void') return i.status;
  if (D(i.balance).lte(0)) return 'paid';
  if (i.dueDate && day(i.dueDate) < today) return 'overdue';
  if (D(i.paidTotal).gt(0) || D(i.creditedTotal).gt(0)) return 'partially_paid';
  return 'issued';
}

export interface IssueOptions {
  acknowledgementIds?: string[];
  /** Cycle issue: refusals skip the invoice instead of throwing. */
  collectRefusals?: boolean;
}

/**
 * Invoices (B4.2, D-040, D-041, D-044, D-046, D-151): drafts persisted from the engine (replaced on recompute), the
 * issue transaction — compliance gate (tariff cap acknowledgement or block, disclosure, lead time, renewal fees, late
 * fees), due date, gapless number (§4.4), prior balance, the snapshot of everything used (§4.2.3) with its sha256,
 * one-off charges applied, estimate settlements opened/settled, the deposit settlement linked for a final invoice —
 * then immutable (trigger `invoice_immutable`). Corrections: void before any payment (with an optional re-computed
 * replacement for the same period) or credit/debit notes after; both move the balance (`invoice.balance_changed`).
 */
@Injectable()
export class InvoicesService extends TenantScopedRepository {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly issuedHooks: ((tx: Tx, invoice: Invoice) => Promise<void>)[] = [];

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly gate: ComplianceGate,
    private readonly numbering: DocumentNumbering,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Modules react to an issued invoice inside the issue transaction (deposit settlement of a final invoice). */
  onIssued(hook: (tx: Tx, invoice: Invoice) => Promise<void>): void {
    this.issuedHooks.push(hook);
  }

  // ------------------------------------------------------------------------------------------- drafts

  /** Replaces the draft of the same target (cycle × unit × party, or the lease's final invoice) with a new one. */
  async persistDraft(tx: Tx, target: DraftTarget, draft: DraftResult): Promise<Invoice> {
    const existing = await tx.invoice.findMany({
      where: {
        tenantId: target.tenantId,
        status: 'draft',
        billedPartyId: target.billedPartyId,
        unitId: target.unitId,
        ...(target.billingCycleId
          ? { billingCycleId: target.billingCycleId }
          : target.isFinal
            ? { leaseId: target.leaseId, isFinal: true }
            : {
                replacesInvoiceId: target.replacesInvoiceId ?? undefined,
                billingCycleId: null,
                isFinal: false,
              }),
      },
      select: { id: true },
    });
    if (existing.length) await tx.invoice.deleteMany({ where: { id: { in: existing.map((e) => e.id) } } });
    const invoice = await tx.invoice.create({
      data: {
        tenantId: target.tenantId,
        buildingId: target.buildingId,
        unitId: target.unitId,
        billedPartyId: target.billedPartyId,
        leaseId: target.leaseId,
        billingCycleId: target.billingCycleId,
        isFinal: target.isFinal,
        replacesInvoiceId: target.replacesInvoiceId ?? null,
        periodStart: asDate(target.periodStart),
        periodEnd: asDate(target.periodEnd),
        subtotal: draft.subtotal,
        vatAmount: draft.vatAmount,
        total: D(draft.total).isNeg() ? '0.00' : draft.total,
        balance: D(draft.total).isNeg() ? '0.00' : draft.total,
        hasEstimate: draft.hasEstimate,
        hasAboveCapLine: draft.hasAboveCapLine,
        complianceFlags: draft.complianceFlags,
        reviewFlags: draft.reviewFlags,
        snapshot: draft.advanceRent ? { draft: { advanceRent: draft.advanceRent } } : undefined,
        createdBy: by(),
      },
    });
    if (draft.lines.length)
      await tx.invoiceLine.createMany({
        data: draft.lines.map((l) => this.lineData(target.tenantId, invoice.id, l)),
      });
    return invoice;
  }

  private lineData(tenantId: string, invoiceId: string, l: DraftLine): Prisma.InvoiceLineCreateManyInput {
    const m = l.meter;
    return {
      tenantId,
      invoiceId,
      lineNo: l.lineNo,
      sourceType: l.sourceType,
      lineKind: l.lineKind,
      sourceId: l.sourceId,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
      periodFrom: l.periodFrom ? asDate(l.periodFrom) : null,
      periodTo: l.periodTo ? asDate(l.periodTo) : null,
      assetItemId: m?.assetItemId ?? null,
      meterAssignmentId: m?.meterAssignmentId ?? null,
      readingFromId: m?.readingFromId ?? null,
      readingToId: m?.readingToId ?? null,
      registerFrom: m?.registerFrom ?? null,
      registerTo: m?.registerTo ?? null,
      units: m?.units ?? null,
      multiplier: m?.multiplier ?? null,
      readingSource: (m?.readingSource ?? null) as Prisma.InvoiceLineCreateManyInput['readingSource'],
      isEstimated: m?.isEstimated ?? false,
      meterSegments: m?.segments.length ? (m.segments as unknown as Prisma.InputJsonValue) : undefined,
      ratePlanVersionId: l.ratePlanVersionId,
      utilityTariffVersionId: l.utilityTariffVersionId,
      capPerUnit: l.capPerUnit,
      aboveCap: l.aboveCap,
      complianceAcknowledgementId: l.acknowledgementId,
      tierBreakdown: l.tierBreakdown ? (l.tierBreakdown as unknown as Prisma.InputJsonValue) : undefined,
      proRata: l.proRata ? (l.proRata as unknown as Prisma.InputJsonValue) : undefined,
      leaseLineId: l.leaseLineId,
      estimateSettlementId: l.estimateSettlementId,
      complianceRuleIds: l.complianceRuleIds,
      vatApplicable: l.vatApplicable,
    };
  }

  // ------------------------------------------------------------------------------------------- reads

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<InvoiceRow> {
    const inv = this.found(await tx.invoice.findFirst({ where: { id }, include: INVOICE_INCLUDE }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(inv.buildingId))
      throw new DomainException('http.not_found');
    return inv;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: {
      status?: InvoiceStatus;
      buildingId?: string;
      unitId?: string;
      leaseId?: string;
      partyId?: string;
      billingCycleId?: string;
      number?: string;
      q?: string;
      period?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.InvoiceWhereInput = {
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.leaseId ? { leaseId: q.leaseId } : {}),
        ...(q.partyId ? { billedPartyId: q.partyId } : {}),
        ...(q.billingCycleId ? { billingCycleId: q.billingCycleId } : {}),
        ...(q.number ? { number: q.number } : {}),
        ...(q.period
          ? { periodEnd: { gte: asDate(`${q.period}-01`), lt: asDate(nextMonth(q.period)) } }
          : {}),
        ...(q.q
          ? {
              OR: [
                { number: { contains: q.q, mode: 'insensitive' } },
                { unit: { unitNo: { contains: q.q, mode: 'insensitive' } } },
                { billedParty: { displayName: { contains: q.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.invoice.findMany({
          where,
          include: INVOICE_INCLUDE,
          orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.invoice.count({ where }),
      ]);
      return { rows, total };
    });
  }

  // ------------------------------------------------------------------------------------------- compliance at issue

  /** The block-only checks of an invoice at issue (disclosure, lead time, renewal fees, late fees). */
  private async issueChecks(
    tx: Tx,
    inv: InvoiceRow,
    issuedOn: string,
    dueDate: string,
    minLeadDays: number,
    at: Date,
  ): Promise<RuleCheck[]> {
    const meterLines = inv.lines.filter((l) => l.lineKind === 'electricity' || l.lineKind === 'water');
    const checks: RuleCheck[] = [
      evaluateBillDisclosure({
        meterLines: meterLines.map((l) => {
          const segments = (l.meterSegments ?? []) as unknown as MeterSegment[];
          return {
            path: `lines[${l.lineNo}]`,
            units: l.units?.toFixed(3) ?? null,
            unitPrice: l.unitPrice?.toFixed(4) ?? null,
            segments: segments.map((s) => ({
              registerFrom: s.from?.register ?? null,
              registerTo: s.to?.register ?? null,
            })),
            readingSource: segments[segments.length - 1]?.to?.source ?? l.readingSource,
            utilityTariffVersionId: l.utilityTariffVersionId,
          };
        }),
        fixedLines: inv.lines
          .filter((l) => l.sourceType === 'service' || l.sourceType === 'common_fee')
          .map((l) => ({ path: `lines[${l.lineNo}]`, kind: l.lineKind, description: l.description })),
      }),
      evaluateInvoiceLeadTime({ issuedOn, dueDate, minLeadDays }),
      evaluateNoRenewalFee({
        lines: inv.lines
          .filter((l) => l.lineKind === 'one_off' || l.lineKind === 'other_fixed')
          .map((l) => ({ path: `lines[${l.lineNo}]`, description: l.description })),
      }),
    ];
    const lateFees = inv.lines.filter((l) => l.lineKind === 'late_fee');
    if (lateFees.length) {
      const enabled = await this.settings.at('late_fee.enabled', at, { tenantId: inv.tenantId });
      const lease = inv.leaseId
        ? await tx.lease.findUnique({ where: { id: inv.leaseId }, include: { lines: true } })
        : null;
      const terms = [
        ...((lease?.addendum ?? []) as { title?: string; text?: string }[]).map(
          (c) => `${c.title ?? ''} ${c.text ?? ''}`,
        ),
        ...(lease?.lines ?? []).map((l) => l.description),
      ];
      checks.push(
        evaluateLateFeePolicy({
          lateFeeEnabled: enabled?.value === true,
          contractStatesLateFee: terms.some((t) => LATE_FEE_TERM.test(t)),
          amount: lateFees.reduce((s, l) => s.plus(l.amount.toString()), D(0)),
          agreedAmount: null,
        }),
      );
    }
    return checks;
  }

  /**
   * The tariff cap of a set of draft lines (D-021a): violated when a line is above the cap without an acknowledgement
   * (severity warn), or above the cap at all (severity block). Shown values list the lines for the warning.
   */
  async tariffCapCheck(
    ctx: TenantContext,
    lines: {
      id: string;
      unitNo: string | null;
      lineKind: string;
      unitPrice: string;
      capPerUnit: string;
      units: string;
      acknowledgementId: string | null;
    }[],
  ): Promise<RuleCheck | null> {
    const above = lines;
    if (!above.length) return null;
    const severity = await this.gate.severity('compliance.tariff_cap', ctx.tenantId, this.clock.now());
    const pending = severity === 'block' ? above : above.filter((l) => !l.acknowledgementId);
    const shownLines = pending.map((l) => ({
      unitNo: l.unitNo,
      utility: l.lineKind,
      units: l.units,
      tenantRate: l.unitPrice,
      capPerUnit: l.capPerUnit,
    }));
    return {
      ruleId: 'compliance.tariff_cap',
      violated: pending.length > 0,
      context: { lines: shownLines, severity },
      shown: { lines: shownLines, count: shownLines.length },
      errors: pending.length
        ? pending.map((l) => ({
            path: `lines.${l.id}`,
            code: 'aboveCap',
            message: `${l.unitPrice} THB/unit is above the utility rate ${l.capPerUnit}`,
          }))
        : undefined,
    };
  }

  // ------------------------------------------------------------------------------------------- issue

  /** `POST /v1/owner/invoices/{id}/actions/issue`: one draft (final, ad hoc or replacement invoice). */
  async issue(ctx: TenantContext, id: string, options: IssueOptions = {}): Promise<InvoiceRow> {
    const draft = await this.db.tenant(ctx, async (tx) => {
      const inv = await this.load(tx, ctx, id);
      if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      return inv;
    });
    if (draft.status !== 'draft') {
      if (draft.issuedAt) return draft; // idempotent repeat
      throw new DomainException('invoice.invalid_state', { params: { status: draft.status } });
    }
    const capCheck = await this.tariffCapCheck(
      ctx,
      draft.lines
        .filter((l) => l.aboveCap)
        .map((l) => ({
          id: l.id,
          unitNo: draft.unit?.unitNo ?? null,
          lineKind: l.lineKind,
          unitPrice: l.unitPrice!.toFixed(4),
          capPerUnit: l.capPerUnit!.toFixed(4),
          units: l.units?.toFixed(3) ?? '0',
          acknowledgementId: l.complianceAcknowledgementId,
        })),
    );
    let ackId: string | null = null;
    if (capCheck) {
      const r = await this.gate.enforce(ctx, {
        subjectType: 'ops.invoice',
        subjectId: draft.id,
        buildingId: draft.buildingId,
        checks: [capCheck],
        acknowledgementIds: options.acknowledgementIds,
      });
      ackId = r.checks[0]?.acknowledgementId ?? null;
    }
    // issues queue on the series row lock (gapless numbering) while holding a connection: a few at a time
    return ISSUE_SLOTS.run(() =>
      this.db.tenant(
        ctx,
        async (tx) => {
          const issued = await this.issueInTx(tx, ctx, id, { ackId, throwOnRefusal: true });
          return this.load(tx, ctx, issued!.id);
        },
        ISSUE_TX,
      ),
    );
  }

  /**
   * Issues one draft inside `tx` (row-locked): flags, block-only compliance checks, due date, number, prior balance,
   * snapshot, charges, estimate settlements, hooks, audit + `invoice.issued`. Returns null (skipped) when the draft
   * cannot be issued and `throwOnRefusal` is false (cycle issue).
   */
  async issueInTx(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    opts: {
      ackId: string | null;
      throwOnRefusal: boolean;
      skipped?: { invoiceId: string; reason: string }[];
    },
  ): Promise<Invoice | null> {
    await tx.$queryRaw`SELECT id FROM ops.invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await this.load(tx, ctx, id);
    if (inv.status !== 'draft') return inv.issuedAt ? inv : null;
    const skip = (
      reason: string,
      code: 'invoice.not_ready' | 'invoice.invalid_state' = 'invoice.not_ready',
    ) => {
      if (opts.throwOnRefusal) throw new DomainException(code, { params: { reason } });
      opts.skipped?.push({ invoiceId: id, reason });
      return null;
    };
    const blocking = inv.reviewFlags.filter((f) => !f.startsWith('acknowledgement_required'));
    if (blocking.length) return skip(blocking.join(','));
    // above-cap lines without an acknowledgement take the one given now (D-021a)
    const unacknowledged = inv.lines.filter((l) => l.aboveCap && !l.complianceAcknowledgementId);
    if (unacknowledged.length) {
      if (!opts.ackId) return skip('acknowledgement_required');
      for (const l of unacknowledged)
        await tx.invoiceLine.update({
          where: { id: l.id },
          data: { complianceAcknowledgementId: opts.ackId },
        });
    }
    const now = this.clock.now();
    const issuedOn = bangkokDate(now);
    const scope = { tenantId: inv.tenantId };
    const minLeadDays = await this.settings.valueAt<number>('invoice.min_lead_days', now, scope);
    const defaultDueDay = await this.settings.valueAt<number>('billing.default_due_day', now, scope);
    const dueDate = dueDateFor({
      periodEnd: day(inv.periodEnd),
      issuedOn,
      dueDay: inv.lease?.billingDay ?? defaultDueDay,
      minLeadDays,
    });
    const checks = await this.issueChecks(tx, inv, issuedOn, dueDate, minLeadDays, now);
    const failed = checks.filter((c) => c.violated);
    if (failed.length) {
      if (opts.throwOnRefusal) {
        // the gate records the evaluations and throws the refusal with its legal reference
        await this.gate.enforce(ctx, {
          subjectType: 'ops.invoice',
          subjectId: id,
          buildingId: inv.buildingId,
          checks: failed,
          refuseWarnings: true,
        });
      }
      return skip(failed.map((c) => c.ruleId).join(','));
    }
    const prior = await tx.invoice.findMany({
      where: {
        tenantId: inv.tenantId,
        id: { not: inv.id },
        billedPartyId: inv.billedPartyId,
        unitId: inv.unitId,
        status: { in: ['issued', 'partially_paid', 'overdue'] },
        balance: { gt: 0 },
      },
      select: { id: true, number: true, balance: true },
      orderBy: { issuedAt: 'asc' },
    });
    const priorBalance = prior.reduce((s, p) => s.plus(p.balance.toString()), D(0));
    const fresh = await this.load(tx, ctx, id);
    const snapshot = await this.snapshot(tx, fresh, {
      issuedAt: now,
      dueDate,
      number: '',
      prior: prior.map((p) => ({ id: p.id, number: p.number, balance: p.balance.toFixed(2) })),
      priorBalance: priorBalance.toFixed(2),
    });
    // the gapless number is taken last (§4.4): the series row stays locked only for the final writes
    const number = await this.numbering.next(tx, inv.tenantId, 'invoice', now);
    snapshot.number = number;
    await tx.invoice.update({
      where: { id },
      data: {
        status: 'issued',
        number,
        promptpayRef: number.replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
        issuedAt: now,
        dueDate: asDate(dueDate),
        priorBalanceCarried: priorBalance.toFixed(2),
        snapshot: snapshot as Prisma.InputJsonValue,
        snapshotSha256: new Uint8Array(canonicalSha256(snapshot)),
        reviewFlags: [],
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    // queued one-offs → applied; estimated lines → pending settlements; settlement lines → settled
    for (const l of fresh.lines) {
      if (l.sourceId && (l.lineKind === 'one_off' || l.lineKind === 'late_fee' || l.lineKind === 'discount'))
        await tx.invoiceCharge.updateMany({
          where: { id: l.sourceId, status: 'pending' },
          data: { status: 'applied', appliedInvoiceLineId: l.id, updatedBy: by() },
        });
      if (l.isEstimated && l.sourceType === 'meter' && l.lineKind !== 'estimate_settlement') {
        const segments = (l.meterSegments ?? []) as unknown as MeterSegment[];
        const est = segments.find((s) => s.to?.isEstimated);
        if (est?.to?.readingId)
          await tx.estimateSettlement.create({
            data: {
              tenantId: inv.tenantId,
              buildingId: inv.buildingId,
              unitId: inv.unitId,
              assetItemId: est.assetItemId,
              meterAssignmentId: est.assignmentId,
              estimatedReadingId: est.to.readingId,
              estimatedInvoiceLineId: l.id,
              estimatedUnits: l.units!.toFixed(3),
              ratePlanVersionId: l.ratePlanVersionId!,
              utilityTariffVersionId: l.utilityTariffVersionId!,
              createdBy: by(),
            },
          });
      }
      if (l.lineKind === 'estimate_settlement' && l.estimateSettlementId) {
        const s = await tx.estimateSettlement.findUniqueOrThrow({ where: { id: l.estimateSettlementId } });
        await tx.estimateSettlement.update({
          where: { id: s.id },
          data: {
            status: 'settled_on_invoice',
            actualReadingId: l.readingToId,
            actualUnits: D(s.estimatedUnits.toString()).plus(l.units!.toString()).toFixed(3),
            deltaUnits: l.units!.toFixed(3),
            deltaAmount: l.amount.toFixed(2),
            settledInvoiceLineId: l.id,
            settledAt: now,
            updatedBy: by(),
          },
        });
      }
    }
    const issued = await tx.invoice.findUniqueOrThrow({ where: { id } });
    for (const hook of this.issuedHooks) await hook(tx, issued);
    await this.audit.record(tx, {
      action: 'invoice.issued',
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      subjectType: 'ops.invoice',
      subjectId: id,
      metadata: { number, total: issued.total.toFixed(2), dueDate, isFinal: inv.isFinal },
    });
    await this.events.record(tx, {
      type: 'invoice.issued',
      aggregateType: 'invoice',
      aggregateId: id,
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      payload: {
        invoiceId: id,
        number,
        total: issued.total.toFixed(2),
        priorBalance: priorBalance.toFixed(2),
        amountDue: priorBalance.plus(issued.total.toString()).toFixed(2),
        dueDate,
        unitId: inv.unitId,
        leaseId: inv.leaseId,
        billedPartyId: inv.billedPartyId,
        billingCycleId: inv.billingCycleId,
        isFinal: inv.isFinal,
        hasAboveCapLine: inv.hasAboveCapLine,
      },
    });
    return issued;
  }

  /** The invoice snapshot of schema-design §4.2.3 (resident surfaces render from it, D-040). */
  private async snapshot(
    tx: Tx,
    inv: InvoiceRow,
    meta: {
      issuedAt: Date;
      dueDate: string;
      number: string;
      prior: { id: string; number: string | null; balance: string }[];
      priorBalance: string;
    },
  ): Promise<Record<string, unknown>> {
    const scope = { tenantId: inv.tenantId };
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: inv.tenantId } });
    const building = await tx.building.findUniqueOrThrow({ where: { id: inv.buildingId } });
    const accounts = await tx.utilityAccount.findMany({ where: { buildingId: inv.buildingId } });
    const unit = inv.unitId ? await tx.unit.findUniqueOrThrow({ where: { id: inv.unitId } }) : null;
    const party = await tx.party.findUniqueOrThrow({ where: { id: inv.billedPartyId } });
    const lease = inv.leaseId
      ? await tx.lease.findUniqueOrThrow({
          where: { id: inv.leaseId },
          include: { lines: true, parties: { include: { party: { select: { displayName: true } } } } },
        })
      : null;
    const bank = await tx.tenantBankAccount.findFirst({
      where: { tenantId: inv.tenantId, isDefault: true, state: 'active' },
      select: { accountNoMasked: true, bankCode: true, bankNameTh: true, accountName: true },
    });
    const readingIds = new Set<string>();
    for (const l of inv.lines)
      for (const s of (l.meterSegments ?? []) as unknown as MeterSegment[]) {
        if (s.from.readingId) readingIds.add(s.from.readingId);
        if (s.to?.readingId) readingIds.add(s.to.readingId);
      }
    const readings = await tx.meterReading.findMany({ where: { id: { in: [...readingIds] } } });
    const readingOf = (id: string | null) => {
      const r = id ? readings.find((x) => x.id === id) : null;
      return r
        ? {
            id: r.id,
            register: r.register.toFixed(3),
            readAt: toBangkokIso(r.readAt),
            source: r.source,
            confidence: r.confidence.toFixed(3),
            quality: r.quality,
            evidenceDocumentId: r.evidenceDocumentId,
            estimateBasis: r.estimateBasis,
          }
        : null;
    };
    const rpvIds = [
      ...new Set(inv.lines.map((l) => l.ratePlanVersionId).filter((x): x is string => Boolean(x))),
    ];
    const utvIds = [
      ...new Set(inv.lines.map((l) => l.utilityTariffVersionId).filter((x): x is string => Boolean(x))),
    ];
    const rpvs = await tx.ratePlanVersion.findMany({ where: { id: { in: rpvIds } } });
    const utvs = await tx.utilityTariffVersion.findMany({
      where: { id: { in: utvIds } },
      include: { utilityTariff: true },
    });
    const acks = await tx.complianceAcknowledgement.findMany({
      where: {
        id: {
          in: inv.lines.map((l) => l.complianceAcknowledgementId).filter((x): x is string => Boolean(x)),
        },
      },
    });
    const settingAt = async (key: string) => {
      const v = await this.settings.at(key, meta.issuedAt, {
        ...scope,
        propertyId: building.propertyId,
      });
      return v ? { value: v.value, effectiveFrom: toBangkokIso(v.effectiveFrom), scope: v.scope } : null;
    };
    const meters = inv.lines
      .filter((l) => l.sourceType === 'meter')
      .map((l) => {
        const segments = (l.meterSegments ?? []) as unknown as MeterSegment[];
        const rpv = rpvs.find((v) => v.id === l.ratePlanVersionId);
        const utv = utvs.find((v) => v.id === l.utilityTariffVersionId);
        const ack = acks.find((a) => a.id === l.complianceAcknowledgementId);
        return {
          lineNo: l.lineNo,
          lineKind: l.lineKind,
          sourceType: l.sourceType,
          assetItemId: l.assetItemId,
          segments: segments.map((s) => ({
            assignmentId: s.assignmentId,
            code: s.code,
            multiplier: s.multiplier,
            fromReading: readingOf(s.from.readingId) ?? {
              register: s.from.register,
              readAt: s.from.readAt,
              source: s.from.source,
            },
            toReading: s.to
              ? (readingOf(s.to.readingId) ?? {
                  register: s.to.register,
                  readAt: s.to.readAt,
                  source: s.to.source,
                })
              : null,
          })),
          units: l.units?.toFixed(3) ?? null,
          isEstimated: l.isEstimated,
          ratePlanVersion: rpv
            ? { id: rpv.id, effectiveFrom: day(rpv.effectiveFrom), tiers: rpv.tiers, basis: rpv.basis }
            : null,
          utilityTariffVersion: utv
            ? {
                id: utv.id,
                provider: utv.utilityTariff.provider,
                tariffCode: utv.utilityTariff.tariffCode,
                effectiveFrom: day(utv.effectiveFrom),
                structure: utv.structure,
              }
            : null,
          capPerUnit: l.capPerUnit?.toFixed(4) ?? null,
          pricePerUnit: l.unitPrice?.toFixed(4) ?? null,
          amount: l.amount.toFixed(2),
          tierBreakdown: l.tierBreakdown,
          compliance: {
            rules: l.complianceRuleIds,
            aboveCap: l.aboveCap,
            acknowledgement: ack
              ? { id: ack.id, by: ack.acknowledgedBy, at: toBangkokIso(ack.acknowledgedAt), shown: ack.shown }
              : null,
          },
        };
      });
    const draftExtra = (inv.snapshot as { draft?: { advanceRent?: unknown } } | null)?.draft ?? {};
    return {
      schemaVersion: 2,
      issuedAt: toBangkokIso(meta.issuedAt),
      number: meta.number,
      dueDate: meta.dueDate,
      tenant: {
        id: tenant.id,
        type: tenant.type,
        legalName: tenant.legalName,
        displayName: tenant.displayName,
        taxId: tenant.taxId,
        vatRegistered: tenant.vatRegistered,
        address: tenant.address,
        bankAccount: bank
          ? {
              bankCode: bank.bankCode,
              bankName: bank.bankNameTh,
              accountName: bank.accountName,
              masked: bank.accountNoMasked,
            }
          : null,
      },
      building: {
        id: building.id,
        name: building.name,
        code: building.code,
        ownerTenantId: building.ownerTenantId,
        operatorTenantId: building.operatorTenantId,
        providers: Object.fromEntries(accounts.map((a) => [a.utility, a.provider])),
      },
      unit: unit
        ? {
            id: unit.id,
            unitNo: unit.unitNo,
            type: unit.type,
            areaSqm: unit.areaSqm?.toFixed(2) ?? null,
            ownershipRatio: unit.ownershipRatio?.toFixed(6) ?? null,
          }
        : null,
      billedParty: { id: party.id, displayName: party.displayName, type: party.type },
      lease: lease
        ? {
            id: lease.id,
            number: lease.number,
            version: lease.version,
            rent: lease.rent.toFixed(2),
            utilityBillingMode: lease.utilityBillingMode,
            lines: lease.lines.map((l) => ({
              id: l.id,
              kind: l.kind,
              description: l.description,
              amount: l.amount.toFixed(2),
              recurrence: l.recurrence,
            })),
            parties: lease.parties.map((p) => ({
              partyId: p.partyId,
              displayName: p.party.displayName,
              role: p.role,
            })),
          }
        : null,
      period: { start: day(inv.periodStart), end: day(inv.periodEnd), isFinal: inv.isFinal },
      lines: inv.lines.map((l) => ({
        lineNo: l.lineNo,
        sourceType: l.sourceType,
        lineKind: l.lineKind,
        description: l.description,
        quantity: l.quantity.toFixed(3),
        unit: l.unit,
        unitPrice: l.unitPrice?.toFixed(4) ?? null,
        amount: l.amount.toFixed(2),
        periodFrom: l.periodFrom ? day(l.periodFrom) : null,
        periodTo: l.periodTo ? day(l.periodTo) : null,
        proRata: l.proRata,
        vatApplicable: l.vatApplicable,
      })),
      meters,
      settings: {
        'billing.cutoff': await settingAt('billing.cutoff'),
        'billing.estimate_policy': await settingAt('billing.estimate_policy'),
        'compliance.tariff_cap.severity': await settingAt('compliance.tariff_cap.severity'),
        'late_fee.enabled': await settingAt('late_fee.enabled'),
        'invoice.min_lead_days': await settingAt('invoice.min_lead_days'),
        'tax.vat': await settingAt('tax.vat'),
      },
      priorBalance: { amount: meta.priorBalance, invoices: meta.prior },
      ...draftExtra,
      totals: {
        subtotal: inv.subtotal.toFixed(2),
        vat: inv.vatAmount.toFixed(2),
        total: inv.total.toFixed(2),
        amountDue: D(meta.priorBalance).plus(inv.total.toString()).toFixed(2),
        rounding: 'half_up_satang_per_line',
      },
      documentTemplate: { key: 'invoice_a4_th', version: 1 },
      engine: { version: ENGINE_VERSION, gitSha: this.config.get('GIT_COMMIT') ?? null },
    };
  }

  // ------------------------------------------------------------------------------------------- balance

  /**
   * Applies a change of what was paid, credited or debited to an issued invoice and recomputes its balance and
   * status (D-044); records `invoice.balance_changed` (and `invoice.paid` / `invoice.partially_paid`).
   */
  async applyBalance(
    tx: Tx,
    invoiceId: string,
    delta: { paid?: Decimal.Value; credited?: Decimal.Value; debited?: Decimal.Value; at?: Date },
    reason: string,
  ): Promise<Invoice> {
    await tx.$queryRaw`SELECT id FROM ops.invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!inv.issuedAt || inv.status === 'void')
      throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
    const paid = D(inv.paidTotal.toString()).plus(delta.paid ?? 0);
    const credited = D(inv.creditedTotal.toString()).plus(delta.credited ?? 0);
    const debited = D(inv.debitedTotal.toString()).plus(delta.debited ?? 0);
    const balance = Decimal.max(0, D(inv.total.toString()).plus(debited).minus(credited).minus(paid));
    const now = delta.at ?? this.clock.now();
    const status = statusFor(
      { ...inv, balance, paidTotal: paid, creditedTotal: credited },
      bangkokDate(this.clock.now()),
    );
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidTotal: paid.toFixed(2),
        creditedTotal: credited.toFixed(2),
        debitedTotal: debited.toFixed(2),
        balance: balance.toFixed(2),
        status,
        ...(delta.paid && D(delta.paid).gt(0) ? { lastPaymentAt: now } : {}),
        ...(status === 'overdue' && !inv.overdueSince ? { overdueSince: inv.dueDate } : {}),
        version: { increment: 1 },
      },
    });
    const payload = {
      invoiceId,
      number: inv.number,
      reason,
      status,
      previousStatus: inv.status,
      balance: balance.toFixed(2),
      paidTotal: paid.toFixed(2),
      unitId: inv.unitId,
      leaseId: inv.leaseId,
      billedPartyId: inv.billedPartyId,
    };
    await this.events.record(tx, {
      type: 'invoice.balance_changed',
      aggregateType: 'invoice',
      aggregateId: invoiceId,
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      payload,
    });
    if (status !== inv.status && (status === 'paid' || status === 'partially_paid'))
      await this.events.record(tx, {
        type: status === 'paid' ? 'invoice.paid' : 'invoice.partially_paid',
        aggregateType: 'invoice',
        aggregateId: invoiceId,
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        payload,
      });
    return updated;
  }

  // ------------------------------------------------------------------------------------------- corrections

  /**
   * Voids an issued invoice that nothing was paid on and no note references (D-040); it keeps its number. With
   * `reissue`, the period is recomputed into a replacement draft (`replaces_invoice_id`) by the caller.
   */
  async voidInvoice(ctx: TenantContext, id: string, input: { reason: string }): Promise<InvoiceRow> {
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.invoice WHERE id = ${id}::uuid FOR UPDATE`;
      const inv = await this.load(tx, ctx, id);
      if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (inv.status === 'draft')
        throw new DomainException('invoice.invalid_state', { params: { status: 'draft' } });
      if (inv.status === 'void') return inv;
      if (inv.paidTotal.gt(0) || inv.creditNotes.length || inv.debitNotes.length)
        throw new DomainException('invoice.has_payments');
      const now = this.clock.now();
      await tx.invoice.update({
        where: { id },
        data: {
          status: 'void',
          voidedAt: now,
          voidReason: input.reason,
          voidedBy: by(),
          balance: '0.00',
          version: { increment: 1 },
        },
      });
      // queued one-offs return to the queue; open estimate settlements of the voided lines go away with it
      await tx.invoiceCharge.updateMany({
        where: { appliedLine: { invoiceId: id } },
        data: { status: 'pending', appliedInvoiceLineId: null, updatedBy: by() },
      });
      await tx.estimateSettlement.deleteMany({
        where: { estimatedLine: { invoiceId: id }, status: 'pending' },
      });
      await tx.estimateSettlement.updateMany({
        where: { settledLine: { invoiceId: id } },
        data: {
          status: 'pending',
          settledInvoiceLineId: null,
          actualReadingId: null,
          actualUnits: null,
          deltaUnits: null,
          deltaAmount: null,
          settledAt: null,
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'invoice.voided',
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        subjectType: 'ops.invoice',
        subjectId: id,
        metadata: { number: inv.number, reason: input.reason, total: inv.total.toFixed(2) },
      });
      await this.events.record(tx, {
        type: 'invoice.voided',
        aggregateType: 'invoice',
        aggregateId: id,
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        payload: {
          invoiceId: id,
          number: inv.number,
          reason: input.reason,
          unitId: inv.unitId,
          leaseId: inv.leaseId,
          billedPartyId: inv.billedPartyId,
          total: inv.total.toFixed(2),
        },
      });
      return this.load(tx, ctx, id);
    });
  }

  /** Credit or debit note against an issued invoice (D-040): numbered, its lines, the balance re-opened or reduced. */
  async note(
    ctx: TenantContext,
    kind: 'credit' | 'debit',
    invoiceId: string,
    input: {
      reason: NoteReason;
      reasonText: string;
      lines: {
        refInvoiceLineId?: string | null;
        lineKind?: InvoiceLineKind;
        description: string;
        amount: string;
      }[];
    },
  ): Promise<InvoiceRow> {
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const inv = await this.load(tx, ctx, invoiceId);
      if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (!inv.issuedAt || inv.status === 'void')
        throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
      if (!input.lines.length)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'lines', code: 'min', message: 'at least one line' }],
        });
      const lines = input.lines.map((l, i) => {
        const ref = l.refInvoiceLineId ? inv.lines.find((x) => x.id === l.refInvoiceLineId) : null;
        if (l.refInvoiceLineId && !ref) throw new DomainException('http.not_found');
        if (!D(l.amount).gt(0))
          throw new DomainException('validation.failed', {
            errors: [{ path: `lines[${i}].amount`, code: 'min', message: 'a positive amount' }],
          });
        return {
          lineNo: i + 1,
          lineKind: ref?.lineKind ?? l.lineKind ?? 'one_off',
          description: l.description,
          amount: D(l.amount).toFixed(2),
          refInvoiceLineId: ref?.id ?? null,
        };
      });
      const total = lines.reduce((s, l) => s.plus(l.amount), D(0));
      if (kind === 'credit') {
        const creditable = D(inv.total.toString())
          .plus(inv.debitedTotal.toString())
          .minus(inv.creditedTotal.toString());
        if (total.gt(creditable))
          throw new DomainException('invoice.credit_exceeds', {
            params: { creditable: creditable.toFixed(2) },
          });
        for (const l of lines.filter((x) => x.refInvoiceLineId)) {
          const ref = inv.lines.find((x) => x.id === l.refInvoiceLineId)!;
          if (D(l.amount).gt(ref.amount.abs().toString()))
            throw new DomainException('invoice.credit_exceeds', {
              params: { creditable: ref.amount.toFixed(2) },
            });
        }
      }
      const now = this.clock.now();
      const number = await this.numbering.next(
        tx,
        inv.tenantId,
        kind === 'credit' ? 'credit_note' : 'debit_note',
        now,
      );
      const data = {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        unitId: inv.unitId,
        invoiceId,
        number,
        reason: input.reason,
        reasonText: input.reasonText,
        subtotal: total.toFixed(2),
        vatAmount: '0.00',
        total: total.toFixed(2),
        issuedAt: now,
        issuedBy: by(),
        createdBy: by(),
      };
      const lineData = (noteId: string) =>
        lines.map((l) => ({
          tenantId: inv.tenantId,
          noteId,
          lineNo: l.lineNo,
          lineKind: l.lineKind,
          description: l.description,
          quantity: '1.000',
          unitPrice: l.amount,
          amount: l.amount,
          refInvoiceLineId: l.refInvoiceLineId,
        }));
      let noteId: string;
      if (kind === 'credit') {
        const n = await tx.creditNote.create({ data });
        await tx.creditNoteLine.createMany({ data: lineData(n.id) });
        noteId = n.id;
      } else {
        const n = await tx.debitNote.create({ data });
        await tx.debitNoteLine.createMany({ data: lineData(n.id) });
        noteId = n.id;
      }
      await this.applyBalance(
        tx,
        invoiceId,
        kind === 'credit' ? { credited: total } : { debited: total },
        `${kind}_note:${number}`,
      );
      await this.audit.record(tx, {
        action: kind === 'credit' ? 'credit_note.issued' : 'debit_note.issued',
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        subjectType: kind === 'credit' ? 'ops.credit_note' : 'ops.debit_note',
        subjectId: noteId,
        metadata: { number, invoiceNumber: inv.number, total: total.toFixed(2), reason: input.reason },
      });
      await this.events.record(tx, {
        type: kind === 'credit' ? 'credit_note.issued' : 'debit_note.issued',
        aggregateType: kind === 'credit' ? 'credit_note' : 'debit_note',
        aggregateId: noteId,
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        payload: {
          noteId,
          number,
          invoiceId,
          invoiceNumber: inv.number,
          total: total.toFixed(2),
          unitId: inv.unitId,
          billedPartyId: inv.billedPartyId,
          leaseId: inv.leaseId,
        },
      });
      return this.load(tx, ctx, invoiceId);
    });
  }

  // ------------------------------------------------------------------------------------------- one-off charges

  async queueCharge(
    ctx: TenantContext,
    input: {
      unitId: string;
      partyId?: string | null;
      leaseId?: string | null;
      lineKind: 'one_off' | 'discount';
      description: string;
      quantity?: string;
      unitPrice: string;
    },
  ) {
    const lineKind = input.lineKind;
    const quantity = D(input.quantity ?? '1');
    const unitPrice = D(input.unitPrice)
      .abs()
      .times(lineKind === 'discount' ? -1 : 1);
    const amount = quantity.times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const renewal = evaluateNoRenewalFee({
      lines: [{ path: 'description', description: input.description }],
    });
    if (renewal.violated)
      await this.gate.enforce(ctx, {
        subjectType: 'ops.unit',
        subjectId: input.unitId,
        checks: [renewal],
        refuseWarnings: true,
      });
    return this.db.tenant(ctx, async (tx) => {
      const unit = this.found(await tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null } }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId))
        throw new DomainException('http.not_found');
      let partyId = input.partyId ?? null;
      let leaseId = input.leaseId ?? null;
      if (leaseId) {
        const lease = this.found(
          await tx.lease.findFirst({ where: this.own(ctx, { id: leaseId, unitId: unit.id }) }),
        );
        partyId ??= lease.lesseePartyId;
      }
      if (!partyId) {
        const current = await tx.unitDetail.findUnique({
          where: { unitId: unit.id },
          select: { currentLeaseId: true },
        });
        const lease = current?.currentLeaseId
          ? await tx.lease.findFirst({ where: { id: current.currentLeaseId } })
          : null;
        if (!lease)
          throw new DomainException('validation.failed', {
            errors: [
              { path: 'partyId', code: 'required', message: 'the unit has no lessee: name the party' },
            ],
          });
        partyId = lease.lesseePartyId;
        leaseId = lease.id;
      }
      this.found(await tx.party.findFirst({ where: { id: partyId, deletedAt: null } }));
      const charge = await tx.invoiceCharge.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId: unit.id,
          partyId,
          leaseId,
          sourceType: sourceTypeOf(lineKind),
          lineKind,
          description: input.description,
          quantity: quantity.toFixed(3),
          unitPrice: unitPrice.toFixed(4),
          amount: amount.toFixed(2),
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'invoice.charge_added',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'ops.invoice_charge',
        subjectId: charge.id,
        after: { description: charge.description, amount: charge.amount.toFixed(2), lineKind },
      });
      await this.events.record(tx, {
        type: 'invoice_charge.queued',
        aggregateType: 'invoice_charge',
        aggregateId: charge.id,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: { chargeId: charge.id, unitId: unit.id, partyId, amount: charge.amount.toFixed(2) },
      });
      return charge;
    });
  }

  listCharges(ctx: TenantContext, q: { unitId?: string; status?: 'pending' | 'applied' | 'cancelled' }) {
    return this.db.tenant(ctx, (tx) =>
      tx.invoiceCharge.findMany({
        where: this.own(ctx, {
          ...(q.unitId ? { unitId: q.unitId } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] as string[] } } : {}),
        }),
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  async cancelCharge(ctx: TenantContext, id: string, reason: string) {
    return this.db.tenant(ctx, async (tx) => {
      const c = this.found(await tx.invoiceCharge.findFirst({ where: this.own(ctx, { id }) }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
        throw new DomainException('http.not_found');
      if (c.status !== 'pending')
        throw new DomainException('invoice.invalid_state', { params: { status: c.status } });
      const updated = await tx.invoiceCharge.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: this.clock.now(), cancelReason: reason, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'invoice.charge_cancelled',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'ops.invoice_charge',
        subjectId: id,
        metadata: { reason },
      });
      return updated;
    });
  }

  /** Used by the system (worker) — a context for the invoice's tenant. */
  static systemCtx(tenantId: string): TenantContext {
    return systemTenantContext(tenantId);
  }
}

function nextMonth(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
