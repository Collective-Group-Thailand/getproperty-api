import { createHash } from 'node:crypto';

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
import { OBJECT_STORAGE, type ObjectStorage } from '@integrations/s3/object-storage.port';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import { TenantDataKeys } from '../tenancy/data-keys.service';
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
    return this.db.tenant(ctx, async (tx) => {
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
        if (dsr.kind === 'erasure') await this.erase(tx, ctx, dsr);
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
    await this.audit.record(tx, {
      action: 'export.created',
      tenantId: ctx.tenantId,
      subjectType: 'core.document',
      subjectId: id,
      metadata: { reason: 'dsr', dsrId: dsr.id },
    });
    return id;
  }

  private async erase(tx: Tx, ctx: TenantContext, dsr: DataSubjectRequest): Promise<void> {
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
        await this.storage.delete(d.storageKey).catch(() => undefined);
        await tx.document.update({
          where: { id: d.id },
          data: { deletedAt: now, deleteReason: `dsr erasure ${dsr.id}`, uploadState: 'deleted' },
        });
      }
    }
  }
}
