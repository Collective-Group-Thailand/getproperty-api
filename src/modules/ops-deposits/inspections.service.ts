import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type InspectionType, type ItemCondition, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { DepositDocuments } from './deposit-documents';
import { type ChecklistItem, DEFAULT_INSPECTION_TEMPLATE_NAME } from './inspection-checklist';

const by = () => userIdOf(RequestContext.actor());
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

export const INSPECTION_INCLUDE = {
  items: { orderBy: [{ sortOrder: 'asc' }, { itemKey: 'asc' }] },
  unit: { select: { id: true, unitNo: true } },
  lease: { select: { id: true, number: true, lesseePartyId: true } },
} as const satisfies Prisma.InspectionInclude;
export type InspectionRow = Prisma.InspectionGetPayload<{ include: typeof INSPECTION_INCLUDE }>;

export interface InspectionItemPatch {
  itemKey: string;
  condition?: ItemCondition | null;
  notes?: string | null;
  photoDocumentIds?: string[];
  meterRegister?: string | null;
}

/**
 * Move-in / move-out inspections (B2.4, D-023): the checklist comes from the room type's template (or the platform
 * default), plus the unit's appliances and furniture (`asset:<id>`) and one register line per assigned meter
 * (`meter:<utility>`), so move-in and move-out compare item by item. Staff fill conditions, notes, photos
 * (`core.document` kind `inspection_photo`) and meter registers; completing numbers the report (series
 * `inspection_report`) and stores its PDF with the signatures. A completed move-out inspection moves the deposit
 * settlement to `inspected`.
 */
