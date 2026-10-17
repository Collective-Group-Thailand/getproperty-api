import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceAcknowledgementService } from '@core/compliance/compliance-acknowledgement.service';
import { ComplianceGate } from '@core/compliance/compliance-gate.service';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { WorkflowService } from '@core/workflow/workflow.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type DeductionKind,
  type DepositStatus,
  type Lease,
  type Prisma,
  type RefundMethod,
  type WearCategory,
} from '@generated/prisma/client';
import { LeasesService } from '@modules/ops-leases/leases.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { DepositDocuments } from './deposit-documents';
import {
  checkDeductionEvidence,
  checkDeductionWear,
  checkRefund,
  EVIDENCE_KINDS,
  proposedRefund,
} from './deposit-rules';
import { type InspectionRow, InspectionsService } from './inspections.service';

const by = () => userIdOf(RequestContext.actor());

export const DEPOSIT_INCLUDE = {
  lease: {
    select: {
      id: true,
      number: true,
      status: true,
      lesseePartyId: true,
      lessee: { select: { id: true, displayName: true } },
      unit: { select: { id: true, unitNo: true } },
      moveOutAt: true,
    },
  },
  settlement: {
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      workflowInstance: { select: { id: true, state: true, slaDueAt: true, slaBreachedAt: true } },
    },
  },
} as const satisfies Prisma.DepositInclude;
export type DepositRow = Prisma.DepositGetPayload<{ include: typeof DEPOSIT_INCLUDE }>;

export interface DeductionCreate {
  kind: DeductionKind;
  description: string;
  amount: string;
  wearCategory?: WearCategory;
  inspectionItemId?: string | null;
  evidenceDocumentIds?: string[];
}

/** What the owner may do next with a deposit (UI next actions). */
export function depositNextActions(d: DepositRow): string[] {
  if (d.status === 'pending') return ['record-receipt'];
  const s = d.settlement;
  if (!s) return [];
  switch (s.status) {
    case 'opened':
    case 'inspected':
      return ['add-deduction', 'propose'];
    case 'proposed':
      return ['revise'];
    case 'disputed':
      return ['add-deduction', 'propose', 'record-refund'];
    case 'agreed':
      return ['record-refund'];
    default:
      return [];
  }
}

/**
 * Deposits and the 7-day settlement (B2.4, D-023, D-159). A lease activation opens its deposit (`pending`, or `held`
 * when a renewal carries the old deposit over); the office records the receipt (`deposit_receipt` series + PDF).
 * The end of the lease opens the settlement on a `deposit_settlement` workflow instance whose clock starts at the
 * move-out (deadline = move-out + `deposit.refund_days`, reminders T-3 / T-1, breach = late) and schedules the
 * move-out inspection. The owner itemises deductions — damage and missing items need the move-out inspection item
 * and a photo (`compliance.deposit_evidence`), normal wear is never deducted (`compliance.deposit_wear`) — and
 * proposes; the resident accepts or disputes in the LIFF; the refund (bank transfer with its slip) closes it with the
 * statement (`deposit_statement` series + PDF). A refund after the deadline, or the SLA breach, flags `is_late`,
 * writes an audit row and a `compliance.deposit_deadline` evaluation.
 */
