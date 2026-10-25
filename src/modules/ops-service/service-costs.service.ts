import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { MoneyDecimal } from '@common/money/money';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ServiceCost,
  type ServiceCostBearer,
  type ServiceCostKind,
  type ServiceCostPayer,
  type ServiceDecision,
  type ServiceHandler,
  type ServiceRequest,
  type ServiceSettlement,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

const by = () => userIdOf(RequestContext.actor());
type Money = InstanceType<typeof MoneyDecimal>;
const ZERO: Money = new MoneyDecimal(0);

export interface DecisionInput {
  handledBy: ServiceHandler;
  costBearer: ServiceCostBearer;
  /** Required with `shared`: the tenant's share in percent (0 < p < 100, two decimals). */
  tenantSharePercent?: string | null;
  note?: string | null;
}

export interface CostInput {
  kind: ServiceCostKind;
  description: string;
  amount: string;
  /** Receipts: who paid the vendor. */
  paidBy?: ServiceCostPayer | null;
  vendorName?: string | null;
  /** A file uploaded with `POST /v1/owner/files/presign` (the quotation or receipt). */
  documentId?: string | null;
  issuedOn: string;
}

/** What a request's receipts come to, and what is still to settle with the tenant (D-263). */
export interface SettlementView {
  receiptsTotal: string;
  ownerShare: string;
  tenantShare: string;
  paidByOwner: string;
  paidByTenant: string;
  /** Positive: the tenant owes the owner; negative: the owner owes the tenant. */
  tenantOwes: string;
  settled: string;
  /** `tenantOwes − settled`: billed on the next invoice when positive, credited when negative. */
  due: string;
}

export interface CostsView {
  request: ServiceRequest;
  decisions: ServiceDecision[];
  costs: (ServiceCost & { url: string | null })[];
  settlements: ServiceSettlement[];
  settlement: SettlementView;
}

/** The tenant's fraction of a request's costs under a decision. */
export function tenantFraction(
  bearer: ServiceCostBearer | null,
  sharePercent: { toString(): string } | null,
) {
  if (bearer === 'tenant') return new MoneyDecimal(1);
  if (bearer === 'shared' && sharePercent) return new MoneyDecimal(sharePercent.toString()).div(100);
  return ZERO;
}

/** Pure settlement arithmetic over the active receipts (unit-tested). */
export function settlementOf(
  receipts: { amount: { toString(): string }; paidBy: ServiceCostPayer | null }[],
  bearer: ServiceCostBearer | null,
  sharePercent: { toString(): string } | null,
  settled: { toString(): string }[],
): SettlementView {
  const total = receipts.reduce<Money>((sum, r) => sum.plus(r.amount.toString()), ZERO);
  const byOwner = receipts
    .filter((r) => r.paidBy === 'owner')
    .reduce<Money>((sum, r) => sum.plus(r.amount.toString()), ZERO);
  const byTenant = total.minus(byOwner);
  const tenantShare = total.mul(tenantFraction(bearer, sharePercent)).toDecimalPlaces(2);
  const owes = tenantShare.minus(byTenant);
  const done = settled.reduce<Money>((sum, s) => sum.plus(s.toString()), ZERO);
  return {
    receiptsTotal: total.toFixed(2),
    ownerShare: total.minus(tenantShare).toFixed(2),
    tenantShare: tenantShare.toFixed(2),
    paidByOwner: byOwner.toFixed(2),
    paidByTenant: byTenant.toFixed(2),
    tenantOwes: owes.toFixed(2),
    settled: done.toFixed(2),
    due: owes.minus(done).toFixed(2),
  };
}

/**
 * Landlord service requests — who fixes, who pays (B7 deliverable 7.8, D-263). For a `landlord` tenant the owner
 * decides who handles a request (own technician, the tenant, a partner) and who bears its cost (owner, tenant, or a
 * share), changeable at any time with a history row; quotations and receipts are attached with their amounts and
 * documents; the tenant's share — or the owner's share of what the tenant paid — is settled as a pending invoice charge
 * on the next invoice (`service_charge_work`, or a negative `discount` for a credit), only when the owner confirms.
 * Owner-borne receipts are the repair expenses of the annual income summary (B7.5). Apartments keep the technician
 * queue (D-210): `service_request.decision_unavailable` elsewhere.
 */
