import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { LegalHoldService } from '@core/storage/legal-hold.service';
import { LEGAL_HOLD_POLICY_KEY, packagePeriod } from '@core/storage/storage-categories';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type PricePlan,
  type PricePlanVersion,
  type Prisma,
  type StoragePackage,
  type TenantType,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PlatformBillingService } from './platform-billing.service';
import { type Charges } from './pricing';

/** `terms.product` of a price-plan add-on that is a storage package definition (D-285). */
export const STORAGE_PRODUCT = 'storage_package';

export interface StoragePackageTerms {
  product: typeof STORAGE_PRODUCT;
  sizeBytes: string;
  period: 'month' | 'year';
  visibility: 'public' | 'hidden';
  decision: string;
  status?: string;
}

export type PlanWithVersions = PricePlan & { versions: PricePlanVersion[] };

export interface PackageDefinitionView {
  plan: PlanWithVersions;
  /** The version in force today (published) or, failing that, the newest draft. */
  version: PricePlanVersion | null;
  terms: StoragePackageTerms | null;
  onSale: boolean;
}

export interface DefinitionInput {
  key: string;
  nameTh: string;
  nameEn: string;
  sizeGb: string;
  period: 'month' | 'year';
  visibility: 'public' | 'hidden';
  tenantType?: TenantType | null;
  effectiveFrom: string;
  unitPrice?: string | null;
  vatRate?: string;
}

const GIB = 1024n ** 3n;
const by = () => userIdOf(RequestContext.actor());
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export const termsOf = (v: PricePlanVersion | null): StoragePackageTerms | null => {
  const t = (v?.terms ?? {}) as Partial<StoragePackageTerms>;
  return t.product === STORAGE_PRODUCT && typeof t.sizeBytes === 'string' ? (t as StoragePackageTerms) : null;
};

