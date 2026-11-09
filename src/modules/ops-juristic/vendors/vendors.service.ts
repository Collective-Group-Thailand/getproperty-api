import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { normalisePhone } from '@core/identity/phone';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ContractDocumentKind,
  type PartyType,
  Prisma,
  type VendorCategory,
  type VendorContractState,
  type VendorState,
} from '@generated/prisma/client';
import { ExpensesService } from '@modules/ops-juristic/accounting/expenses.service';
import { LedgerService } from '@modules/ops-juristic/accounting/ledger.service';
import { isValidThaiId } from '@modules/ops-parties/thai-id';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  alertDue,
  type InstalmentPlan,
  instalmentPlanProblems,
  instalmentSchedule,
  quotationRule,
  type SlaTerm,
  slaTermsProblems,
} from './vendor-rules';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const daysBetween = (from: string, to: string) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

export const VENDOR_INCLUDE = {
  party: { select: { id: true, type: true, taxId: true } },
  _count: { select: { contracts: { where: { state: 'active' } } } },
} as const satisfies Prisma.VendorInclude;
export type VendorRow = Prisma.VendorGetPayload<{ include: typeof VENDOR_INCLUDE }>;

export const CONTRACT_INCLUDE = {
  vendor: { select: { id: true, name: true, state: true, partyId: true } },
  building: { select: { id: true, name: true } },
  expenseAccount: { select: { id: true, code: true, nameTh: true } },
  renewedBy: { select: { id: true, state: true } },
} as const satisfies Prisma.VendorContractInclude;
export type ContractRow = Prisma.VendorContractGetPayload<{ include: typeof CONTRACT_INCLUDE }>;

export const CONTRACT_DETAIL_INCLUDE = {
  ...CONTRACT_INCLUDE,
  instalments: {
    orderBy: { seq: 'asc' },
    include: { expenseRequest: { select: { id: true, number: true, state: true } } },
  },
  documents: { orderBy: { createdAt: 'asc' } },
  evaluations: { orderBy: { month: 'asc' } },
  maintenancePlans: {
    orderBy: { nextDueOn: 'asc' },
    include: {
      assetItem: { select: { id: true, name: true, category: true } },
      lastWorkOrder: { select: { id: true, status: true, scheduledAt: true } },
    },
  },
  expenseRequests: {
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, number: true, state: true, amount: true, createdAt: true },
  },
  alerts: { orderBy: { sentAt: 'asc' } },
} as const satisfies Prisma.VendorContractInclude;
export type ContractDetailRow = Prisma.VendorContractGetPayload<{ include: typeof CONTRACT_DETAIL_INCLUDE }>;

export interface VendorInput {
  partyId?: string | null;
  type?: PartyType;
  name: string;
  taxId?: string | null;
  categories?: VendorCategory[];
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountLast4?: string | null;
  note?: string | null;
}

export interface ContractInput {
  buildingId: string;
  vendorId: string;
  title: string;
  scope?: string | null;
  category?: VendorCategory | null;
  slaTerms?: SlaTerm[];
  startsOn: string;
  endsOn: string;
  renewalNoticeDays?: number;
  value: string;
  expenseAccountId?: string | null;
  whtKey?: string | null;
  instalmentPlan?: InstalmentPlan | null;
  penaltyClauses?: string | null;
  quotationRoundId?: string | null;
  resolutionId?: string | null;
  note?: string | null;
}

/**
 * Vendors and service contracts of juristic tenants (D-310 = D-J09, D-331): a vendor is a `core.party` (its tax id on
 * the party — what the 50 ทวิ prints) with categories, a contact and a masked bank account; a contract carries the
 * scope, SLA terms per priority, term, renewal notice, value, instalment plan and penalty clauses, and goes draft →
 * active (quotation rule, instalments scheduled) → expired | terminated, with renewals as successor drafts. The job
 * `vendor-contracts` turns due instalments into submitted expense requests (J2.1 model), sends expiry alerts at
 * 90 / 60 / 30 days and expires contracts past their end.
 */
