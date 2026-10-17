import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { toBangkokIso } from '@common/time/bangkok';
import { AiUsageService } from '@core/ai-usage/ai-usage.service';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { isUniqueViolation, raisedWith } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type MeterAssignment,
  type MeterReading,
  type Prisma,
  type ReadingChannel,
  type ReadingQuality,
  type ReadingSource,
  type ReviewReason,
} from '@generated/prisma/client';
import { OCR, type OcrPort } from '@integrations/ocr/ocr.port';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type CutoffSetting, periodOf } from './cutoff';
import { classifyReading, type ReviewReasonKey, trailingDailyAverage } from './reading-rules';

const by = () => userIdOf(RequestContext.actor());
const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/** The confidence scale of `readings.confidence` (D-012, Proposed). */
export interface ConfidenceScale {
  iot: string;
  iotEstimatedByGateway: string;
  iotClockSuspect: string;
  iotOverflowCorrected: string;
  ocr: string;
  manual: string;
  inspection: string;
  estimated: string;
}

export interface NewReading {
  assignment: MeterAssignment;
  register: string;
  readAt: Date;
  source: ReadingSource;
  via: ReadingChannel;
  confidence?: string;
  deviceId?: string | null;
  seq?: bigint | null;
  quality?: ReadingQuality | null;
  telemetryTime?: Date | null;
  batchId?: string | null;
  evidenceDocumentId?: string | null;
  ocr?: { raw: string | null; confidence: number; value: string | null; minConfidence: string } | null;
  typedValue?: string | null;
  isInstall?: boolean;
  isFinal?: boolean;
  swapId?: string | null;
  note?: string | null;
  /** Staff-confirmed install / final / inspection registers: monotonic only, no band check. */
  confirmed?: boolean;
  /** IoT readings are never band-checked (hourly samples); decreases still go to review. */
  skipBand?: boolean;
  forceReview?: ReviewReasonKey | null;
}

export const READING_INCLUDE = {
  review: true,
  assignment: { select: { id: true, code: true, utility: true, purpose: true, unitId: true } },
} as const satisfies Prisma.MeterReadingInclude;
export type ReadingRow = Prisma.MeterReadingGetPayload<{ include: typeof READING_INCLUDE }>;

export const REVIEW_INCLUDE = {
  reading: { include: { assignment: { select: { id: true, code: true, utility: true, unitId: true } } } },
  unitRef: { select: { id: true, unitNo: true } },
} as const satisfies Prisma.MeterReadingReviewInclude;
export type ReviewRow = Prisma.MeterReadingReviewGetPayload<{ include: typeof REVIEW_INCLUDE }>;

/**
 * `smart.meter_reading` — the billing source of truth (D-012, D-030, D-035, D-142, D-143). Every source goes through
 * `insert`: the previous accepted reading of the assignment, consumption (rollover-aware), the plausibility band
 * against the trailing daily average (setting `readings.plausibility_pct`), OCR checks, then `accepted` or
 * `pending_review` with a review row; the database trigger refuses any accepted decrease. Owners accept, correct
 * (a superseding row, D-142) or reject reviews. Events: `reading.accepted`, `reading.review_requested`,
 * `reading.reviewed`.
 */
@Injectable()
export class MeterReadingsService extends TenantScopedRepository {
  private readonly logger = new Logger(MeterReadingsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(OCR) private readonly ocr: OcrPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly aiUsage: AiUsageService,
  ) {
    super();
  }

  /** Rules are those in force when the reading is processed: a back-dated reading is judged by today's settings. */
  /** One AI usage record per meter photo sent to OCR (D-161; the plan's monthly OCR allowance counts them). */
  private meterOcrUsage(
    tenantId: string,
    buildingId: string,
    model: string,
    outcome: 'ok' | 'error',
    photoId: string,
  ) {
    return this.aiUsage.record({
      tenantId,
      buildingId,
      feature: 'meter_ocr',
      provider: this.ocr.mode === 'fake' ? 'fake' : 'ai_gateway',
      model,
      inputUnits: 1,
      unitKind: 'images',
      outcome,
      subjectType: 'core.document',
      subjectId: photoId,
    });
  }

