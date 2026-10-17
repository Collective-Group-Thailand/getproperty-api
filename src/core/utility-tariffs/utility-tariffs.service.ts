import { InvalidationBus } from '@common/cache/invalidation-bus';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import {
  type Prisma,
  type TariffVersionState,
  type Utility,
  type UtilityProvider,
  type UtilityTariff,
  type UtilityTariffVersion,
} from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../events/domain-events';
import { type TariffCharge, utilityCharge } from './tariff-math';
import { type UtilityTariffStructure, validateTariffStructure } from './tariff-structure';

/** Versions that can be in force: published, or superseded for the dates before their successor. */
const IN_FORCE: TariffVersionState[] = ['published', 'superseded'];
export const TARIFFS_TOPIC = 'utility_tariffs';

export interface TariffAt {
  tariff: UtilityTariff;
  version: UtilityTariffVersion;
  structure: UtilityTariffStructure;
  /** Effective average rate for `units` (D-140) when units were given. */
  charge: TariffCharge | null;
}

const dayOf = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Utility tariffs — the สคบ. 2568 cap reference (D-021, D-021a, D-140; ADR-0004). Platform-level versioned rows:
 * a platform user **enters** a version, a **different** platform user **verifies** it (maker-checker, the database
 * CHECK backs it), then it is **published**; publishing closes the version it supersedes. Only published versions
 * (or superseded ones for the dates they covered) are the cap reference; `at()` and `current()` return the
 * structure and the effective average rate computed by the existing tariff math.
 */