@Injectable()
export class VendorsService extends TenantScopedRepository implements OnModuleInit {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly expenses: ExpensesService,
    private readonly settings: SettingsService,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('juristic.vendor_contract.expiring', async (tx, e) => {
      if (!e.tenantId) return null;
      return {
        recipients: [
          ...(await operators(tx, e.tenantId, ['owner'], 'owner')),
          // the committee hears operator messages on the manager routes (no committee audience, D-327)
          ...(await operators(tx, e.tenantId, ['manager', 'committee'], 'manager')),
        ],
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          contract: {
            title: e.payload.title ?? '',
            vendorName: e.payload.vendorName ?? '',
            buildingName: e.payload.buildingName ?? '',
            endsOn: e.payload.endsOn ?? '',
            noticeBy: e.payload.noticeBy ?? '',
            daysLeft: e.payload.daysLeft ?? 0,
          },
        },
      };
    });
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private actorId(): string {
    const id = by();
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  // ============================================================================================ vendors

  private async loadVendor(tx: Tx, ctx: TenantContext, id: string): Promise<VendorRow> {
    return this.found(await tx.vendor.findFirst({ where: this.own(ctx, { id }), include: VENDOR_INCLUDE }));
  }

  getVendor(ctx: TenantContext, id: string): Promise<VendorRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.loadVendor(tx, ctx, id);
    });
  }

  listVendors(
    ctx: TenantContext,
    q: {
      state?: VendorState;
      category?: VendorCategory;
      categories?: VendorCategory[];
      partyId?: string;
      q?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.VendorWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
        AND: [
          ...(q.category ? [{ categories: { has: q.category } }] : []),
          ...(q.categories?.length ? [{ categories: { hasSome: q.categories } }] : []),
        ],
      };
      const [rows, total] = await Promise.all([
        tx.vendor.findMany({
          where,
          include: VENDOR_INCLUDE,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.vendor.count({ where }),
      ]);
      // Tab badges (J-CR): per state for the same search and categories.
      const byState = await tx.vendor.groupBy({
        by: ['state'],
        where: { ...where, state: undefined },
        _count: { _all: true },
      });
      const counts = { all: 0, active: 0, blocked: 0 };
      for (const g of byState) {
        counts[g.state] = g._count._all;
        counts.all += g._count._all;
      }
      return { rows, total, counts };
    });
  }

  private taxIdOf(raw: string | null | undefined): string | null | undefined {
    if (raw === undefined || raw === null) return raw;
    const id = raw.replace(/[\s-]/g, '');
    if (!isValidThaiId(id)) throw invalid('taxId', 'taxId', '13 digits with a valid check digit');
    return id;
  }

  private contact(input: Partial<VendorInput>) {
    const phone =
      input.contactPhone === undefined
        ? undefined
        : input.contactPhone === null
          ? null
          : (normalisePhone(input.contactPhone) ??
            (() => {
              throw invalid('contactPhone', 'phone', 'a Thai or E.164 phone number');
            })());
    if (input.bankAccountLast4 && !/^\d{4}$/.test(input.bankAccountLast4))
      throw invalid('bankAccountLast4', 'digits', 'the last 4 digits only');
    return { phone };
  }

  async createVendor(ctx: TenantContext, input: VendorInput): Promise<VendorRow> {
    const taxId = this.taxIdOf(input.taxId);
    const { phone } = this.contact(input);
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      let partyId = input.partyId ?? null;
      if (partyId) {
        const p = await tx.party.findFirst({
          where: { id: partyId, tenantId: ctx.tenantId, deletedAt: null, anonymisedAt: null },
        });
        if (!p) throw new DomainException('http.not_found');
        if (taxId && p.taxId !== taxId)
          await tx.party.update({
            where: { id: p.id },
            data: { taxId, updatedBy: by(), version: { increment: 1 } },
          });
      } else {
        const type = input.type ?? 'company';
        const party = await tx.party.create({
          data: {
            tenantId: ctx.tenantId,
            type,
            displayName: input.name.trim(),
            companyName: type === 'company' ? input.name.trim() : null,
            taxId: taxId ?? null,
            phoneE164: phone ?? null,
            phoneHash: phone ? this.hasher.tenantValue(ctx.tenantId, phone) : null,
            email: input.contactEmail ?? null,
            createdBy: by(),
          },
        });
        partyId = party.id;
        await this.events.record(tx, {
          type: 'party.changed',
          aggregateType: 'party',
          aggregateId: party.id,
          tenantId: ctx.tenantId,
          payload: { partyId: party.id, change: 'created' },
        });
      }
      if (await tx.vendor.findFirst({ where: { tenantId: ctx.tenantId, partyId } }))
        throw new DomainException('vendor.exists');
      const v = await tx.vendor.create({
        data: {
          tenantId: ctx.tenantId,
          partyId,
          name: input.name.trim(),
          categories: [...new Set(input.categories ?? [])],
          contactName: input.contactName ?? null,
          contactPhone: phone ?? null,
          contactEmail: input.contactEmail ?? null,
          bankName: input.bankName ?? null,
          bankAccountName: input.bankAccountName ?? null,
          bankAccountLast4: input.bankAccountLast4 ?? null,
          note: input.note ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_created',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.vendor',
        subjectId: v.id,
        metadata: { partyId, categories: v.categories, taxIdOnFile: Boolean(taxId) },
      });
      await this.vendorEvent(tx, ctx, v.id, 'created');
      return v.id;
    });
    return this.getVendor(ctx, id);
  }

  private vendorEvent(tx: Tx, ctx: TenantContext, vendorId: string, change: string) {
    return this.events.record(tx, {
      type: 'juristic.vendor.changed',
      aggregateType: 'vendor',
      aggregateId: vendorId,
      tenantId: ctx.tenantId,
      payload: { vendorId, change },
    });
  }

  async updateVendor(
    ctx: TenantContext,
    id: string,
    patch: Partial<Omit<VendorInput, 'partyId' | 'type'>> & {
      state?: VendorState;
      blockedReason?: string | null;
      version?: number;
    },
  ): Promise<VendorRow> {
    const taxId = this.taxIdOf(patch.taxId);
    const { phone } = this.contact(patch);
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const v = await this.loadVendor(tx, ctx, id);
      if (patch.version !== undefined && patch.version !== v.version)
        throw new DomainException('concurrency.stale');
      const state = patch.state ?? v.state;
      const blockedReason =
        state === 'blocked'
          ? (patch.blockedReason ?? (v.state === 'blocked' ? v.blockedReason : null))
          : null;
      if (state === 'blocked' && (!blockedReason || blockedReason.trim().length < 3))
        throw invalid('blockedReason', 'required', 'why the vendor is blocked (3–1000)');
      await tx.vendor.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.categories !== undefined ? { categories: [...new Set(patch.categories)] } : {}),
          ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
          ...(phone !== undefined ? { contactPhone: phone } : {}),
          ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
          ...(patch.bankName !== undefined ? { bankName: patch.bankName } : {}),
          ...(patch.bankAccountName !== undefined ? { bankAccountName: patch.bankAccountName } : {}),
          ...(patch.bankAccountLast4 !== undefined ? { bankAccountLast4: patch.bankAccountLast4 } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          state,
          blockedReason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (taxId !== undefined && taxId !== v.party.taxId)
        await tx.party.update({
          where: { id: v.partyId },
          data: { taxId, updatedBy: by(), version: { increment: 1 } },
        });
      await this.audit.record(tx, {
        action: 'juristic.vendor_updated',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.vendor',
        subjectId: id,
        metadata: {
          fields: Object.keys(patch).filter((k) => k !== 'version' && k !== 'taxId'),
          taxIdChanged: taxId !== undefined && taxId !== v.party.taxId,
          state,
          ...(state !== v.state ? { from: v.state, reason: blockedReason } : {}),
        },
      });
      await this.vendorEvent(tx, ctx, id, state !== v.state ? state : 'updated');
    });
    return this.getVendor(ctx, id);
  }

  // ============================================================================================ contracts

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

  private async loadContract(tx: Tx, ctx: TenantContext, id: string): Promise<ContractDetailRow> {
    const c = this.found(
      await tx.vendorContract.findFirst({ where: this.own(ctx, { id }), include: CONTRACT_DETAIL_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
      throw new DomainException('http.not_found');
    return c;
  }

  getContract(ctx: TenantContext, id: string): Promise<ContractDetailRow> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.loadContract(tx, ctx, id);
    });
  }

  listContracts(
    ctx: TenantContext,
    q: {
      vendorId?: string;
      buildingId?: string;
      state?: VendorContractState;
      endingWithinDays?: number;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.VendorContractWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.vendorId ? { vendorId: q.vendorId } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
        ...(q.endingWithinDays !== undefined
          ? { state: 'active', endsOn: { lte: asDate(addCalendarDays(this.today(), q.endingWithinDays)) } }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.vendorContract.findMany({
          where,
          include: CONTRACT_INCLUDE,
          orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.vendorContract.count({ where }),
      ]);
      // Tab badges (J-CR): per state for the same vendor / building, and the renewal queue.
      const scopeWhere: Prisma.VendorContractWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.vendorId ? { vendorId: q.vendorId } : {}),
        ...(q.buildingId
          ? { buildingId: q.buildingId }
          : ctx.buildingIds
            ? { buildingId: { in: [...ctx.buildingIds] } }
            : {}),
      };
      const within =
        q.endingWithinDays ??
        Math.max(
          ...((await this.settings.valueAt<number[]>(
            'juristic.contract_expiry_alert_days',
            this.clock.now(),
            {
              tenantId: ctx.tenantId,
            },
          )) ?? [90, 60, 30]),
        );
      const [byState, endingSoon] = await Promise.all([
        tx.vendorContract.groupBy({ by: ['state'], where: scopeWhere, _count: { _all: true } }),
        tx.vendorContract.count({
          where: {
            ...scopeWhere,
            state: 'active',
            endsOn: { lte: asDate(addCalendarDays(this.today(), within)) },
          },
        }),
      ]);
      const counts = {
        all: 0,
        draft: 0,
        active: 0,
        expired: 0,
        terminated: 0,
        endingSoon,
        endingWithinDays: within,
      };
      for (const g of byState) {
        counts[g.state] = g._count._all;
        counts.all += g._count._all;
      }
      return { rows, total, counts };
    });
  }

  /** Validated contract terms (shape, vendor, account, WHT key, round, resolution) — shared by create / update. */
  private async terms(tx: Tx, ctx: TenantContext, input: ContractInput) {
    await this.ownBuilding(tx, ctx, input.buildingId);
    const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, tenantId: ctx.tenantId } });
    if (!vendor) throw new DomainException('http.not_found');
    if (vendor.state !== 'active') throw new DomainException('vendor.blocked');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) throw invalid('startsOn', 'date', 'a date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn) || input.endsOn < input.startsOn)
      throw invalid('endsOn', 'date', 'a date on or after startsOn');
    if (!MONEY.test(input.value)) throw invalid('value', 'money', 'an amount ≥ 0');
    const sla = input.slaTerms ?? [];
    const slaProblems = slaTermsProblems(sla);
    if (slaProblems.length)
      throw new DomainException('validation.failed', {
        errors: slaProblems.map((p) => ({ path: p.path, code: 'sla', message: p.message })),
      });
    if (input.instalmentPlan) {
      const problems = instalmentPlanProblems(input.instalmentPlan);
      if (problems.length)
        throw new DomainException('validation.failed', {
          errors: problems.map((p) => ({
            path: `instalmentPlan.${p.path}`,
            code: 'plan',
            message: p.message,
          })),
        });
    }
    if (input.expenseAccountId) {
      const a = await tx.account.findFirst({ where: { id: input.expenseAccountId, tenantId: ctx.tenantId } });
      if (!a) throw new DomainException('http.not_found');
      if (a.type !== 'expense' || !a.isActive)
        throw invalid('expenseAccountId', 'expense_account', 'an active expense account');
    }
    if (input.whtKey) {
      const rates =
        (await this.settings.valueAt<{ key: string }[]>('juristic.wht_rates', this.clock.now(), {
          tenantId: ctx.tenantId,
        })) ?? [];
      if (!rates.some((r) => r.key === input.whtKey))
        throw invalid('whtKey', 'unknown', 'a key of juristic.wht_rates');
    }
    if (input.quotationRoundId) {
      const r = await tx.quotationRound.findFirst({
        where: { id: input.quotationRoundId, tenantId: ctx.tenantId },
        include: { awardedQuotation: { select: { vendorId: true } } },
      });
      if (!r) throw new DomainException('http.not_found');
      if (
        r.state !== 'awarded' ||
        r.awardedQuotation?.vendorId !== vendor.id ||
        r.buildingId !== input.buildingId
      )
        throw invalid('quotationRoundId', 'awarded', 'a round of the building awarded to the vendor');
    }
    if (input.resolutionId) await this.ledger.assertResolution(tx, ctx, input.buildingId, input.resolutionId);
    return { vendor, sla };
  }

  private contractData(input: ContractInput, sla: SlaTerm[]) {
    return {
      title: input.title.trim(),
      scope: input.scope ?? null,
      category: input.category ?? null,
      slaTerms: sla as unknown as Prisma.InputJsonValue,
      startsOn: asDate(input.startsOn),
      endsOn: asDate(input.endsOn),
      renewalNoticeDays: input.renewalNoticeDays ?? 30,
      value: D(input.value).toFixed(2),
      expenseAccountId: input.expenseAccountId ?? null,
      whtKey: input.whtKey ?? null,
      instalmentPlan: input.instalmentPlan
        ? (input.instalmentPlan as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      penaltyClauses: input.penaltyClauses ?? null,
      quotationRoundId: input.quotationRoundId ?? null,
      resolutionId: input.resolutionId ?? null,
      note: input.note ?? null,
    };
  }

  /** A contract draft inside the caller's transaction (also the award of a quotation round). */
  async createContractIn(
    tx: Tx,
    ctx: TenantContext,
    input: ContractInput,
    extra: { renewsContractId?: string } = {},
  ): Promise<string> {
    const { sla } = await this.terms(tx, ctx, input);
    const c = await tx.vendorContract.create({
      data: {
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        vendorId: input.vendorId,
        ...this.contractData(input, sla),
        renewsContractId: extra.renewsContractId ?? null,
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: extra.renewsContractId
        ? 'juristic.vendor_contract_renewal_drafted'
        : 'juristic.vendor_contract_drafted',
      tenantId: ctx.tenantId,
      buildingId: input.buildingId,
      subjectType: 'juristic.vendor_contract',
      subjectId: c.id,
      metadata: {
        vendorId: input.vendorId,
        value: c.value.toFixed(2),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        ...(extra.renewsContractId ? { renewsContractId: extra.renewsContractId } : {}),
        ...(input.quotationRoundId ? { quotationRoundId: input.quotationRoundId } : {}),
      },
    });
    await this.contractEvent(tx, ctx, c.id, input.buildingId, 'juristic.vendor_contract.changed', {
      state: 'draft',
      change: extra.renewsContractId ? 'renewal_drafted' : 'drafted',
    });
    return c.id;
  }

  private contractEvent(
    tx: Tx,
    ctx: { tenantId: string },
    contractId: string,
    buildingId: string,
    type: DomainEventType,
    payload: Record<string, unknown>,
  ) {
    return this.events.record(tx, {
      type,
      aggregateType: 'vendor_contract',
      aggregateId: contractId,
      tenantId: ctx.tenantId,
      buildingId,
      payload: { vendorContractId: contractId, ...payload },
    });
  }

  async createContract(ctx: TenantContext, input: ContractInput): Promise<ContractDetailRow> {
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      return this.createContractIn(tx, ctx, input);
    });
    return this.getContract(ctx, id);
  }

  private async lockContract(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.vendor_contract WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private toInput(c: ContractDetailRow): ContractInput {
    return {
      buildingId: c.buildingId,
      vendorId: c.vendorId,
      title: c.title,
      scope: c.scope,
      category: c.category,
      slaTerms: c.slaTerms as unknown as SlaTerm[],
      startsOn: day(c.startsOn),
      endsOn: day(c.endsOn),
      renewalNoticeDays: c.renewalNoticeDays,
      value: c.value.toFixed(2),
      expenseAccountId: c.expenseAccountId,
      whtKey: c.whtKey,
      instalmentPlan: c.instalmentPlan as unknown as InstalmentPlan | null,
      penaltyClauses: c.penaltyClauses,
      quotationRoundId: c.quotationRoundId,
      resolutionId: c.resolutionId,
      note: c.note,
    };
  }

  async updateContract(
    ctx: TenantContext,
    id: string,
    patch: Partial<Omit<ContractInput, 'buildingId' | 'vendorId'>> & { version?: number },
  ): Promise<ContractDetailRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lockContract(tx, id);
      const c = await this.loadContract(tx, ctx, id);
      if (patch.version !== undefined && patch.version !== c.version)
        throw new DomainException('concurrency.stale');
      if (c.state !== 'draft')
        throw new DomainException('vendor_contract.invalid_state', { params: { state: c.state } });
      const { version: _v, ...given } = patch;
      // only the fields sent (a DTO instance carries every declared field, undefined when absent)
      const rest = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
      const merged: ContractInput = { ...this.toInput(c), ...rest };
      const { sla } = await this.terms(tx, ctx, merged);
      await tx.vendorContract.update({
        where: { id },
        data: { ...this.contractData(merged, sla), updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_updated',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: id,
        metadata: { fields: Object.keys(rest) },
      });
      await this.contractEvent(tx, ctx, id, c.buildingId, 'juristic.vendor_contract.changed', {
        state: c.state,
        change: 'updated',
      });
    });
    return this.getContract(ctx, id);
  }

  async attachDocument(
    ctx: TenantContext,
    id: string,
    input: { documentId: string; kind: ContractDocumentKind },
  ): Promise<ContractDetailRow> {
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const c = await this.loadContract(tx, ctx, id);
      const doc = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new DomainException('http.not_found');
      if (c.documents.some((d) => d.documentId === input.documentId)) return;
      await tx.vendorContractDocument.create({
        data: {
          tenantId: ctx.tenantId,
          contractId: id,
          documentId: input.documentId,
          kind: input.kind,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_document_added',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: id,
        metadata: { documentId: input.documentId, kind: input.kind },
      });
      await this.contractEvent(tx, ctx, id, c.buildingId, 'juristic.vendor_contract.changed', {
        state: c.state,
        change: 'document',
      });
    });
    return this.getContract(ctx, id);
  }

  /**
   * Draft → active (Idempotency-Key): the vendor is active; above `juristic.quotation_threshold` the contract comes from
   * a quotation round awarded to the vendor (a renewal may instead carry an adopted resolution, D-310); an instalment
   * plan needs the expense account and is scheduled inside the term with Σ ≤ the value.
   */
  async activate(ctx: TenantContext, id: string): Promise<ContractDetailRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lockContract(tx, id);
      const c = await this.loadContract(tx, ctx, id);
      if (c.state !== 'draft')
        throw new DomainException('vendor_contract.invalid_state', { params: { state: c.state } });
      await this.terms(tx, ctx, this.toInput(c));
      const now = this.clock.now();
      const threshold =
        (await this.settings.valueAt<string>('juristic.quotation_threshold', now, {
          tenantId: ctx.tenantId,
        })) ?? '0';
      const rule = quotationRule({ amount: c.value, threshold, quotations: 0 });
      if (rule.aboveThreshold && !c.quotationRoundId && !(c.renewsContractId && c.resolutionId))
        throw new DomainException('vendor_contract.quotations_required', {
          params: { threshold: D(threshold).toFixed(2) },
        });
      const plan = c.instalmentPlan as unknown as InstalmentPlan | null;
      let schedule: ReturnType<typeof instalmentSchedule> = [];
      if (plan) {
        if (!c.expenseAccountId)
          throw invalid('expenseAccountId', 'required', 'the account instalments post to');
        try {
          schedule = instalmentSchedule(plan, day(c.startsOn), day(c.endsOn));
        } catch {
          throw new DomainException('vendor_contract.schedule_invalid');
        }
        const sum = schedule.reduce((s, x) => s.plus(x.amount), new Decimal(0));
        if (sum.gt(c.value.toString())) throw new DomainException('vendor_contract.schedule_invalid');
      }
      await tx.vendorContract.update({
        where: { id },
        data: {
          state: 'active',
          activatedAt: now,
          activatedBy: me,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      if (schedule.length)
        await tx.vendorContractInstalment.createMany({
          data: schedule.map((s) => ({
            tenantId: ctx.tenantId,
            contractId: id,
            seq: s.seq,
            dueOn: asDate(s.dueOn),
            amount: s.amount,
            vatAmount: s.vatAmount,
            description: `${c.title} งวดที่ ${s.seq}/${schedule.length}`.slice(0, 300),
          })),
        });
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_activated',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: id,
        metadata: {
          value: c.value.toFixed(2),
          instalments: schedule.length,
          aboveThreshold: rule.aboveThreshold,
          quotationRoundId: c.quotationRoundId,
          resolutionId: c.resolutionId,
        },
      });
      await this.contractEvent(tx, ctx, id, c.buildingId, 'juristic.vendor_contract.activated', {
        state: 'active',
        instalments: schedule.length,
      });
    });
    return this.getContract(ctx, id);
  }

  /** A successor draft with the same terms for a new period (Idempotency-Key); one renewal per contract. */
  async renew(
    ctx: TenantContext,
    id: string,
    input: {
      startsOn?: string | null;
      endsOn: string;
      value?: string | null;
      instalmentPlan?: InstalmentPlan | null;
      resolutionId?: string | null;
    },
  ): Promise<ContractDetailRow> {
    const nextId = await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lockContract(tx, id);
      const c = await this.loadContract(tx, ctx, id);
      if (c.state !== 'active' && c.state !== 'expired')
        throw new DomainException('vendor_contract.invalid_state', { params: { state: c.state } });
      if (c.renewedBy.length) throw new DomainException('vendor_contract.already_renewed');
      const base = this.toInput(c);
      const plan = input.instalmentPlan !== undefined ? input.instalmentPlan : base.instalmentPlan;
      const created = await this.createContractIn(
        tx,
        ctx,
        {
          ...base,
          startsOn: input.startsOn ?? addCalendarDays(day(c.endsOn), 1),
          endsOn: input.endsOn,
          value: input.value ?? base.value,
          // the first due date of the old plan lies in the old term: the renewal starts from its own start
          instalmentPlan: plan ? { ...plan, firstDueOn: input.instalmentPlan?.firstDueOn ?? null } : null,
          quotationRoundId: null,
          resolutionId: input.resolutionId ?? null,
        },
        { renewsContractId: id },
      );
      await this.contractEvent(tx, ctx, id, c.buildingId, 'juristic.vendor_contract.renewed', {
        renewalId: created,
      });
      return created;
    });
    return this.getContract(ctx, nextId);
  }

  /** Active → terminated (Idempotency-Key): instalments due on / after the date cancelled, PM plans stopped. */
  async terminate(
    ctx: TenantContext,
    id: string,
    input: { reason: string; effectiveOn?: string | null },
  ): Promise<ContractDetailRow> {
    const me = this.actorId();
    await this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.lockContract(tx, id);
      const c = await this.loadContract(tx, ctx, id);
      if (c.state !== 'active')
        throw new DomainException('vendor_contract.invalid_state', { params: { state: c.state } });
      const today = this.today();
      const effective = input.effectiveOn ?? today;
      if (effective < today || effective > day(c.endsOn))
        throw invalid('effectiveOn', 'range', 'today … the contract end date');
      const now = this.clock.now();
      const cancelled = await tx.vendorContractInstalment.updateMany({
        where: { contractId: id, state: 'scheduled', dueOn: { gte: asDate(effective) } },
        data: { state: 'cancelled', cancelledAt: now, cancelReason: 'contract_terminated' },
      });
      const plans = await tx.maintenancePlan.updateMany({
        where: { vendorContractId: id, isActive: true },
        data: { isActive: false, version: { increment: 1 }, updatedBy: me },
      });
      await tx.vendorContract.update({
        where: { id },
        data: {
          state: 'terminated',
          terminatedOn: asDate(effective),
          terminatedAt: now,
          terminatedBy: me,
          terminationReason: input.reason,
          updatedBy: me,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_terminated',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: id,
        metadata: {
          effectiveOn: effective,
          reason: input.reason,
          instalmentsCancelled: cancelled.count,
          plansStopped: plans.count,
        },
      });
      await this.contractEvent(tx, ctx, id, c.buildingId, 'juristic.vendor_contract.terminated', {
        state: 'terminated',
        effectiveOn: effective,
      });
    });
    return this.getContract(ctx, id);
  }

  // ============================================================================================ job

  /**
   * Job `vendor-contracts` (hourly, idempotent): due instalments → submitted expense requests; expiry alerts at the
   * thresholds of `juristic.contract_expiry_alert_days`; active contracts past their end → expired.
   */
  async run(): Promise<{ requested: number; alerted: number; expired: number }> {
    return RequestContext.run({ actor: systemActor('vendor-contracts') }, async () => {
      const today = this.today();
      const requested = await this.requestDueInstalments(today);
      const alerted = await this.sendExpiryAlerts(today);
      const expired = await this.expireEnded(today);
      if (requested || alerted || expired)
        this.logger.log(
          { event: 'vendor_contracts', requested, alerted, expired },
          'vendor contracts maintained',
        );
      return { requested, alerted, expired };
    });
  }

  private async requestDueInstalments(today: string): Promise<number> {
    // the widest lead (60 days) bounds the scan; each tenant's own lead is checked per row
    const due = await this.db.platform((tx) =>
      tx.vendorContractInstalment.findMany({
        where: {
          state: 'scheduled',
          dueOn: { lte: asDate(addCalendarDays(today, 60)) },
          contract: { state: 'active' },
        },
        select: { id: true, tenantId: true, dueOn: true },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: 500,
      }),
    );
    let n = 0;
    const leads = new Map<string, number>();
    for (const row of due) {
      let lead = leads.get(row.tenantId);
      if (lead === undefined) {
        lead =
          (await this.settings.valueAt<number>('juristic.contract_instalment_lead_days', this.clock.now(), {
            tenantId: row.tenantId,
          })) ?? 7;
        leads.set(row.tenantId, lead);
      }
      if (addCalendarDays(day(row.dueOn), -lead) > today) continue;
      try {
        if (await this.requestInstalment(row.tenantId, row.id)) n += 1;
      } catch (error) {
        this.logger.warn({
          event: 'vendor_contract_instalment_failed',
          instalmentId: row.id,
          error: (error as Error).message,
        });
      }
    }
    return n;
  }

  /** One instalment → one submitted expense request, under the instalment's row lock (re-runs create nothing). */
  private requestInstalment(tenantId: string, instalmentId: string): Promise<boolean> {
    const ctx = systemTenantContext(tenantId);
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM juristic.vendor_contract_instalment WHERE id = ${instalmentId}::uuid FOR UPDATE`;
      const i = await tx.vendorContractInstalment.findUniqueOrThrow({
        where: { id: instalmentId },
        include: { contract: { include: { vendor: true } } },
      });
      const c = i.contract;
      if (i.state !== 'scheduled' || c.state !== 'active' || !c.expenseAccountId || !c.activatedBy)
        return false;
      const { id: requestId } = await this.expenses.createIn(
        tx,
        ctx,
        {
          buildingId: c.buildingId,
          title: i.description,
          vendorId: c.vendorId,
          vendorContractId: c.id,
          note: `งวดที่ ${i.seq} ครบกำหนด ${day(i.dueOn)}`,
          lines: [
            {
              accountId: c.expenseAccountId,
              description: i.description,
              amount: i.amount.toFixed(2),
              vatAmount: i.vatAmount.toFixed(2),
              whtKey: c.whtKey,
            },
          ],
        },
        c.activatedBy,
      );
      await this.expenses.submitIn(tx, ctx, requestId);
      const now = this.clock.now();
      await tx.vendorContractInstalment.update({
        where: { id: i.id },
        data: { state: 'requested', expenseRequestId: requestId, requestedAt: now },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_instalment_requested',
        tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: c.id,
        metadata: { instalmentId: i.id, seq: i.seq, dueOn: day(i.dueOn), expenseRequestId: requestId },
      });
      await this.contractEvent(tx, ctx, c.id, c.buildingId, 'juristic.vendor_contract.instalment_requested', {
        instalmentId: i.id,
        seq: i.seq,
        expenseRequestId: requestId,
      });
      return true;
    });
  }

  private async sendExpiryAlerts(today: string): Promise<number> {
    const contracts = await this.db.platform((tx) =>
      tx.vendorContract.findMany({
        where: { state: 'active', endsOn: { gte: asDate(today), lte: asDate(addCalendarDays(today, 365)) } },
        select: { id: true, tenantId: true, endsOn: true },
        orderBy: { endsOn: 'asc' },
        take: 1000,
      }),
    );
    let n = 0;
    const thresholds = new Map<string, number[]>();
    for (const c of contracts) {
      let t = thresholds.get(c.tenantId);
      if (!t) {
        t = (await this.settings.valueAt<number[]>('juristic.contract_expiry_alert_days', this.clock.now(), {
          tenantId: c.tenantId,
        })) ?? [90, 60, 30];
        thresholds.set(c.tenantId, t);
      }
      const daysLeft = daysBetween(today, day(c.endsOn));
      if (daysLeft > Math.max(...t)) continue;
      try {
        if (await this.alertOne(c.tenantId, c.id, daysLeft, t)) n += 1;
      } catch (error) {
        this.logger.warn({
          event: 'vendor_contract_alert_failed',
          contractId: c.id,
          error: (error as Error).message,
        });
      }
    }
    return n;
  }

  private alertOne(
    tenantId: string,
    contractId: string,
    daysLeft: number,
    thresholds: number[],
  ): Promise<boolean> {
    const ctx = systemTenantContext(tenantId);
    return this.db.tenant(ctx, async (tx) => {
      await this.lockContract(tx, contractId);
      const c = await tx.vendorContract.findUniqueOrThrow({
        where: { id: contractId },
        include: { vendor: { select: { name: true } }, building: { select: { name: true } }, alerts: true },
      });
      if (c.state !== 'active') return false;
      const sent = c.alerts.filter((a) => day(a.endsOn) === day(c.endsOn)).map((a) => a.daysBefore);
      const due = alertDue(daysLeft, thresholds, sent);
      if (due === null) return false;
      await tx.vendorContractAlert.create({
        data: { tenantId, contractId, daysBefore: due, endsOn: c.endsOn, sentAt: this.clock.now() },
      });
      const noticeBy = addCalendarDays(day(c.endsOn), -c.renewalNoticeDays);
      await this.audit.record(tx, {
        action: 'juristic.vendor_contract_expiry_alerted',
        tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: c.id,
        metadata: { daysBefore: due, daysLeft, endsOn: day(c.endsOn), noticeBy },
      });
      await this.contractEvent(tx, ctx, c.id, c.buildingId, 'juristic.vendor_contract.expiring', {
        title: c.title,
        vendorName: c.vendor.name,
        buildingName: c.building.name,
        endsOn: day(c.endsOn),
        noticeBy,
        daysBefore: due,
        daysLeft,
      });
      return true;
    });
  }

  private async expireEnded(today: string): Promise<number> {
    const ended = await this.db.platform((tx) =>
      tx.vendorContract.findMany({
        where: { state: 'active', endsOn: { lt: asDate(today) } },
        select: { id: true, tenantId: true },
        take: 500,
      }),
    );
    let n = 0;
    for (const e of ended) {
      const ctx = systemTenantContext(e.tenantId);
      const done = await this.db.tenant(ctx, async (tx) => {
        await this.lockContract(tx, e.id);
        const c = await tx.vendorContract.findUniqueOrThrow({ where: { id: e.id } });
        if (c.state !== 'active' || day(c.endsOn) >= today) return false;
        const now = this.clock.now();
        const cancelled = await tx.vendorContractInstalment.updateMany({
          where: { contractId: c.id, state: 'scheduled' },
          data: { state: 'cancelled', cancelledAt: now, cancelReason: 'contract_expired' },
        });
        await tx.vendorContract.update({
          where: { id: c.id },
          data: { state: 'expired', expiredAt: now, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: 'juristic.vendor_contract_expired',
          tenantId: e.tenantId,
          buildingId: c.buildingId,
          subjectType: 'juristic.vendor_contract',
          subjectId: c.id,
          metadata: { endsOn: day(c.endsOn), instalmentsCancelled: cancelled.count },
        });
        await this.contractEvent(tx, ctx, c.id, c.buildingId, 'juristic.vendor_contract.expired', {
          state: 'expired',
        });
        return true;
      });
      if (done) n += 1;
    }
    return n;
  }
}
