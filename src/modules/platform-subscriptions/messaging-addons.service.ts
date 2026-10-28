import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokMonth } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type PlatformInvoice, type PricePlanVersion, type TenantType } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PlatformBillingService } from './platform-billing.service';
import { type Charges } from './pricing';
import { type PlanWithVersions, versionInForce } from './storage-packages.service';

/** `terms.product` of the agency LINE OA integration add-on (D-287; seeded without a price, O-027). */
export const OA_PRODUCT = 'line_oa_integration';

export interface AddonOffer {
  plan: PlanWithVersions;
  version: PricePlanVersion;
}

export type AddonCharge = 'setup' | 'monthly';

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const productOf = (v: PricePlanVersion) => (v.terms as { product?: unknown } | null)?.product;

/** The month (`YYYY-MM`) and its first / last day in Bangkok. */
export function monthPeriod(month: string): { start: string; end: string } {
  const start = `${month}-01`;
  const next = new Date(Date.parse(`${start}T00:00:00Z`));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: addCalendarDays(next.toISOString().slice(0, 10), -1) };
}

/**
 * The LINE OA integration fee of an operator's own OA (G4, D-287, D-291): a price-plan add-on (`terms.product =
 * line_oa_integration`, billing unit `per_tenant`; `unit_price` = monthly fee, `setup_fee` = once) — seeded for
 * `agency` without a price (O-027): **no published price, nothing charged** and connecting stays as B7.7. While a
 * priced version is in force for the tenant's type, connecting asks the owner to accept it (`acceptAddonVersionId`,
 * else `messaging.addon_terms_required` with the prices), the setup fee is invoiced once, and the job
 * `messaging-addons` invoices the monthly fee for every Bangkok month an own OA was live on its first day (the first
 * partial month is free). Charges are `purchase` platform invoices (Collective issues them, O-008); unpaid = nothing
 * suspended (D-250). LINE bills its own message charges to the operator directly (D-254).
 */
@Injectable()
export class MessagingAddonsService {
  private readonly logger = new Logger('MessagingAddons');

