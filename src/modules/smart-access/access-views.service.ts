import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { type AccessEvent } from '@generated/prisma/client';
import { TechnicianWorkOrdersService } from '@modules/ops-service/field-access.service';
import { Injectable } from '@nestjs/common';

import {
  AccessCredentialsService,
  CREDENTIAL_INCLUDE,
  type CredentialRow,
} from './access-credentials.service';
import { LIVE_STATUSES } from './access-rules';

export type RevealedCredential = CredentialRow & { pin: string | null };

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
  ) {}

  private async reveal(rows: CredentialRow[], purpose: string): Promise<RevealedCredential[]> {
    const out: RevealedCredential[] = [];
    for (const r of rows)
      out.push({ ...r, pin: await this.db.platform((tx) => this.credentials.reveal(tx, r, purpose)) });
    return out;
  }

  private async myParties(userId: string): Promise<string[]> {
    const links = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({ where: { userId, state: 'active' }, select: { partyId: true } }),
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
