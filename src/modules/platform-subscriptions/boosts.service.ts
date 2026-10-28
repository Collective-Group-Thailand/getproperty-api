import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type ListingBoost,
  type PlatformInvoice,
  type PricePlan,
  type PricePlanVersion,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  type BoostTarget,
  type BoostTerms,
  boostTermsOf,
  boostWindow,
  purchaseCharges,
} from './growth-products';
import { PlatformBillingService } from './platform-billing.service';
import { type PlanWithVersions, versionInForce } from './storage-packages.service';

export interface BoostProduct {
  plan: PlanWithVersions;
  /** The priced version in force (what is charged), else the newest version (terms only). */
  version: PricePlanVersion;
  terms: BoostTerms;
  onSale: boolean;
  /** A building boost given free to this tenant (`boost.building.free`, O-027). */
  free: boolean;
}

export type BoostRow = ListingBoost & {
  platformInvoice: PlatformInvoice | null;
  pricePlanVersion: PricePlanVersion & { plan: PricePlan };
  listing: { id: string; slug: string; titleTh: string } | null;
  building: { id: string; name: string } | null;
};

const BOOST_INCLUDE = {
  platformInvoice: true,
  pricePlanVersion: { include: { plan: true } },
  listing: { select: { id: true, slug: true, titleTh: true } },
  building: { select: { id: true, name: true } },
} as const satisfies Prisma.ListingBoostInclude;

const by = () => userIdOf(RequestContext.actor());

/**
 * Boosts (G5, D-287, D-297): a listing boost (7 / 30 days) or a building boost (one month) is a price-plan add-on
 * (`terms.product = boost`, seeded without a price — O-027: not on sale until the platform admin publishes a priced
 * version). Buying one writes a pending boost and a `purchase` platform invoice (Collective issues it, O-008; nothing
 * goes through the payment gateway, O-020); the boost is active from the payment for its window, queued after a boost
 * of the same target still in force. A building boost is free for a tenant where `boost.building.free` is on. An
 * unpaid boost is simply never active — nothing is suspended (D-250). Public search shows active boosts labelled
 * (`PublicListingsService`).
 */
@Injectable()
export class BoostsService implements EventSubscriber, OnModuleInit {
  readonly name = 'boosts';
  readonly eventTypes = ['platform_payment.confirmed'];
  private readonly logger = new Logger('Boosts');

