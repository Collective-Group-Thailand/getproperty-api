import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type ExportJob, type ExportKind, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

const by = () => userIdOf(RequestContext.actor());

export interface ExportFile {
  fileName: string;
  mimeType: string;
  body: Buffer;
  rowCount: number;
}

/** One export format (B4.3 document archive; B4.5 Excel, FlowAccount, PEAK, VAT figures). */
export interface ExportBuilder {
  readonly kind: ExportKind;
  /** Field errors of the request parameters (empty = valid). */
  validate(params: Record<string, unknown>): { path: string; message: string }[];
  build(tx: Tx, job: ExportJob): Promise<ExportFile>;
}

export const EXPORT_INCLUDE = { fileDocument: true } as const satisfies Prisma.ExportJobInclude;
export type ExportJobRow = Prisma.ExportJobGetPayload<{ include: typeof EXPORT_INCLUDE }>;

/**
 * Export jobs (B4.3, D-051, `ops.export_job`): an operator requests an export (idempotent), the worker builds it
 * (`export.requested` subscriber, inside one transaction), the file is stored as a `core.document` (kind `export`)
 * and announced (`export.completed`); a failure is kept on the job with its reason. Builders register per kind.
 */
@Injectable()
export class ExportsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'exports';
  readonly eventTypes = ['export.requested'] as const;
  private readonly logger = new Logger(ExportsService.name);
  private readonly builders = new Map<ExportKind, ExportBuilder>();

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly documents: DocumentsService,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  register(builder: ExportBuilder): void {
    this.builders.set(builder.kind, builder);
  }

  kinds(): ExportKind[] {
    return [...this.builders.keys()];
  }

  async request(
    ctx: TenantContext,
    input: { kind: ExportKind; params: Record<string, unknown> },
  ): Promise<ExportJobRow> {
    const builder = this.builders.get(input.kind);
    if (!builder)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'kind', code: 'unsupported', message: `${input.kind} is not available yet` }],
      });
    const problems = builder.validate(input.params);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((p) => ({ path: `params.${p.path}`, code: 'invalid', message: p.message })),
      });
    const buildingId = typeof input.params.buildingId === 'string' ? input.params.buildingId : null;
    return this.db.tenant(ctx, async (tx) => {
      if (buildingId) {
        const b = await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } });
        if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
          throw new DomainException('http.not_found');
      } else if (ctx.buildingIds) {
        // Staff limited to buildings export one building at a time
        throw new DomainException('validation.failed', {
          errors: [{ path: 'params.buildingId', code: 'required', message: 'choose one of your buildings' }],
        });
      }
      const job = await tx.exportJob.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId,
          kind: input.kind,
          params: input.params as Prisma.InputJsonValue,
          requestedBy: by(),
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'export.created',
        tenantId: ctx.tenantId,
        buildingId,
        subjectType: 'ops.export_job',
        subjectId: job.id,
        metadata: { kind: input.kind, params: input.params } as Prisma.InputJsonValue,
      });
      await this.events.record(tx, {
        type: 'export.requested',
        aggregateType: 'export_job',
        aggregateId: job.id,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { exportJobId: job.id, kind: input.kind },
      });
      return tx.exportJob.findUniqueOrThrow({ where: { id: job.id }, include: EXPORT_INCLUDE });
    });
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<ExportJobRow> {
    const job = this.found(
      await tx.exportJob.findFirst({ where: this.own(ctx, { id }), include: EXPORT_INCLUDE }),
    );
    if (ctx.buildingIds && (!job.buildingId || !ctx.buildingIds.includes(job.buildingId)))
      throw new DomainException('http.not_found');
    return job;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(ctx: TenantContext, q: { kind?: ExportKind; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.ExportJobWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.exportJob.findMany({
          where,
          include: EXPORT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip: q.skip,
          take: q.take,
        }),
        tx.exportJob.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** A signed link to the file of a finished export. */
  async download(ctx: TenantContext, id: string) {
    const job = await this.get(ctx, id);
    if (job.status !== 'done' || !job.fileDocument) throw new DomainException('export.not_ready');
    return { job, link: await this.documents.signedUrl(job.fileDocument) };
  }

  // ------------------------------------------------------------------------------------------- worker

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    await this.run(tx, event.payload.exportJobId as string);
  }

  /** Builds one queued job inside the subscriber's transaction; a failure is recorded on the job. */
  async run(tx: Tx, jobId: string): Promise<void> {
    const job = await tx.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'queued') return;
    const builder = this.builders.get(job.kind);
    const started = this.clock.now();
    await tx.$executeRawUnsafe('SAVEPOINT export_build');
    try {
      if (!builder) throw new Error(`no builder for ${job.kind}`);
      const file = await builder.build(tx, job);
      const doc = await this.documents.storeGenerated(tx, {
        tenantId: job.tenantId,
        kind: 'export',
        scopeType: job.buildingId ? 'building' : 'tenant',
        scopeId: job.buildingId ?? job.tenantId,
        buildingId: job.buildingId,
        title: file.fileName,
        mimeType: file.mimeType,
        body: file.body,
      });
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT export_build');
      await tx.exportJob.update({
        where: { id: jobId },
        data: {
          status: 'done',
          startedAt: started,
          finishedAt: this.clock.now(),
          fileDocumentId: doc.id,
          rowCount: file.rowCount,
          version: { increment: 1 },
        },
      });
      await this.events.record(tx, {
        type: 'export.completed',
        aggregateType: 'export_job',
        aggregateId: jobId,
        tenantId: job.tenantId,
        buildingId: job.buildingId,
        payload: { exportJobId: jobId, kind: job.kind, documentId: doc.id, rowCount: file.rowCount },
      });
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT export_build');
      this.logger.error(`export ${jobId} (${job.kind}) failed: ${(error as Error).message}`);
      await tx.exportJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          startedAt: started,
          finishedAt: this.clock.now(),
          error: (error as Error).message.slice(0, 500),
          version: { increment: 1 },
        },
      });
    }
  }
}