@Injectable()
export class DepositsService extends TenantScopedRepository implements OnModuleInit {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEvents,
    private readonly gate: ComplianceGate,
    private readonly acknowledgements: ComplianceAcknowledgementService,
    private readonly workflows: WorkflowService,
    private readonly documents: DocumentsService,
    private readonly numbering: DocumentNumbering,
    private readonly renderer: DepositDocuments,
    private readonly leases: LeasesService,
    private readonly inspections: InspectionsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.leases.onActivated((tx, lease) => this.openDeposit(tx, lease));
    this.leases.onEnded((tx, lease, moveOutAt) => this.openSettlement(tx, lease, moveOutAt));
    this.inspections.onCompleted((tx, inspection) => this.inspected(tx, inspection));
    this.workflows.registerGuard(
      'deductions_have_evidence',
      (_instance, data) => data.allHaveEvidence === true,
    );
  }

  private async event(
    tx: Tx,
    d: { id: string; tenantId: string; buildingId: string; leaseId: string },
    type:
      | 'deposit.opened'
      | 'deposit.received'
      | 'deposit.settlement_opened'
      | 'deposit.settlement_proposed'
      | 'deposit.settlement_accepted'
      | 'deposit.settlement_disputed'
      | 'deposit.refunded'
      | 'deposit.settlement_late',
    payload: Record<string, unknown> = {},
  ) {
    await this.domainEvents.record(tx, {
      type,
      aggregateType: 'deposit',
      aggregateId: d.id,
      tenantId: d.tenantId,
      buildingId: d.buildingId,
      payload: { depositId: d.id, leaseId: d.leaseId, ...payload },
    });
  }

  // ------------------------------------------------------------------------------------------- lifecycle hooks

  /** Lease activated (D-173): the deposit is expected; a renewal carries the previous lease's deposit over. */
  async openDeposit(tx: Tx, lease: Lease): Promise<void> {
    if (await tx.deposit.findUnique({ where: { leaseId: lease.id } })) return;
    const carriedFrom = (lease.terms as { depositCarriedOverFrom?: string } | null)?.depositCarriedOverFrom;
    const previous = carriedFrom
      ? await tx.deposit.findFirst({ where: { leaseId: carriedFrom, status: { in: ['held', 'pending'] } } })
      : null;
    const now = this.clock.now();
    const deposit = await tx.deposit.create({
      data: {
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        unitId: lease.unitId,
        leaseId: lease.id,
        amountSecurity: lease.depositAmount,
        amountAdvanceRent: lease.advanceRentAmount,
        ...(previous && previous.status === 'held'
          ? {
              status: 'held',
              receivedAt: previous.receivedAt,
              heldAt: now,
              carriedFromDepositId: previous.id,
              receiptNumber: null,
            }
          : {}),
        createdBy: by(),
      },
    });
    await this.event(tx, deposit, 'deposit.opened', {
      security: deposit.amountSecurity.toFixed(2),
      advanceRent: deposit.amountAdvanceRent.toFixed(2),
      carriedFromDepositId: deposit.carriedFromDepositId,
    });
  }

  /**
   * Lease ended or terminated: the settlement opens with its clock from the move-out (D-023) and the move-out
   * inspection is scheduled for staff. A deposit carried over to a renewal, or never received, has nothing to settle.
   */
  async openSettlement(tx: Tx, lease: Lease, moveOutAt: Date): Promise<void> {
    const deposit = await tx.deposit.findUnique({
      where: { leaseId: lease.id },
      include: { carriedTo: true },
    });
    if (!deposit || deposit.status !== 'held') return;
    if (deposit.carriedTo.some((d) => d.status === 'held')) {
      await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          settledAt: this.clock.now(),
          deductionsSummary: { carriedOverTo: deposit.carriedTo.map((d) => d.id) },
          version: { increment: 1 },
        },
      });
      return;
    }
    const now = this.clock.now();
    const id = uuidv7(now.getTime());
    const instance = await this.workflows.start(tx, {
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.deposit_settlement',
      subjectId: id,
      definitionKey: 'deposit_settlement',
      context: { depositId: deposit.id, leaseId: lease.id },
      clockStart: moveOutAt,
    });
    const moveIn = await tx.inspection.findFirst({ where: { leaseId: lease.id, type: 'move_in' } });
    let moveOut = await tx.inspection.findFirst({ where: { leaseId: lease.id, type: 'move_out' } });
    moveOut ??= await this.inspections.createIn(tx, lease.tenantId, { leaseId: lease.id, type: 'move_out' });
    await tx.depositSettlement.create({
      data: {
        id,
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        unitId: lease.unitId,
        depositId: deposit.id,
        leaseId: lease.id,
        workflowInstanceId: instance.id,
        openedAt: now,
        moveOutAt,
        deadlineAt: instance.slaDueAt!,
        moveInInspectionId: moveIn?.id ?? null,
        moveOutInspectionId: moveOut.id,
        depositHeld: deposit.amountSecurity,
        createdBy: by(),
      },
    });
    await tx.deposit.update({
      where: { id: deposit.id },
      data: { status: 'settling', version: { increment: 1 } },
    });
    await this.event(tx, deposit, 'deposit.settlement_opened', {
      settlementId: id,
      deadlineAt: instance.slaDueAt!.toISOString(),
      moveOutInspectionId: moveOut.id,
    });
  }

  /** A completed move-out inspection moves an open settlement to `inspected`. */
  private async inspected(tx: Tx, inspection: InspectionRow): Promise<void> {
    if (inspection.type !== 'move_out' || !inspection.leaseId) return;
    const s = await tx.depositSettlement.findFirst({
      where: { leaseId: inspection.leaseId, status: 'opened' },
    });
    if (!s) return;
    await this.workflows.transition(tx, s.workflowInstanceId, 'inspect', { inspectionId: inspection.id });
    await tx.depositSettlement.update({
      where: { id: s.id },
      data: { status: 'inspected', moveOutInspectionId: inspection.id, version: { increment: 1 } },
    });
  }

  // ------------------------------------------------------------------------------------------- reads

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<DepositRow> {
    const d = this.found(await tx.deposit.findFirst({ where: { id }, include: DEPOSIT_INCLUDE }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(d.buildingId))
      throw new DomainException('http.not_found');
    return d;
  }

  private async ownDeposit(tx: Tx, ctx: TenantContext, id: string): Promise<DepositRow> {
    const d = await this.load(tx, ctx, id);
    if (d.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
    return d;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: {
      status?: DepositStatus;
      buildingId?: string;
      late?: boolean;
      leaseId?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.DepositWhereInput = {
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.leaseId ? { leaseId: q.leaseId } : {}),
        ...(q.late !== undefined ? { settlement: { isLate: q.late } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.deposit.findMany({
          where,
          include: DEPOSIT_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.deposit.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** Dashboard counter: deposits per status, settlements due within 3 days, overdue, late refunds. */
  summary(ctx: TenantContext) {
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const scope: Prisma.DepositSettlementWhereInput = ctx.buildingIds
        ? { buildingId: { in: [...ctx.buildingIds] } }
        : {};
      const open: Prisma.DepositSettlementWhereInput = {
        ...scope,
        status: { notIn: ['refunded', 'closed'] },
      };
      const [byStatus, dueSoon, overdue, lateRefunded] = await Promise.all([
        tx.deposit.groupBy({
          by: ['status'],
          where: ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {},
          _count: { _all: true },
        }),
        tx.depositSettlement.count({
          where: { ...open, deadlineAt: { gte: now, lte: new Date(now.getTime() + 3 * 86_400_000) } },
        }),
        tx.depositSettlement.count({ where: { ...open, deadlineAt: { lt: now } } }),
        tx.depositSettlement.count({
          where: { ...scope, isLate: true, status: { in: ['refunded', 'closed'] } },
        }),
      ]);
      return {
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        settlementsDueSoon: dueSoon,
        settlementsOverdue: overdue,
        lateRefunds: lateRefunded,
      };
    });
  }

  comparison(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const d = await this.load(tx, ctx, id);
      return this.inspections.comparison(tx, d.leaseId);
    });
  }

  // ------------------------------------------------------------------------------------------- receipt

  /** The deposit and advance rent were received (cash/transfer at signing; payments arrive in B4.4). */
  async recordReceipt(
    ctx: TenantContext,
    id: string,
    input: { receivedAt?: string; reference?: string | null },
  ) {
    return this.db.tenant(
      ctx,
      async (tx) => {
        const d = await this.ownDeposit(tx, ctx, id);
        if (d.status !== 'pending')
          throw new DomainException('deposit.invalid_state', { params: { status: d.status } });
        const now = this.clock.now();
        const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
        if (receivedAt.getTime() > now.getTime() + 60_000)
          throw new DomainException('validation.failed', {
            errors: [{ path: 'receivedAt', code: 'max', message: 'cannot be in the future' }],
          });
        const number = await this.numbering.next(tx, d.tenantId, 'deposit_receipt', now);
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: d.tenantId },
          select: { displayName: true },
        });
        const pdf = await this.renderer.receipt({
          number,
          tenantName: tenant.displayName,
          lessee: d.lease.lessee.displayName,
          unit: d.lease.unit.unitNo,
          contractNumber: d.lease.number,
          receivedOn: bangkokDate(receivedAt),
          security: d.amountSecurity.toFixed(2),
          advanceRent: d.amountAdvanceRent.toFixed(2),
          reference: input.reference ?? null,
        });
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: d.tenantId,
          kind: 'pdf_receipt',
          scopeType: 'unit',
          scopeId: d.unitId,
          buildingId: d.buildingId,
          title: `ใบรับเงินประกัน ${number}.pdf`,
          mimeType: 'application/pdf',
          body: pdf,
        });
        await tx.deposit.update({
          where: { id },
          data: {
            status: 'held',
            receivedAt,
            heldAt: now,
            receiptNumber: number,
            receiptDocumentId: doc.id,
            receiptReference: input.reference ?? null,
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'deposit.received',
          tenantId: d.tenantId,
          buildingId: d.buildingId,
          subjectType: 'ops.deposit',
          subjectId: id,
          metadata: {
            number,
            security: d.amountSecurity.toFixed(2),
            advanceRent: d.amountAdvanceRent.toFixed(2),
          },
        });
        await this.event(tx, d, 'deposit.received', { number });
        return this.load(tx, ctx, id);
      },
      { timeout: 60_000 },
    );
  }

  // ------------------------------------------------------------------------------------------- settlement

  private settlementOf(d: DepositRow) {
    if (!d.settlement) throw new DomainException('deposit.invalid_state', { params: { status: d.status } });
    return d.settlement;
  }

  private assertSettlement(s: { status: string }, allowed: string[]) {
    if (!allowed.includes(s.status))
      throw new DomainException('deposit.invalid_state', { params: { status: s.status } });
  }

  private async recomputeTotal(tx: Tx, settlementId: string) {
    const sum = await tx.depositSettlementItem.aggregate({ where: { settlementId }, _sum: { amount: true } });
    await tx.depositSettlement.update({
      where: { id: settlementId },
      data: { deductionsTotal: sum._sum.amount ?? 0, version: { increment: 1 } },
    });
  }

  /**
   * An itemised deduction (D-023): checked by the compliance gate first — `compliance.deposit_wear` (normal wear)
   * and `compliance.deposit_evidence` (inspection item + photo for damage / missing items, evidence for the rest).
   */
  async addDeduction(ctx: TenantContext, id: string, input: DeductionCreate) {
    const d = await this.db.tenant(ctx, (tx) => this.ownDeposit(tx, ctx, id));
    const s = this.settlementOf(d);
    this.assertSettlement(s, ['opened', 'inspected', 'disputed']);
    const evidence = await this.db.tenant(ctx, async (tx) => {
      const unique = [...new Set(input.evidenceDocumentIds ?? [])];
      if (unique.length) {
        const n = await tx.document.count({
          where: this.own(ctx, { id: { in: unique }, deletedAt: null, uploadState: { not: 'presigned' } }),
        });
        if (n !== unique.length) throw new DomainException('http.not_found');
      }
      const item = input.inspectionItemId
        ? await tx.inspectionItem.findFirst({
            where: { id: input.inspectionItemId, inspection: { leaseId: d.leaseId, type: 'move_out' } },
          })
        : null;
      if (input.inspectionItemId && !item) throw new DomainException('http.not_found');
      return { unique, item };
    });
    const deduction = {
      kind: input.kind,
      wearCategory: input.wearCategory ?? 'damage',
      evidenceCount: evidence.unique.length,
      inspectionItem: evidence.item
        ? { condition: evidence.item.condition, photoCount: evidence.item.photoDocumentIds.length }
        : null,
    };
    await this.gate.enforce(ctx, {
      subjectType: 'ops.deposit_settlement',
      subjectId: s.id,
      buildingId: d.buildingId,
      checks: [checkDeductionWear(deduction), checkDeductionEvidence(deduction)],
      refuseWarnings: true,
    });
    return this.db.tenant(ctx, async (tx) => {
      const fresh = await this.ownDeposit(tx, ctx, id);
      this.assertSettlement(this.settlementOf(fresh), ['opened', 'inspected', 'disputed']);
      // damage evidence = the photos attached here, else the inspection item's photos
      const photos =
        evidence.unique.length || !evidence.item ? evidence.unique : evidence.item.photoDocumentIds;
      const item = await tx.depositSettlementItem.create({
        data: {
          tenantId: fresh.tenantId,
          settlementId: s.id,
          kind: input.kind,
          description: input.description,
          amount: new Decimal(input.amount).toFixed(2),
          inspectionItemId: evidence.item?.id ?? null,
          evidenceDocumentIds: photos,
          wearCategory: 'damage',
          createdBy: by(),
        },
      });
      await this.recomputeTotal(tx, s.id);
      await this.audit.record(tx, {
        action: 'deposit.deduction_added',
        tenantId: fresh.tenantId,
        buildingId: fresh.buildingId,
        subjectType: 'ops.deposit_settlement_item',
        subjectId: item.id,
        metadata: {
          depositId: id,
          kind: input.kind,
          amount: item.amount.toFixed(2),
          evidence: photos.length,
        },
      });
      return this.load(tx, ctx, id);
    });
  }

  async removeDeduction(ctx: TenantContext, id: string, itemId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const d = await this.ownDeposit(tx, ctx, id);
      const s = this.settlementOf(d);
      this.assertSettlement(s, ['opened', 'inspected', 'disputed']);
      const item = this.found(s.items.find((i) => i.id === itemId));
      await tx.depositSettlementItem.delete({ where: { id: item.id } });
      await this.recomputeTotal(tx, s.id);
      await this.audit.record(tx, {
        action: 'deposit.deduction_removed',
        tenantId: d.tenantId,
        buildingId: d.buildingId,
        subjectType: 'ops.deposit_settlement_item',
        subjectId: item.id,
        metadata: { depositId: id, amount: item.amount.toFixed(2) },
      });
      return this.load(tx, ctx, id);
    });
  }

  /** The owner proposes: refund = deposit − deductions − final utilities; the resident is notified (LIFF). */
  async propose(ctx: TenantContext, id: string, input: { utilitiesFinal?: string }) {
    return this.db.tenant(ctx, async (tx) => {
      const d = await this.ownDeposit(tx, ctx, id);
      const s = this.settlementOf(d);
      this.assertSettlement(s, ['opened', 'inspected', 'disputed']);
      const allHaveEvidence = s.items.every(
        (i) =>
          i.wearCategory !== 'normal_wear' &&
          (EVIDENCE_KINDS.includes(i.kind)
            ? i.evidenceDocumentIds.length > 0 && i.inspectionItemId
            : i.evidenceDocumentIds.length > 0),
      );
      await this.workflows.transition(tx, s.workflowInstanceId, 'propose', {
        allHaveEvidence,
        items: s.items.length,
      });
      const utilities = new Decimal(input.utilitiesFinal ?? s.utilitiesFinal.toString()).toFixed(2);
      const refund = proposedRefund(s.depositHeld.toString(), s.deductionsTotal.toString(), utilities);
      const now = this.clock.now();
      await tx.depositSettlement.update({
        where: { id: s.id },
        data: {
          status: 'proposed',
          utilitiesFinal: utilities,
          proposedRefund: refund,
          proposedAt: now,
          proposedBy: by(),
          residentResponse: null,
          residentRespondedAt: null,
          disputeReason: null,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await tx.depositSettlementItem.updateMany({
        where: { settlementId: s.id },
        data: { residentAccepted: null },
      });
      await this.audit.record(tx, {
        action: 'deposit.settlement_proposed',
        tenantId: d.tenantId,
        buildingId: d.buildingId,
        subjectType: 'ops.deposit_settlement',
        subjectId: s.id,
        metadata: {
          deductionsTotal: s.deductionsTotal.toFixed(2),
          utilitiesFinal: utilities,
          proposedRefund: refund,
        },
      });
      await this.event(tx, d, 'deposit.settlement_proposed', {
        settlementId: s.id,
        deductionsTotal: s.deductionsTotal.toFixed(2),
        utilitiesFinal: utilities,
        proposedRefund: refund,
        deadlineOn: bangkokDate(s.deadlineAt),
      });
      return this.load(tx, ctx, id);
    });
  }

  /** Withdraws a proposal the resident has not answered yet (back to `inspected`). */
  async revise(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const d = await this.ownDeposit(tx, ctx, id);
      const s = this.settlementOf(d);
      this.assertSettlement(s, ['proposed']);
      await this.workflows.transition(tx, s.workflowInstanceId, 'revise');
      await tx.depositSettlement.update({
        where: { id: s.id },
        data: {
          status: 'inspected',
          proposedRefund: null,
          proposedAt: null,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      return this.load(tx, ctx, id);
    });
  }

  /** The resident's answer from the LIFF: accept (agreed refund = proposed) or dispute with a reason. */
  async respond(
    ctx: TenantContext,
    id: string,
    input: { accept: boolean; reason?: string | null; partyId: string },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const d = await this.load(tx, ctx, id);
      const s = this.settlementOf(d);
      this.assertSettlement(s, ['proposed']);
      await this.workflows.transition(tx, s.workflowInstanceId, input.accept ? 'agree' : 'dispute', {
        partyId: input.partyId,
      });
      const now = this.clock.now();
      await tx.depositSettlement.update({
        where: { id: s.id },
        data: {
          status: input.accept ? 'agreed' : 'disputed',
          residentResponse: input.accept ? 'accepted' : 'disputed',
          residentRespondedAt: now,
          disputeReason: input.accept ? null : (input.reason ?? null),
          agreedRefund: input.accept ? s.proposedRefund : null,
          version: { increment: 1 },
        },
      });
      await tx.depositSettlementItem.updateMany({
        where: { settlementId: s.id },
        data: { residentAccepted: input.accept },
      });
      if (!input.accept)
        await tx.deposit.update({
          where: { id: d.id },
          data: { status: 'disputed', version: { increment: 1 } },
        });
      await this.audit.record(tx, {
        action: input.accept ? 'deposit.settlement_accepted' : 'deposit.settlement_disputed',
        tenantId: d.tenantId,
        buildingId: d.buildingId,
        subjectType: 'ops.deposit_settlement',
        subjectId: s.id,
        metadata: { partyId: input.partyId, reason: input.reason ?? null },
      });
      await this.event(tx, d, input.accept ? 'deposit.settlement_accepted' : 'deposit.settlement_disputed', {
        settlementId: s.id,
      });
      return this.load(tx, ctx, id);
    });
  }

  /**
   * The refund (D-023): at least what the settlement owes (`compliance.no_forfeiture`), a bank transfer with its slip
   * (`evidenceDocumentId`). Closes the workflow, numbers and stores the statement, and flags a late refund.
   */
  async recordRefund(
    ctx: TenantContext,
    id: string,
    input: {
      amount: string;
      method: RefundMethod;
      reference?: string | null;
      refundedAt?: string;
      evidenceDocumentId?: string | null;
    },
  ) {
    const d = await this.db.tenant(ctx, (tx) => this.ownDeposit(tx, ctx, id));
    const s = this.settlementOf(d);
    this.assertSettlement(s, ['agreed', 'disputed']);
    if (input.method === 'bank_transfer' && !input.evidenceDocumentId)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'evidenceDocumentId', code: 'transferSlipRequired', message: 'attach the transfer slip' },
        ],
      });
    const owed = (s.agreedRefund ?? s.proposedRefund ?? s.depositHeld).toString();
    await this.gate.enforce(ctx, {
      subjectType: 'ops.deposit_settlement',
      subjectId: s.id,
      buildingId: d.buildingId,
      checks: [checkRefund(owed, input.amount)],
      refuseWarnings: true,
    });
    return this.db.tenant(
      ctx,
      async (tx) => {
        const fresh = await this.ownDeposit(tx, ctx, id);
        const st = this.settlementOf(fresh);
        this.assertSettlement(st, ['agreed', 'disputed']);
        if (input.evidenceDocumentId) {
          const doc = await tx.document.count({
            where: this.own(ctx, { id: input.evidenceDocumentId, deletedAt: null }),
          });
          if (!doc) throw new DomainException('http.not_found');
        }
        const now = this.clock.now();
        const refundedAt = input.refundedAt ? new Date(input.refundedAt) : now;
        if (refundedAt.getTime() > now.getTime() + 60_000 || refundedAt.getTime() < st.moveOutAt.getTime())
          throw new DomainException('validation.failed', {
            errors: [{ path: 'refundedAt', code: 'range', message: 'between the move-out and now' }],
          });
        await this.workflows.transition(tx, st.workflowInstanceId, 'refund', { amount: input.amount });
        const number = await this.numbering.next(tx, fresh.tenantId, 'deposit_statement', now);
        const late = refundedAt.getTime() > st.deadlineAt.getTime();
        const amount = new Decimal(input.amount).toFixed(2);
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: fresh.tenantId },
          select: { displayName: true },
        });
        const pdf = await this.renderer.statement({
          number,
          tenantName: tenant.displayName,
          lessee: fresh.lease.lessee.displayName,
          unit: fresh.lease.unit.unitNo,
          contractNumber: fresh.lease.number,
          moveOutOn: bangkokDate(st.moveOutAt),
          deadlineOn: bangkokDate(st.deadlineAt),
          depositHeld: st.depositHeld.toFixed(2),
          items: st.items.map((i) => ({ description: i.description, amount: i.amount.toFixed(2) })),
          deductionsTotal: st.deductionsTotal.toFixed(2),
          utilitiesFinal: st.utilitiesFinal.toFixed(2),
          refundAmount: amount,
          refundMethod: input.method,
          refundReference: input.reference ?? null,
          refundedOn: bangkokDate(refundedAt),
          late,
        });
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: fresh.tenantId,
          kind: 'pdf_statement',
          scopeType: 'unit',
          scopeId: fresh.unitId,
          buildingId: fresh.buildingId,
          title: `ใบแจ้งรายการคืนเงินประกัน ${number}.pdf`,
          mimeType: 'application/pdf',
          body: pdf,
        });
        await tx.depositSettlement.update({
          where: { id: st.id },
          data: {
            status: 'refunded',
            refundedAt,
            refundAmount: amount,
            refundMethod: input.method,
            refundReference: input.reference ?? null,
            refundEvidenceDocumentId: input.evidenceDocumentId ?? null,
            statementNumber: number,
            statementDocumentId: doc.id,
            closedAt: now,
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await tx.deposit.update({
          where: { id },
          data: {
            status: st.deductionsTotal.greaterThan(0) ? 'forfeited_partially' : 'refunded',
            settledAt: now,
            deductionsSummary: {
              items: st.items.map((i) => ({
                kind: i.kind,
                description: i.description,
                amount: i.amount.toFixed(2),
              })),
              deductionsTotal: st.deductionsTotal.toFixed(2),
              utilitiesFinal: st.utilitiesFinal.toFixed(2),
              refund: amount,
            },
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'deposit.refunded',
          tenantId: fresh.tenantId,
          buildingId: fresh.buildingId,
          subjectType: 'ops.deposit_settlement',
          subjectId: st.id,
          metadata: { amount, method: input.method, statementNumber: number, late },
        });
        if (late) await this.flagLate(tx, { tenantId: fresh.tenantId }, st.id, 'refund_after_deadline');
        await this.event(tx, fresh, 'deposit.refunded', {
          settlementId: st.id,
          refundAmount: amount,
          statementNumber: number,
          late,
        });
        return this.load(tx, ctx, id);
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Late refund (D-023): flags the settlement once, with an audit row and a `compliance.deposit_deadline` evaluation
   * (the tenant's compliance score, B6). Called by the SLA breach subscriber and by a refund after the deadline.
   */
  async flagLate(
    tx: Tx,
    ctx: Pick<TenantContext, 'tenantId'>,
    settlementId: string,
    trigger: 'sla_breached' | 'refund_after_deadline',
  ) {
    const now = this.clock.now();
    const flagged = await tx.depositSettlement.updateMany({
      where: { id: settlementId, isLate: false },
      data: { isLate: true, lateFlaggedAt: now, version: { increment: 1 } },
    });
    if (flagged.count !== 1) return false;
    const s = await tx.depositSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    await this.acknowledgements.evaluate(
      tx,
      { tenantId: ctx.tenantId, source: 'path' },
      {
        ruleId: 'compliance.deposit_deadline',
        buildingId: s.buildingId,
        subjectType: 'ops.deposit_settlement',
        subjectId: s.id,
        outcome: 'warn',
        severityApplied: await this.gate.severity('compliance.deposit_deadline', ctx.tenantId, now),
        context: {
          trigger,
          deadlineAt: s.deadlineAt.toISOString(),
          refundedAt: s.refundedAt?.toISOString() ?? null,
        },
      },
    );
    await this.audit.record(tx, {
      action: 'deposit.settlement_late',
      tenantId: s.tenantId,
      buildingId: s.buildingId,
      subjectType: 'ops.deposit_settlement',
      subjectId: s.id,
      outcome: 'failure',
      metadata: { trigger, deadlineAt: s.deadlineAt.toISOString() },
    });
    await this.event(
      tx,
      { id: s.depositId, tenantId: s.tenantId, buildingId: s.buildingId, leaseId: s.leaseId },
      'deposit.settlement_late',
      {
        settlementId: s.id,
        trigger,
        deadlineAt: s.deadlineAt.toISOString(),
      },
    );
    return true;
  }

  /** SLA breach of a `deposit_settlement` workflow instance (subscriber, gp_platform transaction). */
  async onBreach(tx: Tx, instanceId: string): Promise<void> {
    const s = await tx.depositSettlement.findFirst({ where: { workflowInstanceId: instanceId } });
    if (!s || s.refundedAt) return;
    await RequestContext.run({ actor: systemActor('deposit-deadline') }, () =>
      this.flagLate(tx, { tenantId: s.tenantId }, s.id, 'sla_breached'),
    );
    this.logger.warn(`deposit settlement ${s.id} passed its refund deadline (tenant ${s.tenantId})`);
  }

  /** Signed URL of the receipt or the statement PDF (audited download). */
  async document(ctx: TenantContext, id: string, which: 'receipt' | 'statement') {
    const d = await this.get(ctx, id);
    const documentId = which === 'receipt' ? d.receiptDocumentId : d.settlement?.statementDocumentId;
    if (!documentId) throw new DomainException('deposit.invalid_state', { params: { status: d.status } });
    return { deposit: d, download: await this.documents.download(ctx, documentId, `deposit_${which}`) };
  }
}