  constructor(
    private readonly db: TenantTx,
    private readonly billing: PlatformBillingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------------- products

  private async products(tx: Tx, tenantId: string): Promise<BoostProduct[]> {
    const now = this.clock.now();
    const today = bangkokDate(now);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { type: true } });
    const freeBuilding =
      (await this.settings.valueAt<boolean>('boost.building.free', now, { tenantId })) === true;
    const plans = await tx.pricePlan.findMany({
      where: { kind: 'addon', isActive: true, OR: [{ tenantType: null }, { tenantType: tenant.type }] },
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { key: 'asc' },
    });
    const out: BoostProduct[] = [];
    for (const plan of plans) {
      const newest = plan.versions.find((v) => boostTermsOf(v.terms));
      if (!newest) continue;
      const inForce = versionInForce(plan, today);
      const priced = inForce && inForce.unitPrice !== null && boostTermsOf(inForce.terms) ? inForce : null;
      const version = priced ?? newest;
      const terms = boostTermsOf(version.terms)!;
      const free = terms.target === 'building' && freeBuilding;
      out.push({ plan, version, terms, onSale: priced !== null || free, free });
    }
    return out;
  }

  /** `GET /v1/owner/boost-products`: listing and building boosts with their price, `onSale` and `free`. */
  catalogue(ctx: TenantContext): Promise<BoostProduct[]> {
    return this.db.platform((tx) => this.products(tx, ctx.tenantId), { tenantId: ctx.tenantId });
  }

  // ------------------------------------------------------------------------------------------------- purchase

  /** Buys a boost of a published listing of the tenant (Idempotency-Key on the route). */
  async boostListing(ctx: TenantContext, listingId: string, productId: string): Promise<BoostRow> {
    const id = await this.db.platform(
      async (tx) => {
        const listing = await tx.listing.findFirst({ where: { id: listingId, tenantId: ctx.tenantId } });
        if (!listing) throw new DomainException('http.not_found');
        if (listing.state !== 'published' || listing.hiddenAt)
          throw new DomainException('boost.listing_not_public', { params: { state: listing.state } });
        return this.order(tx, ctx.tenantId, productId, 'listing', listing.id, listing.titleTh);
      },
      { tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  /** Buys a boost of a building the tenant owns or operates (Idempotency-Key on the route). */
  async boostBuilding(ctx: TenantContext, buildingId: string, productId: string): Promise<BoostRow> {
    const id = await this.db.platform(
      async (tx) => {
        const building = await tx.building.findFirst({
          where: {
            id: buildingId,
            deletedAt: null,
            OR: [
              { tenantId: ctx.tenantId },
              { ownerTenantId: ctx.tenantId },
              { operatorTenantId: ctx.tenantId },
            ],
          },
        });
        if (!building) throw new DomainException('http.not_found');
        return this.order(tx, ctx.tenantId, productId, 'building', building.id, building.name);
      },
      { tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  private async order(
    tx: Tx,
    tenantId: string,
    productId: string,
    target: BoostTarget,
    targetId: string,
    targetName: string,
  ): Promise<string> {
    const product = (await this.products(tx, tenantId)).find((p) => p.plan.id === productId);
    if (!product || product.terms.target !== target) throw new DomainException('http.not_found');
    if (!product.onSale) throw new DomainException('boost.not_on_sale');
    // one purchase at a time per target and product (serialised per target)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boost:${targetId}`}))`;
    const where = target === 'listing' ? { listingId: targetId } : { buildingId: targetId };
    const now = this.clock.now();
    if (
      await tx.listingBoost.findFirst({
        where: { ...where, productKey: product.plan.key, state: 'pending_payment' },
      })
    )
      throw new DomainException('boost.pending');
    if (
      product.free &&
      (await tx.listingBoost.findFirst({
        where: { ...where, free: true, state: 'active', endsAt: { gt: now } },
      }))
    )
      throw new DomainException('boost.already_active');
    const v = product.version;
    const duration = product.terms.days ? `${product.terms.days} วัน` : `${product.terms.months} เดือน`;
    const charges =
      product.free || v.unitPrice === null
        ? null
        : purchaseCharges(
            'boost',
            `${product.plan.nameTh} — ${targetName} (${duration})`,
            v.unitPrice.toString(),
            v.vatRate.toString(),
          );
    const total = charges ? charges.total : '0.00';
    const invoice =
      charges && new Decimal(total).gt(0)
        ? await this.billing.issue(tx, null, {
            tenantId,
            kind: 'purchase',
            periodStart: bangkokDate(now),
            periodEnd: bangkokDate(now),
            charges,
            snapshot: {
              product: 'boost',
              target,
              targetId,
              days: product.terms.days,
              months: product.terms.months,
              plan: {
                key: product.plan.key,
                versionId: v.id,
                version: v.version,
                vatRate: v.vatRate.toString(),
              },
              decision: 'D-297',
            },
          })
        : null;
    // free / zero-priced boosts have no invoice: active at once
    const window = invoice ? null : await this.windowFor(tx, where, product.terms, null);
    const boost = await tx.listingBoost.create({
      data: {
        tenantId,
        ...where,
        productKey: product.plan.key,
        pricePlanVersionId: v.id,
        days: product.terms.days,
        months: product.terms.months,
        price: total,
        free: product.free,
        state: invoice ? 'pending_payment' : 'active',
        platformInvoiceId: invoice?.id ?? null,
        ...(window ? { startsAt: window.startsAt, endsAt: window.endsAt, activatedAt: now } : {}),
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'boost.ordered',
      tenantId,
      subjectType: 'ops.listing_boost',
      subjectId: boost.id,
      after: {
        product: product.plan.key,
        target,
        targetId,
        total,
        free: product.free,
        invoice: invoice?.number ?? null,
      },
    });
    await this.events.record(tx, {
      type: 'boost.ordered',
      aggregateType: 'listing_boost',
      aggregateId: boost.id,
      tenantId,
      payload: {
        boostId: boost.id,
        target,
        targetId,
        productKey: product.plan.key,
        total,
        free: product.free,
        platformInvoiceId: invoice?.id ?? null,
      },
    });
    if (window) await this.activated(tx, boost.id, boost, window);
    return boost.id;
  }

  // ------------------------------------------------------------------------------------------------- lifecycle

  /** The window of a boost activated now: after the target's last boost still in force (never overlapping). */
  private async windowFor(
    tx: Tx,
    target: { listingId: string } | { buildingId: string },
    duration: { days: number | null; months: number | null },
    excludeId: string | null,
  ) {
    const now = this.clock.now();
    const last = await tx.listingBoost.findFirst({
      where: {
        ...target,
        state: 'active',
        endsAt: { gt: now },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      orderBy: { endsAt: 'desc' },
    });
    return boostWindow(now, duration, last?.endsAt ?? null);
  }

  /** Pending → active (on payment). */
  private async activate(tx: Tx, boost: ListingBoost): Promise<void> {
    const target = boost.listingId ? { listingId: boost.listingId } : { buildingId: boost.buildingId! };
    const window = await this.windowFor(tx, target, boost, boost.id);
    await tx.listingBoost.update({
      where: { id: boost.id },
      data: {
        state: 'active',
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        activatedAt: this.clock.now(),
      },
    });
    await this.activated(tx, boost.id, boost, window);
  }

  private async activated(
    tx: Tx,
    id: string,
    boost: Pick<ListingBoost, 'tenantId' | 'listingId' | 'buildingId'>,
    { startsAt, endsAt }: { startsAt: Date; endsAt: Date },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'boost.activated',
      tenantId: boost.tenantId,
      subjectType: 'ops.listing_boost',
      subjectId: id,
      after: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    });
    await this.events.record(tx, {
      type: 'boost.activated',
      aggregateType: 'listing_boost',
      aggregateId: id,
      tenantId: boost.tenantId,
      payload: {
        boostId: id,
        listingId: boost.listingId,
        buildingId: boost.buildingId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });
  }

  /** Subscriber: a settled purchase invoice activates its boosts. */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload as { platformInvoiceId?: string; settled?: boolean };
    if (!p.settled || !p.platformInvoiceId) return;
    const boosts = await tx.listingBoost.findMany({
      where: { platformInvoiceId: p.platformInvoiceId, state: 'pending_payment' },
    });
    for (const b of boosts) await this.activate(tx, b);
  }

  /** Job `boosts` (hourly, idempotent): boosts past their end become `expired` (nothing else changes). */
  async maintain(): Promise<number> {
    const now = this.clock.now();
    return RequestContext.run({ actor: systemActor('boosts') }, async () => {
      const ended = await this.db.platform((tx) =>
        tx.listingBoost.findMany({ where: { state: 'active', endsAt: { lte: now } }, take: 500 }),
      );
      for (const b of ended) {
        try {
          await this.db.platform(
            async (tx) => {
              const n = await tx.listingBoost.updateMany({
                where: { id: b.id, state: 'active' },
                data: { state: 'expired' },
              });
              if (!n.count) return;
              await this.audit.record(tx, {
                action: 'boost.expired',
                tenantId: b.tenantId,
                subjectType: 'ops.listing_boost',
                subjectId: b.id,
                after: { endsAt: b.endsAt?.toISOString() ?? null },
              });
              await this.events.record(tx, {
                type: 'boost.expired',
                aggregateType: 'listing_boost',
                aggregateId: b.id,
                tenantId: b.tenantId,
                payload: { boostId: b.id, listingId: b.listingId, buildingId: b.buildingId },
              });
            },
            { tenantId: b.tenantId },
          );
        } catch (error) {
          this.logger.warn(`expiry of boost ${b.id}: ${(error as Error).message}`);
        }
      }
      return ended.length;
    });
  }

  // ------------------------------------------------------------------------------------------------- reads

  list(
    ctx: TenantContext,
    filter: { state?: ListingBoost['state']; listingId?: string },
  ): Promise<BoostRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.listingBoost.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(filter.state ? { state: filter.state } : {}),
          ...(filter.listingId ? { listingId: filter.listingId } : {}),
        },
        include: BOOST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<BoostRow> {
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.listingBoost.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: BOOST_INCLUDE,
      });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }
}
