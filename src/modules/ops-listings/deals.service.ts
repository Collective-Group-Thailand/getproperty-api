import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Deal, type FeeAccrual, type FeeAccrualKind } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { coBrokeShare, feeFor, type FeePrice, recordedCommission } from './fee-accrual';
import { HELD } from './mandates.service';

/** The price-plan key of each fee (seeded without a price, O-027; the platform admin publishes a priced version). */
export const FEE_PLAN_KEY: Record<FeeAccrualKind, string> = {
  success_fee: 'success_fee',
  co_broke_fee: 'co_broke_fee',
};

export type DealView = Deal & {
  accruals: FeeAccrual[];
  unitNo: string;
  ownerName: string;
  agencyNames: Record<string, string>;
};

/**
 * Deals and fee accruals (G2, D-287, D-293). A lease of a unit that had a listing or an agency mandate **closes as a
 * deal** once it is activated, was e-signed on the platform (a lease signature exists) and its first payment is
 * confirmed — checked on `lease.activated` and `payment.confirmed`, so whichever comes last closes it, exactly once
 * (`ops.deal.lease_id` unique, `ON CONFLICT DO NOTHING`). The commission is recorded from the mandate terms and the
 * co-broke share from a signed agreement on the listing; money between the parties moves outside the platform
 * (ADR-0008). Fees follow the published price-plan version of the close day: the success fee is owed by the listing
 * agency, the co-broke fee by the co-agency; without a price nothing is accrued (not sold, D-287). G5 invoices the
 * accruals on platform invoices — never deducted from rent (O-020 note).
 */