/** The version of a plan in force on `today`: published, started, not closed. */
export function versionInForce(plan: PlanWithVersions, today: string): PricePlanVersion | null {
  return (
    plan.versions
      .filter((v) => v.state === 'published' && day(v.effectiveFrom)! <= today)
      .filter((v) => !v.effectiveTo || day(v.effectiveTo)! > today)
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
}

/**
 * Storage packages (D-285): the platform admin defines them as price-plan add-ons (`kind addon`, billing unit
 * `per_package`, size / period / visibility in the version's terms); prices stay empty until set (O-022) and a
 * package without a published price is shown as not on sale. An owner's purchase writes a pending package and a
 * `purchase` platform invoice (Collective is the issuer, paid to the platform merchant — O-008; no subscription,
 * D-250); the package is active from the day its invoice is paid and raises the quota until it ends. Expiry never
 * deletes data (uploads over the quota are then held, D-276 / D-286); auto-renew invoices the next period ahead.
 */
@Injectable()
export class StoragePackagesService implements EventSubscriber, OnModuleInit {
  readonly name = 'storage-packages';
  readonly eventTypes = ['platform_payment.confirmed', 'lease.ended', 'lease.terminated', 'lease.cancelled'];
  private readonly logger = new Logger('StoragePackages');

  constructor(
    private readonly db: TenantTx,
    private readonly billing: PlatformBillingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly holds: LegalHoldService,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------- definitions (admin)

  private view(plan: PlanWithVersions, today: string, tenantType?: string): PackageDefinitionView {
    const inForce = versionInForce(plan, today);
    const version = inForce ?? plan.versions.find((v) => v.state === 'draft') ?? plan.versions[0] ?? null;
    const terms = termsOf(version);
    const onSale =
      plan.isActive &&
      inForce !== null &&
      inForce.unitPrice !== null &&
      termsOf(inForce)?.visibility === 'public' &&
      (!tenantType || !plan.tenantType || plan.tenantType === tenantType);
    return { plan, version, terms, onSale };
  }

  private async plans(tx: Tx): Promise<PlanWithVersions[]> {
    const plans = await tx.pricePlan.findMany({
      where: { kind: 'addon' },
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { key: 'asc' },
    });
    return plans.filter((p) => p.versions.some((v) => termsOf(v) !== null));
  }

  async definitions(): Promise<PackageDefinitionView[]> {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => (await this.plans(tx)).map((p) => this.view(p, today)));
  }

  async definition(planId: string): Promise<PackageDefinitionView> {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => {
      const plan = (await this.plans(tx)).find((p) => p.id === planId);
      if (!plan) throw new DomainException('http.not_found');
      return this.view(plan, today);
    });
  }

  /** A new package definition = an add-on price plan with a draft version (price optional — O-022). */
  async createDefinition(input: DefinitionInput): Promise<PackageDefinitionView> {
    const today = bangkokDate(this.clock.now());
    if (input.effectiveFrom < today) throw new DomainException('settings.backdated');
    const sizeBytes = new Decimal(input.sizeGb).times(GIB.toString()).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (sizeBytes.lte(0))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sizeGb', code: 'min', message: 'a positive size' }],
      });
    const planId = await this.db.platform(async (tx) => {
      if (await tx.pricePlan.findUnique({ where: { key: input.key } }))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'key', code: 'unique', message: 'a price plan with this key exists' }],
        });
      const plan = await tx.pricePlan.create({
        data: {
          key: input.key,
          nameTh: input.nameTh,
          nameEn: input.nameEn,
          kind: 'addon',
          tenantType: input.tenantType ?? null,
          createdBy: by(),
        },
      });
      const terms: StoragePackageTerms = {
        product: STORAGE_PRODUCT,
        sizeBytes: sizeBytes.toFixed(0),
        period: input.period,
        visibility: input.visibility,
        decision: 'D-285',
        status: input.unitPrice ? 'proposed' : 'not_on_sale (O-022)',
      };
      const version = await tx.pricePlanVersion.create({
        data: {
          planId: plan.id,
          version: 1,
          effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
          billingUnit: 'per_package',
          unitPrice: input.unitPrice ?? null,
          annualDiscountPct: '0',
          vatRate: input.vatRate ?? '0.07',
          terms: terms as unknown as Prisma.InputJsonValue,
          state: 'draft',
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'storage.package_defined',
        subjectType: 'platform.price_plan',
        subjectId: plan.id,
        after: { key: input.key, versionId: version.id, ...terms, unitPrice: input.unitPrice ?? null },
      });
      return plan.id;
    });
    return this.definition(planId);
  }

  /** Names and the active switch of a definition; prices and sizes change only through new versions (D-204). */
  async updateDefinition(
    planId: string,
    input: { nameTh?: string; nameEn?: string; isActive?: boolean },
  ): Promise<PackageDefinitionView> {
    await this.db.platform(async (tx) => {
      const plan = (await this.plans(tx)).find((p) => p.id === planId);
      if (!plan) throw new DomainException('http.not_found');
      await tx.pricePlan.update({
        where: { id: planId },
        data: {
          ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}),
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'storage.package_definition_updated',
        subjectType: 'platform.price_plan',
        subjectId: planId,
        before: { nameTh: plan.nameTh, nameEn: plan.nameEn, isActive: plan.isActive },
        after: input,
      });
    });
    return this.definition(planId);
  }

  // ------------------------------------------------------------------------------------------- owner

  /** What the owner may buy (public definitions, with `onSale`) and the tenant's own packages. */
  async catalogue(ctx: TenantContext) {
    const today = bangkokDate(this.clock.now());
    return this.db.tenant(ctx, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { type: true },
      });
      const offers = (await this.plans(tx))
        .map((p) => this.view(p, today, tenant.type))
        .filter(
          (v) =>
            v.plan.isActive &&
            v.terms?.visibility === 'public' &&
            (!v.plan.tenantType || v.plan.tenantType === tenant.type),
        );
      const mine = await tx.storagePackage.findMany({
        where: { tenantId: ctx.tenantId },
        include: { platformInvoice: true, pricePlanVersion: { include: { plan: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return { offers, mine };
    });
  }

  getOwn(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.storagePackage.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: { platformInvoice: true, pricePlanVersion: { include: { plan: true } } },
      });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }

  private charges(version: PricePlanVersion, name: string, terms: StoragePackageTerms): Charges {
    const amount = new Decimal(version.unitPrice!.toString()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const vat = amount.times(version.vatRate.toString()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      lines: [
        {
          kind: 'storage',
          description: `${name} (${terms.period === 'month' ? 'รายเดือน' : 'รายปี'})`,
          quantity: '1.000',
          unitPrice: new Decimal(version.unitPrice!.toString()).toFixed(4),
          amount: amount.toFixed(2),
        },
      ],
      subtotal: amount.toFixed(2),
      discount: '0.00',
      vatAmount: vat.toFixed(2),
      total: amount.plus(vat).toFixed(2),
    };
  }

  /**
   * Writes a pending package and its purchase invoice in one platform transaction (the caller's request is
   * idempotent). A price of 0 activates at once (nothing to pay).
   */
  private async order(
    tx: Tx,
    tenantId: string,
    plan: PlanWithVersions,
    version: PricePlanVersion,
    opts: { autoRenew: boolean; renewalOf?: StoragePackage | null },
  ): Promise<StoragePackage> {
    const terms = termsOf(version)!;
    const today = bangkokDate(this.clock.now());
    const charges = this.charges(version, plan.nameTh, terms);
    const start = opts.renewalOf?.endsOn ? addCalendarDays(day(opts.renewalOf.endsOn)!, 1) : today;
    const period = packagePeriod(start, terms.period);
    const invoice = await this.billing.issue(tx, null, {
      tenantId,
      kind: 'purchase',
      periodStart: period.startsOn,
      periodEnd: period.endsOn,
      charges,
      snapshot: {
        product: STORAGE_PRODUCT,
        plan: {
          key: plan.key,
          versionId: version.id,
          version: version.version,
          vatRate: version.vatRate.toString(),
        },
        sizeBytes: terms.sizeBytes,
        period: terms.period,
        renewalOf: opts.renewalOf?.id ?? null,
      },
    });
    const pkg = await tx.storagePackage.create({
      data: {
        tenantId,
        pricePlanVersionId: version.id,
        sizeBytes: BigInt(terms.sizeBytes),
        price: charges.total,
        period: terms.period,
        platformInvoiceId: invoice.id,
        autoRenew: opts.autoRenew,
        renewalOfId: opts.renewalOf?.id ?? null,
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'storage.package_ordered',
      tenantId,
      subjectType: 'platform.storage_package',
      subjectId: pkg.id,
      after: {
        plan: plan.key,
        sizeBytes: terms.sizeBytes,
        total: charges.total,
        invoice: invoice.number,
        renewalOf: opts.renewalOf?.id ?? null,
      },
    });
    await this.events.record(tx, {
      type: 'storage.package_ordered',
      aggregateType: 'storage_package',
      aggregateId: pkg.id,
      tenantId,
      payload: { storagePackageId: pkg.id, platformInvoiceId: invoice.id, total: charges.total },
    });
    if (new Decimal(charges.total).isZero()) return this.activate(tx, pkg);
    return pkg;
  }

  /** The owner buys a package (Idempotency-Key on the route): 409 when not on sale or one is already waiting. */
  async purchase(ctx: TenantContext, input: { packageId: string; autoRenew?: boolean }) {
    const today = bangkokDate(this.clock.now());
    const id = await this.db.platform(
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: ctx.tenantId },
          select: { type: true },
        });
        const plan = (await this.plans(tx)).find((p) => p.id === input.packageId);
        if (!plan) throw new DomainException('http.not_found');
        const view = this.view(plan, today, tenant.type);
        if (!plan.isActive || view.terms?.visibility !== 'public')
          throw new DomainException('http.not_found');
        if (!view.onSale) throw new DomainException('storage.package_not_on_sale');
        await tx.$queryRaw`SELECT id FROM core.tenant WHERE id = ${ctx.tenantId}::uuid FOR UPDATE`;
        const pending = await tx.storagePackage.findFirst({
          where: {
            tenantId: ctx.tenantId,
            state: 'pending_payment',
            renewalOfId: null,
            pricePlanVersion: { planId: plan.id },
          },
        });
        if (pending) throw new DomainException('storage.package_pending');
        return (
          await this.order(tx, ctx.tenantId, plan, versionInForce(plan, today)!, {
            autoRenew: input.autoRenew ?? false,
          })
        ).id;
      },
      { tenantId: ctx.tenantId },
    );
    return this.getOwn(ctx, id);
  }

  /** Switches auto-renew of one of the tenant's packages. */
  async setAutoRenew(ctx: TenantContext, id: string, autoRenew: boolean) {
    await this.db.platform(
      async (tx) => {
        const pkg = await tx.storagePackage.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!pkg) throw new DomainException('http.not_found');
        if (pkg.autoRenew === autoRenew) return;
        await tx.storagePackage.update({ where: { id }, data: { autoRenew, updatedBy: by() } });
        await this.audit.record(tx, {
          action: 'storage.package_auto_renew_changed',
          tenantId: ctx.tenantId,
          subjectType: 'platform.storage_package',
          subjectId: id,
          before: { autoRenew: pkg.autoRenew },
          after: { autoRenew },
        });
      },
      { tenantId: ctx.tenantId },
    );
    return this.getOwn(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Pending → active from today (a paid renewal starts the day after the package it renews). */
  private async activate(tx: Tx, pkg: StoragePackage): Promise<StoragePackage> {
    const today = bangkokDate(this.clock.now());
    const renewed = pkg.renewalOfId
      ? await tx.storagePackage.findUnique({ where: { id: pkg.renewalOfId } })
      : null;
    const afterRenewed =
      renewed?.state === 'active' && renewed.endsOn ? addCalendarDays(day(renewed.endsOn)!, 1) : today;
    const start = afterRenewed > today ? afterRenewed : today;
    const { startsOn, endsOn } = packagePeriod(start, pkg.period);
    const now = this.clock.now();
    const active = await tx.storagePackage.update({
      where: { id: pkg.id },
      data: {
        state: 'active',
        startsOn: new Date(`${startsOn}T00:00:00Z`),
        endsOn: new Date(`${endsOn}T00:00:00Z`),
        activatedAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'storage.package_activated',
      tenantId: pkg.tenantId,
      subjectType: 'platform.storage_package',
      subjectId: pkg.id,
      after: { startsOn, endsOn, sizeBytes: pkg.sizeBytes.toString() },
    });
    await this.events.record(tx, {
      type: 'storage.package_activated',
      aggregateType: 'storage_package',
      aggregateId: pkg.id,
      tenantId: pkg.tenantId,
      payload: { storagePackageId: pkg.id, startsOn, endsOn, sizeBytes: pkg.sizeBytes.toString() },
    });
    return active;
  }

  /** Subscriber: a settled purchase invoice activates its package; a lease that ended dates its contract holds. */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'platform_payment.confirmed') {
      const p = event.payload as { platformInvoiceId: string; settled?: boolean };
      if (!p.settled) return;
      const pkgs = await tx.storagePackage.findMany({
        where: { platformInvoiceId: p.platformInvoiceId, state: 'pending_payment' },
      });
      for (const pkg of pkgs) await this.activate(tx, pkg);
      return;
    }
    // D-286: a lease contract is kept for the policy period counted from the end of the lease (O-025 ⚖)
    const leaseId = (event.payload as { leaseId?: string }).leaseId ?? event.aggregateId;
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: { contractDocumentId: true, signedDocumentId: true },
    });
    if (!lease) return;
    const signatures = await tx.leaseSignature.findMany({
      where: { leaseId },
      select: { signatureImageDocumentId: true },
    });
    const ids = [
      lease.contractDocumentId,
      lease.signedDocumentId,
      ...signatures.map((s) => s.signatureImageDocumentId),
    ].filter((x): x is string => !!x);
    const basis = bangkokDate(this.clock.now());
    for (const id of ids) await this.holds.settle(tx, id, basis);
  }

  /**
   * Worker job `storage-maintenance` (hourly, idempotent): expires packages past their end (nothing is deleted), issues
   * renewals of auto-renew packages `storage.package.renew_days_before` days ahead, and holds legal documents stored
   * before G1 that have no hold yet.
   */
  async maintain(): Promise<{ expired: number; renewed: number; held: number }> {
    const now = this.clock.now();
    const today = bangkokDate(now);
    const renewDays = await this.settings.valueAt<number>('storage.package.renew_days_before', now);
    return RequestContext.run({ actor: systemActor('storage-maintenance') }, async () => {
      const expiring = await this.db.platform((tx) =>
        tx.storagePackage.findMany({
          where: { state: 'active', endsOn: { lt: new Date(`${today}T00:00:00Z`) } },
          take: 500,
        }),
      );
      for (const pkg of expiring)
        await this.db.platform(
          async (tx) => {
            await tx.storagePackage.update({ where: { id: pkg.id }, data: { state: 'expired' } });
            await this.audit.record(tx, {
              action: 'storage.package_expired',
              tenantId: pkg.tenantId,
              subjectType: 'platform.storage_package',
              subjectId: pkg.id,
              after: { endsOn: day(pkg.endsOn) },
            });
            await this.events.record(tx, {
              type: 'storage.package_expired',
              aggregateType: 'storage_package',
              aggregateId: pkg.id,
              tenantId: pkg.tenantId,
              payload: { storagePackageId: pkg.id, endsOn: day(pkg.endsOn) },
            });
          },
          { tenantId: pkg.tenantId },
        );
      const due = await this.db.platform((tx) =>
        tx.storagePackage.findMany({
          where: {
            state: 'active',
            autoRenew: true,
            renewalIssuedAt: null,
            endsOn: { lte: new Date(`${addCalendarDays(today, renewDays)}T00:00:00Z`) },
          },
          include: { pricePlanVersion: true },
          take: 200,
        }),
      );
      let renewed = 0;
      for (const pkg of due) {
        try {
          await this.db.platform(
            async (tx) => {
              const plan = (await this.plans(tx)).find((p) => p.id === pkg.pricePlanVersion.planId);
              const view = plan ? this.view(plan, today) : null;
              // not on sale any more: no renewal invoice; the package simply ends (the owner is told by the event)
              if (plan && view?.onSale) {
                await this.order(tx, pkg.tenantId, plan, versionInForce(plan, today)!, {
                  autoRenew: true,
                  renewalOf: pkg,
                });
                renewed += 1;
              }
              await tx.storagePackage.update({ where: { id: pkg.id }, data: { renewalIssuedAt: now } });
            },
            { tenantId: pkg.tenantId },
          );
        } catch (error) {
          this.logger.error(`renewal of ${pkg.id} failed: ${(error as Error).message}`);
        }
      }
      const held = await this.holdLegacy();
      return { expired: expiring.length, renewed, held };
    });
  }

  /** Legal documents stored before G1 (or by a path that missed it) get their hold (D-286), oldest first. */
  private async holdLegacy(limit = 500): Promise<number> {
    const kinds = Object.keys(LEGAL_HOLD_POLICY_KEY);
    const docs = await this.db.platform(
      (tx) =>
        tx.$queryRaw<{ id: string; tenant_id: string; kind: string; created_at: Date }[]>`
        SELECT d.id, d.tenant_id, d.kind::text AS kind, d.created_at FROM core.document d
         WHERE d.tenant_id IS NOT NULL AND d.deleted_at IS NULL AND d.upload_state IN ('uploaded', 'verified')
           AND d.kind::text = ANY(${kinds}::text[])
           AND (d.scan_status = 'skipped' OR d.kind = 'slip')
           AND NOT EXISTS (SELECT 1 FROM platform.document_legal_hold h WHERE h.document_id = d.id)
         ORDER BY d.created_at LIMIT ${limit}`,
    );
    for (const d of docs)
      await this.db.platform(
        (tx) =>
          this.holds.hold(tx, {
            tenantId: d.tenant_id,
            documentId: d.id,
            kind: d.kind as never,
            issuedAt: d.created_at,
            sourceType: 'backfill',
          }),
        { tenantId: d.tenant_id },
      );
    return docs.length;
  }
}
