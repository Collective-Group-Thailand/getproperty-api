import { createHash } from 'node:crypto';

import { isJuristicTenantType } from '@collective/asset-core';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { AuthService, type TokenPair } from '@core/identity/auth.service';
import { type AnyIdentity, IdentitySignInService } from '@core/identity/identity-sign-in.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Tenant, type WorkspaceLink } from '@generated/prisma/client';
import { INVOICE_INCLUDE, InvoicesService } from '@modules/ops-billing/invoices.service';
import { newLetterCode, normaliseLetterCode } from '@modules/ops-leases/rent-record.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

const by = () => userIdOf(RequestContext.actor());
const hashCode = (code: string) => createHash('sha256').update(normaliseLetterCode(code)).digest();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
/** D-270: what a workspace grant opens — the juristic module only (never the landlord's leases or rent invoices). */
export const WORKSPACE_GRANT_MODULES = ['juristic'];

export interface WorkspaceUnit {
  linkId: string;
  unitId: string;
  unitNo: string;
  buildingId: string;
  buildingName: string;
  landlordPartyId: string;
  landlordName: string;
  linkedAt: Date;
}

/**
 * D-270 juristic workspace (folded into J1.2, D-326): a landlord whose condo units sit in a **stub** building (D-251,
 * status `external`) invites the condo's juristic office. The office accepts with its own sign-in (phone OTP / LINE /
 * Google / Apple, like a landlord sign-up): an existing juristic tenant it owns is linked, otherwise a free `juristic`
 * workspace tenant is created — it owns and operates no building. It receives one **unit-scope grant per linked unit**
 * (module `juristic` only, reason `landlord_unit`, source `d270:<link>`), so it sees those units and nothing else of
 * the landlord (no leases, residents or rent invoices). It bills its common fees to the landlord through a party of its
 * own linked to the inviting landlord login: the landlord sees and pays them in LIFF like any bill. The landlord can
 * revoke at any time (grants revoked → 404 for the office).
 */