  constructor(
    private readonly db: TenantTx,
    private readonly billing: PlatformBillingService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The add-on plan for a tenant type with its version in force on `day` (priced or not), or null. */
  private async plan(tx: Tx, type: TenantType, day: string) {
    const plans = await tx.pricePlan.findMany({
      where: { kind: 'addon', isActive: true, OR: [{ tenantType: type }, { tenantType: null }] },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const plan = plans.find((p) => p.versions.some((v) => productOf(v) === OA_PRODUCT));
    if (!plan) return null;
    return { plan, inForce: versionInForce(plan, day) };
  }

  /** The priced offer in force for a tenant type on a day — what is charged — or null (not on sale). */
  async offerIn(tx: Tx, type: TenantType, day: string): Promise<AddonOffer | null> {
    const found = await this.plan(tx, type, day);
    if (!found?.inForce || found.inForce.unitPrice === null || productOf(found.inForce) !== OA_PRODUCT)
      return null;
    return { plan: found.plan, version: found.inForce };
  }

  private invoices(tx: Tx, tenantId: string) {
    return tx.platformInvoice.findMany({
      where: { tenantId, kind: 'purchase', snapshot: { path: ['product'], equals: OA_PRODUCT } },
      orderBy: { issuedAt: 'desc' },
      take: 24,
    });
  }

  /** `GET /v1/owner/messaging/addons`: the offer for this tenant (priced or "not on sale") and its fee invoices. */
  async catalogue(ctx: TenantContext) {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { type: true },
      });
      const found = await this.plan(tx, tenant.type, today);
      const priced = await this.offerIn(tx, tenant.type, today);
      const invoices = await this.invoices(tx, ctx.tenantId);
      const version = priced?.version ?? found?.plan.versions[0] ?? null;
      return {
        plan: found?.plan ?? null,
        version,
        onSale: priced !== null,
        setupCharged: invoices.some((i) => this.chargeOf(i) === 'setup' && i.state !== 'void'),
        invoices,
      };
    });
  }

  chargeOf(invoice: PlatformInvoice): AddonCharge | null {
    const c = (invoice.snapshot as { charge?: unknown } | null)?.charge;
    return c === 'setup' || c === 'monthly' ? c : null;
  }

  /**
   * Before connecting an own OA: while the add-on is priced for the tenant's type, the owner must have accepted the
   * version in force (409 `messaging.addon_terms_required` with the prices otherwise).
   */
  async assertAccepted(ctx: TenantContext, acceptedVersionId: string | undefined): Promise<void> {
    const today = bangkokDate(this.clock.now());
    await this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { type: true },
      });
      const offer = await this.offerIn(tx, tenant.type, today);
      if (!offer || offer.version.id === acceptedVersionId) return;
      throw new DomainException('messaging.addon_terms_required', {
        extensions: {
          addon: {
            versionId: offer.version.id,
            monthlyFee: money(new Decimal(offer.version.unitPrice!.toString())).toFixed(2),
            setupFee: money(new Decimal(offer.version.setupFee.toString())).toFixed(2),
            vatRate: new Decimal(offer.version.vatRate.toString()).toFixed(4),
            currency: offer.version.currency,
          },
        },
      });
    });
  }

  private charges(version: PricePlanVersion, charge: AddonCharge, name: string, month: string): Charges {
    const amount = money(
      new Decimal((charge === 'setup' ? version.setupFee : version.unitPrice!).toString()),
    );
    const vat = money(amount.times(version.vatRate.toString()));
    return {
      lines: [
        {
          kind: charge === 'setup' ? 'setup' : 'messaging_addon',
          description:
            charge === 'setup' ? `${name} — ค่าตั้งค่าครั้งแรก` : `${name} — ค่าบริการรายเดือน ${month}`,
          quantity: '1.000',
          unitPrice: amount.toFixed(4),
          amount: amount.toFixed(2),
        },
      ],
      subtotal: amount.toFixed(2),
      discount: '0.00',
      vatAmount: vat.toFixed(2),
      total: amount.plus(vat).toFixed(2),
    };
  }

  /** Issues one charge once (advisory lock per tenant; an earlier non-void invoice of the same charge / month wins). */
  private async charge(tx: Tx, tenantId: string, offer: AddonOffer, charge: AddonCharge, month: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`oa-addon:${tenantId}`}))`;
    const existing = (await this.invoices(tx, tenantId)).find(
      (i) =>
        i.state !== 'void' &&
        this.chargeOf(i) === charge &&
        (charge === 'setup' || (i.snapshot as { month?: string }).month === month),
    );
    if (existing) return null;
    const amount = charge === 'setup' ? offer.version.setupFee : offer.version.unitPrice!;
    if (new Decimal(amount.toString()).lte(0)) return null;
    const period =
      charge === 'setup'
        ? { start: bangkokDate(this.clock.now()), end: bangkokDate(this.clock.now()) }
        : monthPeriod(month);
    const charges = this.charges(offer.version, charge, offer.plan.nameTh, month);
    const invoice = await this.billing.issue(tx, null, {
      tenantId,
      kind: 'purchase',
      periodStart: period.start,
      periodEnd: period.end,
      charges,
      snapshot: {
        product: OA_PRODUCT,
        charge,
        month: charge === 'monthly' ? month : null,
        plan: {
          key: offer.plan.key,
          versionId: offer.version.id,
          version: offer.version.version,
          vatRate: offer.version.vatRate.toString(),
        },
        decision: 'D-287',
      },
    });
    await this.audit.record(tx, {
      action: 'messaging.addon_invoiced',
      tenantId,
      subjectType: 'platform.platform_invoice',
      subjectId: invoice.id,
      after: {
        charge,
        month: charge === 'monthly' ? month : null,
        total: charges.total,
        invoice: invoice.number,
      },
    });
    await this.events.record(tx, {
      type: 'messaging.addon_invoiced',
      aggregateType: 'platform_invoice',
      aggregateId: invoice.id,
      tenantId,
      payload: { platformInvoiceId: invoice.id, charge, total: charges.total },
    });
    return invoice;
  }

  /** After an own OA was connected with accepted terms: the setup fee, once per tenant. */
  async chargeSetup(ctx: TenantContext): Promise<void> {
    const today = bangkokDate(this.clock.now());
    await this.db.platform(
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: ctx.tenantId },
          select: { type: true },
        });
        const offer = await this.offerIn(tx, tenant.type, today);
        if (offer) await this.charge(tx, ctx.tenantId, offer, 'setup', today.slice(0, 7));
      },
      { tenantId: ctx.tenantId },
    );
  }

  /**
   * Job `messaging-addons` (hourly, idempotent): the monthly fee of the current Bangkok month for every tenant whose
   * own OA was live on the month's first day, at the version in force that day.
   */
  async maintain(): Promise<number> {
    const now = this.clock.now();
    const monthStart = startOfBangkokMonth(now);
    const month = bangkokDate(now).slice(0, 7);
    const firstDay = `${month}-01`;
    return RequestContext.run({ actor: systemActor('messaging-addons') }, async () => {
      const tenants = await this.db.platform(async (tx) => {
        const rows = await tx.messagingChannel.findMany({
          where: {
            createdAt: { lt: monthStart },
            OR: [{ revokedAt: null }, { revokedAt: { gte: monthStart } }],
          },
          select: { tenantId: true, tenant: { select: { type: true } } },
        });
        return [...new Map(rows.map((r) => [r.tenantId, r.tenant.type])).entries()];
      });
      let issued = 0;
      for (const [tenantId, type] of tenants) {
        try {
          const invoice = await this.db.platform(
            async (tx) => {
              const offer = await this.offerIn(tx, type, firstDay);
              return offer ? this.charge(tx, tenantId, offer, 'monthly', month) : null;
            },
            { tenantId },
          );
          if (invoice) issued += 1;
        } catch (error) {
          this.logger.warn(`OA add-on of ${tenantId}: ${(error as Error).message}`);
        }
      }
      return issued;
    });
  }
}