@Injectable()
export class UtilityTariffsService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly bus: InvalidationBus,
  ) {}

  /** The version of `provider`/`tariffCode` in force on `date` (published or superseded). */
  async at(
    provider: UtilityProvider,
    tariffCode: string,
    date: Date,
    units?: Decimal.Value,
  ): Promise<TariffAt | null> {
    const day = dayOf(date);
    const version = await this.db.platform((tx) =>
      tx.utilityTariffVersion.findFirst({
        where: {
          state: { in: IN_FORCE },
          effectiveFrom: { lte: day },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
          utilityTariff: { provider, tariffCode },
        },
        orderBy: { effectiveFrom: 'desc' },
        include: { utilityTariff: true },
      }),
    );
    if (!version) return null;
    return this.withCharge(version.utilityTariff, version, units);
  }

  private withCharge(tariff: UtilityTariff, version: UtilityTariffVersion, units?: Decimal.Value): TariffAt {
    const structure = version.structure as unknown as UtilityTariffStructure;
    const charge =
      units !== undefined && new Decimal(units).gt(0) && structure.kind !== 'tou'
        ? utilityCharge(structure, { units })
        : null;
    return { tariff, version, structure, charge };
  }

  /** `GET /v1/owner/utility-tariffs/current`: every tariff of a utility/provider in force on `date`; 404 when none. */
  async current(input: {
    utility: Utility;
    provider: UtilityProvider;
    tariffCode?: string;
    date: Date;
    units?: string;
  }) {
    const day = dayOf(input.date);
    const versions = await this.db.platform((tx) =>
      tx.utilityTariffVersion.findMany({
        where: {
          state: { in: IN_FORCE },
          effectiveFrom: { lte: day },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
          utilityTariff: {
            utility: input.utility,
            provider: input.provider,
            isActive: true,
            ...(input.tariffCode ? { tariffCode: input.tariffCode } : {}),
          },
        },
        orderBy: [{ effectiveFrom: 'desc' }],
        include: { utilityTariff: true },
      }),
    );
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions) if (!latest.has(v.utilityTariffId)) latest.set(v.utilityTariffId, v);
    if (latest.size === 0) throw new DomainException('tariff.not_found');
    return [...latest.values()]
      .sort((a, b) => a.utilityTariff.tariffCode.localeCompare(b.utilityTariff.tariffCode))
      .map((v) => this.withCharge(v.utilityTariff, v, input.units));
  }

  list() {
    return this.db.platform((tx) =>
      tx.utilityTariff.findMany({
        orderBy: [{ provider: 'asc' }, { tariffCode: 'asc' }],
        include: { versions: { orderBy: { effectiveFrom: 'desc' } } },
      }),
    );
  }

  getVersion(versionId: string) {
    return this.db.platform(async (tx) => {
      const v = await tx.utilityTariffVersion.findUnique({
        where: { id: versionId },
        include: { utilityTariff: true },
      });
      if (!v) throw new DomainException('http.not_found');
      return v;
    });
  }

  /** Maker: enters a version (`entered`); the structure is validated and its ceiling copied to the column. */
  async enter(
    tariffId: string,
    input: {
      effectiveFrom: string;
      structure: UtilityTariffStructure;
      sourceUrl: string;
      sourcePublishedAt?: string | null;
      notes?: string | null;
    },
  ) {
    const problems = validateTariffStructure(input.structure);
    if (problems.length)
      throw new DomainException('tariff.invalid_structure', {
        errors: problems.map((message) => ({ path: 'structure', code: 'structure', message })),
      });
    const actor = userIdOf(RequestContext.actor());
    return this.db.platform(async (tx) => {
      const tariff = await tx.utilityTariff.findUnique({ where: { id: tariffId } });
      if (!tariff) throw new DomainException('http.not_found');
      if (tariff.utility === 'electric' ? input.structure.unit !== 'kwh' : input.structure.unit !== 'm3')
        throw new DomainException('tariff.invalid_structure', {
          errors: [
            {
              path: 'structure.unit',
              code: 'unit',
              message: `unit must match the ${tariff.utility} utility`,
            },
          ],
        });
      const effectiveFrom = new Date(`${input.effectiveFrom}T00:00:00.000Z`);
      if (await tx.utilityTariffVersion.findFirst({ where: { utilityTariffId: tariffId, effectiveFrom } }))
        throw new DomainException('http.conflict');
      const version = await tx.utilityTariffVersion.create({
        data: {
          utilityTariffId: tariffId,
          effectiveFrom,
          structure: input.structure as unknown as Prisma.InputJsonValue,
          ceilingPerUnit: input.structure.ceilingPerUnit,
          sourceUrl: input.sourceUrl,
          sourcePublishedAt: input.sourcePublishedAt
            ? new Date(`${input.sourcePublishedAt}T00:00:00.000Z`)
            : null,
          state: 'entered',
          needsCheck: (input.structure.needsCheck ?? []).length > 0,
          enteredBy: actor,
          notes: input.notes ?? null,
          createdBy: actor,
        },
      });
      await this.audit.record(tx, {
        action: 'utility_tariff.entered',
        subjectType: 'platform.utility_tariff_version',
        subjectId: version.id,
        after: {
          tariffId,
          provider: tariff.provider,
          tariffCode: tariff.tariffCode,
          effectiveFrom: input.effectiveFrom,
        },
      });
      return version;
    });
  }

  /** Checker: a different platform user confirms every value against the source (`needs_check` cleared). */
  async verify(versionId: string, notes?: string | null) {
    const actor = userIdOf(RequestContext.actor());
    return this.db.platform(async (tx) => {
      const v = await tx.utilityTariffVersion.findUnique({ where: { id: versionId } });
      if (!v) throw new DomainException('http.not_found');
      if (v.state !== 'entered') throw new DomainException('tariff.invalid_state');
      if (v.enteredBy && v.enteredBy === actor) throw new DomainException('tariff.same_verifier');
      const structure = { ...(v.structure as Record<string, unknown>) };
      delete structure.needsCheck;
      const verified = await tx.utilityTariffVersion.update({
        where: { id: versionId },
        data: {
          state: 'verified',
          needsCheck: false,
          structure: structure as Prisma.InputJsonValue,
          verifiedBy: actor,
          verifiedAt: new Date(),
          ...(notes ? { notes } : {}),
          updatedBy: actor,
        },
      });
      await this.audit.record(tx, {
        action: 'utility_tariff.verified',
        subjectType: 'platform.utility_tariff_version',
        subjectId: versionId,
        before: { state: v.state, needsCheck: v.needsCheck },
        after: { state: 'verified' },
      });
      return verified;
    });
  }

  /** Publishes a verified version; the version in force at its start is closed and becomes `superseded`. */
  async publish(versionId: string) {
    const actor = userIdOf(RequestContext.actor());
    const published = await this.db.platform(async (tx) => {
      const v = await tx.utilityTariffVersion.findUnique({
        where: { id: versionId },
        include: { utilityTariff: true },
      });
      if (!v) throw new DomainException('http.not_found');
      if (v.state !== 'verified') throw new DomainException('tariff.invalid_state');
      const previous = await tx.utilityTariffVersion.findFirst({
        where: {
          utilityTariffId: v.utilityTariffId,
          state: 'published',
          effectiveFrom: { lt: v.effectiveFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: v.effectiveFrom } }],
        },
      });
      if (previous)
        await tx.utilityTariffVersion.update({
          where: { id: previous.id },
          data: { state: 'superseded', effectiveTo: v.effectiveFrom, updatedBy: actor },
        });
      const next = await tx.utilityTariffVersion.findFirst({
        where: {
          utilityTariffId: v.utilityTariffId,
          state: { in: IN_FORCE },
          effectiveFrom: { gt: v.effectiveFrom },
        },
        orderBy: { effectiveFrom: 'asc' },
      });
      const row = await tx.utilityTariffVersion.update({
        where: { id: versionId },
        data: {
          state: next ? 'superseded' : 'published',
          effectiveTo: next?.effectiveFrom ?? null,
          publishedBy: actor,
          publishedAt: new Date(),
          updatedBy: actor,
        },
      });
      const effectiveFrom = v.effectiveFrom.toISOString().slice(0, 10);
      await this.audit.record(tx, {
        action: 'utility_tariff.published',
        subjectType: 'platform.utility_tariff_version',
        subjectId: versionId,
        after: {
          provider: v.utilityTariff.provider,
          tariffCode: v.utilityTariff.tariffCode,
          effectiveFrom,
          supersededVersionId: previous?.id ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'utility_tariff.published',
        aggregateType: 'utility_tariff_version',
        aggregateId: versionId,
        tenantId: null,
        payload: {
          versionId,
          provider: v.utilityTariff.provider,
          tariffCode: v.utilityTariff.tariffCode,
          effectiveFrom,
          supersededVersionId: previous?.id ?? null,
        },
      });
      return row;
    });
    await this.bus.publish(TARIFFS_TOPIC, versionId);
    return published;
  }
}
