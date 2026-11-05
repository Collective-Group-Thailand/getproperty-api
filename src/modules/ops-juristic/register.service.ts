import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Building, type Prisma, type Unit } from '@generated/prisma/client';
import { amountFromDate, splitByShares } from '@modules/ops-billing/engine/budget-split';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value) => new Decimal(v);
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);

/** A party named inline (created in the tenant) or by id. */
export interface PartyRef {
  partyId?: string;
  party?: {
    type: 'person' | 'company';
    displayName: string;
    phone?: string | null;
    email?: string | null;
    language?: string | null;
  };
}

export type TransferPolicy = 'carry_to_buyer' | 'refund_seller';

const REGISTER_UNIT_SELECT = {
  id: true,
  tenantId: true,
  buildingId: true,
  unitNo: true,
  type: true,
  areaSqm: true,
  ownershipRatio: true,
  landAreaSqwa: true,
  plotNo: true,
  titleDeedNo: true,
  version: true,
  building: { select: { id: true, name: true, legalForm: true } },
} as const satisfies Prisma.UnitSelect;

export type RegisterUnitRow = Prisma.UnitGetPayload<{ select: typeof REGISTER_UNIT_SELECT }>;

const PARTY_SELECT = {
  id: true,
  type: true,
  displayName: true,
  phoneE164: true,
  email: true,
  lineUserId: true,
  userLinks: { where: { state: 'active' }, select: { id: true } },
} as const satisfies Prisma.PartySelect;

export type RegisterPartyRow = Prisma.PartyGetPayload<{ select: typeof PARTY_SELECT }>;

export interface RegisterEntry {
  unit: RegisterUnitRow;
  owners: {
    ownershipId: string;
    party: RegisterPartyRow;
    sharePct: string;
    validFrom: string;
    validTo: string | null;
    source: string;
  }[];
  sharesTotal: string;
  incomplete: boolean;
  billTo: BillToEntry[];
}

export interface BillToEntry {
  id: string;
  ownerPartyId: string;
  billToParty: RegisterPartyRow;
  kind: 'named_party' | 'agency';
  consentDocumentId: string;
  consentNote: string | null;
  validFrom: string;
  validTo: string | null;
  endedReason: string | null;
}

/**
 * The co-owner register of a juristic tenant (J1.1b, D-303, D-307, D-324): units with their owners and shares
 * (`core.unit_ownership`, `valid_to` exclusive), plot fields, bill-to parties and ownership transfers. Only units of
 * buildings the tenant **operates or owns** are in the register (another tenant's unit — or a grantee's view — is a
 * 404). Every change is one transaction with an audit row and an outbox event.
 */