@Injectable()
export class InspectionsService extends TenantScopedRepository {
  private readonly afterCompleted: ((tx: Tx, inspection: InspectionRow) => Promise<void>)[] = [];

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEvents,
    private readonly documents: DocumentsService,
    private readonly numbering: DocumentNumbering,
    private readonly renderer: DepositDocuments,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onCompleted(hook: (tx: Tx, inspection: InspectionRow) => Promise<void>): void {
    this.afterCompleted.push(hook);
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<InspectionRow> {
    const row = this.found(await tx.inspection.findFirst({ where: { id }, include: INSPECTION_INCLUDE }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId))
      throw new DomainException('http.not_found');
    return row;
  }

  private async ownInspection(tx: Tx, ctx: TenantContext, id: string): Promise<InspectionRow> {
    const row = await this.load(tx, ctx, id);
    if (row.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
    return row;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: {
      leaseId?: string;
      unitId?: string;
      type?: InspectionType;
      status?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.InspectionWhereInput = {
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(q.leaseId ? { leaseId: q.leaseId } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.status ? { status: q.status as never } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.inspection.findMany({
          where,
          include: INSPECTION_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.inspection.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** The checklist lines of a unit: template items + appliances/furniture + one register line per meter. */
  private async checklist(
    tx: Tx,
    unitId: string,
  ): Promise<{
    templateId: string | null;
    items: Omit<Prisma.InspectionItemCreateManyInput, 'tenantId' | 'inspectionId'>[];
  }> {
    const detail = await tx.unitDetail.findUnique({ where: { unitId }, include: { profile: true } });
    const template =
      (detail?.profile?.inspectionTemplateId
        ? await tx.inspectionTemplate.findUnique({ where: { id: detail.profile.inspectionTemplateId } })
        : null) ??
      (await tx.inspectionTemplate.findFirst({
        where: { tenantId: null, name: DEFAULT_INSPECTION_TEMPLATE_NAME },
      }));
    const base = ((template?.items ?? []) as unknown as ChecklistItem[]).map((i) => ({
      itemKey: i.key,
      label: i.labelTh,
      area: i.area,
    }));
    const assets = await tx.assetItem.findMany({
      where: {
        unitId,
        deletedAt: null,
        status: 'active',
        category: { in: ['appliance', 'furniture', 'hvac'] },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    const meters = await tx.meterAssignment.findMany({
      where: { unitId, validTo: null, purpose: 'unit' },
      orderBy: { utility: 'asc' },
    });
    const items = [
      ...base,
      ...assets.map((a) => ({ itemKey: `asset:${a.id}`, label: a.name, area: a.location ?? 'room' })),
      ...meters.map((m) => ({
        itemKey: `meter:${m.utility}`,
        label: m.utility === 'electric' ? `มิเตอร์ไฟฟ้า ${m.code}` : `มิเตอร์น้ำ ${m.code}`,
        area: 'meters',
        meterAssetItemId: m.assetItemId,
      })),
    ].map((i, n) => ({ ...i, sortOrder: n }));
    return { templateId: template?.id ?? null, items };
  }

  /** Creates a move-in / move-out inspection of a lease (409 `inspection.exists` when the lease already has one). */
  async create(
    ctx: TenantContext,
    input: { leaseId: string; type: 'move_in' | 'move_out'; scheduledFor?: string },
  ) {
    return this.db.tenant(ctx, (tx) => this.createIn(tx, ctx.tenantId, input, ctx));
  }

  /** Inside a caller's transaction (the deposit settlement opens the move-out inspection task). */
  async createIn(
    tx: Tx,
    tenantId: string,
    input: { leaseId: string; type: 'move_in' | 'move_out'; scheduledFor?: string },
    ctx?: TenantContext,
  ): Promise<InspectionRow> {
    const lease = this.found(await tx.lease.findFirst({ where: { id: input.leaseId } }));
    if (ctx?.buildingIds && !ctx.buildingIds.includes(lease.buildingId))
      throw new DomainException('http.not_found');
    if (lease.tenantId !== tenantId) throw new DomainException('asset.read_only');
    if (['draft', 'cancelled'].includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    const existing = await tx.inspection.findFirst({ where: { leaseId: lease.id, type: input.type } });
    if (existing) throw new DomainException('inspection.exists');
    const { templateId, items } = await this.checklist(tx, lease.unitId);
    const inspection = await tx.inspection.create({
      data: {
        tenantId,
        buildingId: lease.buildingId,
        unitId: lease.unitId,
        leaseId: lease.id,
        type: input.type,
        templateId,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        createdBy: by(),
      },
    });
    await tx.inspectionItem.createMany({
      data: items.map((i) => ({ ...i, tenantId, inspectionId: inspection.id, createdBy: by() })),
    });
    await this.audit.record(tx, {
      action: 'inspection.created',
      tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.inspection',
      subjectId: inspection.id,
      metadata: { leaseId: lease.id, type: input.type, items: items.length },
    });
    await this.domainEvents.record(tx, {
      type: 'inspection.created',
      aggregateType: 'inspection',
      aggregateId: inspection.id,
      tenantId,
      buildingId: lease.buildingId,
      payload: { inspectionId: inspection.id, leaseId: lease.id, unitId: lease.unitId, type: input.type },
    });
    return tx.inspection.findUniqueOrThrow({ where: { id: inspection.id }, include: INSPECTION_INCLUDE });
  }

  /** Photos must be uploaded files of the tenant (any image kind; inspection photos by convention). */
  private async ownDocuments(tx: Tx, ctx: TenantContext, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const n = await tx.document.count({
      where: this.own(ctx, { id: { in: unique }, deletedAt: null, uploadState: { not: 'presigned' } }),
    });
    if (n !== unique.length) throw new DomainException('http.not_found');
    return unique;
  }

  /** Fills checklist lines (condition, notes, photos, meter register); scheduled → in progress. If-Match. */
  async updateItems(ctx: TenantContext, id: string, version: number, patches: InspectionItemPatch[]) {
    return this.db.tenant(ctx, async (tx) => {
      const inspection = await this.ownInspection(tx, ctx, id);
      if (inspection.version !== version) throw new DomainException('concurrency.stale');
      if (!['scheduled', 'in_progress'].includes(inspection.status))
        throw new DomainException('inspection.invalid_state', { params: { status: inspection.status } });
      const byKey = new Map(inspection.items.map((i) => [i.itemKey, i]));
      for (const [n, p] of patches.entries()) {
        const item = byKey.get(p.itemKey);
        if (!item)
          throw new DomainException('validation.failed', {
            errors: [
              { path: `items[${n}].itemKey`, code: 'unknownItem', message: `no checklist line ${p.itemKey}` },
            ],
          });
        if (p.meterRegister !== undefined && p.meterRegister !== null && !item.meterAssetItemId)
          throw new DomainException('validation.failed', {
            errors: [
              {
                path: `items[${n}].meterRegister`,
                code: 'notMeter',
                message: 'only meter lines take a register',
              },
            ],
          });
        await tx.inspectionItem.update({
          where: { id: item.id },
          data: {
            ...(p.condition !== undefined ? { condition: p.condition } : {}),
            ...(p.notes !== undefined ? { notes: p.notes } : {}),
            ...(p.photoDocumentIds
              ? { photoDocumentIds: await this.ownDocuments(tx, ctx, p.photoDocumentIds) }
              : {}),
            ...(p.meterRegister !== undefined
              ? { meterRegister: p.meterRegister === null ? null : new Decimal(p.meterRegister).toFixed(3) }
              : {}),
            updatedBy: by(),
          },
        });
      }
      await tx.inspection.update({
        where: { id },
        data: {
          status: 'in_progress',
          startedAt: inspection.startedAt ?? this.clock.now(),
          inspectorUserId: inspection.inspectorUserId ?? by(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'inspection.updated',
        tenantId: inspection.tenantId,
        buildingId: inspection.buildingId,
        subjectType: 'ops.inspection',
        subjectId: id,
        metadata: { items: patches.map((p) => p.itemKey) },
      });
      return this.load(tx, ctx, id);
    });
  }

  signature(base64: string | undefined): Buffer | null {
    if (!base64) return null;
    const body = Buffer.from(base64, 'base64');
    if (!body.subarray(0, 8).equals(PNG) || body.length > 200_000)
      throw new DomainException('lease.signature_invalid');
    return body;
  }

  /**
   * Completes the inspection: every line has a condition (or `not_applicable`); the report number from the
   * `inspection_report` series, the report PDF and the signatures are stored; `signed` when the resident signed too.
   */
  async complete(
    ctx: TenantContext,
    id: string,
    input: { staffSignaturePng?: string; residentSignaturePng?: string; notes?: string | null },
  ) {
    const staffPng = this.signature(input.staffSignaturePng);
    const residentPng = this.signature(input.residentSignaturePng);
    return this.db.tenant(
      ctx,
      async (tx) => {
        const inspection = await this.ownInspection(tx, ctx, id);
        if (!['scheduled', 'in_progress'].includes(inspection.status))
          throw new DomainException('inspection.invalid_state', { params: { status: inspection.status } });
        const missing = inspection.items.filter((i) => !i.condition);
        if (missing.length)
          throw new DomainException('validation.failed', {
            errors: missing.map((i) => ({
              path: `items.${i.itemKey}.condition`,
              code: 'required',
              message: 'set a condition',
            })),
          });
        const now = this.clock.now();
        const number = await this.numbering.next(tx, inspection.tenantId, 'inspection_report', now);
        const store = (title: string, body: Buffer, kind: 'signature' | 'pdf_report', mimeType: string) =>
          this.documents.storeGenerated(tx, {
            tenantId: inspection.tenantId,
            kind,
            scopeType: 'unit',
            scopeId: inspection.unitId,
            buildingId: inspection.buildingId,
            title,
            mimeType,
            body,
          });
        const staffSig = staffPng
          ? await store(`ลายมือชื่อผู้ตรวจ ${number}.png`, staffPng, 'signature', 'image/png')
          : null;
        const residentSig = residentPng
          ? await store(`ลายมือชื่อผู้เช่า ${number}.png`, residentPng, 'signature', 'image/png')
          : null;
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: inspection.tenantId },
          select: { displayName: true },
        });
        const pdf = await this.renderer.inspectionReport({
          number,
          tenantName: tenant.displayName,
          unit: inspection.unit.unitNo,
          type: inspection.type,
          completedOn: bangkokDate(now),
          items: inspection.items.map((i) => ({
            label: i.label,
            condition: i.condition!,
            notes: i.notes,
            photos: i.photoDocumentIds.length,
            meterRegister: i.meterRegister?.toFixed(3) ?? null,
          })),
          notes: input.notes ?? inspection.notes,
        });
        const report = await store(
          `บันทึกการตรวจสภาพห้อง ${number}.pdf`,
          pdf,
          'pdf_report',
          'application/pdf',
        );
        await tx.inspection.update({
          where: { id },
          data: {
            status: residentSig ? 'signed' : 'completed',
            startedAt: inspection.startedAt ?? now,
            completedAt: now,
            inspectorUserId: inspection.inspectorUserId ?? by(),
            reportNumber: number,
            reportDocumentId: report.id,
            staffSignatureDocumentId: staffSig?.id ?? null,
            residentSignatureDocumentId: residentSig?.id ?? null,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'inspection.completed',
          tenantId: inspection.tenantId,
          buildingId: inspection.buildingId,
          subjectType: 'ops.inspection',
          subjectId: id,
          metadata: {
            number,
            type: inspection.type,
            damaged: inspection.items.filter((i) => ['damaged', 'missing'].includes(i.condition ?? ''))
              .length,
          },
        });
        await this.domainEvents.record(tx, {
          type: 'inspection.completed',
          aggregateType: 'inspection',
          aggregateId: id,
          tenantId: inspection.tenantId,
          buildingId: inspection.buildingId,
          payload: { inspectionId: id, leaseId: inspection.leaseId, type: inspection.type, number },
        });
        const fresh = await this.load(tx, ctx, id);
        for (const hook of this.afterCompleted) await hook(tx, fresh);
        return fresh;
      },
      { timeout: 60_000 },
    );
  }

  /** Signed URL of the report PDF (audited download). */
  async report(ctx: TenantContext, id: string) {
    const inspection = await this.get(ctx, id);
    if (!inspection.reportDocumentId)
      throw new DomainException('inspection.invalid_state', { params: { status: inspection.status } });
    return {
      inspection,
      download: await this.documents.download(ctx, inspection.reportDocumentId, 'inspection_report'),
    };
  }

  /** Move-in vs move-out per checklist line of a lease (missing side = null). */
  async comparison(tx: Tx, leaseId: string) {
    const [moveIn, moveOut] = await Promise.all([
      tx.inspection.findFirst({ where: { leaseId, type: 'move_in' }, include: INSPECTION_INCLUDE }),
      tx.inspection.findFirst({ where: { leaseId, type: 'move_out' }, include: INSPECTION_INCLUDE }),
    ]);
    const keys = [...new Set([...(moveIn?.items ?? []), ...(moveOut?.items ?? [])].map((i) => i.itemKey))];
    const order = new Map(
      [...(moveOut?.items ?? []), ...(moveIn?.items ?? [])].map((i) => [i.itemKey, i.sortOrder]),
    );
    keys.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return {
      moveIn,
      moveOut,
      lines: keys.map((key) => {
        const a = moveIn?.items.find((i) => i.itemKey === key) ?? null;
        const b = moveOut?.items.find((i) => i.itemKey === key) ?? null;
        return {
          itemKey: key,
          label: (b ?? a)!.label,
          area: (b ?? a)!.area,
          moveIn: a,
          moveOut: b,
          changed: Boolean(a && b && a.condition !== b.condition),
        };
      }),
    };
  }

  /**
   * The resident countersigns a report the owner completed without their signature (L5 5.2, D-253: landlords' move-in
   * and move-out reports are often signed apart): the signature is stored beside the report, the inspection becomes
   * `signed`, the owner hears it. The report PDF itself is not re-issued (its number and content stay as completed).
   */
  async countersign(ctx: TenantContext, id: string, partyId: string, png: Buffer): Promise<InspectionRow> {
    return this.db.tenant(ctx, async (tx) => {
      const inspection = await this.load(tx, ctx, id);
      if (inspection.status !== 'completed' || inspection.residentSignatureDocumentId)
        throw new DomainException('inspection.invalid_state', { params: { status: inspection.status } });
      const signature = await this.documents.storeGenerated(tx, {
        tenantId: inspection.tenantId,
        kind: 'signature',
        scopeType: 'unit',
        scopeId: inspection.unitId,
        buildingId: inspection.buildingId,
        title: `ลายมือชื่อผู้เช่า ${inspection.reportNumber ?? id}.png`,
        mimeType: 'image/png',
        body: png,
      });
      await tx.inspection.update({
        where: { id },
        data: {
          status: 'signed',
          residentSignatureDocumentId: signature.id,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'inspection.countersigned',
        tenantId: inspection.tenantId,
        buildingId: inspection.buildingId,
        subjectType: 'ops.inspection',
        subjectId: id,
        metadata: { number: inspection.reportNumber, type: inspection.type, partyId },
      });
      await this.domainEvents.record(tx, {
        type: 'inspection.countersigned',
        aggregateType: 'inspection',
        aggregateId: id,
        tenantId: inspection.tenantId,
        buildingId: inspection.buildingId,
        payload: {
          inspectionId: id,
          leaseId: inspection.leaseId,
          type: inspection.type,
          number: inspection.reportNumber,
          unitNo: inspection.unit.unitNo,
          partyId,
        },
      });
      return this.load(tx, ctx, id);
    });
  }
}
