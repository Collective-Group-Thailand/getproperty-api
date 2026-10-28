import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService, type PresignInput } from '@core/documents/documents.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type MediaServiceKind,
  type MediaServiceOrder,
  type MediaServiceState,
  type PricePlanVersion,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { mediaTermsOf, purchaseCharges } from './growth-products';
import { PlatformBillingService } from './platform-billing.service';
import { type PlanWithVersions, versionInForce } from './storage-packages.service';

export interface MediaProduct {
  plan: PlanWithVersions;
  version: PricePlanVersion;
  service: MediaServiceKind;
  onSale: boolean;
}

export const MEDIA_ORDER_INCLUDE = {
  platformInvoice: true,
  pricePlanVersion: { include: { plan: true } },
  listing: { select: { id: true, slug: true, titleTh: true } },
  unit: { select: { id: true, unitNo: true } },
  tenant: { select: { id: true, displayName: true } },
} as const satisfies Prisma.MediaServiceOrderInclude;
export type MediaOrderRow = Prisma.MediaServiceOrderGetPayload<{ include: typeof MEDIA_ORDER_INCLUDE }>;

/** Kinds a delivered file may have (listing media, counted to the tenant's quota — D-286). */
export const DELIVERABLE_KINDS = ['listing_photo', 'other'] as const;
const OPEN: MediaServiceState[] = ['pending_payment', 'requested', 'scheduled'];
const by = () => userIdOf(RequestContext.actor());

/**
 * Verified photo / 360° tour orders (G5, D-287, D-297): products are price plans (`terms.product = media_service`,
 * seeded without a price — O-027); the owner orders one for a listing's unit as a `purchase` platform invoice line;
 * it is `requested` once paid; the platform team (a partner fulfils — O-032) schedules it, uploads the deliverables
 * as documents of the ordering tenant (listing media in the unit's scope, counted to its quota) and marks it
 * delivered; a cancellation after payment is refunded only through a credit note (Finance, D-091).
 */
@Injectable()
export class MediaServicesService implements EventSubscriber, OnModuleInit {
  readonly name = 'media-services';
  readonly eventTypes = ['platform_payment.confirmed'];