@Injectable()
export class JuristicRegisterService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly invoices: InvoicesService,
    private readonly hasher: LookupHasher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  /** A unit of a building the tenant operates or owns (else 404 — the register is the tenant's own record). */
  private async unitOf(
    tx: Tx,
    ctx: TenantContext,
    unitId: string,
  ): Promise<{ unit: Unit; building: Building }> {
    const unit = await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } });
    if (!unit || (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId)))
      throw new DomainException('http.not_found');
    const building = await tx.building.findFirst({ where: { id: unit.buildingId, deletedAt: null } });
    if (!building || (building.operatorTenantId !== ctx.tenantId && building.ownerTenantId !== ctx.tenantId))
      throw new DomainException('http.not_found');
    return { unit, building };
  }

  private async buildingIds(tx: Tx, ctx: TenantContext, buildingId?: string): Promise<string[]> {
    const rows = await tx.building.findMany({
      where: {
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        ...(buildingId ? { id: buildingId } : {}),
        ...(ctx.buildingIds ? { id: { in: [...ctx.buildingIds] } } : {}),
      },
      select: { id: true },
    });
    const ids = rows.map((b) => b.id).filter((id) => !buildingId || id === buildingId);
    if (buildingId && !ids.length) throw new DomainException('http.not_found');
    return ids;
  }

  private async entries(tx: Tx, units: RegisterUnitRow[], on: string): Promise<RegisterEntry[]> {
    const unitIds = units.map((u) => u.id);
    const date = asDate(on);
    const [owners, billTos] = await Promise.all([
      tx.unitOwnership.findMany({
        where: {
          unitId: { in: unitIds },
          validFrom: { lte: date },
          OR: [{ validTo: null }, { validTo: { gt: date } }],
        },
        include: { party: { select: PARTY_SELECT } },
        orderBy: [{ validFrom: 'asc' }, { partyId: 'asc' }],
      }),
      tx.billTo.findMany({
        where: { unitId: { in: unitIds }, OR: [{ validTo: null }, { validTo: { gt: date } }] },
        include: { billToParty: { select: PARTY_SELECT } },
        orderBy: [{ validFrom: 'asc' }],
      }),
    ]);
    return units.map((unit) => {
      const mine = owners.filter((o) => o.unitId === unit.id);
      const sharesTotal = mine.reduce((s, o) => s.plus(o.sharePct.toString()), D(0));
      return {
        unit,
        owners: mine.map((o) => ({
          ownershipId: o.id,
          party: o.party,
          sharePct: D(o.sharePct.toString()).toFixed(4),
          validFrom: day(o.validFrom),
          validTo: o.validTo ? day(o.validTo) : null,
          source: o.source,
        })),
        sharesTotal: sharesTotal.toFixed(4),
        incomplete: sharesTotal.lt(100),
        billTo: billTos.filter((b) => b.unitId === unit.id).map(billToEntry),
      };
    });
  }

  /** `GET /v1/owner/juristic/register`: units with their current owners (today), Σ shares and the incomplete flag. */
  async list(
    ctx: TenantContext,
    q: { buildingId?: string; q?: string; incomplete?: boolean; skip: number; take: number },
  ): Promise<{ rows: RegisterEntry[]; total: number }> {
    return this.db.tenant(ctx, async (tx) => {
      const buildingIds = await this.buildingIds(tx, ctx, q.buildingId);
      const term = q.q?.trim();
      const where: Prisma.UnitWhereInput = {
        buildingId: { in: buildingIds },
        deletedAt: null,
        ...(term
          ? {
              OR: [
                { unitNo: { contains: term, mode: 'insensitive' } },
                { plotNo: { contains: term, mode: 'insensitive' } },
                {
                  ownerships: {
                    some: { party: { displayName: { contains: term, mode: 'insensitive' } } },
                  },
                },
              ],
            }
          : {}),
      };
      const units = await tx.unit.findMany({
        where,
        select: REGISTER_UNIT_SELECT,
        orderBy: [{ buildingId: 'asc' }, { unitNo: 'asc' }],
      });
      let rows = await this.entries(tx, units, this.today());
      if (q.incomplete !== undefined) rows = rows.filter((r) => r.incomplete === q.incomplete);
      return { rows: rows.slice(q.skip, q.skip + q.take), total: rows.length };
    });
  }

  /** `GET …/register/units/{unitId}`: the entry with the ownership and bill-to history and the transfers. */
  async get(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, (tx) => this.detail(tx, ctx, unitId));
  }

  private async detail(tx: Tx, ctx: TenantContext, unitId: string) {
    await this.unitOf(tx, ctx, unitId);
    const unit = await tx.unit.findUniqueOrThrow({ where: { id: unitId }, select: REGISTER_UNIT_SELECT });
    const [entry] = await this.entries(tx, [unit], this.today());
    const history = await tx.unitOwnership.findMany({
      where: { unitId },
      include: { party: { select: PARTY_SELECT } },
      orderBy: [{ validFrom: 'asc' }, { partyId: 'asc' }],
    });
    const billToHistory = await tx.billTo.findMany({
      where: { unitId },
      include: { billToParty: { select: PARTY_SELECT } },
      orderBy: { validFrom: 'asc' },
    });
    const transfers = await tx.ownershipTransfer.findMany({
      where: this.own(ctx, { unitId }),
      orderBy: [{ transferDate: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      ...entry!,
      history: history.map((o) => ({
        ownershipId: o.id,
        party: o.party,
        sharePct: D(o.sharePct.toString()).toFixed(4),
        validFrom: day(o.validFrom),
        validTo: o.validTo ? day(o.validTo) : null,
        source: o.source,
      })),
      billToHistory: billToHistory.map(billToEntry),
      transfers,
    };
  }

  /** `PATCH …/register/units/{unitId}`: plot fields, land area, floor area, ownership ratio (audited, versioned). */
  async updateUnit(
    ctx: TenantContext,
    unitId: string,
    input: {
      landAreaSqwa?: string | null;
      plotNo?: string | null;
      titleDeedNo?: string | null;
      areaSqm?: string | null;
      ownershipRatio?: string | null;
      version?: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const { unit } = await this.unitOf(tx, ctx, unitId);
      if (input.version !== undefined && input.version !== unit.version)
        throw new DomainException('concurrency.stale');
      const data: Prisma.UnitUpdateInput = {
        ...(input.landAreaSqwa !== undefined ? { landAreaSqwa: input.landAreaSqwa } : {}),
        ...(input.plotNo !== undefined ? { plotNo: input.plotNo?.trim() || null } : {}),
        ...(input.titleDeedNo !== undefined ? { titleDeedNo: input.titleDeedNo?.trim() || null } : {}),
        ...(input.areaSqm !== undefined ? { areaSqm: input.areaSqm } : {}),
        ...(input.ownershipRatio !== undefined ? { ownershipRatio: input.ownershipRatio } : {}),
      };
      if (input.plotNo) {
        const clash = await tx.unit.findFirst({
          where: {
            buildingId: unit.buildingId,
            plotNo: input.plotNo.trim(),
            id: { not: unit.id },
            deletedAt: null,
          },
          select: { id: true },
        });
        if (clash)
          throw new DomainException('validation.failed', {
            errors: [
              { path: 'plotNo', code: 'unique', message: 'another unit of the building has this plot no.' },
            ],
          });
      }
      await tx.unit.update({
        where: { id: unit.id },
        data: { ...data, version: { increment: 1 }, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'juristic.register_unit_updated',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'core.unit',
        subjectId: unit.id,
        before: {
          landAreaSqwa: unit.landAreaSqwa?.toString() ?? null,
          plotNo: unit.plotNo,
          titleDeedNo: unit.titleDeedNo,
          areaSqm: unit.areaSqm?.toString() ?? null,
          ownershipRatio: unit.ownershipRatio?.toString() ?? null,
        },
        after: {
          landAreaSqwa: input.landAreaSqwa,
          plotNo: input.plotNo,
          titleDeedNo: input.titleDeedNo,
          areaSqm: input.areaSqm,
          ownershipRatio: input.ownershipRatio,
        },
      });
      await this.events.record(tx, {
        type: 'unit.changed',
        aggregateType: 'unit',
        aggregateId: unit.id,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: { unitId: unit.id, change: 'register_updated' },
      });
      return this.detail(tx, ctx, unit.id);
    });
  }

  /** A party of the tenant by id, or a new one (name, phone, e-mail) created in the same transaction. */
  private async partyOf(tx: Tx, ctx: TenantContext, ref: PartyRef, path: string): Promise<string> {
    if (ref.partyId) {
      const p = await tx.party.findFirst({ where: this.own(ctx, { id: ref.partyId, deletedAt: null }) });
      if (!p) throw new DomainException('http.not_found');
      return p.id;
    }
    if (!ref.party)
      throw new DomainException('validation.failed', {
        errors: [{ path, code: 'required', message: 'partyId or party is required' }],
      });
    const created = await tx.party.create({
      data: {
        tenantId: ctx.tenantId,
        type: ref.party.type,
        displayName: ref.party.displayName.trim(),
        ...(ref.party.type === 'company' ? { companyName: ref.party.displayName.trim() } : {}),
        phoneE164: ref.party.phone ?? null,
        phoneHash: ref.party.phone ? this.hasher.tenantValue(ctx.tenantId, ref.party.phone) : null,
        email: ref.party.email ?? null,
        language: ref.party.language ?? 'th',
        createdBy: by(),
      },
    });
    await this.events.record(tx, {
      type: 'party.changed',
      aggregateType: 'party',
      aggregateId: created.id,
      tenantId: ctx.tenantId,
      payload: { partyId: created.id, change: 'created' },
    });
    return created.id;
  }

  /** Σ shares of the unit's rows on every day from `from` (worst day) — the API check before asset-core's trigger. */
  private async worstShare(tx: Tx, unitId: string): Promise<Decimal> {
    const rows = await tx.unitOwnership.findMany({ where: { unitId } });
    let worst = D(0);
    for (const start of new Set(rows.map((r) => day(r.validFrom)))) {
      const sum = rows
        .filter((r) => day(r.validFrom) <= start && (!r.validTo || day(r.validTo) > start))
        .reduce((s, r) => s.plus(r.sharePct.toString()), D(0));
      if (sum.gt(worst)) worst = sum;
    }
    return worst;
  }

  /** Runs a register write; asset-core's deferred Σ ≤ 100 trigger fires at commit and maps to the same 422. */
  private async write<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.tenant(ctx, fn);
    } catch (e) {
      if (/core\.ownership_share_exceeded/.test((e as Error).message ?? ''))
        throw new DomainException('register.shares_exceeded');
      throw e;
    }
  }

  /** `POST …/register/units/{unitId}/owners`: a co-owner from a date with a share (Σ current shares ≤ 100). */
  async addOwner(
    ctx: TenantContext,
    unitId: string,
    input: PartyRef & { sharePct: string; validFrom?: string },
  ) {
    return this.write(ctx, async (tx) => {
      const { unit } = await this.unitOf(tx, ctx, unitId);
      const partyId = await this.partyOf(tx, ctx, input, 'party');
      const validFrom = input.validFrom ?? this.today();
      const overlap = await tx.unitOwnership.findFirst({
        where: { unitId, partyId, OR: [{ validTo: null }, { validTo: { gt: asDate(validFrom) } }] },
      });
      if (overlap)
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'partyId', code: 'unique', message: 'the party already owns a share of this unit' },
          ],
        });
      const row = await tx.unitOwnership.create({
        data: {
          tenantId: unit.tenantId,
          buildingId: unit.buildingId,
          unitId,
          partyId,
          sharePct: D(input.sharePct).toFixed(4),
          validFrom: asDate(validFrom),
          source: 'manual',
          createdBy: by(),
        },
      });
      if ((await this.worstShare(tx, unitId)).gt(100)) throw new DomainException('register.shares_exceeded');
      await this.audit.record(tx, {
        action: 'juristic.owner_added',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'core.unit_ownership',
        subjectId: row.id,
        after: { unitId, partyId, sharePct: row.sharePct.toString(), validFrom },
      });
      await this.events.record(tx, {
        type: 'unit_ownership.added',
        aggregateType: 'unit',
        aggregateId: unitId,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: { unitId, ownershipId: row.id, partyId, sharePct: row.sharePct.toString(), validFrom },
      });
      return this.detail(tx, ctx, unitId);
    });
  }

  /**
   * `POST …/register/units/{unitId}/transfers` (Idempotency-Key): a whole-unit transfer on `transferDate`. Every owner
   * current on that day is closed at the date (exclusive `valid_to`), the buyers open with their shares, the sellers'
   * bill-to rows end, and issued advance invoices that cover the date are prorated (`juristic.transfer_proration`).
   */
  async transfer(
    ctx: TenantContext,
    unitId: string,
    input: {
      transferDate: string;
      buyers: (PartyRef & { sharePct: string })[];
      policy?: TransferPolicy;
      note?: string | null;
    },
  ) {
    return this.write(ctx, async (tx) => {
      const { unit } = await this.unitOf(tx, ctx, unitId);
      await tx.$queryRaw`SELECT id FROM core.unit WHERE id = ${unitId}::uuid FOR UPDATE`;
      const date = asDate(input.transferDate);
      const sellers = await tx.unitOwnership.findMany({
        where: { unitId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gt: date } }] },
        orderBy: { partyId: 'asc' },
      });
      if (!sellers.length || sellers.some((s) => day(s.validFrom) === input.transferDate))
        throw new DomainException('register.transfer_invalid');
      const later = await tx.unitOwnership.count({ where: { unitId, validFrom: { gt: date } } });
      if (later) throw new DomainException('register.transfer_invalid');
      const buyerSum = input.buyers.reduce((s, b) => s.plus(b.sharePct), D(0));
      if (buyerSum.gt(100)) throw new DomainException('register.shares_exceeded');
      const property = await tx.building.findUniqueOrThrow({
        where: { id: unit.buildingId },
        select: { propertyId: true },
      });
      const policy =
        input.policy ??
        (await this.settings.valueAt<TransferPolicy>('juristic.transfer_proration', this.clock.now(), {
          tenantId: ctx.tenantId,
          propertyId: property.propertyId,
        }));
      // close the sellers (and their bill-to rows) at the transfer date
      for (const s of sellers)
        await tx.unitOwnership.update({ where: { id: s.id }, data: { validTo: date, updatedBy: by() } });
      const sellerIds = sellers.map((s) => s.partyId);
      const billTos = await tx.billTo.findMany({
        where: {
          unitId,
          ownerPartyId: { in: sellerIds },
          OR: [{ validTo: null }, { validTo: { gt: date } }],
        },
      });
      for (const b of billTos)
        if (day(b.validFrom) >= input.transferDate) throw new DomainException('register.transfer_invalid');
        else
          await tx.billTo.update({
            where: { id: b.id },
            data: { validTo: date, endedReason: 'ownership_transfer', updatedBy: by() },
          });
      const buyers: { partyId: string; sharePct: string; ownershipId: string }[] = [];
      for (const [i, b] of input.buyers.entries()) {
        const partyId = await this.partyOf(tx, ctx, b, `buyers[${i}]`);
        if (buyers.some((x) => x.partyId === partyId))
          throw new DomainException('validation.failed', {
            errors: [{ path: `buyers[${i}]`, code: 'unique', message: 'a buyer is listed twice' }],
          });
        const row = await tx.unitOwnership.create({
          data: {
            tenantId: unit.tenantId,
            buildingId: unit.buildingId,
            unitId,
            partyId,
            sharePct: D(b.sharePct).toFixed(4),
            validFrom: date,
            source: 'manual',
            sourceRef: 'juristic_transfer',
            createdBy: by(),
          },
        });
        buyers.push({ partyId, sharePct: D(b.sharePct).toFixed(4), ownershipId: row.id });
      }
      // proration of issued advance invoices covering the transfer date (D-303, D-324)
      const prorated = await this.prorate(tx, ctx, unit, input.transferDate, buyers, policy);
      const transfer = await tx.ownershipTransfer.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId,
          transferDate: date,
          fromOwnershipIds: sellers.map((s) => s.id),
          toOwnershipIds: buyers.map((b) => b.ownershipId),
          policy,
          creditNoteIds: prorated.creditNoteIds,
          chargeIds: prorated.chargeIds,
          note: input.note ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'unit_ownership.transferred',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'juristic.ownership_transfer',
        subjectId: transfer.id,
        before: { owners: sellers.map((s) => ({ partyId: s.partyId, sharePct: s.sharePct.toString() })) },
        after: {
          transferDate: input.transferDate,
          owners: buyers.map((b) => ({ partyId: b.partyId, sharePct: b.sharePct })),
          policy,
          credited: prorated.credited,
          charged: prorated.charged,
        },
      });
      await this.events.record(tx, {
        type: 'unit_ownership.transferred',
        aggregateType: 'unit',
        aggregateId: unitId,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: {
          transferId: transfer.id,
          unitId,
          buildingId: unit.buildingId,
          transferDate: input.transferDate,
          sellerPartyIds: sellerIds,
          buyerPartyIds: buyers.map((b) => b.partyId),
          policy,
          creditNoteIds: prorated.creditNoteIds,
          chargeIds: prorated.chargeIds,
          credited: prorated.credited,
        },
      });
      return { transfer, register: await this.detail(tx, ctx, unitId) };
    });
  }

  /**
   * Every issued common-fee / fund line of the unit whose period contains the transfer date: a credit note to its
   * invoice for the days from the date (`amountFromDate`, cumulative rounding as J1.1a; capped by what is still
   * creditable); `carry_to_buyer` also queues the same amount as one-off charges of the line's kind to the buyers by
   * share (remainder to the largest share), billed by the next monthly cycle.
   */
  private async prorate(
    tx: Tx,
    ctx: TenantContext,
    unit: Unit,
    transferDate: string,
    buyers: { partyId: string; sharePct: string }[],
    policy: TransferPolicy,
  ): Promise<{ creditNoteIds: string[]; chargeIds: string[]; credited: string; charged: string }> {
    const date = asDate(transferDate);
    const invoices = await tx.invoice.findMany({
      where: {
        tenantId: ctx.tenantId,
        unitId: unit.id,
        status: { notIn: ['draft', 'void'] },
        issuedAt: { not: null },
        lines: {
          some: {
            lineKind: { in: ['common_fee', 'fund'] },
            periodFrom: { lte: date },
            periodTo: { gte: date },
          },
        },
      },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        creditNotes: { include: { lines: true } },
      },
      orderBy: { issuedAt: 'asc' },
    });
    const creditNoteIds: string[] = [];
    const chargeIds: string[] = [];
    let credited = D(0);
    let charged = D(0);
    for (const inv of invoices) {
      const lines = inv.lines
        .filter(
          (l) =>
            (l.lineKind === 'common_fee' || l.lineKind === 'fund') &&
            l.periodFrom &&
            l.periodTo &&
            day(l.periodFrom) <= transferDate &&
            day(l.periodTo) >= transferDate,
        )
        .map((l) => {
          const already = inv.creditNotes
            .flatMap((n) => n.lines)
            .filter((x) => x.refInvoiceLineId === l.id)
            .reduce((s, x) => s.plus(x.amount.toString()), D(0));
          const due = D(
            amountFromDate(
              l.amount.toString(),
              { from: day(l.periodFrom!), to: day(l.periodTo!) },
              transferDate,
            ),
          );
          return { line: l, amount: Decimal.min(due, D(l.amount.toString()).minus(already)) };
        })
        .filter((x) => x.amount.gt(0));
      if (!lines.length) continue;
      const to = (l: (typeof lines)[number]) => day(l.line.periodTo!);
      const noteId = await this.invoices.noteIn(tx, ctx, 'credit', inv.id, {
        reason: 'ownership_transfer',
        reasonText: `โอนกรรมสิทธิ์ ${transferDate}`,
        lines: lines.map((l) => ({
          refInvoiceLineId: l.line.id,
          description: `${l.line.description} — ส่วนหลังโอน ${transferDate} ถึง ${to(l)}`,
          amount: l.amount.toFixed(2),
        })),
      });
      creditNoteIds.push(noteId);
      for (const l of lines) {
        credited = credited.plus(l.amount);
        if (policy !== 'carry_to_buyer' || !buyers.length) continue;
        for (const [partyId, amount] of splitByShares(l.amount, buyers)) {
          if (!D(amount).gt(0)) continue;
          const charge = await tx.invoiceCharge.create({
            data: {
              tenantId: ctx.tenantId,
              buildingId: unit.buildingId,
              unitId: unit.id,
              partyId,
              sourceType: l.line.lineKind === 'fund' ? 'fund' : 'common_fee',
              lineKind: l.line.lineKind,
              sourceId: l.line.id,
              description: `${l.line.description.replace(/ \(.*\)$/, '')} ${transferDate} – ${to(l)} (รับโอนกรรมสิทธิ์)`,
              quantity: '1.000',
              unitPrice: D(amount).toFixed(4),
              amount,
              createdBy: by(),
            },
          });
          chargeIds.push(charge.id);
          charged = charged.plus(amount);
          await this.events.record(tx, {
            type: 'invoice_charge.queued',
            aggregateType: 'invoice_charge',
            aggregateId: charge.id,
            tenantId: ctx.tenantId,
            buildingId: unit.buildingId,
            payload: { chargeId: charge.id, unitId: unit.id, partyId, amount },
          });
        }
      }
    }
    return { creditNoteIds, chargeIds, credited: credited.toFixed(2), charged: charged.toFixed(2) };
  }

  /** `GET …/register/units/{unitId}/transfers`. */
  async transfers(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.unitOf(tx, ctx, unitId);
      return tx.ownershipTransfer.findMany({
        where: this.own(ctx, { unitId }),
        orderBy: [{ transferDate: 'desc' }, { createdAt: 'desc' }],
      });
    });
  }

  /**
   * `POST …/register/units/{unitId}/bill-to` (D-307): a current co-owner names the party who receives and pays the
   * unit's invoices from `validFrom`, with the owner's **written consent** (a document of the tenant). One bill-to per
   * owner and day; an open earlier one ends the day before.
   */
  async setBillTo(
    ctx: TenantContext,
    unitId: string,
    input: {
      ownerPartyId: string;
      payer: PartyRef;
      kind: 'named_party' | 'agency';
      consentDocumentId: string;
      consentNote?: string | null;
      validFrom?: string;
    },
  ) {
    return this.write(ctx, async (tx) => {
      const { unit } = await this.unitOf(tx, ctx, unitId);
      const validFrom = input.validFrom ?? this.today();
      const date = asDate(validFrom);
      const owner = await tx.unitOwnership.findFirst({
        where: {
          unitId,
          partyId: input.ownerPartyId,
          validFrom: { lte: date },
          OR: [{ validTo: null }, { validTo: { gt: date } }],
        },
      });
      if (!owner)
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'ownerPartyId', code: 'notOwner', message: 'not a co-owner of the unit on validFrom' },
          ],
        });
      const doc = await tx.document.findFirst({
        where: { id: input.consentDocumentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!doc) throw new DomainException('http.not_found');
      const payerId = await this.partyOf(tx, ctx, input.payer, 'payer');
      if (payerId === input.ownerPartyId)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'payer', code: 'sameParty', message: 'the owner is billed by default' }],
        });
      const open = await tx.billTo.findFirst({
        where: {
          unitId,
          ownerPartyId: input.ownerPartyId,
          OR: [{ validTo: null }, { validTo: { gt: date } }],
        },
        orderBy: { validFrom: 'desc' },
      });
      if (open) {
        if (day(open.validFrom) >= validFrom)
          throw new DomainException('validation.failed', {
            errors: [
              { path: 'validFrom', code: 'overlap', message: 'a bill-to starts on or after this day' },
            ],
          });
        await tx.billTo.update({
          where: { id: open.id },
          data: { validTo: date, endedReason: 'replaced', updatedBy: by() },
        });
      }
      const row = await tx.billTo.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId,
          ownerPartyId: input.ownerPartyId,
          billToPartyId: payerId,
          kind: input.kind,
          consentDocumentId: doc.id,
          consentNote: input.consentNote ?? null,
          validFrom: date,
          validTo: owner.validTo,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.bill_to_set',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'juristic.bill_to',
        subjectId: row.id,
        after: {
          unitId,
          ownerPartyId: input.ownerPartyId,
          billToPartyId: payerId,
          kind: input.kind,
          consentDocumentId: doc.id,
          validFrom,
          replaced: open?.id ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'juristic.bill_to.changed',
        aggregateType: 'unit',
        aggregateId: unitId,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: {
          billToId: row.id,
          unitId,
          ownerPartyId: input.ownerPartyId,
          billToPartyId: payerId,
          change: 'set',
          validFrom,
        },
      });
      return this.detail(tx, ctx, unitId);
    });
  }

  /** `POST …/bill-to/{billToId}/actions/end`: from `validTo` (default today) the owner is billed again. */
  async endBillTo(
    ctx: TenantContext,
    unitId: string,
    billToId: string,
    input: { validTo?: string; reason?: string | null },
  ) {
    return this.write(ctx, async (tx) => {
      const { unit } = await this.unitOf(tx, ctx, unitId);
      const row = this.found(await tx.billTo.findFirst({ where: this.own(ctx, { id: billToId, unitId }) }));
      const validTo = input.validTo ?? this.today();
      if (validTo <= day(row.validFrom) || (row.validTo && day(row.validTo) <= validTo))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'validTo', code: 'range', message: 'after the start and before the current end' }],
        });
      await tx.billTo.update({
        where: { id: row.id },
        data: { validTo: asDate(validTo), endedReason: input.reason ?? 'ended', updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'juristic.bill_to_ended',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'juristic.bill_to',
        subjectId: row.id,
        before: { validTo: row.validTo ? day(row.validTo) : null },
        after: { validTo, reason: input.reason ?? null },
      });
      await this.events.record(tx, {
        type: 'juristic.bill_to.changed',
        aggregateType: 'unit',
        aggregateId: unitId,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: {
          billToId: row.id,
          unitId,
          ownerPartyId: row.ownerPartyId,
          billToPartyId: row.billToPartyId,
          change: 'ended',
          validTo,
        },
      });
      return this.detail(tx, ctx, unitId);
    });
  }
}

function billToEntry(
  b: Prisma.BillToGetPayload<{ include: { billToParty: { select: typeof PARTY_SELECT } } }>,
): BillToEntry {
  return {
    id: b.id,
    ownerPartyId: b.ownerPartyId,
    billToParty: b.billToParty,
    kind: b.kind,
    consentDocumentId: b.consentDocumentId,
    consentNote: b.consentNote,
    validFrom: day(b.validFrom),
    validTo: b.validTo ? day(b.validTo) : null,
    endedReason: b.endedReason,
  };
}