  async confidenceScale(): Promise<ConfidenceScale> {
    return this.settings.valueAt<ConfidenceScale>('readings.confidence', this.clock.now());
  }

  /** The assignment of a meter asset item in force at `at` (404 when the meter had none). */
  async assignmentAt(tx: Tx, assetItemId: string, at: Date): Promise<MeterAssignment> {
    const a = await tx.meterAssignment.findFirst({
      where: {
        assetItemId,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
      },
      orderBy: { validFrom: 'desc' },
    });
    if (!a) throw new DomainException('reading.no_assignment');
    return a;
  }

  /**
   * Inserts one reading inside the caller's transaction (any role). Returns the row, or null for an IoT duplicate
   * (`(device_id, seq)` or `(asset item, read_at, iot)` already stored — D-143).
   */
  async insert(tx: Tx, input: NewReading): Promise<MeterReading | null> {
    const a = input.assignment;
    const now = this.clock.now();
    const previous = await tx.meterReading.findFirst({
      where: {
        meterAssignmentId: a.id,
        reviewState: 'accepted',
        supersededByReadingId: null,
        // B4.2: billing estimates never constrain or judge real readings (D-192)
        source: { not: 'estimated' },
        readAt: { lt: input.readAt },
      },
      orderBy: { readAt: 'desc' },
    });
    const history =
      input.skipBand || input.confirmed
        ? []
        : await tx.meterReading.findMany({
            where: {
              meterAssignmentId: a.id,
              reviewState: 'accepted',
              supersededByReadingId: null,
              source: { not: 'estimated' },
              readAt: { lt: input.readAt, gte: new Date(input.readAt.getTime() - 120 * 86_400_000) },
            },
            orderBy: { readAt: 'asc' },
            select: { register: true, readAt: true },
            take: 500,
          });
    const pct = await this.settings.valueAt<string>('readings.plausibility_pct', this.clock.now(), {
      tenantId: a.tenantId,
    });
    const verdict = classifyReading({
      previous: previous ? { register: previous.register.toString(), readAt: previous.readAt } : null,
      initialRegister: a.initialReading.toString(),
      register: input.register,
      readAt: input.readAt,
      rolloverAt: a.rolloverAt.toString(),
      multiplier: a.multiplier.toString(),
      dailyAverage:
        input.skipBand || input.confirmed
          ? null
          : trailingDailyAverage(
              history.map((h) => ({ register: h.register.toString(), readAt: h.readAt })),
              a.rolloverAt.toString(),
            ),
      plausibilityPct: pct,
      ocr:
        input.ocr && input.ocr.value !== null
          ? {
              confidence: input.ocr.confidence,
              minConfidence: input.ocr.minConfidence,
              typedValue: input.typedValue ?? null,
              value: input.ocr.value,
            }
          : null,
      forceReview: input.forceReview ?? null,
    });
    if (input.confirmed && verdict.state !== 'accepted')
      throw new DomainException('reading.non_monotonic', {
        params: { previous: (previous?.register ?? a.initialReading).toString() },
      });
    const confidence = input.confidence ?? (await this.defaultConfidence(input));
    let row: MeterReading;
    // a savepoint keeps the caller's transaction usable when the insert is refused (duplicate IoT candidate,
    // inspection register already recorded): PostgreSQL aborts the whole transaction on a failed statement
    await tx.$executeRaw`SAVEPOINT meter_reading_insert`;
    try {
      row = await tx.meterReading.create({
        data: {
          tenantId: a.tenantId,
          buildingId: a.buildingId,
          assetItemId: a.assetItemId,
          meterAssignmentId: a.id,
          unitId: a.unitId,
          deviceId: input.deviceId ?? null,
          readingBatchId: input.batchId ?? null,
          register: new Decimal(input.register).toFixed(3),
          unit: a.utility === 'electric' ? 'kwh' : 'm3',
          readAt: input.readAt,
          receivedAt: now,
          source: input.source,
          confidence,
          quality: input.quality ?? null,
          seq: input.seq ?? null,
          telemetryTime: input.telemetryTime ?? null,
          reviewState: verdict.state,
          previousReadingId: previous?.id ?? null,
          consumption: verdict.consumption?.toFixed(3) ?? null,
          isRollover: verdict.isRollover,
          swapId: input.swapId ?? null,
          isInstall: input.isInstall ?? false,
          isFinal: input.isFinal ?? false,
          evidenceDocumentId: input.evidenceDocumentId ?? null,
          ocrRawValue: input.ocr?.raw ?? null,
          ocrConfidence: input.ocr ? new Decimal(input.ocr.confidence).toFixed(3) : null,
          typedValue: input.typedValue ? new Decimal(input.typedValue).toFixed(3) : null,
          submittedBy: by(),
          submittedVia: input.via,
          note: input.note ?? null,
          createdBy: by(),
        },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT meter_reading_insert`;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT meter_reading_insert`;
      if (isUniqueViolation(error)) {
        if (input.source === 'iot') return null;
        throw new DomainException('reading.duplicate');
      }
      if (raisedWith(error, 'smart.monotonic'))
        throw new DomainException('reading.non_monotonic', {
          params: { previous: (previous?.register ?? a.initialReading).toString() },
        });
      throw error;
    }
    if (verdict.state === 'pending_review') {
      const review = await tx.meterReadingReview.create({
        data: {
          tenantId: a.tenantId,
          buildingId: a.buildingId,
          unitId: a.unitId,
          readingId: row.id,
          reason: verdict.reason as ReviewReason,
          bandLow: verdict.band?.low.toFixed(3) ?? null,
          bandHigh: verdict.band?.high.toFixed(3) ?? null,
          trailingAvg: verdict.band?.expected.toFixed(3) ?? null,
          createdBy: by(),
        },
      });
      row = await tx.meterReading.update({ where: { id: row.id }, data: { reviewId: review.id } });
      await this.events.record(tx, {
        type: 'reading.review_requested',
        aggregateType: 'meter_reading',
        aggregateId: row.id,
        tenantId: a.tenantId,
        buildingId: a.buildingId,
        payload: {
          readingId: row.id,
          reviewId: review.id,
          assetItemId: a.assetItemId,
          unitId: a.unitId,
          reason: verdict.reason,
          source: input.source,
        },
      });
    } else {
      await this.accepted(tx, row);
    }
    return row;
  }

  private async defaultConfidence(input: NewReading): Promise<string> {
    const scale = await this.confidenceScale();
    if (input.source === 'iot') {
      switch (input.quality) {
        case 'estimated_by_gateway':
          return scale.iotEstimatedByGateway;
        case 'clock_suspect':
          return scale.iotClockSuspect;
        case 'overflow_corrected':
          return scale.iotOverflowCorrected;
        default:
          return scale.iot;
      }
    }
    if (input.via === 'inspection') return scale.inspection;
    return input.source === 'ocr' ? scale.ocr : input.source === 'manual' ? scale.manual : scale.estimated;
  }

  /** Bookkeeping of an accepted reading: meter status (latest reading) and the `reading.accepted` event. */
  private async accepted(tx: Tx, row: MeterReading): Promise<void> {
    const status = await tx.meterStatus.findUnique({ where: { assetItemId: row.assetItemId } });
    if (!status)
      await tx.meterStatus.create({
        data: {
          assetItemId: row.assetItemId,
          tenantId: row.tenantId,
          buildingId: row.buildingId,
          lastReadingAt: row.readAt,
          lastReadingId: row.id,
        },
      });
    else if (!status.lastReadingAt || status.lastReadingAt.getTime() <= row.readAt.getTime())
      await tx.meterStatus.update({
        where: { assetItemId: row.assetItemId },
        data: { lastReadingAt: row.readAt, lastReadingId: row.id },
      });
    await this.events.record(tx, {
      type: 'reading.accepted',
      aggregateType: 'meter_reading',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: {
        readingId: row.id,
        assetItemId: row.assetItemId,
        meterAssignmentId: row.meterAssignmentId,
        unitId: row.unitId,
        source: row.source,
        readAt: row.readAt.toISOString(),
        register: row.register.toFixed(3),
      },
    });
  }

  /**
   * Staff (or owner) reading with a photo (D-035): the photo is OCR'd; the typed value, when given, is the value and
   * OCR checks it; without a typed value the OCR value is used (source `ocr`). Photo required per
   * `readings.require_photo`. Goes to review when out of band, decreasing or doubtful.
   */
  async submit(
    ctx: TenantContext,
    input: {
      assetItemId: string;
      photoDocumentId?: string | null;
      typedValue?: string | null;
      readAt?: string | null;
      batchId?: string | null;
      note?: string | null;
    },
    via: 'staff_pwa' | 'owner_web',
  ): Promise<ReadingRow> {
    const now = this.clock.now();
    const readAt = input.readAt ? new Date(input.readAt) : now;
    if (readAt.getTime() > now.getTime() + 10 * 60_000)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'readAt', code: 'future', message: 'readAt may not be in the future' }],
      });
    const prepared = await this.db.tenant(ctx, async (tx) => {
      const item = await tx.assetItem.findFirst({
        where: {
          id: input.assetItemId,
          deletedAt: null,
          category: { in: ['meter_electric', 'meter_water'] },
        },
      });
      if (!item || (ctx.buildingIds && !ctx.buildingIds.includes(item.buildingId)))
        throw new DomainException('http.not_found');
      const assignment = await this.assignmentAt(tx, item.id, readAt);
      const building = await tx.building.findFirstOrThrow({ where: { id: item.buildingId } });
      return { assignment, propertyId: building.propertyId };
    });
    const requirePhoto = await this.settings.valueAt<boolean>('readings.require_photo', now, {
      tenantId: ctx.tenantId,
      propertyId: prepared.propertyId,
    });
    if (!input.photoDocumentId && requirePhoto) throw new DomainException('reading.photo_required');
    let ocr: NewReading['ocr'] = null;
    if (input.photoDocumentId) {
      const photo = await this.documents.readBytes(ctx, input.photoDocumentId, {
        kinds: ['meter_photo'],
        mimeTypes: PHOTO_MIME,
        maxBytes: 15_000_000,
      });
      const minConfidence = await this.settings.valueAt<string>('readings.ocr_min_confidence', now, {
        tenantId: ctx.tenantId,
      });
      try {
        const r = await this.ocr.readMeter({
          image: photo.body,
          mimeType: photo.document.mimeType,
          utility: prepared.assignment.utility,
          tenantId: ctx.tenantId,
          typedValue: input.typedValue ?? null,
          previousRegister: null,
        });
        ocr = { raw: r.raw, confidence: r.confidence, value: r.value, minConfidence };
        await this.meterOcrUsage(
          ctx.tenantId,
          prepared.assignment.buildingId,
          r.model,
          'ok',
          input.photoDocumentId,
        );
      } catch (error) {
        this.logger.warn(`meter OCR unavailable: ${(error as Error).message}`);
        ocr = { raw: null, confidence: 0, value: null, minConfidence };
        await this.meterOcrUsage(
          ctx.tenantId,
          prepared.assignment.buildingId,
          'unknown',
          'error',
          input.photoDocumentId,
        );
      }
    }
    const value = input.typedValue ?? ocr?.value ?? null;
    if (value === null) throw new DomainException('reading.unreadable');
    const source: ReadingSource = input.typedValue ? 'manual' : 'ocr';
    const row = await this.db.tenant(ctx, async (tx) => {
      const batchId =
        input.batchId ??
        (via === 'staff_pwa'
          ? await this.roundBatchId(
              tx,
              ctx.tenantId,
              prepared.assignment.buildingId,
              prepared.propertyId,
              readAt,
            )
          : null);
      if (input.batchId) {
        const batch = await tx.readingBatch.findFirst({
          where: { id: input.batchId, buildingId: prepared.assignment.buildingId },
        });
        if (!batch) throw new DomainException('http.not_found');
      }
      const inserted = await this.insert(tx, {
        assignment: prepared.assignment,
        register: value,
        readAt,
        source,
        via,
        batchId,
        evidenceDocumentId: input.photoDocumentId ?? null,
        ocr: source === 'ocr' || (ocr && ocr.value !== null) ? ocr : null,
        typedValue: input.typedValue ?? null,
        note: input.note ?? null,
      });
      await this.audit.record(tx, {
        action: 'reading.submitted',
        tenantId: ctx.tenantId,
        buildingId: prepared.assignment.buildingId,
        subjectType: 'smart.meter_reading',
        subjectId: inserted!.id,
        after: { register: inserted!.register.toFixed(3), source, reviewState: inserted!.reviewState },
      });
      return tx.meterReading.findUniqueOrThrow({ where: { id: inserted!.id }, include: READING_INCLUDE });
    });
    return row;
  }

  /** The staff round of a building for the billing period of `at` (one `reading_batch`, created on first use). */
  async roundBatchId(
    tx: Tx,
    tenantId: string,
    buildingId: string,
    propertyId: string,
    at: Date,
  ): Promise<string> {
    const cutoff = await this.settings.valueAt<CutoffSetting>('billing.cutoff', this.clock.now(), {
      tenantId,
      propertyId,
    });
    const key = periodOf(cutoff, at).key;
    const existing = await tx.readingBatch.findFirst({
      where: { buildingId, kind: 'staff_round', periodKey: key },
    });
    if (existing) return existing.id;
    const created = await tx.readingBatch.create({
      data: {
        tenantId,
        buildingId,
        kind: 'staff_round',
        periodKey: key,
        startedAt: at,
        submittedBy: by(),
        createdBy: by(),
      },
    });
    return created.id;
  }

  // --------------------------------------------------------------------------------------- review queue

  listReviews(
    ctx: TenantContext,
    f: {
      status?: 'open' | 'accepted' | 'corrected' | 'rejected';
      buildingId?: string;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const scope = this.buildingScope(ctx);
      const where: Prisma.MeterReadingReviewWhereInput = {
        status: f.status ?? 'open',
        ...(f.buildingId ? { buildingId: f.buildingId } : {}),
        ...(scope ? { buildingId: scope } : {}),
      };
      return {
        rows: await tx.meterReadingReview.findMany({
          where,
          include: REVIEW_INCLUDE,
          orderBy: { createdAt: 'asc' },
          skip: f.skip,
          take: f.take,
        }),
        total: await tx.meterReadingReview.count({ where }),
      };
    });
  }

  getReview(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.meterReadingReview.findFirst({ where: { id }, include: REVIEW_INCLUDE })),
    );
  }

  /** Accept / correct (superseding row, D-142) / reject a reading under review; the note is required except to accept. */
  decide(
    ctx: TenantContext,
    reviewId: string,
    decision:
      | { action: 'accept' }
      | { action: 'correct'; register: string; note: string }
      | { action: 'reject'; note: string },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const review = this.found(await tx.meterReadingReview.findFirst({ where: { id: reviewId } }));
      if (review.status !== 'open') throw new DomainException('reading.review_closed');
      const reading = await tx.meterReading.findUniqueOrThrow({ where: { id: review.readingId } });
      const now = this.clock.now();
      let correctedId: string | null = null;
      if (decision.action === 'accept') {
        try {
          await tx.meterReading.update({
            where: { id: reading.id },
            data: { reviewState: 'accepted', updatedBy: by() },
          });
        } catch (error) {
          if (raisedWith(error, 'smart.monotonic')) throw new DomainException('reading.non_monotonic');
          throw error;
        }
        await this.accepted(tx, { ...reading, reviewState: 'accepted' });
      } else if (decision.action === 'reject') {
        await tx.meterReading.update({
          where: { id: reading.id },
          data: { reviewState: 'rejected', updatedBy: by() },
        });
      } else {
        await tx.meterReading.update({
          where: { id: reading.id },
          data: { reviewState: 'corrected', updatedBy: by() },
        });
        const assignment = await tx.meterAssignment.findUniqueOrThrow({
          where: { id: reading.meterAssignmentId },
        });
        const corrected = await this.insert(tx, {
          assignment,
          register: decision.register,
          readAt: reading.readAt,
          source: 'manual',
          via: 'owner_web',
          evidenceDocumentId: reading.evidenceDocumentId,
          batchId: reading.readingBatchId,
          isInstall: reading.isInstall,
          isFinal: reading.isFinal,
          swapId: reading.swapId,
          note: decision.note,
          confirmed: true,
        });
        correctedId = corrected!.id;
        await tx.meterReading.update({
          where: { id: reading.id },
          data: { supersededByReadingId: correctedId },
        });
      }
      const status =
        decision.action === 'accept' ? 'accepted' : decision.action === 'reject' ? 'rejected' : 'corrected';
      const updated = await tx.meterReadingReview.update({
        where: { id: reviewId },
        data: {
          status,
          decidedBy: by(),
          decidedAt: now,
          decisionNote: decision.action === 'accept' ? null : decision.note,
          correctedRegister: decision.action === 'correct' ? new Decimal(decision.register).toFixed(3) : null,
          correctedReadingId: correctedId,
          updatedBy: by(),
        },
        include: REVIEW_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'reading.reviewed',
        tenantId: review.tenantId,
        buildingId: review.buildingId,
        subjectType: 'smart.meter_reading_review',
        subjectId: reviewId,
        before: { register: reading.register.toFixed(3), reviewState: reading.reviewState },
        after: {
          status,
          correctedRegister: updated.correctedRegister?.toFixed(3) ?? null,
          correctedReadingId: correctedId,
        },
      });
      await this.events.record(tx, {
        type: 'reading.reviewed',
        aggregateType: 'meter_reading',
        aggregateId: reading.id,
        tenantId: review.tenantId,
        buildingId: review.buildingId,
        payload: { reviewId, readingId: reading.id, status, correctedReadingId: correctedId },
      });
      return updated;
    });
  }

  // --------------------------------------------------------------------------------------- history & export

  /** Readings of one meter asset item (newest first), live and superseded, with their review state. */
  listForMeter(
    ctx: TenantContext,
    assetItemId: string,
    f: { from?: Date; to?: Date; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const item = await tx.assetItem.findFirst({ where: { id: assetItemId } });
      if (!item || (ctx.buildingIds && !ctx.buildingIds.includes(item.buildingId)))
        throw new DomainException('http.not_found');
      const where: Prisma.MeterReadingWhereInput = {
        assetItemId,
        ...(f.from || f.to
          ? { readAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
          : {}),
      };
      return {
        rows: await tx.meterReading.findMany({
          where,
          include: READING_INCLUDE,
          orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
          skip: f.skip,
          take: f.take,
        }),
        total: await tx.meterReading.count({ where }),
      };
    });
  }

  /** Meter history of a unit across swaps (D-033): every assignment (oldest first) with its readings and swaps. */
  historyForUnit(ctx: TenantContext, unitId: string, utility?: 'electric' | 'water') {
    return this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } });
      if (!unit || (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId)))
        throw new DomainException('http.not_found');
      const assignments = await tx.meterAssignment.findMany({
        where: { unitId, ...(utility ? { utility } : {}) },
        include: { assetItem: { select: { id: true, name: true, serial: true, status: true } } },
        orderBy: [{ utility: 'asc' }, { validFrom: 'asc' }],
      });
      const readings = await tx.meterReading.findMany({
        where: { meterAssignmentId: { in: assignments.map((a) => a.id) } },
        include: READING_INCLUDE,
        orderBy: [{ readAt: 'asc' }, { createdAt: 'asc' }],
        take: 5000,
      });
      const swaps = await tx.meterSwap.findMany({
        where: {
          OR: [
            { oldAssignmentId: { in: assignments.map((a) => a.id) } },
            { newAssignmentId: { in: assignments.map((a) => a.id) } },
          ],
        },
        orderBy: { swappedAt: 'asc' },
      });
      return { unit, assignments, readings, swaps };
    });
  }

  /** CSV of a building's readings in a window (owner export, D-012 source badges as columns). */
  async exportCsv(ctx: TenantContext, buildingId: string, from: Date, to: Date): Promise<string> {
    const rows = await this.db.tenant(ctx, async (tx) => {
      const building = await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } });
      if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
        throw new DomainException('http.not_found');
      const found = await tx.meterReading.findMany({
        where: { buildingId, readAt: { gte: from, lt: to } },
        include: {
          assignment: { select: { code: true, utility: true, purpose: true } },
          unitRef: { select: { unitNo: true } },
        },
        orderBy: [{ readAt: 'asc' }],
        take: 100_000,
      });
      await this.audit.record(tx, {
        action: 'reading.exported',
        tenantId: ctx.tenantId,
        buildingId,
        subjectType: 'core.building',
        subjectId: buildingId,
        metadata: { from: from.toISOString(), to: to.toISOString(), rows: found.length },
      });
      return found;
    });
    const esc = (v: string | null | undefined) => {
      const s = v ?? '';
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'read_at',
      'unit_no',
      'meter_code',
      'utility',
      'purpose',
      'register',
      'unit',
      'consumption',
      'source',
      'confidence',
      'review_state',
      'is_install',
      'is_final',
      'superseded_by',
      'reading_id',
    ];
    const lines = rows.map((r) =>
      [
        toBangkokIso(r.readAt),
        r.unitRef?.unitNo ?? '',
        r.assignment.code,
        r.assignment.utility,
        r.assignment.purpose,
        r.register.toFixed(3),
        r.unit,
        r.consumption?.toFixed(3) ?? '',
        r.source,
        r.confidence.toFixed(3),
        r.reviewState,
        String(r.isInstall),
        String(r.isFinal),
        r.supersededByReadingId ?? '',
        r.id,
      ]
        .map((v) => esc(v))
        .join(','),
    );
    return `\uFEFF${[header.join(','), ...lines].join('\n')}\n`;
  }

  /**
   * Meter registers recorded on a completed move-in / move-out inspection become `manual` readings (B2.4 → B3.3,
   * channel `inspection`), in the inspection's transaction; a register that contradicts the accepted series goes to
   * review rather than failing the inspection.
   */
  async fromInspection(
    tx: Tx,
    input: {
      assetItemId: string;
      register: string;
      readAt: Date;
      photoDocumentId: string | null;
      inspectionId: string;
    },
  ): Promise<MeterReading | null> {
    const assignment = await tx.meterAssignment.findFirst({
      where: {
        assetItemId: input.assetItemId,
        validFrom: { lte: input.readAt },
        OR: [{ validTo: null }, { validTo: { gt: input.readAt } }],
      },
    });
    if (!assignment) return null;
    try {
      return await this.insert(tx, {
        assignment,
        register: input.register,
        readAt: input.readAt,
        source: 'manual',
        via: 'inspection',
        evidenceDocumentId: input.photoDocumentId,
        note: `inspection ${input.inspectionId}`,
        skipBand: true,
      });
    } catch (error) {
      if (error instanceof DomainException && error.code === 'reading.duplicate') return null;
      throw error;
    }
  }

  /** IoT candidate → billing reading (worker, `reading.candidate` subscriber). */
  async promoteIot(
    tx: Tx,
    c: {
      assetItemId: string;
      deviceId: string;
      seq: string;
      readAt: string;
      register: string;
      quality: ReadingQuality;
      via: 'mqtt' | 'https_batch';
    },
  ): Promise<MeterReading | null> {
    const readAt = new Date(c.readAt);
    const assignment = await tx.meterAssignment.findFirst({
      where: {
        assetItemId: c.assetItemId,
        validFrom: { lte: readAt },
        OR: [{ validTo: null }, { validTo: { gt: readAt } }],
      },
    });
    if (!assignment) return null;
    return this.insert(tx, {
      assignment,
      register: c.register,
      readAt,
      source: 'iot',
      via: c.via,
      deviceId: c.deviceId,
      seq: BigInt(c.seq),
      quality: c.quality,
      telemetryTime: readAt,
      skipBand: true,
      forceReview: c.quality === 'register_decrease' ? 'decreasing_without_swap' : null,
    });
  }

  /** A tenant context for worker-side inserts of tenant `tenantId`. */
  systemContext(tenantId: string): TenantContext {
    return systemTenantContext(tenantId);
  }
}