  constructor(
    private readonly db: TenantTx,
    private readonly billing: PlatformBillingService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  private async products(tx: Tx, tenantId: string): Promise<MediaProduct[]> {
    const today = bangkokDate(this.clock.now());
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { type: true } });
    const plans = await tx.pricePlan.findMany({
      where: { isActive: true, OR: [{ tenantType: null }, { tenantType: tenant.type }] },
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { key: 'asc' },
    });
    const out: MediaProduct[] = [];
    for (const plan of plans) {
      const newest = plan.versions.find((v) => mediaTermsOf(v.terms));
      if (!newest) continue;
      const inForce = versionInForce(plan, today);
      const priced = inForce && inForce.unitPrice !== null && mediaTermsOf(inForce.terms) ? inForce : null;
      const version = priced ?? newest;
      out.push({ plan, version, service: mediaTermsOf(version.terms)!.service, onSale: priced !== null });
    }
    return out;
  }

  /** `GET /v1/owner/media-service-products`. */
  catalogue(ctx: TenantContext): Promise<MediaProduct[]> {
    return this.db.platform((tx) => this.products(tx, ctx.tenantId), { tenantId: ctx.tenantId });
  }

  /** The owner orders a service for one of its listings (Idempotency-Key on the route). */
  async order(
    ctx: TenantContext,
    input: { listingId: string; service: MediaServiceKind; note?: string | null },
  ): Promise<MediaOrderRow> {
    const id = await this.db.platform(
      async (tx) => {
        const listing = await tx.listing.findFirst({
          where: { id: input.listingId, tenantId: ctx.tenantId },
        });
        if (!listing) throw new DomainException('http.not_found');
        if (listing.state === 'closed' || listing.state === 'rejected')
          throw new DomainException('boost.listing_not_public', { params: { state: listing.state } });
        const product = (await this.products(tx, ctx.tenantId)).find((p) => p.service === input.service);
        if (!product?.onSale) throw new DomainException('media_service.not_on_sale');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media:${listing.unitId}`}))`;
        if (
          await tx.mediaServiceOrder.findFirst({
            where: { unitId: listing.unitId, service: input.service, state: { in: OPEN } },
          })
        )
          throw new DomainException('media_service.order_open');
        const v = product.version;
        const charges = purchaseCharges(
          'media_service',
          `${product.plan.nameTh} — ${listing.titleTh}`,
          v.unitPrice!.toString(),
          v.vatRate.toString(),
        );
        const now = this.clock.now();
        const paid = new Decimal(charges.total).lte(0);
        const invoice = paid
          ? null
          : await this.billing.issue(tx, null, {
              tenantId: ctx.tenantId,
              kind: 'purchase',
              periodStart: bangkokDate(now),
              periodEnd: bangkokDate(now),
              charges,
              snapshot: {
                product: 'media_service',
                service: input.service,
                listingId: listing.id,
                unitId: listing.unitId,
                plan: {
                  key: product.plan.key,
                  versionId: v.id,
                  version: v.version,
                  vatRate: v.vatRate.toString(),
                },
                decision: 'D-297',
              },
            });
        const order = await tx.mediaServiceOrder.create({
          data: {
            tenantId: ctx.tenantId,
            listingId: listing.id,
            unitId: listing.unitId,
            buildingId: listing.buildingId,
            service: input.service,
            pricePlanVersionId: v.id,
            price: charges.total,
            state: paid ? 'requested' : 'pending_payment',
            platformInvoiceId: invoice?.id ?? null,
            note: input.note ?? null,
            requestedAt: paid ? now : null,
            createdBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'media_service.ordered',
          tenantId: ctx.tenantId,
          subjectType: 'platform.media_service_order',
          subjectId: order.id,
          after: {
            service: input.service,
            listingId: listing.id,
            total: charges.total,
            invoice: invoice?.number ?? null,
          },
        });
        await this.events.record(tx, {
          type: 'media_service.ordered',
          aggregateType: 'media_service_order',
          aggregateId: order.id,
          tenantId: ctx.tenantId,
          payload: {
            orderId: order.id,
            service: input.service,
            listingId: listing.id,
            total: charges.total,
            platformInvoiceId: invoice?.id ?? null,
          },
        });
        if (paid) await this.requested(tx, order);
        return order.id;
      },
      { tenantId: ctx.tenantId },
    );
    return this.getOwn(ctx, id);
  }

  private async requested(tx: Tx, order: MediaServiceOrder): Promise<void> {
    await this.events.record(tx, {
      type: 'media_service.requested',
      aggregateType: 'media_service_order',
      aggregateId: order.id,
      tenantId: order.tenantId,
      payload: { orderId: order.id, service: order.service, unitId: order.unitId },
    });
  }

  /** Subscriber: a settled purchase invoice makes its orders `requested` (the partner is booked next). */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload as { platformInvoiceId?: string; settled?: boolean };
    if (!p.settled || !p.platformInvoiceId) return;
    const orders = await tx.mediaServiceOrder.findMany({
      where: { platformInvoiceId: p.platformInvoiceId, state: 'pending_payment' },
    });
    for (const o of orders) {
      await tx.mediaServiceOrder.update({
        where: { id: o.id },
        data: { state: 'requested', requestedAt: this.clock.now(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'media_service.requested',
        tenantId: o.tenantId,
        subjectType: 'platform.media_service_order',
        subjectId: o.id,
        after: { state: 'requested' },
      });
      await this.requested(tx, o);
    }
  }

  // ------------------------------------------------------------------------------------------------- reads

  listOwn(ctx: TenantContext): Promise<MediaOrderRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.mediaServiceOrder.findMany({
        where: { tenantId: ctx.tenantId },
        include: MEDIA_ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  getOwn(ctx: TenantContext, id: string): Promise<MediaOrderRow> {
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.mediaServiceOrder.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: MEDIA_ORDER_INCLUDE,
      });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }

  // ------------------------------------------------------------------------------------------------- platform

  list(filter: { state?: MediaServiceState; tenantId?: string; skip: number; take: number }) {
    const where: Prisma.MediaServiceOrderWhereInput = {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.mediaServiceOrder.findMany({
        where,
        include: MEDIA_ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.mediaServiceOrder.count({ where }),
    }));
  }

  get(id: string): Promise<MediaOrderRow> {
    return this.db.platform(async (tx) => {
      const row = await tx.mediaServiceOrder.findUnique({ where: { id }, include: MEDIA_ORDER_INCLUDE });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }

  private async transition(
    id: string,
    allowed: MediaServiceState[],
    change: (o: MediaServiceOrder) => Prisma.MediaServiceOrderUpdateInput,
    event: 'media_service.scheduled' | 'media_service.delivered' | 'media_service.cancelled',
    extra: (o: MediaServiceOrder) => Record<string, unknown>,
  ): Promise<MediaOrderRow> {
    await this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM platform.media_service_order WHERE id = ${id}::uuid FOR UPDATE`;
      const o = await tx.mediaServiceOrder.findUnique({ where: { id } });
      if (!o) throw new DomainException('http.not_found');
      if (!allowed.includes(o.state))
        throw new DomainException('media_service.invalid_state', { params: { state: o.state } });
      const updated = await tx.mediaServiceOrder.update({
        where: { id },
        data: { ...change(o), updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: event,
        tenantId: o.tenantId,
        subjectType: 'platform.media_service_order',
        subjectId: id,
        before: { state: o.state },
        after: { state: updated.state, ...extra(updated) },
      });
      await this.events.record(tx, {
        type: event,
        aggregateType: 'media_service_order',
        aggregateId: id,
        tenantId: o.tenantId,
        payload: { orderId: id, service: o.service, state: updated.state, ...extra(updated) },
      });
    });
    return this.get(id);
  }

  /** The partner's appointment (requested → scheduled; a scheduled order may be moved). */
  schedule(id: string, input: { scheduledFor: Date; partnerRef?: string | null }) {
    return this.transition(
      id,
      ['requested', 'scheduled'],
      () => ({
        state: 'scheduled',
        scheduledFor: input.scheduledFor,
        scheduledAt: this.clock.now(),
        ...(input.partnerRef !== undefined ? { partnerRef: input.partnerRef } : {}),
      }),
      'media_service.scheduled',
      (o) => ({ scheduledFor: o.scheduledFor?.toISOString() ?? null }),
    );
  }

  /**
   * Presigns one deliverable as a document of the ordering tenant (unit scope; `listing_photo` or `other`) — counted
   * to its quota (D-286). Only for an order that is requested or scheduled.
   */
  async presignDeliverable(id: string, input: Omit<PresignInput, 'scopeType' | 'scopeId'>) {
    const order = await this.get(id);
    if (order.state !== 'requested' && order.state !== 'scheduled')
      throw new DomainException('media_service.invalid_state', { params: { state: order.state } });
    if (!(DELIVERABLE_KINDS as readonly string[]).includes(input.kind))
      throw new DomainException('document.type_not_allowed');
    const result = await this.documents.presign(
      { tenantId: order.tenantId, source: 'path' },
      { ...input, scopeType: 'unit', scopeId: order.unitId },
    );
    await this.db.platform((tx) =>
      this.audit.record(tx, {
        action: 'media_service.deliverable_presigned',
        tenantId: order.tenantId,
        subjectType: 'platform.media_service_order',
        subjectId: id,
        after: { documentId: result.document.id, kind: input.kind, sizeBytes: input.sizeBytes },
      }),
    );
    return result;
  }

  /** Delivered: the uploaded deliverables (documents of the tenant in the order's unit) are attached. */
  async deliver(id: string, documentIds: string[]) {
    const order = await this.get(id);
    const ctx: TenantContext = { tenantId: order.tenantId, source: 'path' };
    const ids = [...new Set(documentIds)];
    for (const documentId of ids) {
      const doc = await this.db.platform((tx) =>
        tx.document.findFirst({
          where: {
            id: documentId,
            tenantId: order.tenantId,
            scopeType: 'unit',
            scopeId: order.unitId,
            deletedAt: null,
            kind: { in: [...DELIVERABLE_KINDS] },
          },
        }),
      );
      if (!doc) throw new DomainException('http.not_found');
      if (doc.uploadState === 'presigned') await this.documents.complete(ctx, documentId, {});
    }
    const now = this.clock.now();
    return this.transition(
      id,
      ['requested', 'scheduled'],
      (o) => ({
        state: 'delivered',
        deliveredAt: now,
        deliverableDocumentIds: [...new Set([...o.deliverableDocumentIds, ...ids])],
      }),
      'media_service.delivered',
      (o) => ({ documentIds: o.deliverableDocumentIds }),
    );
  }

  /** Cancelled by the platform (money already paid is credited by Finance — D-091). */
  cancel(id: string, reason: string) {
    return this.transition(
      id,
      OPEN,
      () => ({ state: 'cancelled', cancelledAt: this.clock.now(), cancelReason: reason }),
      'media_service.cancelled',
      (o) => ({ reason: o.cancelReason }),
    );
  }
}
