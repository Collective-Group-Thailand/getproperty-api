import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type AccessEvent } from '@generated/prisma/client';
import { TechnicianWorkOrdersService } from '@modules/ops-service/field-access.service';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessCredentialsService,
  CREDENTIAL_INCLUDE,
  type CredentialRow,
} from './access-credentials.service';
import { LIVE_STATUSES, validWindow } from './access-rules';

export type RevealedCredential = CredentialRow & { pin: string | null };

/** What the operator lets residents do with visitor codes (LIFF #26, D-218). */
export interface VisitorPolicy {
  allowed: boolean;
  maxHours: number;
}

/** A resident visitor code may never exceed 31 days (`validWindow`), whatever the setting says. */
const VISITOR_HOURS_CAP = 31 * 24;

function actorUser(): { userId: string; scopes: readonly string[] } {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return { userId: actor.publicId, scopes: actor.scopes };
}

/**
 * What a holder sees of access (B5.2, D-070, D-025): residents their own credentials (PIN revealed to them, audited)
 * and the log of **their own unit's** locks plus the building-door events of their own credentials — never another
 * unit's; technicians the codes of their work order; staff the codes of the work orders assigned to them.
 */
@Injectable()
export class AccessViewsService {
  constructor(
    private readonly db: TenantTx,
    private readonly credentials: AccessCredentialsService,
    private readonly technicians: TechnicianWorkOrdersService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** My units (`unit:` scopes of my token) with their tenant, property and active unit locks. */
  private async myUnits() {
    const { scopes } = actorUser();
    const ids = scopes.filter((s) => s.startsWith('unit:')).map((s) => s.slice('unit:'.length));
    if (!ids.length) return [];
    return this.db.platform((tx) =>
      tx.unit.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: {
          id: true,
          tenantId: true,
          buildingId: true,
          building: { select: { propertyId: true } },
          lockUnit: {
            where: { scope: 'unit', isActive: true },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    );
  }

  /** The visitor-code policy in force for a unit's tenant / property (settings with effective dates). */
  private async policyOf(unit: {
    tenantId: string;
    building: { propertyId: string };
  }): Promise<VisitorPolicy> {
    const now = this.clock.now();
    const scope = { tenantId: unit.tenantId, propertyId: unit.building.propertyId };
    const allowed = await this.settings.valueAt<boolean>('access.resident_visitor_codes', now, scope);
    const hours = await this.settings.valueAt<number>('access.resident_visitor_max_hours', now, scope);
    return {
      allowed: allowed === true,
      maxHours: Math.max(1, Math.min(VISITOR_HOURS_CAP, Number(hours) || 1)),
    };
  }

  /**
   * `RevealedCredentialsDto.visitorPolicy` (LIFF #26): allowed when the operator of one of my units with an active
   * unit lock lets residents create visitor codes; `maxHours` = the shortest limit among those units (the form never
   * offers more than every unit accepts).
   */
  async visitorPolicy(): Promise<VisitorPolicy> {
    const policies: VisitorPolicy[] = [];
    for (const u of await this.myUnits()) if (u.lockUnit.length) policies.push(await this.policyOf(u));
    const allowed = policies.filter((p) => p.allowed);
    if (!allowed.length) return { allowed: false, maxHours: 0 };
    return { allowed: true, maxHours: Math.min(...allowed.map((p) => p.maxHours)) };
  }

  /**
   * `POST /v1/resident/access/visitor-codes` (LIFF #26, D-070, D-218): a time-boxed keypad code on my unit's lock for a
   * named visitor, within the operator's policy — 404 for a unit outside my scopes, 403 `access.visitor_codes_disabled`
   * when the operator does not allow it, 422 beyond `maxHours`, 409 `access.invalid_state` for a unit without an
   * active lock. The PIN is answered this once (give it to the visitor); the issue is audited with me as the issuer.
   */
  async createVisitorCode(input: {
    unitId: string;
    visitorName: string;
    validFrom: Date;
    validTo: Date;
  }): Promise<CredentialRow & { pin: string }> {
    const unit = (await this.myUnits()).find((u) => u.id === input.unitId);
    if (!unit) throw new DomainException('http.not_found');
    const policy = await this.policyOf(unit);
    if (!policy.allowed) throw new DomainException('access.visitor_codes_disabled');
    const name = input.visitorName.trim();
    if (!name)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'visitorName', code: 'required', message: 'the visitor’s name' }],
      });
    const problem = validWindow(input.validFrom, input.validTo, this.clock.now());
    if (problem)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'validTo', code: 'window', message: problem }],
      });
    if (input.validTo.getTime() - input.validFrom.getTime() > policy.maxHours * 3_600_000)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'validTo', code: 'maxHours', message: `at most ${policy.maxHours} hours` }],
      });
    if (!unit.lockUnit.length)
      throw new DomainException('access.invalid_state', { params: { status: 'no_lock' } });
    const ctx: TenantContext = { tenantId: unit.tenantId, source: 'path' };
    const issued = await this.db.tenant(ctx, async (tx) => {
      const lock = await tx.lock.findFirst({ where: { id: unit.lockUnit[0]!.id, isActive: true } });
      if (!lock) throw new DomainException('access.invalid_state', { params: { status: 'no_lock' } });
      return this.credentials.issueIn(tx, {
        lock,
        holderKind: 'visitor',
        holderName: name,
        validFrom: input.validFrom,
        validTo: input.validTo,
      });
    });
    return { ...(await this.credentials.get(ctx, issued.id)), pin: issued.pin };
  }

  private async reveal(rows: CredentialRow[], purpose: string): Promise<RevealedCredential[]> {
    const out: RevealedCredential[] = [];
    for (const r of rows)
      out.push({ ...r, pin: await this.db.platform((tx) => this.credentials.reveal(tx, r, purpose)) });
    return out;
  }

  /**
   * Parties of my confirmed links (review #6, D-226): a door code is revealed only through a link the tenant made or
   * confirmed — an invitation, a LINE-id match or the Owner's confirmation — never through an unconfirmed phone match.
   */
  private async myParties(userId: string): Promise<string[]> {
    const links = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({
        where: { userId, state: 'active', linkedVia: { not: 'phone_match' } },
        select: { partyId: true },
      }),
    );
    return links.map((l) => l.partyId);
  }

  /** `GET /v1/resident/access/credentials`: my live resident credentials across tenants, with the PIN. */
  async residentCredentials(): Promise<RevealedCredential[]> {
    const { userId } = actorUser();
    const parties = await this.myParties(userId);
    if (!parties.length) return [];
    const rows = await this.db.platform((tx) =>
      tx.accessCredential.findMany({
        where: { holderPartyId: { in: parties }, holderKind: 'resident', status: { in: [...LIVE_STATUSES] } },
        include: CREDENTIAL_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
    );
    return this.reveal(rows, 'resident_own_credential');
  }

  /** `GET /v1/resident/access/events?unitId=`: my unit's lock log + door events of my own credentials. */
  async residentEvents(
    unitId: string,
    range: { from: Date; to: Date; take: number },
  ): Promise<AccessEvent[]> {
    const { userId, scopes } = actorUser();
    if (!scopes.includes(`unit:${unitId}`)) throw new DomainException('http.not_found');
    const parties = await this.myParties(userId);
    const mine = parties.length
      ? (
          await this.db.platform((tx) =>
            tx.accessCredential.findMany({ where: { holderPartyId: { in: parties } }, select: { id: true } }),
          )
        ).map((c) => c.id)
      : [];
    return this.db.platform((tx) =>
      tx.accessEvent.findMany({
        where: {
          time: { gte: range.from, lt: range.to },
          OR: [{ unitId }, ...(mine.length ? [{ credentialId: { in: mine } }] : [])],
        },
        orderBy: { time: 'desc' },
        take: range.take,
      }),
    );
  }

  /** The technician's codes of one of their work orders (404 when not theirs). */
  async technicianCodes(workOrderId: string): Promise<RevealedCredential[]> {
    const { ctx, wo } = await this.technicians.access(workOrderId);
    const rows = await this.db.tenant(ctx, (tx) =>
      tx.accessCredential.findMany({
        where: {
          workOrderId: wo.id,
          holderPartyId: wo.assigneePartyId,
          status: { in: [...LIVE_STATUSES] },
        },
        include: CREDENTIAL_INCLUDE,
      }),
    );
    return this.reveal(rows, 'technician_work_order');
  }

  /** A staff member's codes of a work order assigned to them (staff PWA). */
  async staffCodes(ctx: TenantContext, workOrderId: string): Promise<RevealedCredential[]> {
    const { userId } = actorUser();
    const rows = await this.db.tenant(ctx, async (tx) => {
      const wo = await tx.workOrder.findFirst({
        where: {
          id: workOrderId,
          tenantId: ctx.tenantId,
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
      });
      if (!wo) throw new DomainException('http.not_found');
      return tx.accessCredential.findMany({
        where: { workOrderId: wo.id, holderUserId: userId, status: { in: [...LIVE_STATUSES] } },
        include: CREDENTIAL_INCLUDE,
      });
    });
    return this.reveal(rows, 'staff_work_order');
  }
}
