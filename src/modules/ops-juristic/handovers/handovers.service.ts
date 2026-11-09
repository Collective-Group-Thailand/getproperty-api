import { isJuristicTenantType } from '@collective/asset-core';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { BuildingService } from '@core/asset/asset.services';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Building,
  type BuildingLegalForm,
  type BuildingType,
  type Handover,
  type HandoverState,
  type Prisma,
  type PropertyKind,
  type UnitType,
} from '@generated/prisma/client';
import { GETBUILD_HANDOFF, type GetbuildHandoffPort } from '@integrations/getbuild/getbuild-handoff.port';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { UnitsService } from '@modules/ops-units/units.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { LedgerService } from '../accounting/ledger.service';
import { cr, dr, type Leg } from '../accounting/posting';
import {
  asOfOf,
  type HandoverPayload,
  type HandoverProblem,
  handoverProblems,
  type HandoverTotals,
  handoverTotals,
  kindOfBuildingType,
  minimisePayload,
  ownersOn,
  splitByShares,
  unitMoney,
  unitTypeOf,
} from './handover-plan';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const lc = (s: string) => s.trim().toLowerCase();
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

const SUBJECT = 'juristic.handover';
/** Delivery attempts of a rejection through the port before it waits for an admin. */
export const MAX_REJECTION_DELIVERIES = 10;
const OPEN: readonly HandoverState[] = ['received', 'pending_review'];
const LEGAL_FORMS: readonly BuildingLegalForm[] = [
  'condo_act',
  'land_allocation_act',
  'voluntary',
  'lease_contract',
];
const KINDS: readonly PropertyKind[] = [
  'apartment',
  'condo',
  'village',
  'community',
  'office',
  'retail',
  'industrial',
  'mixed',
];
const BUILDING_TYPES: readonly BuildingType[] = ['apartment', 'condo', 'house_cluster', 'mixed_use'];

export const buildingSourceRef = (developerRef: string, buildingRef: string) =>
  `getbuild:${developerRef}:${buildingRef}`.slice(0, 300);
const propertySourceRef = (developerRef: string, propertyRef: string) =>
  `getbuild:${developerRef}:property:${propertyRef}`.slice(0, 300);
const partySourceRef = (developerRef: string, partyRef: string) =>
  `getbuild:${developerRef}:party:${partyRef}`.slice(0, 200);
const unitSourceRef = (developerRef: string, unitRef: string) =>
  `getbuild:${developerRef}:unit:${unitRef}`.slice(0, 200);

export interface AcceptInput {
  legalForm?: BuildingLegalForm;
  propertyKind?: PropertyKind;
  notifyOpeningBalances?: boolean;
}

export interface HandoverUnitView {
  unitRef: string;
  unitNo: string;
  owners: { partyRef: string; displayName: string; sharePct: string }[];
  advanceCommonFees: string;
  advancePeriodFrom: string | null;
  advancePeriodTo: string | null;
  firstFundContribution: string;
  receivablesBroughtForward: string;
  receivableItems: number;
}

export interface HandoverReview {
  handover: Handover;
  totals: HandoverTotals;
  problems: HandoverProblem[];
  units: HandoverUnitView[];
  partiesToAttach: number;
  partiesToCreate: number;
  bankAccount: { id: string; masked: string } | null;
  applied: AppliedTotals | null;
}

export interface AppliedTotals {
  credits: string;
  openingInvoices: number;
  openingInvoicesTotal: string;
  fundContributions: string;
}

/**
 * Developer handover from getbuild (J3.2, D-314 = D-J13, D-150 D1, D-333): `building.handover.requested` (v1 register,
 * v2 + finance) arrives on the signed integration webhook (D-238) and is stored once per event; the platform admin
 * assigns it to a juristic tenant (or it is assigned at once to the tenant already holding the building); the juristic
 * office reviews the totals and **accepts** it — the register (property, building with its legal form, floors, units,
 * parties never duplicated, ownerships, LINE identities linked), advance common fees as the owners' credit, first
 * sinking-fund contributions into the fund ledger, receivables brought forward as opening-balance invoices issued at
 * once (series OPB, normal due rule) — with totals that must equal the payload; or **rejects** it with a reason that
 * goes back to getbuild through the port. While the developer operates the building (operator period `handover`), the
 * juristic person's formation hands the operation over (`juristic_formed`) and `juristic.formed` goes to getbuild.
 */
