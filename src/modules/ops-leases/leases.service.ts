import { createHash } from 'node:crypto';

import { actorEnvelope, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceAcknowledgementService } from '@core/compliance/compliance-acknowledgement.service';
import { ComplianceGate, type GateResult, type RuleCheck } from '@core/compliance/compliance-gate.service';
import { LESSEE_NOTICE_DAYS, LESSOR_DISTURBANCE_DAYS, LESSOR_REMEDY_DAYS } from '@core/compliance/evaluators';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { SettingsService } from '@core/settings/settings.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import { isExclusionViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Lease,
  type LeaseLineKind,
  type LeasePartyRole,
  type LeaseStatus,
  type LineRecurrence,
  type Prisma,
} from '@generated/prisma/client';
import { type BoardLease, BoardService } from '@modules/ops-units/board.service';
import { operates } from '@modules/ops-units/building-access';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type ContractData, type ContractLanguage, ContractRenderer } from './contract-renderer';
import { bahtTextEn, englishDate } from './english-text';
import { landlordTemplateKey, landlordTemplateKind } from './landlord-templates';
import {
  type AddendumInput,
  checkLeaseTerms,
  checkLesseeNotice,
  checkLessorNotice,
  type LessorReason,
} from './lease-compliance';
import { endDateFor, monthsBetween } from './lease-dates';
import {
  rentOverTerm,
  STAMP_DUTY_PAYER_EN,
  STAMP_DUTY_PAYER_TH,
  stampDutyFor,
  type StampDutyPayer,
} from './stamp-duty';
import { bahtText, formatThb, thaiDate } from './thai-text';

const by = () => userIdOf(RequestContext.actor());

export interface LeaseLineDraft {
  kind: LeaseLineKind;
  description: string;
  amount: string;
  recurrence?: LineRecurrence;
}

export interface LeaseDraftInput {
  unitId: string;
  lesseePartyId: string;
  coTenantPartyIds?: string[];
  guarantorPartyIds?: string[];
  occupantPartyIds?: string[];
  startDate: string;
  months?: number;
  endDate?: string;
  rent?: string;
  depositAmount?: string;
  advanceRentAmount?: string;
  billingDay?: number | null;
  utilityBillingMode?: 'metered' | 'included';
  keysCount?: number;
  parkingSlots?: number;
  lines?: LeaseLineDraft[];
  addendum?: AddendumInput[];
  rentIncreases?: { effectiveFrom: string; rent: string }[];
  terms?: Record<string, unknown>;
  acknowledgementIds?: string[];
  /** B7.5 (D-253): the contract language — landlord templates exist in th and en; others only th. */
  language?: ContractLanguage;
  /** B7.5 (O-019): who pays the stamp duty (default the lessor). */
  stampDutyPayer?: StampDutyPayer;
  /** B7.5 (D-253): Thai and English texts in one signed PDF (templates published in both languages only). */
  bilingual?: boolean;
}

export const LEASE_INCLUDE = {
  unit: { select: { id: true, unitNo: true, floorId: true, status: true } },
  building: { select: { id: true, name: true, code: true, operatorTenantId: true, ownerTenantId: true } },
  lessee: {
    select: { id: true, displayName: true, idNumberEnc: true, idDocumentType: true, phoneE164: true },
  },
  parties: { include: { party: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'asc' } },
  lines: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  signatures: { orderBy: { signedAt: 'asc' } },
  templateVersion: {
    select: { id: true, version: true, language: true, template: { select: { id: true, key: true } } },
  },
} as const satisfies Prisma.LeaseInclude;
export type LeaseRow = Prisma.LeaseGetPayload<{ include: typeof LEASE_INCLUDE }>;

/** Permission that reveals ID / passport numbers (D-172). */
export const PII_DECRYPT = 'party.pii.decrypt';
/** What a contract preview shows instead of the ID number to a caller without `party.pii.decrypt` (D-222). */
export const MASKED_ID_NUMBER = 'xxxxxxxxxxxxx (ปกปิด)';

export const IN_FORCE: LeaseStatus[] = ['active', 'notice_given', 'ending'];
const ID_LABEL: Record<string, string> = {
  thai_national_id: 'เลขประจำตัวประชาชน',
  passport: 'หนังสือเดินทางเลขที่',
  other: 'เอกสารแสดงตนเลขที่',
};
const PROVIDER_TH: Record<string, string> = {
  mea: 'การไฟฟ้านครหลวง',
  pea: 'การไฟฟ้าส่วนภูมิภาค',
  mwa: 'การประปานครหลวง',
  pwa: 'การประปาส่วนภูมิภาค',
};
const RECURRENCE_TH: Record<string, string> = { monthly: 'ต่อเดือน', once: 'ครั้งเดียว' };
const ID_LABEL_EN: Record<string, string> = {
  thai_national_id: 'Thai ID card no.',
  passport: 'passport no.',
  other: 'identity document no.',
};
const PROVIDER_EN: Record<string, string> = {
  mea: 'the Metropolitan Electricity Authority',
  pea: 'the Provincial Electricity Authority',
  mwa: 'the Metropolitan Waterworks Authority',
  pwa: 'the Provincial Waterworks Authority',
};
const RECURRENCE_EN: Record<string, string> = { monthly: 'per month', once: 'once' };

export const addressText = (a: unknown): string => {
  const v = (a ?? {}) as Record<string, string | undefined>;
  return [v.line1, v.line2, v.subdistrict, v.district, v.province, v.postcode].filter(Boolean).join(' ');
};

/** What actions the current state allows (UI next actions). */
export function nextActions(status: LeaseStatus): string[] {
  switch (status) {
    case 'draft':
      return ['update', 'preview-contract', 'send-for-signature', 'cancel'];
    case 'pending_signature':
      return ['invite', 'countersign', 'cancel'];
    case 'active':
      return ['record-notice', 'begin-move-out', 'terminate', 'renew'];
    case 'notice_given':
      return ['begin-move-out', 'terminate', 'renew'];
    case 'ending':
      return ['complete-move-out', 'terminate', 'renew'];
    default:
      return [];
  }
}

/**
 * Leases (B2.3, D-020, D-023, D-062): drafts with the สคบ. compliance checks, the standard contract PDF with its
 * number from the `contract` series, e-signatures (residents through `LeaseSigningService`), the lessor's
 * countersignature that activates the lease (occupancy, unit status, current lease), notices, move-out, termination,
 * renewal and cancellation. Everything after "send for signature" is immutable except the lifecycle columns
 * (`compliance.no_midterm_increase`). Every change writes the lease history (`ops.lease_event`), an audit row and a
 * domain event in the same transaction; the compliance gate records its evaluations first.
 */
@Injectable()
export class LeasesService extends TenantScopedRepository implements OnModuleInit {
  private readonly afterActivation: ((tx: Tx, lease: Lease) => Promise<void>)[] = [];
  private readonly afterEnd: ((tx: Tx, lease: Lease, moveOutAt: Date) => Promise<void>)[] = [];

  constructor(
    private readonly db: TenantTx,
    private readonly domainEvents: DomainEvents,
    private readonly audit: AuditService,
    private readonly gate: ComplianceGate,
    private readonly settings: SettingsService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly keys: TenantDataKeys,
    private readonly board: BoardService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.board.useLeaseSource({ currentLeases: (tx, unitIds) => this.currentLeases(tx, unitIds) });
  }

  /** B2.4 hooks: the deposit opens at activation, the settlement at the end of the lease. */
  onActivated(hook: (tx: Tx, lease: Lease) => Promise<void>): void {
    this.afterActivation.push(hook);
  }

  onEnded(hook: (tx: Tx, lease: Lease, moveOutAt: Date) => Promise<void>): void {
    this.afterEnd.push(hook);
  }

