import { createHash } from 'node:crypto';

import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type DataSubjectRequest, type DsrKind, type DsrState, Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import { StorageLedger } from '../storage/storage-ledger';
import { TenantDataKeys } from '../tenancy/data-keys.service';
import { workflowDefinition } from '../workflow/definitions';
import { WorkflowService } from '../workflow/workflow.service';

export const DSR_EVENTS = ['verify', 'start', 'fulfil', 'reject', 'withdraw'] as const;
export type DsrEvent = (typeof DSR_EVENTS)[number];
const SUBJECT_TYPE = 'platform.data_subject_request';

/**
 * Data subject requests (D-025; blueprint compliance: the tenant is the controller, Collective the processor). A
 * resident files a request per controller tenant; it runs on the workflow engine (`data_subject_request`, due
 * `privacy.dsr_due_days`, SLA warning and breach events) and the Owner handles it. Fulfilling an access/portability
 * request writes a JSON export as a private document; an erasure request anonymises the subject's parties in the
 * tenant (PII cleared, links ended, identity documents removed). Requester contact is sealed with the tenant key.
 */
@Injectable()
export class DsrService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly workflow: WorkflowService,
    private readonly settings: SettingsService,
    private readonly keys: TenantDataKeys,
    private readonly platformKey: FieldEncryption,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: StorageLedger,
  ) {
    super();
  }

  /** Resident files a request (one per controller tenant, or a platform-level one when not linked to any tenant). */
  async create(userId: string, input: { kind: DsrKind; tenantId?: string | null; details?: string | null }) {
    const now = this.clock.now();
    const days = await this.settings.valueAt<number>('privacy.dsr_due_days', now);
    const dueAt = new Date(now.getTime() + days * 86_400_000);
    const { user, tenants } = await this.db.platform(async (tx) => {
      const u = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { tenantId: true },
      });
      return { user: u, tenants: [...new Set(links.map((l) => l.tenantId))] };
    });
    if (input.tenantId && !tenants.includes(input.tenantId)) throw new DomainException('http.not_found');
    const targets: (string | null)[] = input.tenantId ? [input.tenantId] : tenants.length ? tenants : [null];
    const contact = JSON.stringify({
      phone: user.phoneE164,
      email: user.email,
      lineUserId: user.lineUserId,
      details: input.details ?? null,
    });
    const created: DataSubjectRequest[] = [];
    for (const tenantId of targets) {
      const run = async (tx: Tx) => {
        const id = uuidv7();
        const contactEnc = tenantId
          ? await this.keys.encrypt(
              tx,
              { tenantId, table: 'platform.data_subject_request', column: 'requester_contact', rowId: id },
              contact,
            )
          : this.platformKey.encrypt(contact, `dsr:${id}`);
        const dsr = await tx.dataSubjectRequest.create({
          data: {
            id,
            tenantId,
            subjectType: 'user',
            subjectId: userId,
            requesterContactEnc: contactEnc,
            kind: input.kind,
            receivedAt: now,
            dueAt,
            notes: null,
            createdBy: userId,
          },
        });
        if (tenantId)
          await this.workflow.start(tx, {
            tenantId,
            subjectType: SUBJECT_TYPE,
            subjectId: id,
            definitionKey: 'data_subject_request',
          });
        await this.audit.record(tx, {
          action: 'dsr.received',
          tenantId,
          subjectType: SUBJECT_TYPE,
          subjectId: id,
          after: { kind: input.kind, dueAt: dueAt.toISOString() },
        });
        await this.events.record(tx, {
          type: 'dsr.received',
          aggregateType: 'data_subject_request',
          aggregateId: id,
          tenantId,
          payload: { dsrId: id, kind: input.kind, dueAt: dueAt.toISOString() },
        });
        return dsr;
      };
      created.push(
        tenantId ? await this.db.tenant({ tenantId, source: 'path' }, run) : await this.db.platform(run),
      );
    }
    return created;
  }

  listForSubject(userId: string) {
    return this.db.platform((tx) =>
      tx.dataSubjectRequest.findMany({
        where: { subjectType: 'user', subjectId: userId },
        orderBy: { receivedAt: 'desc' },
      }),
    );
  }

  list(ctx: TenantContext, state?: DsrState) {
    return this.db.tenant(ctx, (tx) =>
      tx.dataSubjectRequest.findMany({
        where: this.own(ctx, state ? { state } : {}),
        orderBy: { receivedAt: 'desc' },
      }),
    );
  }

  listAll(state?: DsrState) {
    return this.db.platform((tx) =>
      tx.dataSubjectRequest.findMany({
        where: state ? { state } : {},
        orderBy: { receivedAt: 'desc' },
        take: 200,
      }),
    );
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.dataSubjectRequest.findFirst({ where: this.own(ctx, { id }) })),
    );
  }

  /** Owner moves the request through the workflow; fulfilment does the export or the erasure. */
  async transition(ctx: TenantContext, id: string, event: DsrEvent, notes?: string | null) {
    // erased files leave object storage only once the guarded row updates committed (G review #7)
    const objects: string[] = [];
    const result = await this.db.tenant(ctx, async (tx) => {
      const dsr = this.found(await tx.dataSubjectRequest.findFirst({ where: this.own(ctx, { id }) }));
      const instance = await tx.workflowInstance.findFirst({
        where: { tenantId: ctx.tenantId, subjectType: SUBJECT_TYPE, subjectId: id, closedAt: null },
      });
      if (!instance) throw new DomainException('workflow.invalid_transition');
      const next = await this.workflow.transition(tx, instance.id, event, { notes: notes ?? null });
      const now = this.clock.now();
      let exportDocumentId: string | null = dsr.exportDocumentId;
      if (event === 'fulfil') {
        if (dsr.kind === 'access' || dsr.kind === 'portability')
          exportDocumentId = await this.export(tx, ctx, dsr);
        if (dsr.kind === 'erasure') await this.erase(tx, ctx, dsr, objects);
      }
      const updated = await tx.dataSubjectRequest.update({
        where: { id },
        data: {
          state: next.state as DsrState,
          fulfilledAt: next.state === 'fulfilled' ? now : null,
          handledBy: userIdOf(RequestContext.actor()),
          exportDocumentId,
          notes: notes ?? dsr.notes,
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: event === 'fulfil' ? 'dsr.fulfilled' : 'dsr.transitioned',
        tenantId: ctx.tenantId,
        subjectType: SUBJECT_TYPE,
        subjectId: id,
        before: { state: dsr.state },
        after: { state: updated.state, exportDocumentId },
      });
      await this.events.record(tx, {
        type: 'dsr.transitioned',
        aggregateType: 'data_subject_request',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { dsrId: id, from: dsr.state, to: updated.state, kind: dsr.kind },
      });
      return updated;
    });
    for (const key of new Set(objects)) await this.storage.delete(key).catch(() => undefined);
    return result;
  }

  /**
   * Requests where Collective is the controller (`tenant_id` NULL: logins not linked to any tenant, platform users;
   * web F5, D-214). Same state machine as the tenant workflow (definition `data_subject_request`) without a workflow
   * instance (instances belong to a tenant); the due date is the one stored at receipt. `fulfil`: access /
   * portability → a JSON export of the login (platform file); erasure → the login's contact data is anonymised and
   * the login disabled — refused while it still works for a tenant (membership or linked party: that tenant is the
   * controller of those records, 409 `dsr.erasure_blocked`). A tenant's request is 409 `dsr.tenant_controlled`.
   */
  async transitionPlatform(id: string, event: DsrEvent, notes?: string | null) {
    const spec = workflowDefinition('data_subject_request');
    return this.db.platform(async (tx) => {
      const dsr = this.found(await tx.dataSubjectRequest.findUnique({ where: { id } }));
      if (dsr.tenantId) throw new DomainException('dsr.tenant_controlled');
      const terminal = new Set(spec.states.filter((st) => st.terminal).map((st) => st.key));
      const t = spec.transitions.find(
        (tr) =>
          tr.event === event &&
          (tr.from === '*'
            ? !terminal.has(dsr.state)
            : (Array.isArray(tr.from) ? tr.from : [tr.from]).includes(dsr.state)),
      );
      if (!t)
        throw new DomainException('workflow.invalid_transition', { params: { event, state: dsr.state } });
      const now = this.clock.now();
      let exportDocumentId = dsr.exportDocumentId;
      if (event === 'fulfil') {
        if (dsr.kind === 'access' || dsr.kind === 'portability')
          exportDocumentId = await this.exportPlatform(tx, dsr);
        if (dsr.kind === 'erasure') await this.erasePlatform(tx, dsr);
      }
      const actor = userIdOf(RequestContext.actor());
      const updated = await tx.dataSubjectRequest.update({
        where: { id },
        data: {
          state: t.to as DsrState,
          fulfilledAt: t.to === 'fulfilled' ? now : null,
          handledBy: actor,
          exportDocumentId,
          notes: notes ?? dsr.notes,
          updatedBy: actor,
        },
      });
      await this.audit.record(tx, {
        action: event === 'fulfil' ? 'dsr.fulfilled' : 'dsr.transitioned',
        tenantId: null,
        subjectType: SUBJECT_TYPE,
        subjectId: id,
        before: { state: dsr.state },
        after: { state: updated.state, exportDocumentId, controller: 'platform' },
      });
      await this.events.record(tx, {
        type: 'dsr.transitioned',
        aggregateType: 'data_subject_request',
        aggregateId: id,
        tenantId: null,
        payload: { dsrId: id, from: dsr.state, to: updated.state, kind: dsr.kind },
      });
      return updated;
    });
  }

  private async exportPlatform(tx: Tx, dsr: DataSubjectRequest): Promise<string> {
    const user = dsr.subjectId ? await tx.userAccount.findUnique({ where: { id: dsr.subjectId } }) : null;
    const consents = dsr.subjectId
      ? await tx.consent.findMany({ where: { tenantId: null, subjectId: dsr.subjectId } })
      : [];
    const memberships = dsr.subjectId
      ? await tx.membership.findMany({
          where: { userId: dsr.subjectId },
          select: { tenantId: true, role: true, status: true },
        })
      : [];
    // G6 (D-300): recommendation preferences and what was sent (Collective is the controller)
    const preference = dsr.subjectId
      ? await tx.audiencePreference.findUnique({ where: { userId: dsr.subjectId } })
      : null;
    const sponsored = dsr.subjectId
      ? await tx.sponsoredDelivery.findMany({
          where: { userId: dsr.subjectId },
          include: { campaign: { select: { listingIds: true, tenant: { select: { displayName: true } } } } },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    // G9 (D-301): the person's building reviews (Collective is the controller of the public review)
    const reviews = dsr.subjectId
      ? await tx.buildingReview.findMany({
          where: { authorUserId: dsr.subjectId },
          include: { building: { select: { name: true } } },
          orderBy: { submittedAt: 'asc' },
        })
      : [];
    // G8 (D-299) / G review #8: relocation offers (destination and budget the person typed; Collective controls them)
    const relocation = dsr.subjectId
      ? await tx.relocationOffer.findMany({
          where: { userId: dsr.subjectId },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const body = Buffer.from(
      JSON.stringify(
        {
          generatedAt: this.clock.now().toISOString(),
          controller: 'Collective Group (Thailand)',
          requestId: dsr.id,
          account: user
            ? {
                id: user.id,
                displayName: user.displayName,
                email: user.email,
                phone: user.phoneE164,
                lineUserId: user.lineUserId,
                language: user.language,
                status: user.status,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt,
              }
            : null,
          memberships,
          consents: consents.map((c) => ({
            purposeVersionId: c.purposeVersionId,
            granted: c.granted,
            at: c.capturedAt,
          })),
          recommendationPreferences: preference
            ? {
                areas: preference.areaSlugs,
                budgetMin: preference.budgetMin?.toFixed(2) ?? null,
                budgetMax: preference.budgetMax?.toFixed(2) ?? null,
                unitKinds: preference.unitKinds,
                moveInFrom: preference.moveInFrom,
                moveInTo: preference.moveInTo,
                language: preference.language,
                withdrawnAt: preference.withdrawnAt,
                updatedAt: preference.updatedAt,
              }
            : null,
          buildingReviews: reviews.map((r) => ({
            building: r.building.name,
            rating: r.rating,
            text: r.body,
            state: r.state,
            tenureFrom: r.tenureFrom,
            tenureTo: r.tenureTo,
            submittedAt: r.submittedAt,
            ownerReply: r.ownerReply,
          })),
          relocationOffers: relocation.map((o) => ({
            state: o.state,
            moveOutDate: o.moveOutDate,
            destination:
              o.areaSlug || o.province || o.district || o.maxRent
                ? {
                    areaSlug: o.areaSlug,
                    province: o.province,
                    district: o.district,
                    maxRent: o.maxRent?.toFixed(2) ?? null,
                  }
                : null,
            clickedListingIds: o.clickedListingIds,
            createdAt: o.createdAt,
            closedAt: o.closedAt,
          })),
          sponsoredMessages: sponsored.map((d) => ({
            state: d.state,
            sentAt: d.sentAt,
            sponsor: d.campaign.tenant.displayName,
            listingIds: d.campaign.listingIds,
          })),
        },
        null,
        2,
      ),
    );
    const id = uuidv7();
    const key = `p/export/${this.clock.now().toISOString().slice(0, 7).replace('-', '/')}/${id}.json`;
    await this.storage.put(key, body, 'application/json');
    await tx.document.create({
      data: {
        id,
        tenantId: null,
        scopeType: 'platform',
        scopeId: null,
        kind: 'export',
        title: `dsr-${dsr.id}.json`,
        storageBucket: this.config.get('S3_BUCKET'),
        storageKey: key,
        mimeType: 'application/json',
        sizeBytes: BigInt(body.length),
        sha256: new Uint8Array(createHash('sha256').update(body).digest()),
        retentionClass: 'export',
        scanStatus: 'skipped',
        uploadState: 'verified',
        uploadedAt: this.clock.now(),
        createdBy: userIdOf(RequestContext.actor()),
      },
    });
    await this.audit.record(tx, {
      action: 'export.created',
      tenantId: null,
      subjectType: 'core.document',
      subjectId: id,
      metadata: { reason: 'dsr', dsrId: dsr.id },
    });
    return id;
  }

  private async erasePlatform(tx: Tx, dsr: DataSubjectRequest): Promise<void> {
    if (!dsr.subjectId) return;
    const working =
      (await tx.membership.count({ where: { userId: dsr.subjectId, status: 'active', deletedAt: null } })) +
      (await tx.partyUserLink.count({ where: { userId: dsr.subjectId, state: 'active' } }));
    if (working > 0) throw new DomainException('dsr.erasure_blocked');
    const now = this.clock.now();
    await tx.userAccount.update({
      where: { id: dsr.subjectId },
      data: {
        displayName: 'ลบข้อมูลแล้ว (PDPA)',
        // the account must keep one contact (core CHECK): a non-routable tombstone, unique and without PII
        email: `erased+${dsr.subjectId}@erased.invalid`,
        emailVerifiedAt: null,
        phoneE164: null,
        phoneHash: null,
        phoneVerifiedAt: null,
        lineUserId: null,
        status: 'disabled',
        disabledAt: now,
        disabledReason: `dsr:${dsr.id}`,
        updatedBy: userIdOf(RequestContext.actor()),
      },
    });
    // G6 (D-300): recommendation preferences and per-person delivery rows go (campaign totals stay)
    await tx.audiencePreference.deleteMany({ where: { userId: dsr.subjectId } });
    await tx.sponsoredDelivery.deleteMany({ where: { userId: dsr.subjectId } });
    // G9 (D-301): reviews are withdrawn (text erased); the rows stay one per lease, the rating leaves the averages
    await tx.buildingReview.updateMany({
      where: { authorUserId: dsr.subjectId, state: { not: 'withdrawn' } },
      data: { state: 'withdrawn', body: null, withdrawnAt: now },
    });
    // G8 (D-299) / G review #8: open relocation offers are withdrawn; every offer loses its destination and clicks
    await tx.relocationOffer.updateMany({
      where: { userId: dsr.subjectId },
      data: { areaSlug: null, province: null, district: null, maxRent: null, clickedListingIds: [] },
    });
    await tx.relocationOffer.updateMany({
      where: { userId: dsr.subjectId, state: 'open' },
      data: { state: 'withdrawn', closedAt: now },
    });
    const identities = await tx.userIdentity.findMany({ where: { userId: dsr.subjectId } });
    for (const i of identities)
      await tx.userIdentity.update({
        where: { id: i.id },
        data: {
          providerSubject: `erased:${i.id}`,
          displayName: null,
          pictureUrl: null,
          rawClaims: {},
        },
      });
    // G6 fix: the reason is required with the revocation (CHECK auth_session_revoked_check) — the platform team acted
    await tx.authSession.updateMany({
      where: { userId: dsr.subjectId, revokedAt: null },
      data: { revokedAt: now, revokeReason: 'admin' },
    });
  }

  private async subjectParties(tx: Tx, ctx: TenantContext, dsr: DataSubjectRequest) {
    if (!dsr.subjectId) return [];
    const links = await tx.partyUserLink.findMany({
      where: { tenantId: ctx.tenantId, userId: dsr.subjectId },
    });
    return tx.party.findMany({ where: { tenantId: ctx.tenantId, id: { in: links.map((l) => l.partyId) } } });
  }

  private async export(tx: Tx, ctx: TenantContext, dsr: DataSubjectRequest): Promise<string> {
    const parties = await this.subjectParties(tx, ctx, dsr);
    const consents = await tx.consent.findMany({
      where: {
        tenantId: ctx.tenantId,
        subjectId: { in: [dsr.subjectId ?? '', ...parties.map((p) => p.id)] },
      },
    });
    const occupancies = await tx.occupancy.findMany({
      where: { tenantId: ctx.tenantId, partyId: { in: parties.map((p) => p.id) } },
    });
    const body = Buffer.from(
      JSON.stringify(
        {
          generatedAt: this.clock.now().toISOString(),
          controllerTenantId: ctx.tenantId,
          requestId: dsr.id,
          parties: parties.map((p) => ({
            id: p.id,
            type: p.type,
            displayName: p.displayName,
            firstName: p.firstName,
            lastName: p.lastName,
            phone: p.phoneE164,
            email: p.email,
            language: p.language,
            nationality: p.nationality,
            address: p.address,
            idDocumentType: p.idDocumentType,
            idNumberOnFile: Boolean(p.idNumberEnc),
          })),
          occupancies: occupancies.map((o) => ({
            unitId: o.unitId,
            role: o.role,
            validFrom: o.validFrom,
            validTo: o.validTo,
          })),
          consents: consents.map((c) => ({
            purposeVersionId: c.purposeVersionId,
            granted: c.granted,
            capturedAt: c.capturedAt,
            channel: c.channel,
          })),
        },
        null,
        2,
      ),
    );
    const id = uuidv7();
    const key = `t/${ctx.tenantId}/export/${this.clock.now().toISOString().slice(0, 7).replace('-', '/')}/${id}.json`;
    await this.storage.put(key, body, 'application/json');
    await tx.document.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        scopeType: 'tenant',
        scopeId: ctx.tenantId,
        kind: 'export',
        title: `dsr-${dsr.id}.json`,
        storageBucket: this.config.get('S3_BUCKET'),
        storageKey: key,
        mimeType: 'application/json',
        sizeBytes: BigInt(body.length),
        sha256: new Uint8Array(createHash('sha256').update(body).digest()),
        retentionClass: 'export',
        scanStatus: 'skipped',
        uploadState: 'verified',
        uploadedAt: this.clock.now(),
        createdBy: userIdOf(RequestContext.actor()),
      },
    });
    // G1: the export counts to the tenant's storage until it is removed
    await this.ledger.count(tx, {
      documentId: id,
      tenantId: ctx.tenantId,
      category: 'system_other',
      bytes: BigInt(body.length),
    });
    await this.audit.record(tx, {
      action: 'export.created',
      tenantId: ctx.tenantId,
      subjectType: 'core.document',
      subjectId: id,
      metadata: { reason: 'dsr', dsrId: dsr.id },
    });
    return id;
  }

  private async erase(tx: Tx, ctx: TenantContext, dsr: DataSubjectRequest, objects: string[]): Promise<void> {
    const now = this.clock.now();
    for (const p of await this.subjectParties(tx, ctx, dsr)) {
      await tx.party.update({
        where: { id: p.id },
        data: {
          displayName: 'ลบข้อมูลแล้ว (PDPA)',
          firstName: null,
          lastName: null,
          phoneE164: null,
          phoneHash: null,
          email: null,
          lineUserId: null,
          idNumberEnc: null,
          idNumberHash: null,
          idExpiresOn: null,
          dateOfBirth: null,
          address: Prisma.DbNull,
          emergencyContact: Prisma.DbNull,
          notes: null,
          anonymisedAt: now,
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await tx.partyUserLink.updateMany({
        where: { partyId: p.id, state: 'active' },
        data: { state: 'unlinked', unlinkedAt: now, unlinkReason: `dsr:${dsr.id}` },
      });
      const docs = await tx.document.findMany({
        where: {
          tenantId: ctx.tenantId,
          scopeType: 'party',
          scopeId: p.id,
          kind: 'id_document',
          deletedAt: null,
        },
      });
      for (const d of docs) {
        const derivatives = await this.ledger.uncount(tx, d.id);
        await tx.document.update({
          where: { id: d.id },
          data: { deletedAt: now, deleteReason: `dsr erasure ${dsr.id}`, uploadState: 'deleted' },
        });
        objects.push(d.storageKey, ...(d.thumbnailKey ? [d.thumbnailKey] : []), ...derivatives);
      }
    }
  }
}