@Injectable()
export class DealsService implements EventSubscriber, OnModuleInit {
  readonly name = 'deals';
  readonly eventTypes = ['lease.activated', 'payment.confirmed'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly registry: EventSubscriberRegistry,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'lease.activated') {
      const leaseId = (event.payload.leaseId as string | undefined) ?? event.aggregateId;
      await this.tryClose(tx, leaseId);
      return;
    }
    const paymentId = event.payload.paymentId as string | undefined;
    if (!paymentId) return;
    const leases = await tx.$queryRaw<{ lease_id: string }[]>`
      SELECT DISTINCT i.lease_id FROM ops.payment_allocation a JOIN ops.invoice i ON i.id = a.invoice_id
       WHERE a.payment_id = ${paymentId}::uuid AND i.lease_id IS NOT NULL
      UNION SELECT p.lease_id FROM ops.payment p WHERE p.id = ${paymentId}::uuid AND p.lease_id IS NOT NULL`;
    for (const l of leases) await this.tryClose(tx, l.lease_id);
  }

  /** Closes the deal of a lease when every condition holds (idempotent); returns the deal or null. */
  async tryClose(tx: Tx, leaseId: string): Promise<Deal | null> {
    const lease = await tx.lease.findUnique({ where: { id: leaseId } });
    if (!lease?.activatedAt || ['cancelled', 'draft', 'pending_signature'].includes(lease.status))
      return null;
    if (await tx.deal.findUnique({ where: { leaseId } })) return null;
    const signed = await tx.leaseSignature.count({ where: { leaseId } });
    if (!signed) return null;
    const payments = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM ops.payment p
       WHERE p.status = 'confirmed' AND p.method <> 'offset'
         AND (p.lease_id = ${leaseId}::uuid
              OR EXISTS (SELECT 1 FROM ops.payment_allocation a JOIN ops.invoice i ON i.id = a.invoice_id
                          WHERE a.payment_id = p.id AND a.reversed_at IS NULL AND i.lease_id = ${leaseId}::uuid))
       ORDER BY p.confirmed_at NULLS LAST, p.id LIMIT 1`;
    const firstPayment = payments[0];
    if (!firstPayment) return null;

    // the listing the lease came from (B7.4 links it when the lease is activated), else a live one of the unit
    const listing =
      (await tx.listing.findFirst({ where: { leaseId } })) ??
      (await tx.listing.findFirst({
        where: { unitId: lease.unitId, state: { in: ['pending_review', 'published', 'paused'] } },
        orderBy: { publishedAt: 'desc' },
      }));
    let mandate = listing?.mandateId
      ? await tx.listingMandate.findUnique({ where: { id: listing.mandateId } })
      : null;
    if (!mandate && !listing) {
      // no listing: the one agency holding a mandate on the unit, if exactly one does
      const held = await tx.listingMandate.findMany({ where: { unitId: lease.unitId, state: { in: HELD } } });
      mandate = held.length === 1 ? held[0]! : null;
    }
    if (!listing && !mandate) return null;

    const now = this.clock.now();
    const today = bangkokDate(now);
    const rent = lease.rent.toFixed(2);
    const commission = mandate
      ? recordedCommission(
          {
            amount: mandate.commissionAmount?.toFixed(2) ?? null,
            percent: mandate.commissionPercent?.toFixed(4) ?? null,
          },
          rent,
        )
      : null;
    const dayDate = new Date(`${today}T00:00:00Z`);
    const coBroke = listing
      ? await tx.coBrokeAgreement.findFirst({
          where: {
            listingId: listing.id,
            state: 'signed',
            validFrom: { lte: dayDate },
            OR: [{ validTo: null }, { validTo: { gte: dayDate } }],
          },
          orderBy: { signedAt: 'asc' },
        })
      : null;
    const listingAgency = mandate?.tenantId ?? null;
    const coAgency = coBroke?.coAgencyTenantId ?? null;
    const coAmount = coBroke ? coBrokeShare(commission, coBroke.splitPercent.toFixed(4)) : null;

    const inserted = await tx.deal.createMany({
      data: [
        {
          tenantId: lease.tenantId,
          leaseId,
          unitId: lease.unitId,
          buildingId: lease.buildingId,
          listingId: listing?.id ?? null,
          mandateId: mandate?.id ?? null,
          coBrokeAgreementId: coBroke?.id ?? null,
          listingAgencyTenantId: listingAgency,
          coAgencyTenantId: coAgency,
          monthlyRent: rent,
          commissionAmount: commission,
          coBrokeAmount: coAmount,
          firstPaymentId: firstPayment.id,
          closedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return null;
    const deal = await tx.deal.findUniqueOrThrow({ where: { leaseId } });
    await this.audit.record(tx, {
      action: 'deal.closed',
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.deal',
      subjectId: deal.id,
      after: {
        leaseId,
        listingId: deal.listingId,
        mandateId: deal.mandateId,
        listingAgencyTenantId: listingAgency,
        coAgencyTenantId: coAgency,
        commissionAmount: commission,
        coBrokeAmount: coAmount,
      },
    });
    await this.events.record(tx, {
      type: 'deal.closed',
      aggregateType: 'deal',
      aggregateId: deal.id,
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      payload: {
        dealId: deal.id,
        leaseId,
        listingId: deal.listingId,
        mandateId: deal.mandateId,
        listingAgencyTenantId: listingAgency,
        coAgencyTenantId: coAgency,
      },
    });
    if (listingAgency) await this.accrue(tx, deal, 'success_fee', listingAgency, commission, today);
    if (coAgency) await this.accrue(tx, deal, 'co_broke_fee', coAgency, coAmount, today);
    return deal;
  }

  /** The published fee price of the day (null = no published version, or the plan is inactive). */
  async price(tx: Tx, kind: FeeAccrualKind, day: string): Promise<(FeePrice & { id: string }) | null> {
    const rows = await tx.$queryRaw<
      { id: string; billing_unit: string; unit_price: string | null; terms: unknown }[]
    >`
      SELECT v.id, v.billing_unit::text AS billing_unit, v.unit_price::text AS unit_price, v.terms
        FROM platform.price_plan_version v JOIN platform.price_plan p ON p.id = v.plan_id
       WHERE p.key = ${FEE_PLAN_KEY[kind]} AND p.is_active AND v.state = 'published'
         AND v.effective_from <= ${day}::date AND (v.effective_to IS NULL OR v.effective_to > ${day}::date)
       ORDER BY v.effective_from DESC, v.version DESC LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      billingUnit: r.billing_unit,
      unitPrice: r.unit_price,
      terms: (r.terms as FeePrice['terms'] | null) ?? {},
    };
  }

  private async accrue(
    tx: Tx,
    deal: Deal,
    kind: FeeAccrualKind,
    payer: string,
    commission: string | null,
    day: string,
  ): Promise<void> {
    const price = await this.price(tx, kind, day);
    if (!price) return;
    const fee = feeFor(price, { commission, monthlyRent: deal.monthlyRent.toFixed(2) });
    if (!fee) return;
    const made = await tx.feeAccrual.createMany({
      data: [
        {
          tenantId: payer,
          dealId: deal.id,
          kind,
          pricePlanVersionId: price.id,
          billingUnit: fee.billingUnit,
          rate: fee.rate,
          baseAmount: fee.baseAmount,
          amount: fee.amount,
          capped: fee.capped,
          accruedOn: new Date(`${day}T00:00:00Z`),
        },
      ],
      skipDuplicates: true,
    });
    if (!made.count) return;
    await this.events.record(tx, {
      type: 'fee.accrued',
      aggregateType: 'deal',
      aggregateId: deal.id,
      tenantId: payer,
      buildingId: deal.buildingId,
      payload: {
        dealId: deal.id,
        kind,
        amount: fee.amount,
        capped: fee.capped,
        pricePlanVersionId: price.id,
      },
    });
  }

  // ------------------------------------------------------------------------------------------------- reads

  private async view(ctx: TenantContext, deals: Deal[]): Promise<DealView[]> {
    if (!deals.length) return [];
    const accruals = await this.db.tenant(ctx, (tx) =>
      tx.feeAccrual.findMany({ where: { tenantId: ctx.tenantId, dealId: { in: deals.map((d) => d.id) } } }),
    );
    const tenantIds = [
      ...new Set(
        deals.flatMap((d) => [d.tenantId, d.listingAgencyTenantId, d.coAgencyTenantId]).filter(Boolean),
      ),
    ] as string[];
    const [tenants, units] = await this.db.platform(async (tx) => [
      await tx.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, displayName: true } }),
      await tx.unit.findMany({
        where: { id: { in: deals.map((d) => d.unitId) } },
        select: { id: true, unitNo: true },
      }),
    ]);
    const name = Object.fromEntries(tenants.map((t) => [t.id, t.displayName]));
    const unitNo = new Map(units.map((u) => [u.id, u.unitNo]));
    return deals.map((d) => ({
      ...d,
      accruals: accruals.filter((a) => a.dealId === d.id),
      unitNo: unitNo.get(d.unitId) ?? '',
      ownerName: name[d.tenantId] ?? '',
      agencyNames: name,
    }));
  }

  /** Deals the tenant is part of: as the owner of the lease, the listing agency or the co-agency (RLS). */
  async list(ctx: TenantContext): Promise<DealView[]> {
    const deals = await this.db.tenant(ctx, (tx) =>
      tx.deal.findMany({
        where: {
          OR: [
            { tenantId: ctx.tenantId },
            { listingAgencyTenantId: ctx.tenantId },
            { coAgencyTenantId: ctx.tenantId },
          ],
        },
        orderBy: { closedAt: 'desc' },
        take: 500,
      }),
    );
    return this.view(ctx, deals);
  }

  async get(ctx: TenantContext, id: string): Promise<DealView> {
    const deal = await this.db.tenant(ctx, (tx) =>
      tx.deal.findFirst({
        where: {
          id,
          OR: [
            { tenantId: ctx.tenantId },
            { listingAgencyTenantId: ctx.tenantId },
            { coAgencyTenantId: ctx.tenantId },
          ],
        },
      }),
    );
    if (!deal) throw new DomainException('http.not_found');
    return (await this.view(ctx, [deal]))[0]!;
  }
}