  /** Board: the lease shown on each unit card (in force first, else the one waiting for signature). */
  async currentLeases(tx: Tx, unitIds: string[]): Promise<Map<string, BoardLease>> {
    const rows = await tx.lease.findMany({
      where: { unitId: { in: unitIds }, status: { in: [...IN_FORCE, 'pending_signature'] } },
      include: { lessee: { select: { id: true, displayName: true } } },
      orderBy: { startDate: 'asc' },
    });
    const out = new Map<string, BoardLease>();
    for (const r of rows) {
      const existing = out.get(r.unitId);
      if (existing && IN_FORCE.includes(existing.status as LeaseStatus)) continue;
      out.set(r.unitId, {
        leaseId: r.id,
        status: r.status,
        endDate: r.endDate,
        lessee: (r.lessee as typeof r.lessee | null)
          ? { partyId: r.lessee.id, displayName: r.lessee.displayName }
          : null,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- helpers

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  async load(tx: Tx, id: string): Promise<LeaseRow> {
    return this.found(await tx.lease.findFirst({ where: { id }, include: LEASE_INCLUDE }));
  }

  /** The lease of the current tenant (the lessor); grantees of the building see but never change it. */
  private async ownLease(tx: Tx, ctx: TenantContext, id: string): Promise<LeaseRow> {
    const lease = await this.load(tx, id);
    if (lease.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
    if (ctx.buildingIds && !ctx.buildingIds.includes(lease.buildingId))
      throw new DomainException('http.not_found');
    return lease;
  }

  private assertStatus(lease: { status: LeaseStatus }, allowed: LeaseStatus[]) {
    if (!allowed.includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
  }

  async history(
    tx: Tx,
    lease: { id: string; tenantId: string; buildingId: string },
    type: string,
    data: Record<string, unknown>,
    eventType: DomainEventType,
  ) {
    const envelope = await this.domainEvents.record(tx, {
      type: eventType,
      aggregateType: 'lease',
      aggregateId: lease.id,
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      payload: { leaseId: lease.id, ...data },
    });
    await tx.leaseEvent.create({
      data: {
        tenantId: lease.tenantId,
        leaseId: lease.id,
        type,
        occurredAt: this.clock.now(),
        actor: actorEnvelope(RequestContext.actor()),
        data: data as Prisma.InputJsonValue,
        domainEventId: envelope.id,
      },
    });
  }

  /**
   * Unit status and the unit's current lease are the building owner's/operator's rows: a unit grantee leasing the
   * unit (landlord, D-152) cannot write them, so its leases leave them alone (the owner's board still shows the lease
   * through the lease source).
   */
  private async unitRowsWritable(tx: Tx, lease: { tenantId: string; buildingId: string }): Promise<boolean> {
    const n = await tx.building.count({
      where: {
        id: lease.buildingId,
        OR: [{ ownerTenantId: lease.tenantId }, { operatorTenantId: lease.tenantId }],
      },
    });
    return n > 0;
  }

  /**
   * May the current tenant lease out this unit: owner/operator of the building, the unit's own owner (a landlord's
   * condo unit in a shared building, D-251 / D-280: an ownership of this tenant in force), or an ops.lease write grant.
   */
  private async leasableUnit(tx: Tx, ctx: TenantContext, unitId: string) {
    const unit = this.found(
      await tx.unit.findFirst({
        where: { id: unitId, deletedAt: null },
        include: { unitDetailUnit: { include: { profile: true } } },
      }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId))
      throw new DomainException('http.not_found');
    const building = await tx.building.findFirst({ where: { id: unit.buildingId, deletedAt: null } });
    const ownsUnit =
      (await tx.unitOwnership.count({
        where: {
          tenantId: ctx.tenantId,
          unitId,
          validFrom: { lte: new Date(bangkokDate(this.clock.now())) },
          OR: [{ validTo: null }, { validTo: { gt: new Date(bangkokDate(this.clock.now())) } }],
        },
      })) > 0;
    if (!ownsUnit && (!building || !operates(ctx, building))) {
      const granted = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT ${unitId}::uuid = ANY (core.accessible_unit_ids('ops.lease', 'write')) AS ok`;
      if (!granted[0]?.ok) throw new DomainException('asset.read_only');
    }
    if (unit.status === 'inactive' || unit.status === 'maintenance')
      throw new DomainException('lease.unit_unavailable');
    return unit;
  }

  /** Settings of the lease rules; the water minimum of the tariff of the building's water utility (D-141). */
  private async ruleSettings(ctx: TenantContext, buildingId: string) {
    const now = this.clock.now();
    const tenantId = ctx.tenantId;
    const account = await this.db.tenant(ctx, (tx) =>
      tx.utilityAccount.findFirst({ where: { buildingId, utility: 'water' }, select: { provider: true } }),
    );
    const [depositMaxMonths, lateFee, tariff] = await Promise.all([
      this.settings.valueAt<string>('deposit.max_months_short', now, { tenantId }),
      this.settings.at('late_fee.enabled', now, { tenantId }),
      this.db.platform((tx) =>
        tx.utilityTariffVersion.findFirst({
          where: {
            state: 'published',
            effectiveFrom: { lte: now },
            utilityTariff: {
              utility: 'water',
              isActive: true,
              ...(account ? { provider: account.provider } : {}),
            },
          },
          orderBy: { effectiveFrom: 'desc' },
          select: { structure: true },
        }),
      ),
    ]);
    const structure = tariff?.structure as UtilityTariffStructure | null | undefined;
    const minimum = structure?.minimumCharge?.amount ?? null;
    return {
      depositMaxMonths: String(depositMaxMonths),
      lateFeeEnabled: lateFee?.value === true,
      waterMinimumCap: minimum,
    };
  }

  private termsOf(input: {
    rent: string;
    depositAmount: string;
    advanceRentAmount: string;
    months: number;
    startDate: string;
    endDate: string;
    utilityBillingMode: 'metered' | 'included';
    lines: LeaseLineDraft[];
    addendum: AddendumInput[];
    rentIncreases: { effectiveFrom: string; rent: string }[];
    isRenewal: boolean;
  }) {
    return {
      ...input,
      lines: input.lines.map((l) => ({ kind: l.kind, description: l.description, amount: l.amount })),
    };
  }

  private async checkTerms(
    ctx: TenantContext,
    leaseId: string,
    buildingId: string,
    terms: Parameters<LeasesService['termsOf']>[0],
    acknowledgementIds: string[] | undefined,
  ): Promise<GateResult> {
    const settings = await this.ruleSettings(ctx, buildingId);
    const checks = checkLeaseTerms(this.termsOf(terms), settings);
    return this.gate.enforce(ctx, {
      subjectType: 'ops.lease',
      subjectId: leaseId,
      buildingId,
      checks,
      acknowledgementIds,
    });
  }

  // ------------------------------------------------------------------------------------------- drafts

  /** Terms of a new draft with the defaults the API applies (unit base rent / room type months and lines). */
  private async prepareDraft(tx: Tx, ctx: TenantContext, input: LeaseDraftInput) {
    const unit = await this.leasableUnit(tx, ctx, input.unitId);
    const profile = unit.unitDetailUnit?.profile ?? null;
    const rent = input.rent ?? unit.baseRent?.toFixed(2) ?? profile?.defaultRent.toFixed(2);
    if (!rent)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'rent', code: 'required', message: 'the unit has no base rent; give the rent' }],
      });
    const months = input.endDate ? monthsBetween(input.startDate, input.endDate) : (input.months ?? 12);
    const endDate = input.endDate ?? endDateFor(input.startDate, months);
    const depositMonths = profile?.defaultDepositMonths.toString() ?? '1';
    const advanceMonths = profile?.defaultAdvanceRentMonths.toString() ?? '1';
    const lines =
      input.lines ??
      ((profile?.defaultLeaseLines ?? []) as unknown as LeaseLineDraft[]).map((l) => ({
        ...l,
        recurrence: 'monthly' as const,
      }));
    return {
      unit,
      rent,
      months,
      endDate,
      deposit: input.depositAmount ?? new Decimal(rent).times(depositMonths).toFixed(2),
      advance: input.advanceRentAmount ?? new Decimal(rent).times(advanceMonths).toFixed(2),
      defaultDeposit: new Decimal(rent).times(depositMonths).toFixed(2),
      defaultAdvance: new Decimal(rent).times(advanceMonths).toFixed(2),
      lines,
    };
  }

  /**
   * Dry run of `createDraft` (web F2 wizard, D-208): the compliance checks the terms would get now and the defaults
   * the API applies — nothing is written, no evaluation recorded. Refusals that are not compliance rules (unit not
   * leasable, unknown parties) come back as problems instead of an error.
   */
  async previewDraft(ctx: TenantContext, input: LeaseDraftInput) {
    const problems: {
      code: string;
      status: number;
      ruleId: string | null;
      legalRef: string | null;
      errors: unknown[];
    }[] = [];
    const prepared = await this.db
      .tenant(ctx, async (tx) => {
        const p = await this.prepareDraft(tx, ctx, input);
        const partyIds = [
          input.lesseePartyId,
          ...(input.coTenantPartyIds ?? []),
          ...(input.guarantorPartyIds ?? []),
          ...(input.occupantPartyIds ?? []),
        ];
        const unique: string[] = [...new Set(partyIds)];
        const parties = await tx.party.count({
          where: { tenantId: ctx.tenantId, id: { in: unique }, deletedAt: null, anonymisedAt: null },
        });
        if (parties !== new Set(partyIds).size)
          problems.push({
            code: 'validation.failed',
            status: 422,
            ruleId: null,
            legalRef: null,
            errors: [{ path: 'lesseePartyId', code: 'notFound', message: 'a party of the lease is unknown' }],
          });
        return p;
      })
      .catch((error: unknown) => {
        if (error instanceof DomainException && error.code !== 'http.not_found') {
          problems.push({
            code: error.code,
            status: error.status,
            ruleId: null,
            legalRef: null,
            errors: error.errors ?? [],
          });
          return null;
        }
        throw error;
      });
    if (!prepared) return { checks: [], problems, defaults: null, inScope: true };
    const settings = await this.ruleSettings(ctx, prepared.unit.buildingId);
    const checks = checkLeaseTerms(
      this.termsOf({
        rent: prepared.rent,
        depositAmount: prepared.deposit,
        advanceRentAmount: prepared.advance,
        months: prepared.months,
        startDate: input.startDate,
        endDate: prepared.endDate,
        utilityBillingMode: input.utilityBillingMode ?? 'metered',
        lines: prepared.lines,
        addendum: input.addendum ?? [],
        rentIncreases: input.rentIncreases ?? [],
        isRenewal: false,
      }),
      settings,
    );
    const preview = await this.gate.preview(ctx.tenantId, checks);
    for (const c of preview.checks)
      if (c.outcome === 'block')
        problems.push({
          code: c.ruleId,
          status: 422,
          ruleId: c.ruleId,
          legalRef: c.legalRef,
          errors: c.errors ?? [],
        });
      else if (c.outcome === 'warn')
        problems.push({
          code: 'compliance.acknowledgement_required',
          status: 409,
          ruleId: c.ruleId,
          legalRef: c.legalRef,
          errors: c.errors ?? [],
        });
    return {
      inScope: preview.inScope,
      checks: preview.checks,
      problems,
      defaults: {
        rent: prepared.rent,
        depositAmount: prepared.defaultDeposit,
        advanceRentAmount: prepared.defaultAdvance,
        billingDay: input.billingDay ?? null,
        endDate: prepared.endDate,
        months: prepared.months,
        lines: prepared.lines,
      },
    };
  }

  /** A new draft (B2.3 §3): defaults from the unit and its room type, compliance-checked before it is written. */
  async createDraft(
    ctx: TenantContext,
    input: LeaseDraftInput,
    renewedFromLeaseId: string | null = null,
  ): Promise<LeaseRow> {
    const id = uuidv7(this.clock.now().getTime());
    const prepared = await this.db.tenant(ctx, (tx) => this.prepareDraft(tx, ctx, input));
    const { unit } = prepared;
    const template = await this.templateFor(ctx.tenantId, unit, input.language ?? 'th');
    if (input.bilingual) await this.assertBilingual(template.templateId);
    const gate = await this.checkTerms(
      ctx,
      id,
      unit.buildingId,
      {
        rent: prepared.rent,
        depositAmount: prepared.deposit,
        advanceRentAmount: prepared.advance,
        months: prepared.months,
        startDate: input.startDate,
        endDate: prepared.endDate,
        utilityBillingMode: input.utilityBillingMode ?? 'metered',
        lines: prepared.lines,
        addendum: input.addendum ?? [],
        rentIncreases: input.rentIncreases ?? [],
        isRenewal: renewedFromLeaseId !== null,
      },
      input.acknowledgementIds,
    );
    return this.db.tenant(ctx, async (tx) => {
      const partyIds = [
        input.lesseePartyId,
        ...(input.coTenantPartyIds ?? []),
        ...(input.guarantorPartyIds ?? []),
        ...(input.occupantPartyIds ?? []),
      ];
      const parties = await tx.party.findMany({
        where: this.own(ctx, { id: { in: partyIds }, deletedAt: null, anonymisedAt: null }),
        select: { id: true },
      });
      if (new Set(parties.map((p) => p.id)).size !== new Set(partyIds).size)
        throw new DomainException('http.not_found');
      const advanceMonths = new Decimal(prepared.advance)
        .dividedBy(prepared.rent)
        .toDecimalPlaces(1)
        .toString();
      await tx.lease.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId: unit.id,
          lesseePartyId: input.lesseePartyId,
          templateVersionId: template.id,
          startDate: new Date(input.startDate),
          endDate: new Date(prepared.endDate),
          months: prepared.months,
          rent: prepared.rent,
          depositAmount: prepared.deposit,
          advanceRentAmount: prepared.advance,
          advanceRentMonths: Decimal.min(advanceMonths, '99.9').toString(),
          billingDay: input.billingDay ?? null,
          utilityBillingMode: input.utilityBillingMode ?? 'metered',
          keysCount: input.keysCount ?? 0,
          parkingSlots: input.parkingSlots ?? 0,
          terms: (input.terms ?? {}) as Prisma.InputJsonValue,
          stampDutyPayer: input.stampDutyPayer ?? 'lessor',
          bilingual: input.bilingual ?? false,
          addendum: (input.addendum ?? []) as unknown as Prisma.InputJsonValue,
          rentIncreaseRecorded: input.rentIncreases?.length
            ? (input.rentIncreases as unknown as Prisma.InputJsonValue)
            : undefined,
          renewedFromLeaseId,
          complianceSnapshot: { ...gate, acknowledgementIds: input.acknowledgementIds ?? [] },
          createdBy: by(),
        },
      });
      const roles: [string, LeasePartyRole, boolean][] = [
        [input.lesseePartyId, 'lessee', true],
        ...(input.coTenantPartyIds ?? []).map(
          (p) => [p, 'co_tenant', true] as [string, LeasePartyRole, boolean],
        ),
        ...(input.guarantorPartyIds ?? []).map(
          (p) => [p, 'guarantor', false] as [string, LeasePartyRole, boolean],
        ),
        ...(input.occupantPartyIds ?? []).map(
          (p) => [p, 'occupant', false] as [string, LeasePartyRole, boolean],
        ),
      ];
      for (const [partyId, role, isSigner] of roles)
        await tx.leaseParty.create({
          data: { tenantId: ctx.tenantId, leaseId: id, partyId, role, isSigner, createdBy: by() },
        });
      await this.writeLines(tx, ctx.tenantId, id, input.startDate, prepared.lines);
      await this.audit.record(tx, {
        action: renewedFromLeaseId ? 'lease.renewed' : 'lease.created',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'ops.lease',
        subjectId: id,
        after: {
          unitId: unit.id,
          lesseePartyId: input.lesseePartyId,
          rent: prepared.rent,
          renewedFromLeaseId,
        },
      });
      await this.history(
        tx,
        { id, tenantId: ctx.tenantId, buildingId: unit.buildingId },
        renewedFromLeaseId ? 'renewed' : 'drafted',
        { unitId: unit.id, renewedFromLeaseId },
        'lease.drafted',
      );
      return this.load(tx, id);
    });
  }

  private async writeLines(
    tx: Tx,
    tenantId: string,
    leaseId: string,
    startDate: string,
    lines: LeaseLineDraft[],
  ) {
    let order = 0;
    for (const l of lines)
      await tx.leaseLine.create({
        data: {
          tenantId,
          leaseId,
          kind: l.kind,
          description: l.description,
          amount: new Decimal(l.amount).toFixed(2),
          recurrence: l.recurrence ?? 'monthly',
          effectiveFrom: new Date(startDate),
          sortOrder: order++,
          createdBy: by(),
        },
      });
  }

  async updateDraft(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: Partial<LeaseDraftInput>,
  ): Promise<LeaseRow> {
    const current = await this.db.tenant(ctx, (tx) => this.ownLease(tx, ctx, id));
    if (current.version !== version) throw new DomainException('concurrency.stale');
    if (current.status !== 'draft') {
      // After sending, the agreed terms are frozen: changing money terms is a mid-term increase (D-020).
      const money = ['rent', 'depositAmount', 'advanceRentAmount', 'lines', 'rentIncreases'].some(
        (k) => k in patch,
      );
      if (money)
        throw new DomainException('compliance.no_midterm_increase', {
          extensions: {
            legalRef: ComplianceAcknowledgementService.legalRef('compliance.no_midterm_increase'),
            ruleId: 'compliance.no_midterm_increase',
          },
        });
      throw new DomainException('lease.invalid_state', { params: { status: current.status } });
    }
    const startDate = patch.startDate ?? current.startDate.toISOString().slice(0, 10);
    const months = patch.endDate ? monthsBetween(startDate, patch.endDate) : (patch.months ?? current.months);
    const endDate =
      patch.endDate ??
      (patch.months || patch.startDate
        ? endDateFor(startDate, months)
        : current.endDate.toISOString().slice(0, 10));
    const rent = patch.rent ?? current.rent.toFixed(2);
    const lines =
      patch.lines ??
      current.lines.map((l) => ({
        kind: l.kind,
        description: l.description,
        amount: l.amount.toFixed(2),
        recurrence: l.recurrence,
      }));
    const addendum = patch.addendum ?? ((current.addendum ?? []) as unknown as AddendumInput[]);
    const rentIncreases =
      patch.rentIncreases ??
      ((current.rentIncreaseRecorded ?? []) as unknown as { effectiveFrom: string; rent: string }[]);
    const deposit = patch.depositAmount ?? current.depositAmount.toFixed(2);
    const advance = patch.advanceRentAmount ?? current.advanceRentAmount.toFixed(2);
    const acks = [
      ...((current.complianceSnapshot as { acknowledgementIds?: string[] }).acknowledgementIds ?? []),
      ...(patch.acknowledgementIds ?? []),
    ];
    const gate = await this.checkTerms(
      ctx,
      id,
      current.buildingId,
      {
        rent,
        depositAmount: deposit,
        advanceRentAmount: advance,
        months,
        startDate,
        endDate,
        utilityBillingMode: patch.utilityBillingMode ?? current.utilityBillingMode,
        lines,
        addendum,
        rentIncreases,
        isRenewal: current.renewedFromLeaseId !== null,
      },
      acks,
    );
    const template = patch.language
      ? await this.db.tenant(ctx, async (tx) =>
          this.templateFor(ctx.tenantId, await this.leasableUnit(tx, ctx, current.unitId), patch.language!),
        )
      : null;
    if (patch.bilingual)
      await this.assertBilingual(template?.templateId ?? current.templateVersion.template.id);
    return this.db.tenant(ctx, async (tx) => {
      const updated = await tx.lease.updateMany({
        where: { id, version, status: 'draft' },
        data: {
          ...(template ? { templateVersionId: template.id } : {}),
          ...(patch.stampDutyPayer ? { stampDutyPayer: patch.stampDutyPayer } : {}),
          ...(patch.bilingual !== undefined ? { bilingual: patch.bilingual } : {}),
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          months,
          rent,
          depositAmount: deposit,
          advanceRentAmount: advance,
          advanceRentMonths: Decimal.min(
            new Decimal(advance).dividedBy(rent).toDecimalPlaces(1),
            '99.9',
          ).toString(),
          ...(patch.billingDay !== undefined ? { billingDay: patch.billingDay } : {}),
          ...(patch.utilityBillingMode ? { utilityBillingMode: patch.utilityBillingMode } : {}),
          ...(patch.keysCount !== undefined ? { keysCount: patch.keysCount } : {}),
          ...(patch.parkingSlots !== undefined ? { parkingSlots: patch.parkingSlots } : {}),
          ...(patch.terms !== undefined ? { terms: patch.terms as Prisma.InputJsonValue } : {}),
          addendum: addendum as unknown as Prisma.InputJsonValue,
          rentIncreaseRecorded: rentIncreases.length
            ? (rentIncreases as unknown as Prisma.InputJsonValue)
            : undefined,
          complianceSnapshot: { ...gate, acknowledgementIds: acks },
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new DomainException('concurrency.stale');
      if (patch.lines) {
        await tx.leaseLine.deleteMany({ where: { leaseId: id } });
        await this.writeLines(tx, ctx.tenantId, id, startDate, patch.lines);
      }
      await this.history(tx, current, 'updated', { fields: Object.keys(patch) }, 'lease.updated');
      return this.load(tx, id);
    });
  }

  get(ctx: TenantContext, id: string): Promise<LeaseRow> {
    return this.db.tenant(ctx, async (tx) => {
      const lease = await this.load(tx, id);
      if (ctx.buildingIds && !ctx.buildingIds.includes(lease.buildingId))
        throw new DomainException('http.not_found');
      return lease;
    });
  }

  list(
    ctx: TenantContext,
    query: {
      status?: LeaseStatus;
      buildingId?: string;
      unitId?: string;
      partyId?: string;
      q?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.LeaseWhereInput = {
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(query.buildingId ? { buildingId: query.buildingId } : {}),
        ...(query.unitId ? { unitId: query.unitId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.partyId
          ? { OR: [{ lesseePartyId: query.partyId }, { parties: { some: { partyId: query.partyId } } }] }
          : {}),
        ...(query.q
          ? {
              OR: [
                { number: { contains: query.q, mode: 'insensitive' } },
                { unit: { unitNo: { contains: query.q, mode: 'insensitive' } } },
                { lessee: { displayName: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.lease.findMany({
          where,
          include: LEASE_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.take,
        }),
        tx.lease.count({ where }),
      ]);
      return { rows, total };
    });
  }

  listEvents(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.load(tx, id);
      return tx.leaseEvent.findMany({
        where: { leaseId: id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  // ------------------------------------------------------------------------------------------- contract

  async standardTemplate() {
    return this.db.platform(async (tx) => {
      const v = await tx.leaseTemplateVersion.findFirst({
        where: {
          tenantId: null,
          state: 'published',
          language: 'th',
          template: { tenantId: null, key: 'ocpb_2568_residential_th' },
        },
        orderBy: { version: 'desc' },
      });
      if (!v) throw new Error('the standard lease template is not seeded (pnpm db:seed)');
      return v;
    });
  }

  /**
   * The template a new lease is written on (B7.5, D-253): a landlord's lease uses the published landlord template of
   * the unit's kind (condo unit / house / room) in the chosen language; every other tenant uses the สคบ. 2568 standard
   * (Thai only). A language without a published version is a 422 on `language`.
   */
  async templateFor(
    tenantId: string,
    unit: { type: string; unitDetailUnit?: { kind: string | null } | null },
    language: ContractLanguage,
  ) {
    const tenant = await this.db.platform((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { type: true } }),
    );
    if (tenant.type !== 'landlord') {
      if (language !== 'th')
        throw new DomainException('validation.failed', {
          errors: [{ path: 'language', code: 'unavailable', message: 'the standard lease is in Thai only' }],
        });
      return this.standardTemplate();
    }
    const key = landlordTemplateKey(landlordTemplateKind(unit.unitDetailUnit?.kind, unit.type));
    const version = await this.db.platform((tx) =>
      tx.leaseTemplateVersion.findFirst({
        where: { tenantId: null, state: 'published', language, template: { tenantId: null, key } },
        orderBy: { version: 'desc' },
      }),
    );
    if (!version)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'language', code: 'unavailable', message: `no published ${key} template in ${language}` },
        ],
      });
    return version;
  }

  /** The templates this tenant can write on: platform templates of its kind (landlord or standard) and its own. */
  async templates(ctx: TenantContext) {
    const tenant = await this.db.platform((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { type: true } }),
    );
    const landlord = tenant.type === 'landlord';
    const all = await this.db.tenant(ctx, (tx) =>
      tx.leaseTemplate.findMany({
        include: { versions: { orderBy: [{ version: 'desc' }] } },
        orderBy: [{ key: 'asc' }],
      }),
    );
    return all.filter((t) => t.tenantId !== null || t.key.startsWith('landlord_') === landlord);
  }

  /** The data a contract renders from; decrypting the lessee's ID number is audited (`pii.decrypted`). */
  async contractData(
    tx: Tx,
    lease: LeaseRow,
    options: {
      draft: boolean;
      number: string | null;
      signatures?: ContractData['signatures'];
      madeOn?: string;
      /**
       * Review #5 (D-172, D-222): false renders the ID / passport number masked without decrypting it — for callers
       * without `party.pii.decrypt` (Staff, Accountant). Stored contracts are always rendered in full.
       */
      revealIdNumber?: boolean;
      /** B7.5: the stamp duty fixed at send-for-signature (default: the lease's, else computed now). */
      stampDutyAmount?: string;
    },
  ): Promise<{ data: ContractData; body: string; language: ContractLanguage }> {
    const now = this.clock.now();
    const [tenant, party, unit, version, equipment, accounts] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: lease.tenantId } }),
      tx.party.findUniqueOrThrow({ where: { id: lease.lesseePartyId } }),
      // building data through gp_platform: a unit grantee leasing the unit does not see the building row (D-152)
      this.db.platform((p) =>
        p.unit.findUniqueOrThrow({
          where: { id: lease.unitId },
          include: { floor: true, building: { include: { property: true } } },
        }),
      ),
      tx.leaseTemplateVersion.findUniqueOrThrow({
        where: { id: lease.templateVersionId },
        include: { template: true },
      }),
      tx.assetItem.findMany({
        where: {
          unitId: lease.unitId,
          deletedAt: null,
          status: 'active',
          category: { in: ['appliance', 'furniture', 'hvac', 'other'] },
        },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      }),
      this.db.platform((p) =>
        p.utilityAccount.findMany({
          where: { buildingId: lease.buildingId },
          select: { utility: true, provider: true },
        }),
      ),
    ]);
    let idNumber = '-';
    if (party.idNumberEnc && options.revealIdNumber === false) idNumber = MASKED_ID_NUMBER;
    else if (party.idNumberEnc) {
      idNumber = await this.keys.decrypt(
        tx,
        { tenantId: lease.tenantId, table: 'core.party', column: 'id_number', rowId: party.id },
        party.idNumberEnc,
      );
      await this.audit.record(tx, {
        action: 'pii.decrypted',
        tenantId: lease.tenantId,
        subjectType: 'core.party',
        subjectId: party.id,
        metadata: {
          field: 'id_number',
          purpose: options.draft ? 'contract_preview' : 'contract_render',
          leaseId: lease.id,
        },
      });
    }
    const [depositCap, leadDays, refundDays, stampDutyAmount] = await Promise.all([
      this.settings.valueAt<string>('deposit.max_months_short', now, { tenantId: lease.tenantId }),
      this.settings.valueAt<number>('invoice.min_lead_days', now, { tenantId: lease.tenantId }),
      this.settings.valueAt<number>('deposit.refund_days', now, { tenantId: lease.tenantId }),
      options.stampDutyAmount ?? this.stampDutyAmount(lease),
    ]);
    const electric = accounts.find((a) => a.utility === 'electric')?.provider;
    const water = accounts.find((a) => a.utility === 'water')?.provider;
    const increases = ((lease.rentIncreaseRecorded ?? []) as { effectiveFrom: string; rent: string }[]).map(
      (r) => ({
        effectiveFrom: thaiDate(r.effectiveFrom),
        amount: formatThb(r.rent),
        text: bahtText(r.rent),
        effectiveFromEn: englishDate(r.effectiveFrom),
        textEn: bahtTextEn(r.rent),
      }),
    );
    const data: ContractData = {
      draft: options.draft,
      contract: {
        number: options.number,
        madeAt: unit.building.property.name,
        madeOn: thaiDate(options.madeOn ?? bangkokDate(now)),
      },
      lessor: {
        legalName: tenant.legalName,
        taxId: tenant.taxId,
        address: addressText(tenant.address) || addressText(unit.building.property.address),
      },
      lessee: {
        displayName: party.displayName,
        idDocumentLabel: ID_LABEL[party.idDocumentType ?? 'other']!,
        idNumber,
        nationality: party.nationality,
        address: party.address ? addressText(party.address) || null : null,
        phone: party.phoneE164,
      },
      coTenants: lease.parties
        .filter((p) => p.role === 'co_tenant')
        .map((p) => ({ displayName: p.party.displayName })),
      premises: {
        unitNo: unit.unitNo,
        floorName: unit.floor?.name ?? '',
        buildingName: unit.building.name,
        propertyName: unit.building.property.name,
        address: addressText(unit.building.address) || addressText(unit.building.property.address),
        areaSqm: unit.areaSqm ? unit.areaSqm.toFixed(2) : null,
        equipment: equipment.map((e) => ({ name: e.name, location: e.location })),
        keysCount: lease.keysCount,
        parkingSlots: lease.parkingSlots,
      },
      term: {
        months: lease.months,
        startDate: thaiDate(lease.startDate.toISOString().slice(0, 10)),
        endDate: thaiDate(lease.endDate.toISOString().slice(0, 10)),
      },
      rent: {
        amount: formatThb(lease.rent.toString()),
        text: bahtText(lease.rent.toString()),
        dueDay: lease.billingDay ? String(lease.billingDay) : '5',
      },
      rentIncreases: increases,
      utilities: {
        metered: lease.utilityBillingMode === 'metered',
        electricProvider: electric ? PROVIDER_TH[electric]! : 'การไฟฟ้า',
        waterProvider: water ? PROVIDER_TH[water]! : 'การประปา',
      },
      lines: lease.lines.map((l) => ({
        description: l.description,
        amount: formatThb(l.amount.toString()),
        recurrence: RECURRENCE_TH[l.recurrence]!,
        recurrenceEn: RECURRENCE_EN[l.recurrence]!,
      })),
      deposit: {
        amount: formatThb(lease.depositAmount.toString()),
        text: bahtText(lease.depositAmount.toString()),
      },
      advanceRent: {
        amount: formatThb(lease.advanceRentAmount.toString()),
        text: bahtText(lease.advanceRentAmount.toString()),
      },
      depositCapMonths: String(depositCap),
      invoiceLeadDays: Number(leadDays),
      refundDays: Number(refundDays),
      noticeDays: LESSEE_NOTICE_DAYS,
      remedyDays: LESSOR_REMEDY_DAYS,
      disturbanceDays: LESSOR_DISTURBANCE_DAYS,
      addendum: ((lease.addendum ?? []) as unknown as AddendumInput[]).map((a) => ({
        title: a.title,
        text: a.text,
      })),
      signatures: options.signatures ?? { lessor: null, lessee: null },
      template: { key: version.template.key, version: version.version, legalRef: version.legalRef },
      en: {
        madeOn: englishDate(options.madeOn ?? bangkokDate(now)),
        startDate: englishDate(lease.startDate.toISOString().slice(0, 10)),
        endDate: englishDate(lease.endDate.toISOString().slice(0, 10)),
        rentText: bahtTextEn(lease.rent.toString()),
        depositText: bahtTextEn(lease.depositAmount.toString()),
        advanceText: bahtTextEn(lease.advanceRentAmount.toString()),
        idDocumentLabel: ID_LABEL_EN[party.idDocumentType ?? 'other']!,
        electricProvider: electric ? PROVIDER_EN[electric]! : 'the electricity authority',
        waterProvider: water ? PROVIDER_EN[water]! : 'the waterworks authority',
      },
      stampDuty: {
        amount: formatThb(stampDutyAmount),
        text: bahtText(stampDutyAmount),
        textEn: bahtTextEn(stampDutyAmount),
        payer: lease.stampDutyPayer,
        payerTh: STAMP_DUTY_PAYER_TH[lease.stampDutyPayer],
        payerEn: STAMP_DUTY_PAYER_EN[lease.stampDutyPayer],
      },
    };
    if (lease.bilingual) {
      // Thai first (it prevails), then the English text of the same template, in one document and one hash
      const [th, en] = await Promise.all([
        this.publishedVersion(version.templateId, 'th', version),
        this.publishedVersion(version.templateId, 'en', version),
      ]);
      if (th && en)
        return {
          data,
          body: `${th.bodyHtml}\n<div class="page-break"></div>\n${en.bodyHtml}`,
          language: 'th',
        };
    }
    return { data, body: version.bodyHtml, language: version.language === 'en' ? 'en' : 'th' };
  }

  /** The template version in a language: the lease's own when it matches, else the latest published one. */
  private async publishedVersion(
    templateId: string,
    language: ContractLanguage,
    own: { language: string; bodyHtml: string },
  ): Promise<{ bodyHtml: string } | null> {
    if (own.language === language) return own;
    return this.db.platform((tx) =>
      tx.leaseTemplateVersion.findFirst({
        where: { templateId, language, state: 'published' },
        orderBy: { version: 'desc' },
        select: { bodyHtml: true },
      }),
    );
  }

  /** A bilingual lease needs its template published in Thai and English (the landlord templates, B7.5). */
  private async assertBilingual(templateId: string): Promise<void> {
    const languages = await this.db.platform((tx) =>
      tx.leaseTemplateVersion.findMany({
        where: { templateId, state: 'published' },
        select: { language: true },
        distinct: ['language'],
      }),
    );
    const set = new Set(languages.map((l) => l.language));
    if (!set.has('th') || !set.has('en'))
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'bilingual',
            code: 'unavailable',
            message: 'this contract template is not published in Thai and English',
          },
        ],
      });
  }

  /**
   * Stamp duty of a lease (B7.5, O-019): the amount fixed at send-for-signature, else computed now from the rent over
   * the term and `lease.stamp_duty.baht_per_thousand`.
   */
  async stampDutyAmount(
    lease: Pick<
      Lease,
      'tenantId' | 'rent' | 'startDate' | 'months' | 'rentIncreaseRecorded' | 'stampDutyAmount'
    >,
  ): Promise<string> {
    if (lease.stampDutyAmount) return lease.stampDutyAmount.toFixed(2);
    const rate = await this.settings.valueAt<string>('lease.stamp_duty.baht_per_thousand', this.clock.now(), {
      tenantId: lease.tenantId,
    });
    const total = rentOverTerm(
      lease.rent.toFixed(2),
      lease.startDate.toISOString().slice(0, 10),
      lease.months,
      (lease.rentIncreaseRecorded ?? []) as { effectiveFrom: string; rent: string }[],
    );
    return stampDutyFor(total, rate);
  }

  /** Draft PDF for review (not stored, marked ร่าง). */
  previewPdf(ctx: TenantContext, id: string): Promise<Buffer> {
    return this.db.tenant(
      ctx,
      async (tx) => {
        const lease = await this.load(tx, id);
        const { data, body, language } = await this.contractData(tx, lease, {
          draft: lease.status === 'draft',
          number: lease.number,
          revealIdNumber: RequestContext.permissions().has(PII_DECRYPT),
        });
        return (await this.renderer.render(body, data, language)).pdf;
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Send for signature (D-062): final compliance check, lessee identity on file, the contract number from the
   * `contract` series, the contract PDF stored (`core.document` kind contract) with its sha256 — the hash the
   * residents sign — and the unit reserved for this lease.
   */
  async sendForSignature(ctx: TenantContext, id: string): Promise<LeaseRow> {
    const current = await this.db.tenant(ctx, (tx) => this.ownLease(tx, ctx, id));
    this.assertStatus(current, ['draft']);
    if (!current.lessee.idDocumentType || !current.lessee.idNumberEnc)
      throw new DomainException('lease.lessee_identity_missing');
    const acks = (current.complianceSnapshot as { acknowledgementIds?: string[] }).acknowledgementIds ?? [];
    const gate = await this.checkTerms(
      ctx,
      id,
      current.buildingId,
      {
        rent: current.rent.toFixed(2),
        depositAmount: current.depositAmount.toFixed(2),
        advanceRentAmount: current.advanceRentAmount.toFixed(2),
        months: current.months,
        startDate: current.startDate.toISOString().slice(0, 10),
        endDate: current.endDate.toISOString().slice(0, 10),
        utilityBillingMode: current.utilityBillingMode,
        lines: current.lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          amount: l.amount.toFixed(2),
        })),
        addendum: (current.addendum ?? []) as unknown as AddendumInput[],
        rentIncreases: (current.rentIncreaseRecorded ?? []) as unknown as {
          effectiveFrom: string;
          rent: string;
        }[],
        isRenewal: current.renewedFromLeaseId !== null,
      },
      acks,
    );
    return this.db.tenant(
      ctx,
      async (tx) => {
        const lease = await this.ownLease(tx, ctx, id);
        this.assertStatus(lease, ['draft']);
        const now = this.clock.now();
        const number = await this.numbering.next(tx, lease.tenantId, 'contract', now);
        const stampDutyAmount = await this.stampDutyAmount(lease);
        const { data, body, language } = await this.contractData(tx, lease, {
          draft: false,
          number,
          stampDutyAmount,
        });
        const rendered = await this.renderer.render(body, data, language);
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: lease.tenantId,
          kind: 'contract',
          scopeType: 'unit',
          scopeId: lease.unitId,
          buildingId: lease.buildingId,
          title: `สัญญาเช่า ${number} (รอลงนาม).pdf`,
          mimeType: 'application/pdf',
          body: rendered.pdf,
        });
        await tx.lease.update({
          where: { id },
          data: {
            status: 'pending_signature',
            number,
            sentForSignatureAt: now,
            stampDutyAmount,
            contractDocumentId: doc.id,
            contractSha256: new Uint8Array(rendered.sha256),
            complianceSnapshot: { ...gate, acknowledgementIds: acks, contentSha256: rendered.contentSha256 },
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        if (await this.unitRowsWritable(tx, lease)) {
          if (lease.unit.status === 'vacant')
            await tx.unit.updateMany({
              where: { id: lease.unitId },
              data: { status: 'reserved', statusChangedAt: now, version: { increment: 1 } },
            });
          // a renewal waits behind the lease in force: the unit keeps showing that one until it ends
          await tx.unitDetail.updateMany({
            where: { unitId: lease.unitId, currentLeaseId: null },
            data: { currentLeaseId: id },
          });
        }
        await this.audit.record(tx, {
          action: 'lease.sent_for_signature',
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          subjectType: 'ops.lease',
          subjectId: id,
          metadata: { number, documentId: doc.id, sha256: rendered.sha256.toString('hex') },
        });
        await this.history(
          tx,
          lease,
          'sent_for_signature',
          { number, documentId: doc.id, sha256: rendered.sha256.toString('hex') },
          'lease.sent_for_signature',
        );
        return this.load(tx, id);
      },
      { timeout: 60_000 },
    );
  }

  /**
   * The lessor countersigns once every lessee signer has signed (D-062): the lessor's drawn signature is stored, the
   * final PDF with both signatures and the content hash in the footer is rendered and stored as a new version of the
   * contract, and the lease is **activated** in the same transaction — occupancies for the lessee (role `tenant`),
   * co-tenants and occupants from the start date, the unit occupied (reserved until a future start date), the
   * unit's current lease, and the B2.4 deposit.
   */
  async countersign(ctx: TenantContext, id: string, input: { signaturePng: Buffer }): Promise<LeaseRow> {
    const userId = by();
    if (!userId) throw new DomainException('auth.unauthenticated');
    try {
      return await this.db.tenant(
        ctx,
        async (tx) => {
          const lease = await this.ownLease(tx, ctx, id);
          this.assertStatus(lease, ['pending_signature']);
          const signers = lease.parties.filter((p) => p.isSigner);
          const signed = new Set(
            lease.signatures.filter((s) => s.signerRole !== 'lessor').map((s) => s.partyId),
          );
          if (signers.some((s) => !signed.has(s.partyId)))
            throw new DomainException('lease.signatures_missing');
          const now = this.clock.now();
          const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: lease.tenantId } });
          const image = await this.documents.storeGenerated(tx, {
            tenantId: lease.tenantId,
            kind: 'signature',
            scopeType: 'unit',
            scopeId: lease.unitId,
            buildingId: lease.buildingId,
            title: `ลายมือชื่อผู้ให้เช่า ${lease.number}.png`,
            mimeType: 'image/png',
            body: input.signaturePng,
            retentionClass: 'contract',
          });
          const request = RequestContext.current();
          await tx.leaseSignature.create({
            data: {
              tenantId: lease.tenantId,
              leaseId: id,
              signerRole: 'lessor',
              partyId: tenant.legalPartyId,
              userId,
              method: 'draw_web',
              signatureImageDocumentId: image.id,
              pdfSha256: new Uint8Array(lease.contractSha256!),
              signedAt: now,
              ip: request?.ip ?? null,
              userAgent: request?.userAgent ?? null,
              createdBy: userId,
            },
          });
          const lesseeSig = lease.signatures.find(
            (s) => s.signerRole === 'lessee' && s.partyId === lease.lesseePartyId,
          );
          const lesseeImage = lesseeSig
            ? await this.documents.bytesOf(
                await tx.document.findUniqueOrThrow({ where: { id: lesseeSig.signatureImageDocumentId } }),
              )
            : null;
          const madeOn = bangkokDate(lease.sentForSignatureAt ?? now);
          const { data, body, language } = await this.contractData(tx, lease, {
            draft: false,
            number: lease.number,
            madeOn,
            signatures: {
              lessor: {
                signedAt: thaiDate(bangkokDate(now)),
                signedAtEn: englishDate(bangkokDate(now)),
                imageDataUrl: `data:image/png;base64,${input.signaturePng.toString('base64')}`,
              },
              lessee:
                lesseeSig && lesseeImage
                  ? {
                      signedAt: thaiDate(bangkokDate(lesseeSig.signedAt)),
                      signedAtEn: englishDate(bangkokDate(lesseeSig.signedAt)),
                      imageDataUrl: `data:image/png;base64,${lesseeImage.toString('base64')}`,
                    }
                  : null,
            },
          });
          const rendered = await this.renderer.render(body, data, language);
          const signedDoc = await this.documents.storeGenerated(tx, {
            tenantId: lease.tenantId,
            kind: 'contract',
            scopeType: 'unit',
            scopeId: lease.unitId,
            buildingId: lease.buildingId,
            title: `สัญญาเช่า ${lease.number}.pdf`,
            mimeType: 'application/pdf',
            body: rendered.pdf,
            versionOfDocumentId: lease.contractDocumentId,
          });
          await tx.leaseSignature.updateMany({
            where: { leaseId: id },
            data: { signedPdfDocumentId: signedDoc.id },
          });
          await tx.lease.update({
            where: { id },
            data: {
              signedDocumentId: signedDoc.id,
              contractSha256: new Uint8Array(rendered.sha256),
              updatedBy: userId,
              version: { increment: 1 },
            },
          });
          await this.audit.record(tx, {
            action: 'lease.countersigned',
            tenantId: lease.tenantId,
            buildingId: lease.buildingId,
            subjectType: 'ops.lease',
            subjectId: id,
            metadata: { signedDocumentId: signedDoc.id, sha256: rendered.sha256.toString('hex') },
          });
          await this.activate(tx, lease, now, signedDoc.id, rendered.sha256);
          return this.load(tx, id);
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      if (isExclusionViolation(error)) throw new DomainException('lease.overlap');
      throw error;
    }
  }

  private async activate(tx: Tx, lease: LeaseRow, now: Date, signedDocumentId: string, sha256: Buffer) {
    const start = lease.startDate.toISOString().slice(0, 10);
    const started = start <= this.today();
    await tx.lease.update({
      where: { id: lease.id },
      data: { status: 'active', activatedAt: now, moveInAt: started ? now : null, version: { increment: 1 } },
    });
    const roleOf: Record<LeasePartyRole, 'tenant' | 'co_tenant' | 'family' | null> = {
      lessee: 'tenant',
      co_tenant: 'co_tenant',
      occupant: 'family',
      guarantor: null,
    };
    for (const p of lease.parties) {
      const role = roleOf[p.role];
      if (!role) continue;
      await tx.occupancy.create({
        data: {
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          unitId: lease.unitId,
          partyId: p.partyId,
          role,
          leaseId: lease.id,
          validFrom: lease.startDate,
          movedInAt: started ? now : null,
          createdBy: by(),
        },
      });
    }
    // A renewal activated before its start keeps the lease in force as the unit's current lease (unit stays occupied).
    const inForceBefore = await tx.lease.count({
      where: { unitId: lease.unitId, id: { not: lease.id }, status: { in: IN_FORCE } },
    });
    if ((started || inForceBefore === 0) && (await this.unitRowsWritable(tx, lease))) {
      await tx.unit.updateMany({
        where: { id: lease.unitId },
        data: { status: started ? 'occupied' : 'reserved', statusChangedAt: now, version: { increment: 1 } },
      });
      await tx.unitDetail.updateMany({
        where: { unitId: lease.unitId },
        data: { currentLeaseId: lease.id, statusReason: null },
      });
    }
    const fresh = await tx.lease.findUniqueOrThrow({ where: { id: lease.id } });
    for (const hook of this.afterActivation) await hook(tx, fresh);
    await this.history(
      tx,
      lease,
      'activated',
      { signedDocumentId, sha256: sha256.toString('hex'), occupied: started },
      'lease.activated',
    );
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<LeaseRow> {
    return this.db.tenant(ctx, async (tx) => {
      const lease = await this.ownLease(tx, ctx, id);
      this.assertStatus(lease, ['draft', 'pending_signature']);
      const now = this.clock.now();
      await tx.lease.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (await this.unitRowsWritable(tx, lease)) {
        const inForce = await tx.lease.count({
          where: { unitId: lease.unitId, id: { not: id }, status: { in: IN_FORCE } },
        });
        if (lease.status === 'pending_signature' && lease.unit.status === 'reserved' && inForce === 0)
          await tx.unit.updateMany({
            where: { id: lease.unitId },
            data: { status: 'vacant', statusChangedAt: now, version: { increment: 1 } },
          });
        await tx.unitDetail.updateMany({
          where: { unitId: lease.unitId, currentLeaseId: id },
          data: { currentLeaseId: null },
        });
      }
      await tx.invitation.updateMany({
        where: { leaseId: id, state: 'pending' },
        data: { state: 'revoked' },
      });
      await this.audit.record(tx, {
        action: 'lease.cancelled',
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        subjectType: 'ops.lease',
        subjectId: id,
        metadata: { reason },
      });
      await this.history(tx, lease, 'cancelled', { reason }, 'lease.cancelled');
      return this.load(tx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- notices & end

  /**
   * A notice recorded by the office (D-020): the lessee's written notice (≥ 30 days, `compliance.notice_period`) or
   * the lessor's (ground + notice period + evidence, `compliance.termination_notice`). Both rules are warnings by
   * default: a shorter period needs the Owner's acknowledgement (409 → acknowledge → repeat).
   */
  async recordNotice(
    ctx: TenantContext,
    id: string,
    input: {
      by: 'lessee' | 'lessor';
      noticeDate?: string;
      effectiveDate: string;
      reasonCode?: string;
      evidenceDocumentIds?: string[];
      acknowledgementIds?: string[];
      /** Free text from the lessee (LIFF), kept in the lease history only. */
      note?: string | null;
    },
    options: { refuseWarnings?: boolean } = {},
  ): Promise<LeaseRow> {
    const lease = await this.db.tenant(ctx, (tx) => this.ownLease(tx, ctx, id));
    this.assertStatus(lease, ['active']);
    const noticeDate = input.noticeDate ?? this.today();
    const endDate = lease.endDate.toISOString().slice(0, 10);
    if (input.effectiveDate > endDate || input.effectiveDate <= noticeDate)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'effectiveDate',
            code: 'range',
            message: `between the notice date and the end of the lease (${endDate})`,
          },
        ],
      });
    const evidence = await this.evidence(ctx, input.evidenceDocumentIds ?? []);
    let check: RuleCheck;
    if (input.by === 'lessee') check = checkLesseeNotice(noticeDate, input.effectiveDate);
    else {
      const reason = (input.reasonCode ?? '') as LessorReason;
      if (
        !['lessee_breach', 'disturbance', 'end_of_term', 'mutual_agreement', 'unlawful_use'].includes(reason)
      )
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'reasonCode',
              code: 'isIn',
              message: 'a lessor notice needs a legal ground (reasonCode)',
            },
          ],
        });
      check = checkLessorNotice(reason, noticeDate, input.effectiveDate, evidence.length, endDate);
    }
    await this.gate.enforce(ctx, {
      subjectType: 'ops.lease',
      subjectId: id,
      buildingId: lease.buildingId,
      checks: [check],
      acknowledgementIds: input.acknowledgementIds,
      refuseWarnings: options.refuseWarnings,
    });
    return this.db.tenant(ctx, async (tx) => {
      const fresh = await this.ownLease(tx, ctx, id);
      this.assertStatus(fresh, ['active']);
      const now = this.clock.now();
      await tx.lease.update({
        where: { id },
        data: {
          status: 'notice_given',
          noticeGivenAt: now,
          noticeBy: input.by,
          noticeReasonCode: input.reasonCode ?? (input.by === 'lessee' ? 'lessee_notice' : null),
          noticeEffectiveDate: new Date(input.effectiveDate),
          noticeEvidenceDocumentIds: evidence,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'lease.notice_given',
        tenantId: fresh.tenantId,
        buildingId: fresh.buildingId,
        subjectType: 'ops.lease',
        subjectId: id,
        metadata: {
          by: input.by,
          noticeDate,
          effectiveDate: input.effectiveDate,
          reasonCode: input.reasonCode ?? null,
        },
      });
      await this.history(
        tx,
        fresh,
        'notice_given',
        {
          by: input.by,
          noticeDate,
          effectiveDate: input.effectiveDate,
          reasonCode: input.reasonCode ?? null,
          ...(input.note ? { note: input.note } : {}),
        },
        'lease.notice_given',
      );
      return this.load(tx, id);
    });
  }

  /** Evidence documents must be files of the tenant (any kind: scanned letters, photos). */
  private async evidence(ctx: TenantContext, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const found = await this.db.tenant(ctx, (tx) =>
      tx.document.count({
        where: this.own(ctx, { id: { in: unique }, deletedAt: null, uploadState: { not: 'presigned' } }),
      }),
    );
    if (found !== unique.length) throw new DomainException('http.not_found');
    return unique;
  }

  /** Move-out phase (`ending`): the lease reached its notice date or end, or the office starts it. */
  async beginMoveOut(ctx: TenantContext, id: string): Promise<LeaseRow> {
    return this.db.tenant(ctx, async (tx) => {
      const lease = await this.ownLease(tx, ctx, id);
      this.assertStatus(lease, ['active', 'notice_given']);
      await this.toEnding(tx, lease, 'office');
      return this.load(tx, id);
    });
  }

  private async toEnding(tx: Tx, lease: Lease, trigger: 'office' | 'notice_date' | 'end_date') {
    await tx.lease.update({
      where: { id: lease.id },
      data: { status: 'ending', updatedBy: by(), version: { increment: 1 } },
    });
    await this.history(tx, lease, 'move_out_started', { trigger }, 'lease.move_out_started');
  }

  /**
   * Move-out done (`ended`): occupancies closed on the move-out date, the unit vacant, the current lease cleared, and
   * the deposit settlement opened with its 7-day clock (B2.4, D-023).
   */
  async completeMoveOut(ctx: TenantContext, id: string, input: { moveOutAt?: string }): Promise<LeaseRow> {
    return this.db.tenant(ctx, async (tx) => {
      const lease = await this.ownLease(tx, ctx, id);
      this.assertStatus(lease, ['ending']);
      const now = this.clock.now();
      const moveOutAt = input.moveOutAt ? new Date(input.moveOutAt) : now;
      if (moveOutAt.getTime() > now.getTime() + 60_000)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'moveOutAt', code: 'max', message: 'move-out cannot be in the future' }],
        });
      // a termination scheduled for a later date (D-219) closes as `terminated` once the move-out is done
      const scheduled = Boolean(lease.terminationReasonCode && !lease.terminatedAt);
      await this.close(
        tx,
        lease,
        scheduled ? 'terminated' : 'ended',
        moveOutAt,
        scheduled ? { terminatedAt: now } : {},
      );
      return this.load(tx, id);
    });
  }

  private async close(
    tx: Tx,
    lease: Lease,
    status: 'ended' | 'terminated',
    moveOutAt: Date,
    extra: Prisma.LeaseUncheckedUpdateInput,
  ) {
    const now = this.clock.now();
    const day = bangkokDate(moveOutAt);
    await tx.lease.update({
      where: { id: lease.id },
      data: {
        status,
        moveOutAt,
        endedAt: now,
        ...extra,
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    const occupancies = await tx.occupancy.findMany({ where: { leaseId: lease.id, validTo: null } });
    for (const o of occupancies)
      await tx.occupancy.update({
        where: { id: o.id },
        // the period ends on the move-out day; a lease ended on (or before) its first day keeps a one-day period
        // (valid_to > valid_from, exclusion ranges cannot be empty)
        data: {
          validTo: new Date(
            day > o.validFrom.toISOString().slice(0, 10) ? day : o.validFrom.getTime() + 86_400_000,
          ),
          movedOutAt: moveOutAt,
          updatedBy: by(),
        },
      });
    // The next lease on the unit (an activated renewal) takes over; otherwise the unit is vacant.
    const next = await tx.lease.findFirst({
      where: { unitId: lease.unitId, id: { not: lease.id }, status: 'active' },
      orderBy: { startDate: 'asc' },
    });
    const nextStarted = next ? next.startDate.toISOString().slice(0, 10) <= this.today() : false;
    if (await this.unitRowsWritable(tx, lease)) {
      await tx.unit.updateMany({
        where: { id: lease.unitId },
        data: {
          status: next ? (nextStarted ? 'occupied' : 'reserved') : 'vacant',
          statusChangedAt: now,
          version: { increment: 1 },
        },
      });
      await tx.unitDetail.updateMany({
        where: { unitId: lease.unitId, currentLeaseId: lease.id },
        data: { currentLeaseId: next?.id ?? null },
      });
    }
    const fresh = await tx.lease.findUniqueOrThrow({ where: { id: lease.id } });
    for (const hook of this.afterEnd) await hook(tx, fresh, moveOutAt);
    await this.audit.record(tx, {
      action: status === 'ended' ? 'lease.ended' : 'lease.terminated',
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.lease',
      subjectId: lease.id,
      metadata: { moveOutAt: moveOutAt.toISOString(), occupanciesClosed: occupancies.length },
    });
    await this.history(
      tx,
      lease,
      status,
      { moveOutAt: moveOutAt.toISOString() },
      status === 'ended' ? 'lease.ended' : 'lease.terminated',
    );
  }

  /**
   * Termination with a ground and evidence (D-020): the lessor's grounds follow `compliance.termination_notice`
   * (30-day remedy / 7-day warning, evidence on file); `lessee_notice` closes a lease the lessee gave notice for.
   */
  async terminate(
    ctx: TenantContext,
    id: string,
    input: {
      reasonCode: string;
      effectiveDate: string;
      noticeDate?: string;
      notes?: string | null;
      evidenceDocumentIds?: string[];
      acknowledgementIds?: string[];
    },
  ): Promise<LeaseRow> {
    const lease = await this.db.tenant(ctx, (tx) => this.ownLease(tx, ctx, id));
    this.assertStatus(lease, ['active', 'notice_given', 'ending']);
    const evidence = await this.evidence(ctx, input.evidenceDocumentIds ?? []);
    const endDate = lease.endDate.toISOString().slice(0, 10);
    if (input.reasonCode !== 'lessee_notice') {
      if (
        !['lessee_breach', 'disturbance', 'end_of_term', 'mutual_agreement', 'unlawful_use'].includes(
          input.reasonCode,
        )
      )
        throw new DomainException('validation.failed', {
          errors: [{ path: 'reasonCode', code: 'isIn', message: 'unknown termination ground' }],
        });
      const noticeDate =
        input.noticeDate ??
        (lease.noticeBy === 'lessor' && lease.noticeGivenAt
          ? bangkokDate(lease.noticeGivenAt)
          : this.today());
      await this.gate.enforce(ctx, {
        subjectType: 'ops.lease',
        subjectId: id,
        buildingId: lease.buildingId,
        checks: [
          checkLessorNotice(
            input.reasonCode as LessorReason,
            noticeDate,
            input.effectiveDate,
            evidence.length,
            endDate,
          ),
        ],
        acknowledgementIds: input.acknowledgementIds,
      });
    } else if (lease.noticeBy !== 'lessee') {
      throw new DomainException('validation.failed', {
        errors: [{ path: 'reasonCode', code: 'noNotice', message: 'the lessee gave no notice' }],
      });
    }
    return this.db.tenant(ctx, async (tx) => {
      const fresh = await this.ownLease(tx, ctx, id);
      this.assertStatus(fresh, ['active', 'notice_given', 'ending']);
      // Review #1 (D-024, D-071, D-176, D-219): a termination effective later is recorded as the lessor's notice; the
      // lease stays in force — occupancy, unit, door codes and deposit clock untouched — until the hourly lifecycle
      // sweep starts the move-out on the effective date and the office completes it (then `terminated`).
      if (input.effectiveDate > this.today()) {
        await this.scheduleTermination(tx, fresh, input, evidence);
        return this.load(tx, id);
      }
      const effective = new Date(`${input.effectiveDate}T00:00:00+07:00`);
      const moveOutAt = effective.getTime() < this.clock.now().getTime() ? effective : this.clock.now();
      await this.close(tx, fresh, 'terminated', moveOutAt, {
        terminatedAt: this.clock.now(),
        terminationReasonCode: input.reasonCode,
        terminationNotes: input.notes ?? null,
        terminationEvidenceDocumentIds: evidence,
      });
      return this.load(tx, id);
    });
  }

  /**
   * A termination with a future effective date (D-219): the lessor's notice (`notice_given`, `noticeBy = lessor`, the
   * ground, the effective date and the evidence) plus the termination ground kept for the close; `terminatedAt` stays
   * empty until the move-out completes. A lease already in its move-out phase keeps `ending`.
   */
  private async scheduleTermination(
    tx: Tx,
    lease: LeaseRow,
    input: { reasonCode: string; effectiveDate: string; notes?: string | null },
    evidence: string[],
  ): Promise<void> {
    const now = this.clock.now();
    const endDate = lease.endDate.toISOString().slice(0, 10);
    if (input.effectiveDate > endDate)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'effectiveDate',
            code: 'range',
            message: `a termination takes effect at the latest at the end of the lease (${endDate})`,
          },
        ],
      });
    await tx.lease.update({
      where: { id: lease.id },
      data: {
        ...(lease.status === 'ending' ? {} : { status: 'notice_given' as const }),
        noticeGivenAt: now,
        noticeBy: 'lessor',
        noticeReasonCode: input.reasonCode,
        noticeEffectiveDate: new Date(input.effectiveDate),
        noticeEvidenceDocumentIds: evidence,
        terminationReasonCode: input.reasonCode,
        terminationNotes: input.notes ?? null,
        terminationEvidenceDocumentIds: evidence,
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    const data = {
      by: 'lessor',
      noticeDate: this.today(),
      effectiveDate: input.effectiveDate,
      reasonCode: input.reasonCode,
      termination: true,
    };
    await this.audit.record(tx, {
      action: 'lease.termination_scheduled',
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.lease',
      subjectId: lease.id,
      metadata: data,
    });
    await this.history(tx, lease, 'notice_given', data, 'lease.notice_given');
  }

  /** Renewal = a new draft from the old lease, starting the day after it ends (no renewal fee, D-020). */
  async renew(
    ctx: TenantContext,
    id: string,
    input: { months?: number; rent?: string; acknowledgementIds?: string[] },
  ): Promise<LeaseRow> {
    const old = await this.db.tenant(ctx, (tx) => this.ownLease(tx, ctx, id));
    this.assertStatus(old, ['active', 'notice_given', 'ending']);
    const start = new Date(old.endDate.getTime() + 86_400_000).toISOString().slice(0, 10);
    return this.createDraft(
      ctx,
      {
        unitId: old.unitId,
        lesseePartyId: old.lesseePartyId,
        coTenantPartyIds: old.parties.filter((p) => p.role === 'co_tenant').map((p) => p.partyId),
        guarantorPartyIds: old.parties.filter((p) => p.role === 'guarantor').map((p) => p.partyId),
        occupantPartyIds: old.parties.filter((p) => p.role === 'occupant').map((p) => p.partyId),
        startDate: start,
        months: input.months ?? old.months,
        rent: input.rent ?? old.rent.toFixed(2),
        depositAmount: old.depositAmount.toFixed(2),
        advanceRentAmount: '0',
        billingDay: old.billingDay,
        utilityBillingMode: old.utilityBillingMode,
        keysCount: old.keysCount,
        parkingSlots: old.parkingSlots,
        lines: old.lines
          .filter((l) => l.recurrence === 'monthly')
          .map((l) => ({
            kind: l.kind,
            description: l.description,
            amount: l.amount.toFixed(2),
            recurrence: l.recurrence,
          })),
        addendum: (old.addendum ?? []) as unknown as AddendumInput[],
        terms: { ...(old.terms as Record<string, unknown>), depositCarriedOverFrom: old.id },
        acknowledgementIds: input.acknowledgementIds,
        language: old.templateVersion.language === 'en' ? 'en' : 'th',
        stampDutyPayer: old.stampDutyPayer,
        bilingual: old.bilingual,
      },
      old.id,
    );
  }

  /** Signed download URL of the latest contract PDF (signed when available), audited (`document.downloaded`). */
  async contract(ctx: TenantContext, id: string) {
    const lease = await this.get(ctx, id);
    const documentId = lease.signedDocumentId ?? lease.contractDocumentId;
    if (!documentId) throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    return { lease, download: await this.documents.download(ctx, documentId, 'lease_contract') };
  }

  /**
   * Worker sweep (hourly, all tenants as gp_platform): a reserved unit becomes occupied on the lease start date; a
   * notice reaching its effective date, or a lease reaching its end date without notice, enters the move-out phase.
   */
  async sweep(): Promise<number> {
    const today = this.today();
    return this.db.platform(async (tx) => {
      let changed = 0;
      const starting = await tx.lease.findMany({
        where: { status: 'active', startDate: { lte: new Date(today) }, moveInAt: null },
      });
      for (const l of starting) {
        if (await this.unitRowsWritable(tx, l))
          await tx.unit.updateMany({
            where: { id: l.unitId, status: 'reserved' },
            data: { status: 'occupied', statusChangedAt: this.clock.now(), version: { increment: 1 } },
          });
        await tx.occupancy.updateMany({
          where: { leaseId: l.id, movedInAt: null },
          data: { movedInAt: this.clock.now() },
        });
        await tx.lease.update({
          where: { id: l.id },
          data: { moveInAt: this.clock.now(), version: { increment: 1 } },
        });
        await this.history(tx, l, 'moved_in', { trigger: 'start_date' }, 'lease.moved_in');
        changed += 1;
      }
      const due = await tx.lease.findMany({
        where: {
          OR: [
            { status: 'notice_given', noticeEffectiveDate: { lte: new Date(today) } },
            { status: 'active', endDate: { lt: new Date(today) } },
          ],
        },
      });
      for (const l of due) {
        await this.toEnding(tx, l, l.status === 'notice_given' ? 'notice_date' : 'end_date');
        changed += 1;
      }
      return changed;
    });
  }

  /** sha256 helper for tests and the resident contract view. */
  static hex(bytes: Uint8Array | null | undefined): string | null {
    return bytes ? Buffer.from(bytes).toString('hex') : null;
  }

  static sha256(body: Buffer): string {
    return createHash('sha256').update(body).digest('hex');
  }
}