@Injectable()
export class ServiceCostsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async request(tx: Tx, ctx: TenantContext, id: string): Promise<ServiceRequest> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { type: true } });
    const sr = this.found(
      await tx.serviceRequest.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
      }),
    );
    if (tenant.type !== 'landlord') throw new DomainException('service_request.decision_unavailable');
    return sr;
  }

  private async view(tx: Tx, sr: ServiceRequest): Promise<CostsView> {
    const [decisions, costs, settlements] = await Promise.all([
      tx.serviceDecision.findMany({ where: { serviceRequestId: sr.id }, orderBy: { decidedAt: 'asc' } }),
      tx.serviceCost.findMany({
        where: { serviceRequestId: sr.id },
        include: { document: true },
        orderBy: [{ issuedOn: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.serviceSettlement.findMany({ where: { serviceRequestId: sr.id }, orderBy: { settledAt: 'asc' } }),
    ]);
    const withLinks = [];
    for (const { document, ...cost } of costs) {
      const clean = document && !document.deletedAt && ['clean', 'skipped'].includes(document.scanStatus);
      withLinks.push({ ...cost, url: clean ? (await this.documents.signedUrl(document)).url : null });
    }
    const receipts = costs.filter((c) => c.kind === 'receipt' && !c.voidedAt);
    return {
      request: sr,
      decisions,
      costs: withLinks,
      settlements,
      settlement: settlementOf(
        receipts,
        sr.costBearer,
        sr.tenantSharePercent,
        settlements.map((s) => s.amount),
      ),
    };
  }

  async costs(ctx: TenantContext, id: string): Promise<CostsView> {
    return this.db.tenant(ctx, async (tx) => this.view(tx, await this.request(tx, ctx, id)));
  }

  /** Who fixes and who pays; a new decision row each time (the request keeps the current one). */
  async decide(ctx: TenantContext, id: string, input: DecisionInput): Promise<CostsView> {
    return this.db.tenant(ctx, async (tx) => {
      const sr = await this.request(tx, ctx, id);
      if (sr.status === 'cancelled')
        throw new DomainException('service_request.invalid_state', { params: { status: sr.status } });
      let share: Money | null = null;
      if (input.costBearer === 'shared') {
        share = new MoneyDecimal(input.tenantSharePercent ?? 'NaN');
        if (share.isNaN() || share.lte(0) || share.gte(100) || !share.equals(share.toDecimalPlaces(2)))
          throw new DomainException('validation.failed', {
            errors: [{ path: 'tenantSharePercent', code: 'range', message: 'a share above 0 and below 100' }],
          });
      } else if (input.tenantSharePercent) {
        throw new DomainException('validation.failed', {
          errors: [{ path: 'tenantSharePercent', code: 'forbidden', message: 'only with a shared cost' }],
        });
      }
      const now = this.clock.now();
      const before = {
        handledBy: sr.handledBy,
        costBearer: sr.costBearer,
        tenantSharePercent: sr.tenantSharePercent?.toFixed(2) ?? null,
      };
      await tx.serviceDecision.create({
        data: {
          tenantId: ctx.tenantId,
          serviceRequestId: sr.id,
          handledBy: input.handledBy,
          costBearer: input.costBearer,
          tenantSharePercent: share?.toFixed(2) ?? null,
          note: input.note?.trim() || null,
          decidedAt: now,
          decidedBy: by(),
        },
      });
      const updated = await tx.serviceRequest.update({
        where: { id: sr.id },
        data: {
          handledBy: input.handledBy,
          costBearer: input.costBearer,
          tenantSharePercent: share?.toFixed(2) ?? null,
          decidedAt: now,
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      const after = {
        handledBy: input.handledBy,
        costBearer: input.costBearer,
        tenantSharePercent: share?.toFixed(2) ?? null,
      };
      await this.audit.record(tx, {
        action: 'service_request.decided',
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        subjectType: 'ops.service_request',
        subjectId: sr.id,
        before,
        after,
      });
      await this.events.record(tx, {
        type: 'service_request.decided',
        aggregateType: 'service_request',
        aggregateId: sr.id,
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        payload: {
          serviceRequestId: sr.id,
          requesterPartyId: sr.requesterPartyId,
          reporterKind: sr.reporterKind,
          ...after,
          first: sr.decidedAt === null,
        },
      });
      return this.view(tx, updated);
    });
  }

  /** A quotation or a receipt with its amount (and file). */
  async addCost(ctx: TenantContext, id: string, input: CostInput): Promise<CostsView> {
    return this.db.tenant(ctx, async (tx) => {
      const sr = await this.request(tx, ctx, id);
      if (sr.status === 'cancelled')
        throw new DomainException('service_request.invalid_state', { params: { status: sr.status } });
      const amount = new MoneyDecimal(input.amount);
      if (amount.isNaN() || amount.lt(0) || !amount.equals(amount.toDecimalPlaces(2)))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'amount', code: 'money', message: 'an amount in baht and satang' }],
        });
      if ((input.kind === 'receipt') !== Boolean(input.paidBy))
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'paidBy', code: 'required', message: 'a receipt says who paid; a quotation does not' },
          ],
        });
      if (input.issuedOn > bangkokDate(this.clock.now()))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'issuedOn', code: 'future', message: 'not after today' }],
        });
      if (input.documentId) {
        const doc = await tx.document.findFirst({
          where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!doc) throw new DomainException('http.not_found');
      }
      const cost = await tx.serviceCost.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: sr.buildingId,
          unitId: sr.unitId,
          serviceRequestId: sr.id,
          kind: input.kind,
          description: input.description.trim(),
          amount: amount.toFixed(2),
          paidBy: input.paidBy ?? null,
          vendorName: input.vendorName?.trim() || null,
          documentId: input.documentId ?? null,
          issuedOn: new Date(`${input.issuedOn}T00:00:00Z`),
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'service_cost.added',
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        subjectType: 'ops.service_cost',
        subjectId: cost.id,
        after: {
          serviceRequestId: sr.id,
          kind: cost.kind,
          amount: cost.amount.toFixed(2),
          paidBy: cost.paidBy,
        },
      });
      return this.view(tx, sr);
    });
  }

  async voidCost(ctx: TenantContext, id: string, costId: string, reason: string): Promise<CostsView> {
    return this.db.tenant(ctx, async (tx) => {
      const sr = await this.request(tx, ctx, id);
      const cost = this.found(
        await tx.serviceCost.findFirst({ where: { id: costId, serviceRequestId: sr.id } }),
      );
      if (cost.voidedAt) throw new DomainException('service_cost.voided');
      await tx.serviceCost.update({
        where: { id: cost.id },
        data: { voidedAt: this.clock.now(), voidReason: reason.trim() },
      });
      await this.audit.record(tx, {
        action: 'service_cost.voided',
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        subjectType: 'ops.service_cost',
        subjectId: cost.id,
        before: { amount: cost.amount.toFixed(2), kind: cost.kind },
        after: { reason: reason.trim() },
      });
      return this.view(tx, sr);
    });
  }

  /** The party a request's cost is settled with: the resident who reported it, else the unit's current lessee. */
  private async settlementParty(
    tx: Tx,
    sr: ServiceRequest,
  ): Promise<{ partyId: string; leaseId: string | null }> {
    const today = new Date(`${bangkokDate(this.clock.now())}T00:00:00Z`);
    const leases = sr.unitId
      ? await tx.lease.findMany({
          where: {
            tenantId: sr.tenantId,
            unitId: sr.unitId,
            status: { in: ['active', 'notice_given', 'ending'] },
            startDate: { lte: today },
          },
          orderBy: { startDate: 'desc' },
          select: { id: true, lesseePartyId: true },
        })
      : [];
    if (sr.requesterPartyId && sr.reporterKind === 'resident') {
      const lease = leases.find((l) => l.lesseePartyId === sr.requesterPartyId) ?? null;
      return { partyId: sr.requesterPartyId, leaseId: lease?.id ?? null };
    }
    const lease = leases[0];
    if (!lease)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'serviceRequestId',
            code: 'no_lessee',
            message: 'the unit has no tenant to bill or credit',
          },
        ],
      });
    return { partyId: lease.lesseePartyId, leaseId: lease.id };
  }

  /**
   * Settles what is due with the tenant (owner confirms): a pending charge on the next invoice — the tenant's share
   * (`service_charge_work`) or a credit of the owner's share they paid (`discount`, negative). Repeatable as receipts
   * are added or voided; nothing due is `service_request.nothing_to_settle`.
   */
  async settle(ctx: TenantContext, id: string): Promise<CostsView> {
    return this.db.tenant(ctx, async (tx) => {
      const sr = await this.request(tx, ctx, id);
      if (!sr.costBearer) throw new DomainException('service_request.not_decided');
      const current = await this.view(tx, sr);
      const due = new MoneyDecimal(current.settlement.due);
      if (due.isZero()) throw new DomainException('service_request.nothing_to_settle');
      const { partyId, leaseId } = await this.settlementParty(tx, sr);
      if (!sr.unitId)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'serviceRequestId',
              code: 'no_unit',
              message: 'a request without a unit cannot be billed',
            },
          ],
        });
      const credit = due.isNegative();
      const reference = `#${sr.id.slice(-6).toUpperCase()}`;
      const charge = await tx.invoiceCharge.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: sr.buildingId,
          unitId: sr.unitId,
          partyId,
          leaseId,
          sourceType: credit ? 'adjustment' : 'service',
          lineKind: credit ? 'discount' : 'service_charge_work',
          sourceId: sr.id,
          description: (credit
            ? `คืนค่าซ่อมส่วนของเจ้าของ ${reference}`
            : `ค่าซ่อมส่วนของผู้เช่า ${reference}`
          ).slice(0, 200),
          quantity: '1.000',
          unitPrice: due.toFixed(4),
          amount: due.toFixed(2),
          createdBy: by(),
        },
      });
      await tx.serviceSettlement.create({
        data: {
          tenantId: ctx.tenantId,
          serviceRequestId: sr.id,
          partyId,
          amount: due.toFixed(2),
          invoiceChargeId: charge.id,
          settledAt: this.clock.now(),
          settledBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'service_request.settled',
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        subjectType: 'ops.service_request',
        subjectId: sr.id,
        after: { amount: due.toFixed(2), chargeId: charge.id, partyId },
      });
      await this.events.record(tx, {
        type: 'invoice_charge.queued',
        aggregateType: 'invoice_charge',
        aggregateId: charge.id,
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        payload: { chargeId: charge.id, unitId: sr.unitId, partyId, amount: charge.amount.toFixed(2) },
      });
      await this.events.record(tx, {
        type: 'service_request.cost_settled',
        aggregateType: 'service_request',
        aggregateId: sr.id,
        tenantId: ctx.tenantId,
        buildingId: sr.buildingId,
        payload: { serviceRequestId: sr.id, partyId, amount: due.toFixed(2) },
      });
      return this.view(tx, sr);
    });
  }
}