@Injectable()
export class HandoversService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'juristic-handovers';
  readonly eventTypes = ['juristic.handover.formed'] as const;
  private readonly logger = new Logger(HandoversService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly integrations: IntegrationEventsService,
    private readonly registry: EventSubscriberRegistry,
    private readonly units: UnitsService,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly buildings: BuildingService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(GETBUILD_HANDOFF) private readonly getbuild: GetbuildHandoffPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    this.integrations.onInbound('building.handover.requested', (tx, envelope, row) =>
      this.received(tx, envelope, row.id),
    );
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private payloadOf(h: Handover): HandoverPayload {
    return h.payload as unknown as HandoverPayload;
  }

  private async event(
    tx: Tx,
    h: Handover,
    kind: 'received' | 'assigned' | 'accepted' | 'rejected' | 'formed',
    extra: Record<string, unknown> = {},
  ) {
    await this.events.record(tx, {
      type: `juristic.handover.${kind}`,
      aggregateType: 'juristic_handover',
      aggregateId: h.id,
      tenantId: h.tenantId,
      buildingId: h.buildingId,
      payload: { handoverId: h.id, state: h.state, ...extra },
    });
  }

  // ------------------------------------------------------------------------------------------- inbound

  /** Applies `building.handover.requested` inside the receiving (platform) transaction: stores it for review. */
  async received(tx: Tx, envelope: Record<string, unknown>, integrationEventId: string): Promise<void> {
    const p = minimisePayload(envelope.payload as Record<string, unknown>);
    const developerRef = p.developerTenantRef.slice(0, 200);
    const key = { developerRef, buildingRef: p.building.ref };
    const accepted = await tx.handover.findFirst({
      where: { ...key, state: 'accepted' },
      select: { id: true },
    });
    if (accepted) throw new Error(`building ${p.building.ref} was already handed over (${accepted.id})`);
    const open = await tx.handover.findFirst({ where: { ...key, state: { in: [...OPEN] } } });
    if (open)
      await tx.handover.update({
        where: { id: open.id },
        data: { state: 'superseded', version: { increment: 1 } },
      });
    let tenantId = open?.tenantId ?? null;
    let developerTenantId = open?.developerTenantId ?? null;
    if (!tenantId) {
      const b = await tx.building.findFirst({
        where: { sourceRef: buildingSourceRef(developerRef, p.building.ref), deletedAt: null },
        select: { ownerTenantId: true, operatorTenantId: true },
      });
      const candidate = b?.ownerTenantId ?? b?.operatorTenantId ?? null;
      if (candidate) {
        const t = await tx.tenant.findUnique({ where: { id: candidate }, select: { type: true } });
        if (isJuristicTenantType(t?.type)) tenantId = candidate;
      }
      developerTenantId = null;
    }
    const finance = p.finance;
    const row = await tx.handover.create({
      data: {
        tenantId,
        integrationEventId,
        contractVersion: Number(envelope.version) === 2 ? 2 : 1,
        state: tenantId ? 'pending_review' : 'received',
        developerRef,
        propertyRef: p.property.ref.slice(0, 200),
        buildingRef: p.building.ref.slice(0, 200),
        buildingName: p.building.name.slice(0, 300),
        requestedHandoverAt: new Date(p.requestedHandoverAt),
        asOfDate: asDate(asOfOf(p)),
        payload: p as unknown as Prisma.InputJsonValue,
        totals: handoverTotals(p) as unknown as Prisma.InputJsonValue,
        receivingBank: finance ? (finance.receivingBankAccount as Prisma.InputJsonValue) : undefined,
        developerTenantId,
        assignedAt: tenantId ? this.clock.now() : null,
      },
    });
    if (open) await tx.handover.update({ where: { id: open.id }, data: { supersededById: row.id } });
    await tx.integrationEvent.update({
      where: { id: integrationEventId },
      data: { tenantId, subjectType: SUBJECT, subjectId: row.id },
    });
    if (open)
      await this.audit.record(tx, {
        action: 'juristic.handover_superseded',
        tenantId: open.tenantId ?? undefined,
        subjectType: SUBJECT,
        subjectId: open.id,
        after: { supersededById: row.id },
      });
    await this.audit.record(tx, {
      action: 'juristic.handover_received',
      tenantId: tenantId ?? undefined,
      subjectType: SUBJECT,
      subjectId: row.id,
      after: { developerRef, buildingRef: row.buildingRef, version: row.contractVersion, state: row.state },
    });
    await this.event(tx, row, 'received', { integrationEventId });
    if (tenantId) await this.event(tx, row, 'assigned', { automatic: true });
  }

  // ------------------------------------------------------------------------------------------- platform

  async adminList(q: { state?: HandoverState; skip: number; take: number }) {
    const where: Prisma.HandoverWhereInput = q.state ? { state: q.state } : {};
    return this.db.platform(async (tx) => ({
      rows: await tx.handover.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.take,
      }),
      total: await tx.handover.count({ where }),
    }));
  }

  /** `POST /v1/admin/juristic-handovers/{id}/actions/assign`: the handover goes to a juristic tenant's inbox. */
  async assign(id: string, input: { juristicTenantId: string; developerTenantId?: string | null }) {
    return this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM juristic.handover WHERE id = ${id}::uuid FOR UPDATE`;
      const h = await tx.handover.findUnique({ where: { id } });
      if (!h) throw new DomainException('http.not_found');
      if (!OPEN.includes(h.state))
        throw new DomainException('handover.invalid_state', { params: { state: h.state } });
      const t = await tx.tenant.findFirst({
        where: { id: input.juristicTenantId, deletedAt: null },
        select: { type: true },
      });
      if (!t) throw new DomainException('http.not_found');
      if (!isJuristicTenantType(t.type))
        throw invalid('juristicTenantId', 'juristic_required', 'the tenant must be a juristic tenant');
      const developer = input.developerTenantId ?? null;
      if (developer) {
        if (developer === input.juristicTenantId)
          throw invalid('developerTenantId', 'distinct', 'the developer is not the juristic tenant');
        const d = await tx.tenant.findFirst({
          where: { id: developer, deletedAt: null },
          select: { type: true },
        });
        if (!d) throw new DomainException('http.not_found');
        if (d.type !== 'pm_company')
          throw invalid(
            'developerTenantId',
            'pm_company_required',
            'the developer operates as a pm_company tenant',
          );
      }
      const updated = await tx.handover.update({
        where: { id },
        data: {
          tenantId: input.juristicTenantId,
          developerTenantId: developer,
          state: 'pending_review',
          assignedAt: this.clock.now(),
          assignedBy: by(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await tx.integrationEvent.update({
        where: { id: h.integrationEventId },
        data: { tenantId: input.juristicTenantId },
      });
      await this.audit.record(tx, {
        action: 'juristic.handover_assigned',
        tenantId: input.juristicTenantId,
        subjectType: SUBJECT,
        subjectId: id,
        before: { tenantId: h.tenantId, developerTenantId: h.developerTenantId },
        after: { tenantId: input.juristicTenantId, developerTenantId: developer },
      });
      await this.event(tx, updated, 'assigned', { automatic: false });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------- juristic office

  private async load(tx: Tx, ctx: TenantContext, id: string, lock = false): Promise<Handover> {
    await this.ledger.assertJuristic(tx, ctx.tenantId);
    if (lock) await tx.$queryRaw`SELECT id FROM juristic.handover WHERE id = ${id}::uuid FOR UPDATE`;
    const h = await tx.handover.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!h || (ctx.buildingIds && h.buildingId && !ctx.buildingIds.includes(h.buildingId)))
      throw new DomainException('http.not_found');
    return h;
  }

  list(ctx: TenantContext, q: { state?: HandoverState; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const where: Prisma.HandoverWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
      };
      return {
        rows: await tx.handover.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        total: await tx.handover.count({ where }),
      };
    });
  }

  /** The review of one handover: totals, per-unit money, problems, party matches, the matched bank account. */
  review(ctx: TenantContext, id: string): Promise<HandoverReview> {
    return this.db.tenant(ctx, async (tx) => this.reviewIn(tx, ctx, await this.load(tx, ctx, id)));
  }

  private async reviewIn(tx: Tx, ctx: TenantContext, h: Handover): Promise<HandoverReview> {
    const p = this.payloadOf(h);
    const asOf = asOfOf(p);
    const parties = new Map(p.parties.map((x) => [x.ref, x]));
    const fin = new Map((p.finance?.units ?? []).map((u) => [u.unitRef, u]));
    const units: HandoverUnitView[] = p.units.map((u) => {
      const f = fin.get(u.ref);
      const m = f ? unitMoney(f) : null;
      return {
        unitRef: u.ref,
        unitNo: u.unitNo,
        owners: ownersOn(p, u.ref, asOf).map((o) => ({
          partyRef: o.partyRef,
          displayName: parties.get(o.partyRef)?.displayName ?? o.partyRef,
          sharePct: D(o.sharePct).toFixed(4),
        })),
        advanceCommonFees: (m?.advance ?? new Decimal(0)).toFixed(2),
        advancePeriodFrom: f?.advanceCommonFees?.periodFrom ?? null,
        advancePeriodTo: f?.advanceCommonFees?.periodTo ?? null,
        firstFundContribution: (m?.fund ?? new Decimal(0)).toFixed(2),
        receivablesBroughtForward: (m?.receivables ?? new Decimal(0)).toFixed(2),
        receivableItems: f?.receivablesBroughtForward.length ?? 0,
      };
    });
    const matches = await this.partyMatches(tx, ctx.tenantId, h.developerRef, p);
    const attached = [...matches.values()].filter(Boolean).length;
    const bank = h.bankAccountId
      ? await tx.tenantBankAccount.findFirst({
          where: { id: h.bankAccountId },
          select: { id: true, accountNoMasked: true },
        })
      : await this.matchBank(tx, ctx.tenantId, p);
    return {
      handover: h,
      totals: h.totals as unknown as HandoverTotals,
      problems: h.state === 'pending_review' || h.state === 'received' ? handoverProblems(p) : [],
      units,
      partiesToAttach: attached,
      partiesToCreate: p.parties.length - attached,
      bankAccount: bank ? { id: bank.id, masked: bank.accountNoMasked } : null,
      applied: h.state === 'accepted' ? await this.appliedTotals(tx, h.id) : null,
    };
  }

  /** Party ref → the tenant's existing party (same LINE id, or created by an earlier handover), else null. */
  private async partyMatches(
    tx: Tx,
    tenantId: string,
    developerRef: string,
    p: HandoverPayload,
  ): Promise<Map<string, string | null>> {
    const lines = p.parties.map((x) => x.lineUserId).filter((x): x is string => Boolean(x));
    const refs = p.parties.map((x) => partySourceRef(developerRef, x.ref));
    const existing = await tx.party.findMany({
      where: {
        tenantId,
        deletedAt: null,
        anonymisedAt: null,
        OR: [{ sourceRef: { in: refs } }, ...(lines.length ? [{ lineUserId: { in: lines } }] : [])],
      },
      select: { id: true, sourceRef: true, lineUserId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const out = new Map<string, string | null>();
    for (const x of p.parties) {
      const hit =
        existing.find((e) => e.sourceRef === partySourceRef(developerRef, x.ref)) ??
        (x.lineUserId ? existing.find((e) => e.lineUserId === x.lineUserId) : undefined);
      out.set(x.ref, hit?.id ?? null);
    }
    return out;
  }

  /** The tenant bank account whose bank code and last 4 digits match the receiving account (exactly one). */
  private async matchBank(tx: Tx, tenantId: string, p: HandoverPayload) {
    const rb = p.finance?.receivingBankAccount;
    if (!rb) return null;
    const last4 = rb.accountNoMasked.replace(/\D/g, '').slice(-4);
    const rows = await tx.tenantBankAccount.findMany({
      where: {
        tenantId,
        bankCode: rb.bankCode,
        state: { in: ['active', 'pending_otp'] },
        effectiveTo: null,
      },
      select: { id: true, accountNoMasked: true },
    });
    const hits = rows.filter((a) => a.accountNoMasked.replace(/\D/g, '').slice(-4) === last4);
    return hits.length === 1 ? hits[0]! : null;
  }

  private async appliedTotals(tx: Tx, handoverId: string): Promise<AppliedTotals> {
    const credits = await tx.payerCredit.aggregate({
      where: { handoverId, kind: 'handover_advance' },
      _sum: { amount: true },
    });
    const inv = await tx.invoice.aggregate({
      where: { handoverId, status: { not: 'void' } },
      _sum: { total: true },
      _count: true,
    });
    const [fund] = await tx.$queryRaw<{ total: string | null }[]>`
      SELECT sum(jl.debit)::text AS total
        FROM juristic.handover_unit hu
        JOIN juristic.journal_line jl ON jl.journal_id = hu.journal_id
        JOIN juristic.account a ON a.id = jl.account_id
       WHERE hu.handover_id = ${handoverId}::uuid AND a.role = 'fund_bank'`;
    return {
      credits: D(credits._sum.amount ?? 0).toFixed(2),
      openingInvoices: inv._count,
      openingInvoicesTotal: D(inv._sum.total ?? 0).toFixed(2),
      fundContributions: D(fund?.total ?? 0).toFixed(2),
    };
  }

  /**
   * `POST …/{id}/actions/accept` (Idempotency-Key): applies the handover in one transaction (see the class comment);
   * refused before the handover date and while the review lists problems; the recorded totals must equal the payload.
   */
  async accept(ctx: TenantContext, id: string, input: AcceptInput): Promise<HandoverReview> {
    // LINE identities of the payload already known to getproperty (user_identity is read as the platform)
    const pre = await this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
    const lineIds = this.payloadOf(pre)
      .parties.map((x) => x.lineUserId)
      .filter((x): x is string => Boolean(x));
    const identities = lineIds.length
      ? await this.db.platform((tx) =>
          tx.userIdentity.findMany({
            where: { provider: 'line', providerSubject: { in: lineIds } },
            select: { id: true, userId: true, providerSubject: true },
          }),
        )
      : [];
    try {
      return await this.db.tenant(
        ctx,
        async (tx) => {
          const h = await this.load(tx, ctx, id, true);
          if (h.state !== 'pending_review')
            throw new DomainException('handover.invalid_state', { params: { state: h.state } });
          const now = this.clock.now();
          if (now < h.requestedHandoverAt) throw new DomainException('handover.not_due');
          const p = this.payloadOf(h);
          const problems = handoverProblems(p);
          if (problems.length)
            throw new DomainException('handover.invalid', {
              params: { problems: problems.map((x) => x.code).join(',') },
            });
          const legalForm = (p.building.legalForm ?? input.legalForm) as BuildingLegalForm | undefined;
          if (!legalForm || !LEGAL_FORMS.includes(legalForm))
            throw invalid('legalForm', 'required', 'getbuild did not send the legal form: choose it');
          const kind = (p.property.kind ??
            input.propertyKind ??
            kindOfBuildingType(p.building.type)) as PropertyKind;
          if (!KINDS.includes(kind)) throw invalid('propertyKind', 'isEnum', 'unknown property kind');
          const notify = input.notifyOpeningBalances ?? true;
          const register = await this.applyRegister(tx, ctx, h, p, legalForm, kind, identities);
          const building = register.building;
          const bank = await this.matchBank(tx, ctx.tenantId, p);
          const invoiceIds = await this.applyFinance(tx, ctx, h, p, register, bank?.id ?? null);
          for (const invoiceId of invoiceIds)
            await this.invoices.issueInTx(tx, ctx, invoiceId, {
              ackId: null,
              throwOnRefusal: true,
              docType: 'opening_balance',
              notify,
            });
          const applied = await this.appliedTotals(tx, h.id);
          const totals = handoverTotals(p);
          if (
            applied.credits !== totals.advanceCommonFees ||
            applied.openingInvoicesTotal !== totals.receivablesBroughtForward ||
            applied.fundContributions !== totals.firstFundContributions
          )
            throw new DomainException('handover.totals_mismatch');
          const updated = await tx.handover.update({
            where: { id },
            data: {
              state: 'accepted',
              buildingId: building.id,
              bankAccountId: bank?.id ?? null,
              acceptedAt: now,
              acceptedBy: by(),
              notifyOpeningBalances: notify,
              updatedBy: by(),
              version: { increment: 1 },
            },
          });
          await this.audit.record(tx, {
            action: 'juristic.handover_accepted',
            tenantId: ctx.tenantId,
            buildingId: building.id,
            subjectType: SUBJECT,
            subjectId: id,
            after: { ...applied, legalForm, kind, developerTenantId: h.developerTenantId },
          });
          await this.event(tx, updated, 'accepted', { ...applied, buildingId: building.id });
          return this.reviewIn(tx, ctx, updated);
        },
        { timeout: 300_000, maxWait: 30_000 },
      );
    } catch (e) {
      if (/core\.ownership_share_exceeded/.test((e as Error).message ?? ''))
        throw new DomainException('register.shares_exceeded');
      throw e;
    }
  }

  /** Property, building, floors, units, parties, ownerships and party links (attach, never duplicate). */
  private async applyRegister(
    tx: Tx,
    ctx: TenantContext,
    h: Handover,
    p: HandoverPayload,
    legalForm: BuildingLegalForm,
    kind: PropertyKind,
    identities: readonly { id: string; userId: string; providerSubject: string }[],
  ): Promise<{ building: Building; unitByRef: Map<string, string>; partyByRef: Map<string, string> }> {
    const actor = by();
    const now = this.clock.now();
    const bRef = buildingSourceRef(h.developerRef, p.building.ref);
    let building = await tx.building.findFirst({ where: { sourceRef: bRef, deletedAt: null } });
    if (building && building.ownerTenantId !== ctx.tenantId && building.operatorTenantId !== ctx.tenantId)
      throw new DomainException('handover.invalid', { params: { problems: 'building_of_another_tenant' } });
    if (building) {
      if (!building.legalForm)
        building = await tx.building.update({
          where: { id: building.id },
          data: { legalForm, updatedBy: actor, version: { increment: 1 } },
        });
    } else {
      const pRef = propertySourceRef(h.developerRef, p.property.ref);
      let property = await tx.property.findFirst({
        where: { tenantId: ctx.tenantId, sourceRef: pRef, deletedAt: null },
      });
      if (!property) {
        const code = await this.freeCode(p.property.code, async (c) =>
          Boolean(
            await tx.property.findFirst({ where: { tenantId: ctx.tenantId, code: c, deletedAt: null } }),
          ),
        );
        property = await tx.property.create({
          data: {
            tenantId: ctx.tenantId,
            code,
            name: p.property.name,
            address: p.property.address as Prisma.InputJsonValue,
            kind,
            sourceRef: pRef,
            createdBy: actor,
          },
        });
        await this.events.record(tx, {
          type: 'property.changed',
          aggregateType: 'property',
          aggregateId: property.id,
          tenantId: ctx.tenantId,
          payload: { propertyId: property.id, change: 'created', source: 'handover' },
        });
      } else if (!property.kind)
        await tx.property.update({ where: { id: property.id }, data: { kind, updatedBy: actor } });
      const propertyId = property.id;
      const code = await this.freeCode(p.building.code, async (c) =>
        Boolean(await tx.building.findFirst({ where: { propertyId, code: c, deletedAt: null } })),
      );
      const operator = h.developerTenantId ?? ctx.tenantId;
      building = await tx.building.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId,
          code,
          name: p.building.name,
          type: (BUILDING_TYPES.includes(p.building.type as BuildingType)
            ? p.building.type
            : 'condo') as BuildingType,
          floorsCount: p.building.floorsCount ?? Math.max(1, p.floors.length),
          ownerTenantId: ctx.tenantId,
          operatorTenantId: operator,
          legalForm,
          registrationNo: p.building.registrationNo ?? null,
          handedOverAt: h.requestedHandoverAt,
          sourceRef: bRef,
          createdBy: actor,
        },
      });
      await tx.buildingOperatorPeriod.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: building.id,
          ownerTenantId: ctx.tenantId,
          operatorTenantId: operator,
          validFrom: now,
          reason: 'handover',
          sourceRef: `handover:${h.id}`,
          createdBy: actor,
        },
      });
      await this.events.record(tx, {
        type: 'building.changed',
        aggregateType: 'building',
        aggregateId: building.id,
        tenantId: ctx.tenantId,
        buildingId: building.id,
        payload: { buildingId: building.id, change: 'created', source: 'handover' },
      });
    }
    const b = building;
    // floors (attach by level)
    const floors = await tx.floor.findMany({ where: { buildingId: b.id, deletedAt: null } });
    const floorByRef = new Map<string, string>();
    for (const f of p.floors) {
      let row = floors.find((x) => x.level === f.level);
      if (!row) {
        row = await tx.floor.create({
          data: {
            tenantId: b.tenantId,
            buildingId: b.id,
            level: f.level,
            name: f.name,
            sortOrder: Math.max(-32768, Math.min(32767, f.level)),
            createdBy: actor,
          },
        });
        floors.push(row);
      }
      floorByRef.set(f.ref, row.id);
    }
    // units (attach by number when nobody owns them; else create)
    const existing = await tx.unit.findMany({ where: { buildingId: b.id, deletedAt: null } });
    const today = asDate(this.today());
    const unitByRef = new Map<string, string>();
    for (const u of p.units) {
      const hit = existing.find((x) => lc(x.unitNo) === lc(u.unitNo));
      if (hit) {
        const owned = await tx.unitOwnership.count({
          where: { unitId: hit.id, OR: [{ validTo: null }, { validTo: { gt: today } }] },
        });
        if (owned) throw new DomainException('handover.unit_owned', { params: { unitNo: hit.unitNo } });
        if (!hit.sourceRef)
          await tx.unit.update({
            where: { id: hit.id },
            data: { sourceRef: unitSourceRef(h.developerRef, u.ref), updatedBy: actor },
          });
        unitByRef.set(u.ref, hit.id);
        continue;
      }
      const unit = await this.units.insertUnit(
        tx,
        ctx,
        b,
        {
          unitNo: u.unitNo,
          floorId: u.floorRef ? (floorByRef.get(u.floorRef) ?? null) : null,
          type: unitTypeOf(u.type) as UnitType,
          areaSqm: u.areaSqm ?? null,
          landAreaSqwa: u.landAreaSqwa ?? null,
          plotNo: u.plotNo ?? null,
        },
        'getbuild_transfer',
      );
      await tx.unit.update({
        where: { id: unit.id },
        data: {
          ownershipRatio: u.ownershipRatio ?? null,
          titleDeedNo: u.titleDeedNo ?? null,
          sourceRef: unitSourceRef(h.developerRef, u.ref),
        },
      });
      unitByRef.set(u.ref, unit.id);
    }
    // parties (never duplicated: same LINE id or created by an earlier handover of this developer)
    const matches = await this.partyMatches(tx, ctx.tenantId, h.developerRef, p);
    const partyByRef = new Map<string, string>();
    for (const x of p.parties) {
      const found = matches.get(x.ref);
      if (found) {
        partyByRef.set(x.ref, found);
        continue;
      }
      const party = await tx.party.create({
        data: {
          tenantId: ctx.tenantId,
          type: x.type,
          displayName: x.displayName.slice(0, 300),
          ...(x.type === 'company' ? { companyName: x.displayName.slice(0, 300) } : {}),
          lineUserId: x.lineUserId ?? null,
          language: x.language ?? 'th',
          sourceRef: partySourceRef(h.developerRef, x.ref),
          createdBy: actor,
        },
      });
      partyByRef.set(x.ref, party.id);
      await this.events.record(tx, {
        type: 'party.changed',
        aggregateType: 'party',
        aggregateId: party.id,
        tenantId: ctx.tenantId,
        payload: { partyId: party.id, change: 'created', source: 'handover' },
      });
    }
    // residents keep their identity: logins already holding the LINE id are linked now (later ones at sign-in, D-061)
    for (const x of p.parties) {
      if (!x.lineUserId) continue;
      const partyId = partyByRef.get(x.ref)!;
      for (const ident of identities.filter((i) => i.providerSubject === x.lineUserId)) {
        const linked = await tx.partyUserLink.findFirst({
          where: { partyId, userId: ident.userId, state: 'active' },
          select: { id: true },
        });
        if (!linked)
          await tx.partyUserLink.create({
            data: {
              tenantId: ctx.tenantId,
              partyId,
              userId: ident.userId,
              identityId: ident.id,
              linkedAt: now,
              linkedVia: 'integration',
              createdBy: actor,
            },
          });
      }
    }
    // ownerships
    for (const o of p.unitOwnerships)
      await tx.unitOwnership.create({
        data: {
          tenantId: b.tenantId,
          buildingId: b.id,
          unitId: unitByRef.get(o.unitRef)!,
          partyId: partyByRef.get(o.partyRef)!,
          sharePct: o.sharePct,
          validFrom: asDate(o.validFrom),
          source: 'getbuild_transfer',
          sourceRef: `handover:${h.id}`,
          createdBy: actor,
        },
      });
    return { building: b, unitByRef, partyByRef };
  }

  private async freeCode(code: string, taken: (c: string) => Promise<boolean>): Promise<string> {
    const base = code.trim().slice(0, 40) || 'GB';
    if (!(await taken(base))) return base;
    for (let n = 2; n < 100; n += 1) {
      const c = `${base}-GB${n}`;
      if (!(await taken(c))) return c;
    }
    throw new Error(`no free code for ${base}`);
  }

  /**
   * Advance fees → the owners' credit; fund contributions → the sinking fund; receivables → opening-balance drafts
   * (returned, issued by the caller); one `handover` journal per unit for the money received with it.
   */
  private async applyFinance(
    tx: Tx,
    ctx: TenantContext,
    h: Handover,
    p: HandoverPayload,
    maps: { building: Building; unitByRef: Map<string, string>; partyByRef: Map<string, string> },
    bankAccountId: string | null,
  ): Promise<string[]> {
    const fin = p.finance;
    const b = maps.building;
    if (!fin) return [];
    const actor = by();
    const asOf = fin.asOf;
    const invoiceIds: string[] = [];
    await this.ledger.ensureChart(tx, ctx.tenantId);
    const bankKey = await this.ledger.bankKey(tx, ctx.tenantId, bankAccountId);
    const unitNo = new Map(p.units.map((u) => [u.ref, u.unitNo]));
    for (const u of fin.units) {
      const m = unitMoney(u);
      if (m.advance.isZero() && m.fund.isZero() && m.receivables.isZero()) continue;
      const unitId = maps.unitByRef.get(u.unitRef)!;
      const owners = ownersOn(p, u.unitRef, asOf).map((o) => ({
        key: maps.partyByRef.get(o.partyRef)!,
        sharePct: o.sharePct,
      }));
      const hu = await tx.handoverUnit.create({
        data: {
          tenantId: ctx.tenantId,
          handoverId: h.id,
          unitId,
          unitRef: u.unitRef.slice(0, 200),
          advanceAmount: m.advance.toFixed(2),
          advancePeriodFrom: u.advanceCommonFees ? asDate(u.advanceCommonFees.periodFrom) : null,
          advancePeriodTo: u.advanceCommonFees ? asDate(u.advanceCommonFees.periodTo) : null,
          fundAmount: m.fund.toFixed(2),
          receivablesAmount: m.receivables.toFixed(2),
          createdBy: actor,
        },
      });
      const legs: Leg[] = [];
      if (m.advance.gt(0)) {
        const a = u.advanceCommonFees!;
        legs.push(
          dr(bankKey, m.advance, { unitId, memo: 'ค่าส่วนกลางชำระล่วงหน้า (รับโอนจากผู้พัฒนาโครงการ)' }),
        );
        for (const [partyId, amount] of splitByShares(m.advance, owners)) {
          if (amount.isZero()) continue;
          await tx.payerCredit.create({
            data: {
              tenantId: b.tenantId,
              buildingId: b.id,
              unitId,
              partyId,
              kind: 'handover_advance',
              amount: amount.toFixed(2),
              handoverId: h.id,
              note: `ค่าส่วนกลางชำระล่วงหน้า ${a.periodFrom} – ${a.periodTo} (รับโอนจากผู้พัฒนาโครงการ)`,
              createdBy: actor,
            },
          });
          legs.push(cr('receivable', amount, { unitId, partyId }));
        }
      }
      if (m.fund.gt(0))
        legs.push(
          dr('fund_bank', m.fund, { unitId, memo: 'เงินกองทุนงวดแรก' }),
          cr('fund_equity', m.fund, { unitId }),
        );
      if (legs.length) {
        const j = await this.ledger.post(tx, {
          tenantId: ctx.tenantId,
          buildingId: b.id,
          postedOn: asOf,
          sourceType: 'handover',
          sourceId: hu.id,
          memo: `รับมอบจากผู้พัฒนาโครงการ ห้อง ${unitNo.get(u.unitRef) ?? u.unitRef}`,
          legs,
        });
        await tx.handoverUnit.update({ where: { id: hu.id }, data: { journalId: j.id } });
      }
      if (m.receivables.gt(0)) {
        const perItem = u.receivablesBroughtForward.map((r) => ({
          r,
          parts: splitByShares(r.amount, owners),
        }));
        for (const o of owners) {
          const lines = perItem
            .map(({ r, parts }) => ({ r, amount: parts.get(o.key) ?? new Decimal(0) }))
            .filter((l) => l.amount.gt(0));
          if (!lines.length) continue;
          const total = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
          const row = await tx.invoice.create({
            data: {
              tenantId: b.tenantId,
              buildingId: b.id,
              unitId,
              billedPartyId: o.key,
              periodStart: asDate(asOf),
              periodEnd: asDate(asOf),
              subtotal: total.toFixed(2),
              vatAmount: '0.00',
              total: total.toFixed(2),
              balance: total.toFixed(2),
              reviewFlags: [],
              notesToPayer: `ยอดค้างชำระยกมาจากผู้พัฒนาโครงการ ณ วันที่ ${asOf}`,
              handoverId: h.id,
              createdBy: actor,
            },
          });
          await tx.invoiceLine.createMany({
            data: lines.map((l, i) => ({
              tenantId: b.tenantId,
              invoiceId: row.id,
              lineNo: i + 1,
              sourceType: 'common_fee' as const,
              lineKind: 'opening_balance' as const,
              sourceId: h.id,
              description: `${l.r.description} (ยกมาจากผู้พัฒนาโครงการ)`.slice(0, 500),
              quantity: '1.000',
              unit: null,
              unitPrice: l.amount.toFixed(4),
              amount: l.amount.toFixed(2),
              periodFrom: asDate(l.r.dueOn ?? asOf),
              periodTo: asDate(l.r.dueOn ?? asOf),
              aboveCap: false,
              complianceRuleIds: [],
              vatApplicable: false,
            })),
          });
          invoiceIds.push(row.id);
        }
      }
    }
    return invoiceIds;
  }

  /** `POST …/{id}/actions/reject` (Idempotency-Key): refused with a reason; getbuild hears it through the port. */
  async reject(ctx: TenantContext, id: string, input: { reason: string }): Promise<HandoverReview> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 1000) throw invalid('reason', 'length', '5–1000 characters');
    await this.db.tenant(ctx, async (tx) => {
      const h = await this.load(tx, ctx, id, true);
      if (h.state !== 'pending_review')
        throw new DomainException('handover.invalid_state', { params: { state: h.state } });
      const updated = await tx.handover.update({
        where: { id },
        data: {
          state: 'rejected',
          rejectedAt: this.clock.now(),
          rejectedBy: by(),
          rejectReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.handover_rejected',
        tenantId: ctx.tenantId,
        subjectType: SUBJECT,
        subjectId: id,
        after: { reason },
      });
      await this.event(tx, updated, 'rejected');
    });
    await this.deliverRejection(id).catch(() => false);
    return this.review(ctx, id);
  }

  /** Worker job `juristic-handovers`: undelivered rejections go to getbuild (port off → they wait). */
  async maintain(): Promise<{ delivered: number }> {
    return RequestContext.run({ actor: systemActor('juristic-handovers') }, async () => {
      if (this.getbuild.mode === 'off') return { delivered: 0 };
      const due = await this.db.platform((tx) =>
        tx.handover.findMany({
          where: {
            state: 'rejected',
            rejectionDeliveredAt: null,
            rejectionAttempts: { lt: MAX_REJECTION_DELIVERIES },
          },
          select: { id: true },
          orderBy: { rejectedAt: 'asc' },
          take: 50,
        }),
      );
      let delivered = 0;
      for (const { id } of due) if (await this.deliverRejection(id)) delivered += 1;
      return { delivered };
    });
  }

  private async deliverRejection(id: string): Promise<boolean> {
    if (this.getbuild.mode === 'off') return false;
    const h = await this.db.platform((tx) =>
      tx.handover.findUnique({
        where: { id },
        include: { integrationEvent: { select: { idempotencyKey: true } } },
      }),
    );
    if (!h || h.state !== 'rejected' || h.rejectionDeliveredAt) return false;
    try {
      await this.getbuild.handoverRejected({
        handoverId: h.id,
        idempotencyKey: h.integrationEvent.idempotencyKey,
        developerRef: h.developerRef,
        propertyRef: h.propertyRef,
        buildingRef: h.buildingRef,
        reason: h.rejectReason!,
        rejectedAt: h.rejectedAt!.toISOString(),
      });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await this.db.platform((tx) =>
        tx.handover.update({
          where: { id },
          data: { rejectionAttempts: { increment: 1 }, lastDeliveryError: message },
        }),
      );
      this.logger.warn({ event: 'getbuild_handover_rejection_failed', handoverId: id, error: message });
      return false;
    }
    await this.db.platform(async (tx) => {
      await tx.handover.update({
        where: { id },
        data: {
          rejectionDeliveredAt: this.clock.now(),
          rejectionAttempts: { increment: 1 },
          lastDeliveryError: null,
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.handover_rejection_delivered',
        tenantId: h.tenantId ?? undefined,
        subjectType: SUBJECT,
        subjectId: id,
      });
    });
    return true;
  }

  /**
   * `POST …/{id}/actions/juristic-formed` (Idempotency-Key): the juristic person is formed — with the developer still
   * operating, the operator period switches to the juristic tenant (`juristic_formed`) and the developer keeps a
   * warranty grant until the payload's last warranty end; `juristic.formed` goes to getbuild (subscriber, outbox).
   */
  async formed(
    ctx: TenantContext,
    id: string,
    input: { formedOn: string; registrationNo?: string | null },
  ): Promise<HandoverReview> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.formedOn ?? '') || input.formedOn > this.today())
      throw invalid('formedOn', 'isDate', 'a date, not after today');
    const reg = input.registrationNo?.trim() || null;
    if (reg && reg.length > 100) throw invalid('registrationNo', 'length', 'at most 100 characters');
    return this.db.tenant(ctx, async (tx) => {
      const h = await this.load(tx, ctx, id, true);
      if (h.state !== 'accepted' || h.formedAt)
        throw new DomainException('handover.invalid_state', {
          params: { state: h.formedAt ? 'formed' : h.state },
        });
      const b = await tx.building.findUniqueOrThrow({ where: { id: h.buildingId! } });
      const p = this.payloadOf(h);
      const switched = b.operatorTenantId !== ctx.tenantId;
      let warrantyGrantValidTo: string | null = null;
      if (switched) {
        const previous = b.operatorTenantId;
        await this.buildings.changeOperatorInTx(tx, b.id, {
          operatorTenantId: ctx.tenantId,
          ownerTenantId: ctx.tenantId,
          reason: 'juristic_formed',
          sourceRef: `handover:${h.id}`,
        });
        const ends = p.warrantyTerms
          .filter((w) => w.scope !== 'asset_item')
          .map((w) => w.endsOn)
          .sort();
        const last = ends[ends.length - 1];
        if (previous && last && last >= this.today()) {
          warrantyGrantValidTo = last;
          await tx.assetAccessGrant.create({
            data: {
              tenantId: b.tenantId,
              granteeTenantId: previous,
              buildingId: b.id,
              scope: 'building',
              modules: ['warranty'],
              access: 'write',
              reason: 'warranty',
              validTo: new Date(`${last}T17:00:00Z`),
              sourceRef: `handover:${h.id}`,
              createdBy: by(),
            },
          });
        }
      }
      if (reg)
        await tx.building.update({ where: { id: b.id }, data: { registrationNo: reg, updatedBy: by() } });
      const updated = await tx.handover.update({
        where: { id },
        data: {
          formedOn: asDate(input.formedOn),
          formedAt: this.clock.now(),
          formedBy: by(),
          registrationNo: reg,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.handover_formed',
        tenantId: ctx.tenantId,
        buildingId: b.id,
        subjectType: SUBJECT,
        subjectId: id,
        after: {
          formedOn: input.formedOn,
          registrationNo: reg,
          operatorSwitched: switched,
          warrantyGrantValidTo,
        },
      });
      await this.event(tx, updated, 'formed', {
        buildingId: b.id,
        formedOn: input.formedOn,
        operatorSwitched: switched,
        warrantyGrantValidTo,
      });
      return this.reviewIn(tx, ctx, updated);
    });
  }

  /** `juristic.handover.formed` → the outbound `juristic.formed` integration event for getbuild (D-238 outbox). */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const id = event.payload.handoverId as string;
    const h = await tx.handover.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, legalForm: true } },
        tenant: { select: { displayName: true } },
      },
    });
    if (!h?.formedOn || !h.building || !h.tenantId) return;
    const warranty = event.payload.warrantyGrantValidTo as string | null | undefined;
    await this.integrations.outbound(tx, {
      platform: 'getbuild',
      envelope: {
        eventId: uuidv7(this.clock.now().getTime()),
        type: 'juristic.formed',
        version: 1,
        occurredAt: event.occurredAt,
        idempotencyKey: `getproperty:building:${h.building.id}:juristic_formed`,
        sourcePlatform: 'getproperty',
        tenantId: h.tenantId,
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          buildingId: h.building.id,
          buildingRef: h.buildingRef,
          juristicTenantId: h.tenantId,
          juristicName: h.tenant?.displayName ?? h.buildingName,
          ...(h.registrationNo ? { registrationNo: h.registrationNo } : {}),
          formedOn: day(h.formedOn),
          ...(warranty ? { warrantyGrantValidTo: warranty } : {}),
          ...(h.building.legalForm ? { legalForm: h.building.legalForm } : {}),
        },
      },
      tenantId: h.tenantId,
      buildingId: h.building.id,
      subjectType: SUBJECT,
      subjectId: h.id,
      causationEventId: event.id,
    });
  }
}
