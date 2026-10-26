import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { WorkflowService } from '@core/workflow/workflow.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type Tm30Export, type Tm30Status } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { TM30_FORMAT, tm30Missing, type Tm30Person, tm30Workbook } from './tm30-format';

const SUBJECT_TYPE = 'ops.tm30_export';
/** Occupancy roles of the people who stay at the premises (owner-occupiers notify for themselves). */
const STAYING_ROLES = ['tenant', 'co_tenant', 'family'] as const;
const PENDING: Tm30Status[] = ['due', 'generated', 'downloaded'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const TM30_INCLUDE = {
  party: { include: { occupantProfileParty: true } },
  unit: { select: { unitNo: true } },
  workflowInstance: { select: { slaDueAt: true, state: true } },
} as const satisfies Prisma.Tm30ExportInclude;
export type Tm30Row = Prisma.Tm30ExportGetPayload<{ include: typeof TM30_INCLUDE }>;

/** A party is foreign for TM30 when its nationality is not Thai, or (nationality unknown) it identified by passport. */
export const isForeign = (p: { nationality: string | null; idDocumentType: string | null }) =>
  p.nationality ? p.nationality.toUpperCase() !== 'TH' : p.idDocumentType === 'passport';

/**
 * TM30 data pack (B6.2, D-052, D-216; Immigration Act B.E. 2522 s.38). When a lease's occupants move in
 * (`lease.activated` already occupied, or `lease.moved_in` on the start date) every foreign occupant (tenant,
 * co-tenant, family) gets one `ops.tm30_export` row and a `tm30_notification` workflow due 24 h after the move-in
 * (`tm30.notify_within_hours`): the owner and managers are told at once (`tm30.due`), reminded 6 h before and told
 * again at the deadline (`workflow.sla_reminder` / `workflow.sla_breached`). The owner generates the Immigration
 * Bureau upload file of a building (passport numbers decrypted, each reveal audited), uploads it to the Immigration
 * Bureau's system and records the submission — the platform never submits (no public API). The rows are the
 * building's export log.
 */
@Injectable()
export class Tm30Service extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'tm30';
  readonly eventTypes = ['lease.activated', 'lease.moved_in'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly workflow: WorkflowService,
    private readonly settings: SettingsService,
    private readonly keys: TenantDataKeys,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('foreign_stay.due', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: { tenant: { name: await tenantName(tx, e.tenantId) }, tm30: e.payload },
          }
        : null,
    );
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'lease.activated' && event.payload.occupied !== true) return;
    await this.openFor(tx, event.payload.leaseId as string);
  }

  /** Opens the TM30 duties of a lease that moved in (idempotent per lease × party). */
  async openFor(tx: Tx, leaseId: string): Promise<Tm30Export[]> {
    const lease = await tx.lease.findUnique({ where: { id: leaseId } });
    if (!lease?.moveInAt) return [];
    const occupancies = await tx.occupancy.findMany({
      where: { leaseId, role: { in: [...STAYING_ROLES] } },
      include: { party: { include: { occupantProfileParty: true } } },
    });
    const hours = Number(
      (await this.settings.at('tm30.notify_within_hours', lease.moveInAt, { tenantId: lease.tenantId }))
        ?.value ?? 24,
    );
    const opened: Tm30Export[] = [];
    for (const o of occupancies) {
      if (!isForeign(o.party)) continue;
      if (await tx.tm30Export.findUnique({ where: { leaseId_partyId: { leaseId, partyId: o.partyId } } }))
        continue;
      const movedInAt = o.movedInAt ?? lease.moveInAt;
      const row = await tx.tm30Export.create({
        data: {
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          unitId: lease.unitId,
          leaseId,
          partyId: o.partyId,
          arrivalDate: o.party.occupantProfileParty?.arrivalDate ?? null,
          movedInAt,
          dueAt: new Date(movedInAt.getTime() + hours * 3_600_000),
          format: TM30_FORMAT,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      const instance = await this.workflow.start(tx, {
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        subjectType: SUBJECT_TYPE,
        subjectId: row.id,
        definitionKey: 'tm30_notification',
        clockStart: movedInAt,
      });
      const linked = await tx.tm30Export.update({
        where: { id: row.id },
        data: { workflowInstanceId: instance.id, dueAt: instance.slaDueAt ?? row.dueAt },
      });
      await this.audit.record(tx, {
        action: 'foreign_stay.opened',
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        subjectType: SUBJECT_TYPE,
        subjectId: row.id,
        metadata: { leaseId, partyId: o.partyId, dueAt: linked.dueAt.toISOString() },
      });
      const unit = await tx.unit.findUnique({ where: { id: lease.unitId }, select: { unitNo: true } });
      await this.events.record(tx, {
        type: 'foreign_stay.due',
        aggregateType: 'tm30_export',
        aggregateId: row.id,
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        payload: {
          tm30ExportId: row.id,
          leaseId,
          unitNo: unit?.unitNo ?? '',
          name: o.party.displayName,
          dueAt: linked.dueAt.toISOString(),
          missing: tm30Missing(this.person(o.party, null, bangkokDate(movedInAt), unit?.unitNo ?? '')),
        },
      });
      opened.push(linked);
    }
    return opened;
  }

  private person(
    party: {
      nationality: string | null;
      firstName: string | null;
      lastName: string | null;
      gender: string | null;
      dateOfBirth: Date | null;
      idNumberEnc: Uint8Array | null;
      idDocumentType: string | null;
      occupantProfileParty?: {
        arrivalDate: Date | null;
        visaType: string | null;
        entryPort: string | null;
      } | null;
    },
    passportNo: string | null,
    checkInDate: string,
    unitNo: string,
  ): Tm30Person {
    const profile = party.occupantProfileParty ?? null;
    return {
      // without decrypting: a sealed passport number counts as present
      passportNo:
        passportNo ?? (party.idNumberEnc && party.idDocumentType === 'passport' ? '(sealed)' : null),
      nationality: party.nationality,
      firstName: party.firstName,
      lastName: party.lastName,
      gender: party.gender,
      dateOfBirth: party.dateOfBirth ? party.dateOfBirth.toISOString().slice(0, 10) : null,
      arrivalDate: profile?.arrivalDate ? profile.arrivalDate.toISOString().slice(0, 10) : null,
      visaType: profile?.visaType ?? null,
      entryPort: profile?.entryPort ?? null,
      checkInDate,
      unitNo,
    };
  }

  /** What the Immigration Bureau requires and is still missing for a row (no decryption). */
  missing(row: Tm30Row): string[] {
    return tm30Missing(this.person(row.party, null, bangkokDate(row.movedInAt), row.unit.unitNo));
  }

  // ------------------------------------------------------------------------------------------------- operators

  list(ctx: TenantContext, q: { buildingId?: string; status?: Tm30Status; skip: number; take: number }) {
    const where: Prisma.Tm30ExportWhereInput = this.own(ctx, {
      ...(q.buildingId ? { buildingId: q.buildingId } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    return this.db.tenant(ctx, async (tx) => ({
      rows: await tx.tm30Export.findMany({
        where,
        include: TM30_INCLUDE,
        orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.take,
      }),
      total: await tx.tm30Export.count({ where }),
    }));
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.tm30Export.findFirst({ where: this.own(ctx, { id }), include: TM30_INCLUDE })),
    );
  }

  /**
   * The Immigration Bureau upload file of a building: every pending row (or the chosen ones) in one `.xlsx`
   * (`immigration_xlsx_v1`), stored as an export document; the rows move to `generated` (workflow `generate`).
   * Passport numbers are decrypted for the file only, one `pii.decrypted` audit row per person. Rows missing
   * required data → 422 `tm30.data_missing` with the fields per row.
   */
  async generate(ctx: TenantContext, buildingId: string, exportIds?: string[]) {
    const now = this.clock.now();
    return this.db.tenant(ctx, async (tx) => {
      const building = this.found(
        await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } }),
      );
      const rows = await tx.tm30Export.findMany({
        where: this.own(ctx, {
          buildingId,
          status: { in: PENDING },
          ...(exportIds?.length ? { id: { in: exportIds } } : {}),
        }),
        include: TM30_INCLUDE,
        orderBy: { movedInAt: 'asc' },
      });
      if (exportIds?.length && rows.length !== new Set(exportIds).size)
        throw new DomainException('http.not_found');
      if (!rows.length) throw new DomainException('tm30.nothing_pending');
      const problems = rows
        .map((r) => ({ r, missing: this.missing(r) }))
        .filter((x) => x.missing.length)
        .flatMap((x) =>
          x.missing.map((f) => ({
            path: `exports.${x.r.id}.${f}`,
            code: 'required',
            message: `${x.r.party.displayName} (${x.r.unit.unitNo}): ${f} is required`,
          })),
        );
      if (problems.length) throw new DomainException('tm30.data_missing', { errors: problems });
      const people: Tm30Person[] = [];
      for (const r of rows) {
        const passportNo = await this.keys.decrypt(
          tx,
          { tenantId: r.tenantId, table: 'core.party', column: 'id_number', rowId: r.partyId },
          r.party.idNumberEnc!,
        );
        await this.audit.record(tx, {
          action: 'pii.decrypted',
          tenantId: ctx.tenantId,
          buildingId,
          subjectType: 'core.party',
          subjectId: r.partyId,
          metadata: { field: 'id_number', purpose: 'tm30_export', tm30ExportId: r.id },
        });
        people.push(this.person(r.party, passportNo, bangkokDate(r.movedInAt), r.unit.unitNo));
      }
      const body = await tm30Workbook(people, now);
      const doc = await this.documents.storeGenerated(tx, {
        tenantId: ctx.tenantId,
        kind: 'export',
        scopeType: 'building',
        scopeId: buildingId,
        buildingId,
        title: `tm30-${building.code}-${bangkokDate(now)}.xlsx`,
        mimeType: XLSX,
        body,
        retentionClass: 'export',
        holdPolicyKey: 'tm30_export', // D-286: kept as a legal document
      });
      const actor = userIdOf(RequestContext.actor());
      for (const r of rows) {
        await tx.tm30Export.update({
          where: { id: r.id },
          data: {
            status: 'generated',
            generatedAt: now,
            generatedBy: actor,
            fileDocumentId: doc.id,
            downloadedAt: null,
            version: { increment: 1 },
            updatedBy: actor,
          },
        });
        if (r.workflowInstanceId) await this.workflow.transition(tx, r.workflowInstanceId, 'generate');
      }
      await this.audit.record(tx, {
        action: 'foreign_stay.file_generated',
        tenantId: ctx.tenantId,
        buildingId,
        subjectType: 'core.document',
        subjectId: doc.id,
        metadata: { exports: rows.map((r) => r.id), format: TM30_FORMAT },
      });
      await this.events.record(tx, {
        type: 'foreign_stay.file_generated',
        aggregateType: 'building',
        aggregateId: buildingId,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { buildingId, documentId: doc.id, exports: rows.map((r) => r.id) },
      });
      const fresh = await tx.tm30Export.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        include: TM30_INCLUDE,
        orderBy: { movedInAt: 'asc' },
      });
      return { document: doc, rows: fresh, ...(await this.documents.signedUrl(doc)) };
    });
  }

  /** A 5-minute link to the upload file of a row (audited; the rows of that file become `downloaded`). */
  async download(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.tm30Export.findFirst({ where: this.own(ctx, { id }) }));
      if (!row.fileDocumentId)
        throw new DomainException('tm30.invalid_state', { params: { status: row.status } });
      const doc = await tx.document.findUniqueOrThrow({ where: { id: row.fileDocumentId } });
      await tx.tm30Export.updateMany({
        where: { fileDocumentId: doc.id, status: 'generated' },
        data: { status: 'downloaded', downloadedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        action: 'foreign_stay.file_downloaded',
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        subjectType: 'core.document',
        subjectId: doc.id,
        metadata: { tm30ExportId: id },
      });
      return { document: doc, ...(await this.documents.signedUrl(doc)) };
    });
  }

  /** The owner uploaded the file at the Immigration Bureau and records it (the receipt number is optional). */
  async markSubmitted(
    ctx: TenantContext,
    id: string,
    input: { submittedAt?: Date; reference?: string | null },
  ) {
    return this.transitionRow(ctx, id, 'submit', (row, now) => ({
      status: 'submitted_manually',
      submittedAt:
        input.submittedAt && input.submittedAt.getTime() <= now.getTime() ? input.submittedAt : now,
      submittedBy: userIdOf(RequestContext.actor()),
      submissionRef: input.reference ?? null,
      reminderSentAt: row.reminderSentAt,
    }));
  }

  /** Not due after all (e.g. the occupant is Thai, or the stay ended before the notification), with a reason. */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    return this.transitionRow(ctx, id, 'cancel', () => ({ status: 'cancelled', cancelReason: reason }));
  }

  private async transitionRow(
    ctx: TenantContext,
    id: string,
    event: 'submit' | 'cancel',
    data: (row: Tm30Export, now: Date) => Prisma.Tm30ExportUpdateInput,
  ) {
    const now = this.clock.now();
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.tm30Export.findFirst({ where: this.own(ctx, { id }) }));
      if (!PENDING.includes(row.status))
        throw new DomainException('tm30.invalid_state', { params: { status: row.status } });
      const updated = await tx.tm30Export.update({
        where: { id },
        data: { ...data(row, now), version: { increment: 1 }, updatedBy: userIdOf(RequestContext.actor()) },
      });
      if (row.workflowInstanceId) await this.workflow.transition(tx, row.workflowInstanceId, event);
      await this.audit.record(tx, {
        action: event === 'submit' ? 'foreign_stay.submitted' : 'foreign_stay.cancelled',
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT_TYPE,
        subjectId: id,
        before: { status: row.status },
        after: {
          status: updated.status,
          submissionRef: updated.submissionRef,
          cancelReason: updated.cancelReason,
        },
      });
      if (event === 'submit')
        await this.events.record(tx, {
          type: 'foreign_stay.submitted',
          aggregateType: 'tm30_export',
          aggregateId: id,
          tenantId: ctx.tenantId,
          buildingId: row.buildingId,
          payload: { tm30ExportId: id, leaseId: row.leaseId, partyId: row.partyId },
        });
    });
    return this.get(ctx, id);
  }

  /** Worker: TM30 duties of leases that moved in before this subscriber existed (or whose event was missed). */
  async sweep(): Promise<number> {
    const since = new Date(this.clock.now().getTime() - 7 * 86_400_000);
    return RequestContext.run({ actor: systemActor('tm30') }, async () => {
      const leases = await this.db.platform((tx) =>
        tx.lease.findMany({
          where: { moveInAt: { gte: since }, status: { in: ['active', 'notice_given'] } },
          select: { id: true },
        }),
      );
      let opened = 0;
      for (const l of leases) opened += (await this.db.platform((tx) => this.openFor(tx, l.id))).length;
      return opened;
    });
  }
}
