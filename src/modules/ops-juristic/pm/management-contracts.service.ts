import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ManagementContract,
  type ManagementContractState,
  type ManagementFeePeriod,
  Prisma,
} from '@generated/prisma/client';
import { ExpensesService } from '@modules/ops-juristic/accounting/expenses.service';
import { LedgerService } from '@modules/ops-juristic/accounting/ledger.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { chargeableSlices, dueOnAfter, lastServiceDay, proratedFee, termsProblems } from './management-rules';

const by = () => userIdOf(RequestContext.actor());
const day = (d: Date) => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null) => (d ? day(d) : null);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
/** Bangkok midnight that starts business day `d` (UTC instant). */
export const bangkokMidnight = (d: string) => new Date(`${d}T00:00:00+07:00`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** Grant modules of a management contract (D-334): the juristic module only, read — aggregates, never residents. */
export const PM_GRANT_MODULES = ['juristic'] as const;

export type ContractSide = 'juristic' | 'pm';

export interface ManagementContractInput {
  buildingId: string;
  pmTenantId: string;
  vendorId: string;
  title: string;
  scope?: string | null;
  fee: string;
  vatAmount?: string | null;
  feePeriod?: ManagementFeePeriod;
  dueDay?: number;
  startsOn: string;
  endsOn: string;
  expenseAccountId?: string | null;
  whtKey?: string | null;
  resolutionId?: string | null;
  documentId?: string | null;
  note?: string | null;
}

export interface ManagementContractView {
  contract: ManagementContract;
  side: ContractSide;
  juristicName: string;
  pmName: string;
  buildingName: string;
  access: { active: boolean; validFrom: Date | null; validTo: Date | null; revokedAt: Date | null };
  feesRequested: number;
}

export interface ChargeView {
  id: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  serviceDays: number;
  periodDays: number;
  amount: string;
  vatAmount: string;
  dueOn: string;
  requestedAt: Date;
  /** Juristic side only: the expense request carrying the fee. */
  expenseRequest: { id: string; number: string | null; state: string } | null;
}

/**
 * Management contracts between a `pm_company` tenant and a juristic tenant (D-150 C3, D-334). The juristic drafts and
 * offers (with the adopted resolution that appoints the manager); the PM accepts (→ a read grant on the building,
 * module `juristic`, for the term) or declines; either side terminates (grant revoked or cut at the date). The job
 * `management-contracts` turns every ended billing period into one submitted expense request of the juristic
 * (never paid automatically) and ends contracts past their term.
 */
@Injectable()
export class ManagementContractsService extends TenantScopedRepository {
  private readonly logger = new Logger(ManagementContractsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly expenses: ExpensesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  today(): string {
    return bangkokDate(this.clock.now());
  }

  private actorId(): string {
    const id = by();
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  /** Only `pm_company` tenants have the PM surface (any other tenant: 404). */
  async assertPm(tx: Tx, tenantId: string): Promise<void> {
    const t = await tx.tenant.findFirst({ where: { id: tenantId }, select: { type: true } });
    if (t?.type !== 'pm_company') throw new DomainException('http.not_found');
  }

  // ============================================================================================ loading

  private async ownBuilding(tx: Tx, ctx: TenantContext, buildingId: string) {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
      select: { id: true, name: true },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
      throw new DomainException('http.not_found');
    return b;
  }

  private async lock(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.management_contract WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** A contract of the calling side (juristic: own + building scope; PM: addressed to it); else 404. */
  async load(tx: Tx, ctx: TenantContext, side: ContractSide, id: string): Promise<ManagementContract> {
    const c = await tx.managementContract.findFirst({
      where: side === 'juristic' ? { id, tenantId: ctx.tenantId } : { id, pmTenantId: ctx.tenantId },
    });
    if (!c) throw new DomainException('http.not_found');
    // a draft is the juristic's own business until it is offered
    if (side === 'pm' && (c.state === 'draft' || (c.state === 'cancelled' && !c.offeredAt)))
      throw new DomainException('http.not_found');
    if (side === 'juristic' && ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
      throw new DomainException('http.not_found');
    return c;
  }

  /** Names of tenants and buildings and the grant state — read as gp_platform for rows the caller already sees. */
  async views(side: ContractSide, rows: ManagementContract[]): Promise<ManagementContractView[]> {
    if (!rows.length) return [];
    const tenantIds = [...new Set(rows.flatMap((r) => [r.tenantId, r.pmTenantId]))];
    const buildingIds = [...new Set(rows.map((r) => r.buildingId))];
    const grantIds = rows.map((r) => r.grantId).filter((g): g is string => Boolean(g));
    const ids = rows.map((r) => r.id);
    const [tenants, buildings, grants, counts] = await this.db.platform(async (tx) =>
      Promise.all([
        tx.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, displayName: true } }),
        tx.building.findMany({ where: { id: { in: buildingIds } }, select: { id: true, name: true } }),
        tx.assetAccessGrant.findMany({ where: { id: { in: grantIds } } }),
        tx.managementFeeCharge.groupBy({
          by: ['contractId'],
          where: { contractId: { in: ids } },
          _count: true,
        }),
      ]),
    );
    const tName = new Map(tenants.map((t) => [t.id, t.displayName]));
    const bName = new Map(buildings.map((b) => [b.id, b.name]));
    const grant = new Map(grants.map((g) => [g.id, g]));
    const count = new Map(counts.map((c) => [c.contractId, c._count]));
    const now = this.clock.now();
    return rows.map((c) => {
      const g = c.grantId ? grant.get(c.grantId) : undefined;
      return {
        contract: c,
        side,
        juristicName: tName.get(c.tenantId) ?? '',
        pmName: tName.get(c.pmTenantId) ?? '',
        buildingName: bName.get(c.buildingId) ?? '',
        access: {
          active: Boolean(g && !g.revokedAt && g.validFrom <= now && (!g.validTo || g.validTo > now)),
          validFrom: g?.validFrom ?? null,
          validTo: g?.validTo ?? null,
          revokedAt: g?.revokedAt ?? null,
        },
        feesRequested: count.get(c.id) ?? 0,
      };
    });
  }

  async view(side: ContractSide, c: ManagementContract): Promise<ManagementContractView> {
    return (await this.views(side, [c]))[0]!;
  }

  get(ctx: TenantContext, side: ContractSide, id: string): Promise<ManagementContractView> {
    return this.db
      .tenant(ctx, async (tx) => {
        await this.assertSide(tx, ctx, side);
        return this.load(tx, ctx, side, id);
      })
      .then((c) => this.view(side, c));
  }

  private async assertSide(tx: Tx, ctx: TenantContext, side: ContractSide) {
    if (side === 'juristic') await this.ledger.assertJuristic(tx, ctx.tenantId);
    else await this.assertPm(tx, ctx.tenantId);
  }

  async list(
    ctx: TenantContext,
    side: ContractSide,
    q: {
      state?: ManagementContractState;
      buildingId?: string;
      counterpartTenantId?: string;
      skip: number;
      take: number;
    },
  ): Promise<{ rows: ManagementContractView[]; total: number }> {
    const { rows, total } = await this.db.tenant(ctx, async (tx) => {
      await this.assertSide(tx, ctx, side);
      const where: Prisma.ManagementContractWhereInput =
        side === 'juristic'
          ? {
              tenantId: ctx.tenantId,
              ...(q.counterpartTenantId ? { pmTenantId: q.counterpartTenantId } : {}),
              ...(q.buildingId
                ? { buildingId: q.buildingId }
                : ctx.buildingIds
                  ? { buildingId: { in: [...ctx.buildingIds] } }
                  : {}),
            }
          : {
              pmTenantId: ctx.tenantId,
              offeredAt: { not: null },
              ...(q.counterpartTenantId ? { tenantId: q.counterpartTenantId } : {}),
              ...(q.buildingId ? { buildingId: q.buildingId } : {}),
            };
      if (q.state) where.state = q.state;
      if (side === 'juristic' && q.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(q.buildingId))
        return { rows: [], total: 0 };
      const [rows, total] = await Promise.all([
        tx.managementContract.findMany({
          where,
          orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.managementContract.count({ where }),
      ]);
      return { rows, total };
    });
    return { rows: await this.views(side, rows), total };
  }

  // ============================================================================================ juristic side

  /** Shape, building, vendor, account, WHT key, resolution, document and the PM tenant of the terms. */
  private async checkTerms(tx: Tx, ctx: TenantContext, input: ManagementContractInput, forOffer: boolean) {
    await this.ownBuilding(tx, ctx, input.buildingId);
    if (!DATE.test(input.startsOn)) throw invalid('startsOn', 'date', 'a date YYYY-MM-DD');
    if (!DATE.test(input.endsOn)) throw invalid('endsOn', 'date', 'a date YYYY-MM-DD');
    const problems = termsProblems({
      fee: input.fee,
      vatAmount: input.vatAmount ?? '0.00',
      dueDay: input.dueDay ?? 5,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    });
    if (problems.length) throw new DomainException('validation.failed', { errors: problems });
    const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, tenantId: ctx.tenantId } });
    if (!vendor) throw new DomainException('http.not_found');
    if (vendor.state !== 'active') throw new DomainException('vendor.blocked');
    if (input.expenseAccountId) {
      const a = await tx.account.findFirst({ where: { id: input.expenseAccountId, tenantId: ctx.tenantId } });
      if (!a) throw new DomainException('http.not_found');
      if (a.type !== 'expense' || !a.isActive)
        throw invalid('expenseAccountId', 'expense_account', 'an active expense account');
    } else if (forOffer) throw invalid('expenseAccountId', 'required', 'the account the fee posts to');
    if (input.whtKey) {
      const rates =
        (await this.settings.valueAt<{ key: string }[]>('juristic.wht_rates', this.clock.now(), {
          tenantId: ctx.tenantId,
        })) ?? [];
      if (!rates.some((r) => r.key === input.whtKey))
        throw invalid('whtKey', 'unknown', 'a key of juristic.wht_rates');
    }
    if (input.documentId) {
      const d = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!d) throw new DomainException('http.not_found');
    }
    if (input.resolutionId) {
      const r = await tx.resolution.findFirst({ where: { id: input.resolutionId, tenantId: ctx.tenantId } });
      if (!r) throw new DomainException('http.not_found');
      if (forOffer && (r.state !== 'adopted' || r.buildingId !== input.buildingId))
        throw new DomainException('management_contract.resolution_invalid');
    } else if (forOffer) throw new DomainException('management_contract.resolution_required');
    // the other party: an active pm_company tenant (one answer for "missing" and "not a PM", no enumeration)
    if (input.pmTenantId === ctx.tenantId) throw new DomainException('management_contract.pm_tenant_invalid');
    const pm = await this.db.platform((p) =>
      p.tenant.findFirst({
        where: { id: input.pmTenantId, deletedAt: null, status: { not: 'deactivated' } },
        select: { type: true },
      }),
    );
    if (pm?.type !== 'pm_company') throw new DomainException('management_contract.pm_tenant_invalid');
  }

  private data(input: ManagementContractInput) {
    return {
      buildingId: input.buildingId,
      pmTenantId: input.pmTenantId,
      vendorId: input.vendorId,
      title: input.title.trim(),
      scope: input.scope ?? null,
      fee: new Decimal(input.fee).toFixed(2),
      vatAmount: new Decimal(input.vatAmount ?? '0').toFixed(2),
      feePeriod: input.feePeriod ?? 'monthly',
      dueDay: input.dueDay ?? 5,
      startsOn: asDate(input.startsOn),
      endsOn: asDate(input.endsOn),
      expenseAccountId: input.expenseAccountId ?? null,
      whtKey: input.whtKey ?? null,
      resolutionId: input.resolutionId ?? null,
      documentId: input.documentId ?? null,
      note: input.note ?? null,
    };
  }

  private toInput(c: ManagementContract): ManagementContractInput {
    return {
      buildingId: c.buildingId,
      pmTenantId: c.pmTenantId,
      vendorId: c.vendorId,
      title: c.title,
      scope: c.scope,
      fee: c.fee.toFixed(2),
      vatAmount: c.vatAmount.toFixed(2),
      feePeriod: c.feePeriod,
      dueDay: c.dueDay,
      startsOn: day(c.startsOn),
      endsOn: day(c.endsOn),
      expenseAccountId: c.expenseAccountId,
      whtKey: c.whtKey,
      resolutionId: c.resolutionId,
      documentId: c.documentId,
      note: c.note,
    };
  }

  private event(
    tx: Tx,
    c: Pick<ManagementContract, 'id' | 'tenantId' | 'pmTenantId' | 'buildingId'>,
    type: DomainEventType,
    payload: Record<string, unknown>,
  ) {
    return this.events.record(tx, {
      type,
      aggregateType: 'management_contract',
      aggregateId: c.id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { managementContractId: c.id, pmTenantId: c.pmTenantId, ...payload },
    });
  }

  async create(ctx: TenantContext, input: ManagementContractInput): Promise<ManagementContractView> {
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.checkTerms(tx, ctx, input, false);
      const dup = await tx.managementContract.findFirst({
        where: {
          buildingId: input.buildingId,
          pmTenantId: input.pmTenantId,
          startsOn: asDate(input.startsOn),
        },
        select: { id: true },
      });
      if (dup) throw new DomainException('management_contract.overlap');
      const row = await tx.managementContract.create({
        data: { tenantId: ctx.tenantId, ...this.data(input), createdBy: by() },
      });
      await this.audit.record(tx, {
        action: 'juristic.management_contract_drafted',
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: row.id,
        metadata: { pmTenantId: row.pmTenantId, fee: row.fee.toFixed(2), feePeriod: row.feePeriod },
      });
      await this.event(tx, row, 'juristic.management_contract.changed', {
        state: 'draft',
        change: 'drafted',
      });
      return row;
    });
    return this.view('juristic', c);
  }

  async update(
    ctx: TenantContext,
    id: string,
    patch: Partial<Omit<ManagementContractInput, 'buildingId'>> & { version?: number },
  ): Promise<ManagementContractView> {
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const c = await this.load(tx, ctx, 'juristic', id);
      if (patch.version !== undefined && patch.version !== c.version)
        throw new DomainException('concurrency.stale');
      if (c.state !== 'draft')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      const { version: _v, ...given } = patch;
      const rest = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
      const merged: ManagementContractInput = { ...this.toInput(c), ...rest };
      await this.checkTerms(tx, ctx, merged, false);
      const row = await tx.managementContract.update({
        where: { id },
        data: { ...this.data(merged), updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'juristic.management_contract_updated',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: id,
        metadata: { fields: Object.keys(rest) },
      });
      await this.event(tx, row, 'juristic.management_contract.changed', {
        state: 'draft',
        change: 'updated',
      });
      return row;
    });
    return this.view('juristic', c);
  }

  /**
   * Draft → offered (Idempotency-Key): terms complete (expense account, adopted resolution of the building), the
   * start not in the past, no live contract of the building overlapping the term (409 `management_contract.overlap`).
   */
  async offer(ctx: TenantContext, id: string): Promise<ManagementContractView> {
    const me = this.actorId();
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const c = await this.load(tx, ctx, 'juristic', id);
      if (c.state !== 'draft')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      await this.checkTerms(tx, ctx, this.toInput(c), true);
      if (day(c.startsOn) < this.today()) throw invalid('startsOn', 'past', 'today or later');
      await this.assertNoOverlap(tx, c);
      const row = await tx.managementContract.update({
        where: { id },
        data: {
          state: 'offered',
          offeredAt: this.clock.now(),
          offeredBy: me,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.management_contract_offered',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: id,
        metadata: {
          pmTenantId: c.pmTenantId,
          fee: c.fee.toFixed(2),
          feePeriod: c.feePeriod,
          startsOn: day(c.startsOn),
          endsOn: day(c.endsOn),
          resolutionId: c.resolutionId,
        },
      });
      await this.event(tx, row, 'juristic.management_contract.offered', { state: 'offered' });
      return row;
    });
    return this.view('juristic', c);
  }

  private async assertNoOverlap(tx: Tx, c: ManagementContract): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM juristic.management_contract
       WHERE building_id = ${c.buildingId}::uuid AND id <> ${c.id}::uuid
         AND ((state IN ('offered', 'active')
               AND daterange(starts_on, ends_on, '[]') && daterange(${day(c.startsOn)}::date, ${day(c.endsOn)}::date, '[]'))
           -- a terminated contract still runs until the day before its termination takes effect
           OR (state = 'terminated'
               AND daterange(starts_on, terminated_on, '[)') && daterange(${day(c.startsOn)}::date, ${day(c.endsOn)}::date, '[]')))`;
    if (rows.length) throw new DomainException('management_contract.overlap');
  }

  /** Draft / offered → cancelled by the juristic (Idempotency-Key); an accepted contract is terminated instead. */
  async cancel(ctx: TenantContext, id: string, reason: string): Promise<ManagementContractView> {
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lock(tx, id);
      const c = await this.load(tx, ctx, 'juristic', id);
      if (c.state !== 'draft' && c.state !== 'offered')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      const row = await tx.managementContract.update({
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
        action: 'juristic.management_contract_cancelled',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: id,
        metadata: { from: c.state, reason },
      });
      await this.event(tx, row, 'juristic.management_contract.cancelled', {
        state: 'cancelled',
        from: c.state,
      });
      return row;
    });
    return this.view('juristic', c);
  }

  // ============================================================================================ PM side

  /**
   * Offered → active by the PM (Idempotency-Key), on or before the start date (later: 409
   * `management_contract.offer_expired` — the juristic offers again with a new start): one building-scope **read**
   * grant (module `juristic`, reason `pm_contract`) valid from the start to the day after the end, Bangkok midnight.
   * Written as gp_platform (the grant belongs to the juristic) after the PM-side checks.
   */
  async accept(ctx: TenantContext, id: string): Promise<ManagementContractView> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.assertPm(tx, ctx.tenantId);
      await this.load(tx, ctx, 'pm', id);
    });
    const c = await this.db.platform(async (tx) => {
      await this.lock(tx, id);
      const c = await tx.managementContract.findUniqueOrThrow({ where: { id } });
      if (c.pmTenantId !== ctx.tenantId) throw new DomainException('http.not_found');
      if (c.state !== 'offered')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      if (this.today() > day(c.startsOn)) throw new DomainException('management_contract.offer_expired');
      await this.assertNoOverlap(tx, c);
      const now = this.clock.now();
      const from = bangkokMidnight(day(c.startsOn));
      const grant = await tx.assetAccessGrant.create({
        data: {
          tenantId: c.tenantId,
          granteeTenantId: c.pmTenantId,
          buildingId: c.buildingId,
          scope: 'building',
          modules: [...PM_GRANT_MODULES],
          access: 'read',
          reason: 'pm_contract',
          validFrom: from > now ? from : now,
          validTo: bangkokMidnight(addCalendarDays(day(c.endsOn), 1)),
          sourceRef: `management_contract:${c.id}`,
          createdBy: me,
        },
      });
      const row = await tx.managementContract.update({
        where: { id },
        data: {
          state: 'active',
          acceptedAt: now,
          acceptedBy: me,
          grantId: grant.id,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      for (const tenantId of [c.tenantId, c.pmTenantId])
        await this.audit.record(tx, {
          action: 'juristic.management_contract_accepted',
          tenantId,
          buildingId: c.buildingId,
          subjectType: 'juristic.management_contract',
          subjectId: id,
          metadata: { grantId: grant.id, modules: [...PM_GRANT_MODULES], access: 'read' },
        });
      await this.event(tx, row, 'juristic.management_contract.accepted', {
        state: 'active',
        grantId: grant.id,
      });
      await this.events.record(tx, {
        type: 'grant.changed',
        aggregateType: 'asset_access_grant',
        aggregateId: grant.id,
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        payload: {
          grantId: grant.id,
          change: 'created',
          granteeTenantId: c.pmTenantId,
          modules: [...PM_GRANT_MODULES],
        },
      });
      return row;
    });
    return this.view('pm', c);
  }

  async decline(ctx: TenantContext, id: string, reason: string): Promise<ManagementContractView> {
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.assertPm(tx, ctx.tenantId);
      await this.lock(tx, id);
      const c = await this.load(tx, ctx, 'pm', id);
      if (c.state !== 'offered')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      const row = await tx.managementContract.update({
        where: { id },
        data: {
          state: 'declined',
          declinedAt: this.clock.now(),
          declineReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.management_contract_declined',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: id,
        metadata: { reason },
      });
      return row;
    });
    // the juristic's own audit row and the event (its tenant) are written as gp_platform
    await this.db.platform(async (tx) => {
      await this.audit.record(tx, {
        action: 'juristic.management_contract_declined',
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: id,
        metadata: { reason },
      });
      await this.event(tx, c, 'juristic.management_contract.declined', { state: 'declined' });
    });
    return this.view('pm', c);
  }

  /**
   * Active → terminated by either side (Idempotency-Key): `effectiveOn` = the first day without service, today … the
   * end date (default today). The grant is revoked at once when the date is today (or the term had not started),
   * else cut to that date's Bangkok midnight; fees stop at the last day of service; the PM's staff assignments end.
   */
  async terminate(
    ctx: TenantContext,
    side: ContractSide,
    id: string,
    input: { reason: string; effectiveOn?: string | null },
  ): Promise<ManagementContractView> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.assertSide(tx, ctx, side);
      await this.load(tx, ctx, side, id);
    });
    const c = await this.db.platform(async (tx) => {
      await this.lock(tx, id);
      const c = await tx.managementContract.findUniqueOrThrow({ where: { id } });
      if ((side === 'pm' ? c.pmTenantId : c.tenantId) !== ctx.tenantId)
        throw new DomainException('http.not_found');
      if (c.state !== 'active')
        throw new DomainException('management_contract.invalid_state', { params: { state: c.state } });
      const today = this.today();
      const effective = input.effectiveOn ?? today;
      if (!DATE.test(effective)) throw invalid('effectiveOn', 'date', 'a date YYYY-MM-DD');
      if (effective < today || effective > day(c.endsOn))
        throw invalid('effectiveOn', 'range', 'today … the end date of the contract');
      const termEffective = effective < day(c.startsOn) ? day(c.startsOn) : effective;
      const now = this.clock.now();
      if (c.grantId) {
        const immediate = termEffective <= today || termEffective === day(c.startsOn);
        await tx.assetAccessGrant.update({
          where: { id: c.grantId },
          data: immediate
            ? { revokedAt: now, revokedBy: me, revokeReason: 'management contract terminated' }
            : { validTo: bangkokMidnight(termEffective) },
        });
      }
      const row = await tx.managementContract.update({
        where: { id },
        data: {
          state: 'terminated',
          terminatedOn: asDate(termEffective),
          terminatedAt: now,
          terminatedBy: me,
          terminatedByTenantId: ctx.tenantId,
          terminationReason: input.reason,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      await tx.pmStaffAssignment.updateMany({
        where: { contractId: id, OR: [{ endsOn: null }, { endsOn: { gt: asDate(termEffective) } }] },
        data: { endsOn: asDate(termEffective), endedAt: now, endedBy: me },
      });
      for (const tenantId of [c.tenantId, c.pmTenantId])
        await this.audit.record(tx, {
          action: 'juristic.management_contract_terminated',
          tenantId,
          buildingId: c.buildingId,
          subjectType: 'juristic.management_contract',
          subjectId: id,
          metadata: { by: side, effectiveOn: termEffective, reason: input.reason, grantId: c.grantId },
        });
      await this.event(tx, row, 'juristic.management_contract.terminated', {
        state: 'terminated',
        by: side,
        effectiveOn: termEffective,
      });
      return row;
    });
    return this.view(side, c);
  }

  // ============================================================================================ charges

  async charges(ctx: TenantContext, side: ContractSide, id: string): Promise<ChargeView[]> {
    const rows = await this.db.tenant(ctx, async (tx) => {
      await this.assertSide(tx, ctx, side);
      await this.load(tx, ctx, side, id);
      return tx.managementFeeCharge.findMany({
        where: { contractId: id },
        orderBy: { periodStart: 'asc' },
        ...(side === 'juristic'
          ? { include: { expenseRequest: { select: { id: true, number: true, state: true } } } }
          : {}),
      });
    });
    return rows.map((r) => {
      const er = (r as typeof r & { expenseRequest?: { id: string; number: string | null; state: string } })
        .expenseRequest;
      return {
        id: r.id,
        periodKey: r.periodKey,
        periodStart: day(r.periodStart),
        periodEnd: day(r.periodEnd),
        serviceDays: r.serviceDays,
        periodDays: r.periodDays,
        amount: r.amount.toFixed(2),
        vatAmount: r.vatAmount.toFixed(2),
        dueOn: day(r.dueOn),
        requestedAt: r.requestedAt,
        expenseRequest: side === 'juristic' && er ? { id: er.id, number: er.number, state: er.state } : null,
      };
    });
  }

  // ============================================================================================ job

  /** Job `management-contracts` (hourly, idempotent): fees of ended periods requested; contracts past their end ended. */
  async run(): Promise<{ requested: number; ended: number }> {
    return RequestContext.run({ actor: systemActor('management-contracts') }, async () => {
      const today = this.today();
      const ended = await this.endPast(today);
      const requested = await this.requestFees(today);
      if (requested || ended)
        this.logger.log(
          { event: 'management_contracts', requested, ended },
          'management contracts maintained',
        );
      return { requested, ended };
    });
  }

  private async requestFees(today: string): Promise<number> {
    const contracts = await this.db.platform((tx) =>
      tx.managementContract.findMany({
        where: { state: { in: ['active', 'ended', 'terminated'] }, startsOn: { lt: asDate(today) } },
        select: {
          id: true,
          tenantId: true,
          feePeriod: true,
          startsOn: true,
          endsOn: true,
          terminatedOn: true,
          charges: { select: { periodKey: true } },
        },
        orderBy: { startsOn: 'asc' },
        take: 2000,
      }),
    );
    let n = 0;
    for (const c of contracts) {
      const done = new Set(c.charges.map((x) => x.periodKey));
      const due = chargeableSlices(
        {
          feePeriod: c.feePeriod,
          startsOn: day(c.startsOn),
          endsOn: day(c.endsOn),
          terminatedOn: dayOrNull(c.terminatedOn),
        },
        today,
      ).filter((s) => !done.has(s.periodKey));
      for (const slice of due.slice(0, 24)) {
        try {
          if (await this.requestFee(c.tenantId, c.id, slice.periodKey, today)) n += 1;
        } catch (error) {
          this.logger.warn({
            event: 'management_fee_request_failed',
            contractId: c.id,
            periodKey: slice.periodKey,
            error: (error as Error).message,
          });
        }
      }
    }
    return n;
  }

  /** One period → one submitted expense request of the juristic, under the contract's row lock (re-runs: nothing). */
  private requestFee(
    tenantId: string,
    contractId: string,
    periodKey: string,
    today: string,
  ): Promise<boolean> {
    const ctx = systemTenantContext(tenantId);
    return this.db.tenant(ctx, async (tx) => {
      await this.lock(tx, contractId);
      const c = await tx.managementContract.findUniqueOrThrow({ where: { id: contractId } });
      if (!['active', 'ended', 'terminated'].includes(c.state) || !c.offeredBy || !c.expenseAccountId)
        return false;
      if (await tx.managementFeeCharge.findFirst({ where: { contractId, periodKey }, select: { id: true } }))
        return false;
      const slice = chargeableSlices(
        {
          feePeriod: c.feePeriod,
          startsOn: day(c.startsOn),
          endsOn: day(c.endsOn),
          terminatedOn: dayOrNull(c.terminatedOn),
        },
        today,
      ).find((s) => s.periodKey === periodKey);
      if (!slice) return false;
      const fee = proratedFee(c.fee, c.vatAmount, slice);
      const dueOn = dueOnAfter(slice.periodEnd, c.dueDay);
      const partial =
        slice.serviceDays < slice.periodDays ? ` (${slice.serviceDays}/${slice.periodDays} วัน)` : '';
      const description = `ค่าบริหารจัดการอาคาร ${slice.periodKey}${partial}`.slice(0, 300);
      const { id: requestId } = await this.expenses.createIn(
        tx,
        ctx,
        {
          buildingId: c.buildingId,
          title: `${c.title} ${slice.periodKey}`.slice(0, 200),
          vendorId: c.vendorId,
          managementContractId: c.id,
          note: `ครบกำหนดชำระ ${dueOn} · บริการ ${slice.serviceStart} – ${slice.serviceEnd}`,
          lines: [
            {
              accountId: c.expenseAccountId,
              description,
              amount: fee.amount,
              vatAmount: fee.vatAmount,
              whtKey: c.whtKey,
            },
          ],
        },
        c.offeredBy,
      );
      await this.expenses.submitIn(tx, ctx, requestId);
      const charge = await tx.managementFeeCharge.create({
        data: {
          tenantId,
          contractId,
          periodKey: slice.periodKey,
          periodStart: asDate(slice.periodStart),
          periodEnd: asDate(slice.periodEnd),
          serviceDays: slice.serviceDays,
          periodDays: slice.periodDays,
          amount: fee.amount,
          vatAmount: fee.vatAmount,
          dueOn: asDate(dueOn),
          expenseRequestId: requestId,
          requestedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.management_fee_requested',
        tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.management_contract',
        subjectId: c.id,
        metadata: {
          chargeId: charge.id,
          periodKey: slice.periodKey,
          amount: fee.amount,
          serviceDays: slice.serviceDays,
          periodDays: slice.periodDays,
          expenseRequestId: requestId,
        },
      });
      await this.event(tx, c, 'juristic.management_fee.requested', {
        chargeId: charge.id,
        periodKey: slice.periodKey,
        amount: fee.amount,
        dueOn,
        expenseRequestId: requestId,
      });
      return true;
    });
  }

  /** Active contracts whose last day passed → `ended`; the grant (already expired by its validity) is revoked too. */
  private async endPast(today: string): Promise<number> {
    const past = await this.db.platform((tx) =>
      tx.managementContract.findMany({
        where: { state: 'active', endsOn: { lt: asDate(today) } },
        select: { id: true },
        take: 500,
      }),
    );
    let n = 0;
    for (const p of past) {
      const done = await this.db.platform(async (tx) => {
        await this.lock(tx, p.id);
        const c = await tx.managementContract.findUniqueOrThrow({ where: { id: p.id } });
        if (c.state !== 'active' || day(c.endsOn) >= today) return false;
        const now = this.clock.now();
        if (c.grantId)
          await tx.assetAccessGrant.updateMany({
            where: { id: c.grantId, revokedAt: null },
            data: { revokedAt: now, revokeReason: 'management contract ended' },
          });
        const end = asDate(addCalendarDays(day(c.endsOn), 1));
        await tx.pmStaffAssignment.updateMany({
          where: { contractId: c.id, OR: [{ endsOn: null }, { endsOn: { gt: end } }] },
          data: { endsOn: end, endedAt: now },
        });
        const row = await tx.managementContract.update({
          where: { id: c.id },
          data: { state: 'ended', endedAt: now, version: { increment: 1 } },
        });
        for (const tenantId of [c.tenantId, c.pmTenantId])
          await this.audit.record(tx, {
            action: 'juristic.management_contract_ended',
            tenantId,
            buildingId: c.buildingId,
            subjectType: 'juristic.management_contract',
            subjectId: c.id,
            metadata: { endsOn: day(c.endsOn), grantId: c.grantId },
          });
        await this.event(tx, row, 'juristic.management_contract.ended', { state: 'ended' });
        return true;
      });
      if (done) n += 1;
    }
    return n;
  }

  /** Is the contract live on `today` for the PM (accepted, started, not past its last day of service)? */
  static liveOn(c: ManagementContract, today: string): boolean {
    return (
      // a termination with a future date keeps the contract live until its last day of service
      (c.state === 'active' || c.state === 'terminated') &&
      day(c.startsOn) <= today &&
      lastServiceDay({ endsOn: day(c.endsOn), terminatedOn: dayOrNull(c.terminatedOn) }) >= today
    );
  }
}