@Injectable()
export class JuristicWorkspaceService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly identities: IdentitySignInService,
    private readonly auth: AuthService,
    private readonly keys: TenantDataKeys,
    private readonly invoices: InvoicesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------- landlord

  /** `POST /v1/owner/juristic-workspace-invitations` (landlord): the code is returned once, stored hashed. */
  async invite(
    ctx: TenantContext,
    input: { buildingId: string; unitIds: string[]; officeName: string; officePhone?: string | null },
  ): Promise<{ link: WorkspaceLink; code: string; url: string }> {
    const name = input.officeName.trim();
    if (name.length < 2 || name.length > 200) throw invalid('officeName', 'length', '2–200 characters');
    const unitIds = [...new Set(input.unitIds)];
    if (!unitIds.length || unitIds.length > 50) throw invalid('unitIds', 'size', '1–50 units');
    const code = newLetterCode();
    const days = Number(
      (await this.settings.valueAt<number>('juristic.workspace_invite_days', this.clock.now(), {})) ?? 14,
    );
    const link = await this.db.tenant(ctx, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { type: true },
      });
      if (tenant.type !== 'landlord') throw new DomainException('auth.forbidden');
      const building = this.found(
        await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } }),
      );
      if (building.status !== 'external' || building.ownerTenantId || building.operatorTenantId)
        throw new DomainException('workspace.not_a_stub');
      const units = await tx.unit.findMany({
        where: { id: { in: unitIds }, tenantId: ctx.tenantId, buildingId: building.id, deletedAt: null },
        select: { id: true },
      });
      if (units.length !== unitIds.length) throw new DomainException('http.not_found');
      const now = this.clock.now();
      const row = await tx.workspaceLink.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: building.id,
          unitIds,
          officeName: name,
          officePhone: input.officePhone?.trim() || null,
          codeHash: new Uint8Array(hashCode(code)),
          codeHint: code.slice(-4),
          expiresAt: new Date(now.getTime() + days * 86_400_000),
          invitedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.workspace_invited',
        tenantId: ctx.tenantId,
        buildingId: building.id,
        subjectType: 'juristic.workspace_link',
        subjectId: row.id,
        metadata: { officeName: name, units: unitIds.length },
      });
      await this.events.record(tx, {
        type: 'juristic.workspace.invited',
        aggregateType: 'workspace_link',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        buildingId: building.id,
        payload: { linkId: row.id, buildingId: building.id, units: unitIds.length },
      });
      return row;
    });
    return { link, code, url: `${this.config.get('PUBLIC_WEB_APP_URL')}/juristic/join/${code}` };
  }

  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.workspaceLink.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<WorkspaceLink> {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.workspaceLink.findFirst({ where: this.own(ctx, { id }) })),
    );
  }

  /** `POST …/{id}/actions/revoke`: an invitation is withdrawn; an active link's grants are revoked at once. */
  async revoke(ctx: TenantContext, id: string, reason: string): Promise<WorkspaceLink> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 600) throw invalid('reason', 'length', '3–600 characters');
    await this.db.tenant(ctx, async (tx) => {
      const link = this.found(await tx.workspaceLink.findFirst({ where: this.own(ctx, { id }) }));
      if (link.state === 'revoked')
        throw new DomainException('workspace.invalid_state', { params: { state: link.state } });
      const now = this.clock.now();
      await tx.workspaceLink.update({
        where: { id },
        data: { state: 'revoked', revokedAt: now, revokeReason: text, version: { increment: 1 } },
      });
      if (link.grantIds.length)
        await this.db.platform((p) =>
          p.assetAccessGrant.updateMany({
            where: { id: { in: link.grantIds }, revokedAt: null },
            data: { revokedAt: now, revokedBy: by(), revokeReason: `D-270 workspace revoked: ${text}` },
          }),
        );
      await this.audit.record(tx, {
        action: 'juristic.workspace_revoked',
        tenantId: ctx.tenantId,
        buildingId: link.buildingId,
        subjectType: 'juristic.workspace_link',
        subjectId: id,
        metadata: { reason: text, grants: link.grantIds.length, juristicTenantId: link.juristicTenantId },
      });
      await this.events.record(tx, {
        type: 'juristic.workspace.revoked',
        aggregateType: 'workspace_link',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: link.buildingId,
        payload: { linkId: id, juristicTenantId: link.juristicTenantId, reason: text },
      });
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- public

  private async openLink(tx: Tx, code: string): Promise<WorkspaceLink> {
    const normalised = normaliseLetterCode(code);
    if (normalised.length !== 10) throw new DomainException('workspace.invitation_invalid');
    const link = await tx.workspaceLink.findFirst({
      where: { codeHash: new Uint8Array(hashCode(normalised)) },
    });
    if (!link || link.state !== 'invited' || link.expiresAt.getTime() <= this.clock.now().getTime())
      throw new DomainException('workspace.invitation_invalid');
    return link;
  }

  /** `GET /v1/public/juristic-workspaces/{code}`: what the office is invited to (no landlord personal data). */
  preview(code: string) {
    return this.db.platform(async (tx) => {
      const link = await this.openLink(tx, code);
      const building = await tx.building.findUniqueOrThrow({
        where: { id: link.buildingId },
        select: { name: true },
      });
      return {
        officeName: link.officeName,
        buildingName: building.name,
        units: link.unitIds.length,
        expiresAt: link.expiresAt,
      };
    });
  }

  /**
   * `POST /v1/public/juristic-workspaces/accept`: the office signs in; its juristic tenant is linked (one it already
   * owns) or a workspace tenant is created; grants per unit; the landlord's party in the workspace is linked to the
   * inviting login so the bills reach the landlord's LIFF.
   */
  async accept(input: {
    code: string;
    identity: AnyIdentity;
    displayName: string;
    language?: 'th' | 'en';
  }): Promise<{ created: boolean; tenant: Tenant; tokens: TokenPair; linkId: string }> {
    const v = await this.identities.verify(input.identity, 'landlord_signup', 'landlord_signup');
    const language = input.language ?? 'th';
    return this.db.platform(async (tx) => {
      const link = await this.openLink(tx, input.code);
      await tx.$queryRaw`SELECT id FROM juristic.workspace_link WHERE id = ${link.id}::uuid FOR UPDATE`;
      const user = (await this.identities.accountFor(tx, v, { create: true, language }))!;
      const now = this.clock.now();
      const owned = await tx.membership.findFirst({
        where: {
          userId: user.id,
          role: 'owner',
          status: 'active',
          deletedAt: null,
          tenant: { deletedAt: null, status: { not: 'deactivated' } },
        },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      });
      let tenant: Tenant;
      let created = false;
      if (owned && isJuristicTenantType(owned.tenant.type)) tenant = owned.tenant;
      else {
        created = true;
        const id = uuidv7(now.getTime());
        const legalPartyId = uuidv7(now.getTime());
        const name = (input.displayName.trim() || link.officeName).slice(0, 200);
        await tx.tenant.create({
          data: {
            id,
            type: 'juristic',
            slug: `juristic-${id.replace(/-/g, '').slice(-10)}`,
            displayName: name,
            legalName: name,
            legalForm: 'juristic_person',
            defaultLanguage: language,
            createdBy: user.id,
          },
        });
        await this.keys.createFirst(tx, id);
        await tx.party.create({
          data: { id: legalPartyId, tenantId: id, type: 'company', displayName: name },
        });
        tenant = await tx.tenant.update({ where: { id }, data: { legalPartyId } });
        const m = await tx.membership.create({
          data: {
            tenantId: id,
            userId: user.id,
            role: 'owner',
            status: 'active',
            joinedAt: now,
            createdBy: user.id,
          },
        });
        await this.audit.record(tx, {
          action: 'tenant.created',
          tenantId: id,
          subjectType: 'core.tenant',
          subjectId: id,
          after: { type: 'juristic', slug: tenant.slug, source: 'd270_workspace', linkId: link.id },
        });
        await this.audit.record(tx, {
          action: 'tenant.member.joined',
          tenantId: id,
          subjectType: 'core.membership',
          subjectId: m.id,
          after: { role: 'owner', userId: user.id, via: 'd270_workspace' },
        });
        await this.events.record(tx, {
          type: 'tenant.created',
          aggregateType: 'tenant',
          aggregateId: id,
          tenantId: id,
          payload: { tenantId: id, type: 'juristic', plan: null, source: 'd270_workspace' },
        });
      }
      if (tenant.id === link.tenantId) throw new DomainException('workspace.invitation_invalid');
      // the landlord as a billed party of the workspace, linked to the inviting landlord login
      const landlord = await tx.tenant.findUniqueOrThrow({
        where: { id: link.tenantId },
        include: { legalParty: true },
      });
      const inviter = link.invitedBy
        ? await tx.userAccount.findUnique({ where: { id: link.invitedBy } })
        : null;
      const party = await tx.party.create({
        data: {
          tenantId: tenant.id,
          type: landlord.legalParty?.type ?? 'person',
          displayName: landlord.displayName,
          phoneE164: landlord.legalParty?.phoneE164 ?? (inviter?.phoneVerifiedAt ? inviter.phoneE164 : null),
          email: landlord.legalParty?.email ?? (inviter?.emailVerifiedAt ? inviter.email : null),
          language: landlord.defaultLanguage === 'en' ? 'en' : 'th',
          sourceRef: `d270:${link.id}`,
          createdBy: user.id,
        },
      });
      if (inviter)
        await tx.partyUserLink.create({
          data: {
            tenantId: tenant.id,
            partyId: party.id,
            userId: inviter.id,
            linkedVia: 'invitation',
            linkedAt: now,
            createdBy: inviter.id,
          },
        });
      const grantIds: string[] = [];
      for (const unitId of link.unitIds) {
        const g = await tx.assetAccessGrant.create({
          data: {
            tenantId: link.tenantId,
            granteeTenantId: tenant.id,
            buildingId: link.buildingId,
            unitId,
            scope: 'unit',
            modules: WORKSPACE_GRANT_MODULES,
            access: 'read',
            reason: 'landlord_unit',
            validFrom: now,
            sourceRef: `d270:${link.id}`,
            createdBy: link.invitedBy,
          },
        });
        grantIds.push(g.id);
      }
      await tx.workspaceLink.update({
        where: { id: link.id },
        data: {
          state: 'active',
          juristicTenantId: tenant.id,
          landlordPartyId: party.id,
          grantIds,
          acceptedAt: now,
          acceptedBy: user.id,
          version: { increment: 1 },
        },
      });
      for (const t of [link.tenantId, tenant.id])
        await this.audit.record(tx, {
          action: 'juristic.workspace_linked',
          tenantId: t,
          buildingId: link.buildingId,
          subjectType: 'juristic.workspace_link',
          subjectId: link.id,
          metadata: { juristicTenantId: tenant.id, grants: grantIds.length, created },
        });
      await this.events.record(tx, {
        type: 'juristic.workspace.linked',
        aggregateType: 'workspace_link',
        aggregateId: link.id,
        tenantId: link.tenantId,
        buildingId: link.buildingId,
        payload: { linkId: link.id, juristicTenantId: tenant.id, units: link.unitIds.length, created },
      });
      return {
        created,
        tenant,
        tokens: await this.auth.issueOperator(tx, user, [v.provider]),
        linkId: link.id,
      };
    });
  }

  // ------------------------------------------------------------------------------------------- juristic office

  /** The linked units of a juristic tenant (active links with live grants), read as gp_platform for this tenant only. */
  private async units(tenantId: string, unitId?: string): Promise<WorkspaceUnit[]> {
    return this.db.platform(async (tx) => {
      const links = await tx.workspaceLink.findMany({
        where: {
          juristicTenantId: tenantId,
          state: 'active',
          ...(unitId ? { unitIds: { has: unitId } } : {}),
        },
        include: { building: { select: { name: true } }, landlordParty: { select: { displayName: true } } },
      });
      const live = await tx.assetAccessGrant.findMany({
        where: { id: { in: links.flatMap((l) => l.grantIds) }, granteeTenantId: tenantId, revokedAt: null },
        select: { unitId: true },
      });
      const liveUnits = new Set(live.map((g) => g.unitId));
      const units = await tx.unit.findMany({
        where: { id: { in: [...liveUnits].filter((u): u is string => Boolean(u)) }, deletedAt: null },
        select: { id: true, unitNo: true },
      });
      const out: WorkspaceUnit[] = [];
      for (const l of links)
        for (const u of l.unitIds) {
          const unit = units.find((x) => x.id === u);
          if (!unit || !liveUnits.has(u) || (unitId && u !== unitId)) continue;
          out.push({
            linkId: l.id,
            unitId: u,
            unitNo: unit.unitNo,
            buildingId: l.buildingId,
            buildingName: l.building.name,
            landlordPartyId: l.landlordPartyId!,
            landlordName: l.landlordParty?.displayName ?? '',
            linkedAt: l.acceptedAt!,
          });
        }
      return out.sort((a, b) => a.unitNo.localeCompare(b.unitNo));
    });
  }

  workspaceUnits(ctx: TenantContext): Promise<WorkspaceUnit[]> {
    return this.units(ctx.tenantId);
  }

  /**
   * `POST /v1/owner/juristic/workspace/units/{unitId}/invoices`: a common-fee bill to the landlord of a linked unit — an
   * invoice of the workspace issued at once (number of its own series, due date by its settings); unlinked or revoked
   * units are a 404.
   */
  async billLandlord(
    ctx: TenantContext,
    unitId: string,
    input: { periodStart: string; periodEnd: string; amount: string; description?: string | null },
  ) {
    if (!DATE.test(input.periodStart)) throw invalid('periodStart', 'date', 'a date YYYY-MM-DD');
    if (!DATE.test(input.periodEnd) || input.periodEnd < input.periodStart)
      throw invalid('periodEnd', 'date', 'a date YYYY-MM-DD on or after periodStart');
    const amount = new Decimal(input.amount);
    if (amount.lte(0) || amount.decimalPlaces() > 2) throw invalid('amount', 'money', 'a positive amount');
    const [unit] = await this.units(ctx.tenantId, unitId);
    if (!unit) throw new DomainException('http.not_found');
    const description = (
      input.description?.trim() || `ค่าส่วนกลาง ${input.periodStart} – ${input.periodEnd}`
    ).slice(0, 200);
    // the office holds unit-scope grants only, so the stub building row is not visible under its RLS (asset-core:
    // buildings are visible to owner / operator / building-scope grantees): the bill is written as gp_platform with
    // every tenant field explicit, after the link + live-grant check above (same pattern as G2 mandated units)
    return this.db.platform(
      async (tx) => {
        const draft = await this.invoices.persistDraft(
          tx,
          {
            tenantId: ctx.tenantId,
            buildingId: unit.buildingId,
            unitId,
            billedPartyId: unit.landlordPartyId,
            leaseId: null,
            billingCycleId: null,
            isFinal: false,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
          {
            lines: [
              {
                lineNo: 1,
                sourceType: 'common_fee',
                lineKind: 'common_fee',
                description,
                quantity: '1.000',
                unit: null,
                unitPrice: amount.toFixed(4),
                amount: amount.toFixed(2),
                periodFrom: input.periodStart,
                periodTo: input.periodEnd,
                sourceId: unit.linkId,
                leaseLineId: null,
                chargeId: null,
                estimateSettlementId: null,
                meter: null,
                ratePlanVersionId: null,
                utilityTariffVersionId: null,
                capPerUnit: null,
                aboveCap: false,
                acknowledgementId: null,
                tierBreakdown: null,
                proRata: null,
                vatApplicable: false,
                complianceRuleIds: [],
              },
            ],
            subtotal: amount.toFixed(2),
            vatAmount: '0.00',
            total: amount.toFixed(2),
            hasEstimate: false,
            hasAboveCapLine: false,
            reviewFlags: [],
            complianceFlags: [],
            advanceRent: null,
          },
        );
        await this.audit.record(tx, {
          action: 'juristic.workspace_invoice_issued',
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          subjectType: 'ops.invoice',
          subjectId: draft.id,
          metadata: { unitNo: unit.unitNo, amount: amount.toFixed(2), linkId: unit.linkId },
        });
        const issued = await this.invoices.issueInTx(tx, ctx, draft.id, {
          ackId: null,
          throwOnRefusal: true,
        });
        return this.invoices.load(tx, ctx, issued!.id);
      },
      { timeout: 60_000 },
    );
  }

  /** `GET /v1/owner/juristic/workspace/invoices`: the bills of this workspace to the landlords of its linked units. */
  async invoicesOf(ctx: TenantContext, q: { skip: number; take: number }) {
    return this.db.platform(async (tx) => {
      const links = await tx.workspaceLink.findMany({
        where: { juristicTenantId: ctx.tenantId, state: { in: ['active', 'revoked'] } },
        select: { landlordPartyId: true },
      });
      const parties = links.map((l) => l.landlordPartyId).filter((p): p is string => Boolean(p));
      const where = {
        tenantId: ctx.tenantId,
        billedPartyId: { in: parties },
        status: { not: 'draft' as const },
      };
      const [rows, total] = await Promise.all([
        tx.invoice.findMany({
          where,
          include: INVOICE_INCLUDE,
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.invoice.count({ where }),
      ]);
      return { rows, total };
    });
  }
}
