import { SLIP_VERIFIER, type SlipVerifierPort } from '@collective/integrations/payments/qr';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type SlipStatus } from '@generated/prisma/client';
import { ResidentInvoicesService } from '@modules/ops-billing/resident-invoices.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PaymentsService } from './payments.service';

const by = () => userIdOf(RequestContext.actor());

type SlipVerifyResult = Awaited<ReturnType<SlipVerifierPort['verify']>>;
/** What `prepare` found out about a slip before the transaction (review #10). */
interface SlipVerification {
  slipId: string;
  result: SlipVerifyResult;
}
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export const SLIP_INCLUDE = {
  invoice: { select: { id: true, number: true, balance: true, total: true } },
  payer: { select: { id: true, displayName: true } },
  unit: { select: { id: true, unitNo: true } },
  duplicateOf: { select: { id: true, invoiceId: true, status: true, uploadedAt: true } },
} as const satisfies Prisma.SlipReviewInclude;
export type SlipRow = Prisma.SlipReviewGetPayload<{ include: typeof SLIP_INCLUDE }>;

/**
 * Transfer slips — the fallback only (D-043, setting `payments.allow_slip`): the resident uploads the slip of a
 * transfer to the landlord's account; the slip verifier reads it; it is confirmed automatically only when it is a
 * real slip, its reference was never used, the receiving bank and account (last 4 digits) are the tenant's, and the
 * amount is what is due (or, with `payments.allow_partial`, not more than due). Anything else waits in the owner's
 * review queue with the reasons and the earlier slip of the same reference (duplicate warning).
 */
@Injectable()
export class SlipsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'slips';
  readonly eventTypes = ['slip.uploaded'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly residentInvoices: ResidentInvoicesService,
    private readonly payments: PaymentsService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(SLIP_VERIFIER) private readonly verifier: SlipVerifierPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * `POST /v1/resident/invoices/{id}/slips`: the resident sends the slip image (residents have no file uploads; the
   * image comes inline, ≤ 5 MB). It is stored as a `slip` document, virus-scanned like every upload, and verified
   * by the worker (`slip.uploaded`).
   */
  async submit(invoiceId: string, input: { image: Buffer; mimeType: string }): Promise<SlipRow> {
    const inv = await this.residentInvoices.get({ id: invoiceId });
    const allowed = await this.settings.valueAt<boolean>('payments.allow_slip', this.clock.now(), {
      tenantId: inv.tenantId,
    });
    if (allowed !== true) throw new DomainException('slip.not_allowed');
    if (
      !['issued', 'partially_paid', 'overdue'].includes(inv.status) ||
      new Decimal(inv.balance.toString()).lte(0)
    )
      throw new DomainException('invoice.nothing_due');
    const actor = RequestContext.actor();
    const userId = actor?.type === 'user' ? actor.publicId : null;
    const id = await this.db.platform(async (tx) => {
      const doc = await this.documents.storeGenerated(tx, {
        tenantId: inv.tenantId,
        kind: 'slip',
        scopeType: inv.unitId ? 'unit' : 'building',
        scopeId: inv.unitId ?? inv.buildingId,
        buildingId: inv.buildingId,
        title: `slip ${inv.number ?? inv.id}`,
        mimeType: input.mimeType,
        body: input.image,
      });
      // an upload from outside: scanned like the presigned ones (document.uploaded → document-scan)
      await tx.document.update({ where: { id: doc.id }, data: { scanStatus: 'pending', scannedAt: null } });
      await this.events.record(tx, {
        type: 'document.uploaded',
        aggregateType: 'document',
        aggregateId: doc.id,
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        payload: { documentId: doc.id, kind: 'slip' },
      });
      const slip = await tx.slipReview.create({
        data: {
          tenantId: inv.tenantId,
          buildingId: inv.buildingId,
          unitId: inv.unitId,
          invoiceId: inv.id,
          payerPartyId: inv.billedPartyId,
          slipDocumentId: doc.id,
          uploadedBy: userId,
          uploadedAt: this.clock.now(),
        },
      });
      await this.events.record(tx, {
        type: 'slip.uploaded',
        aggregateType: 'slip_review',
        aggregateId: slip.id,
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        payload: { slipReviewId: slip.id, invoiceId: inv.id },
      });
      return slip.id;
    });
    return this.db.platform(async (tx) =>
      tx.slipReview.findUniqueOrThrow({ where: { id }, include: SLIP_INCLUDE }),
    );
  }

  /**
   * Review #10: the slip image is read from object storage and sent to the slip verifier (HTTP, up to 2 × 10 s)
   * before the subscriber transaction opens; `handle` then decides in a short transaction.
   */
  async prepare(event: DomainEventEnvelope): Promise<SlipVerification | null> {
    const slipId = event.payload.slipReviewId as string;
    const slip = await this.db.platform((tx) =>
      tx.slipReview.findUnique({ where: { id: slipId }, include: { slipDocument: true } }),
    );
    if (!slip || slip.status !== 'pending_verification') return null;
    const image = await this.documents.bytesOf(slip.slipDocument);
    return { slipId, result: await this.verifier.verify(image, slip.slipDocument.mimeType) };
  }

  /** Worker: verify the slip and confirm it, or queue it for the owner. */
  async handle(event: DomainEventEnvelope, tx: Tx, prepared?: unknown): Promise<void> {
    const pre = prepared as SlipVerification | null | undefined;
    const slipId = event.payload.slipReviewId as string;
    await this.verify(tx, slipId, pre?.slipId === slipId ? pre.result : undefined);
  }

  async verify(tx: Tx, slipId: string, verified?: SlipVerifyResult): Promise<void> {
    const slip = await tx.slipReview.findUnique({
      where: { id: slipId },
      include: { slipDocument: true, invoice: true },
    });
    if (!slip || slip.status !== 'pending_verification') return;
    const v =
      verified ??
      (await this.verifier.verify(
        await this.documents.bytesOf(slip.slipDocument),
        slip.slipDocument.mimeType,
      ));
    const reasons: string[] = [];
    let duplicateOf: string | null = null;
    if (!v.valid) reasons.push('not_recognised');
    if (v.transRef) {
      const earlier = await tx.slipReview.findFirst({
        where: {
          tenantId: slip.tenantId,
          transRef: v.transRef,
          id: { not: slip.id },
          status: { notIn: ['duplicate', 'rejected'] },
        },
      });
      if (earlier) {
        reasons.push('duplicate_reference');
        duplicateOf = earlier.id;
      }
    }
    const accounts = await tx.tenantBankAccount.findMany({
      where: { tenantId: slip.tenantId, state: 'active' },
    });
    const receiver = digits(v.receiverAccount);
    const receiverOk = accounts.some(
      (a) =>
        (!v.receiverBankCode || a.bankCode === v.receiverBankCode) &&
        receiver.length >= 4 &&
        digits(a.accountNoMasked).slice(-4) === receiver.slice(-4),
    );
    if (v.valid && !receiverOk) reasons.push('receiver_mismatch');
    // serialised with every other confirmation of this payer × unit (review #3) before reading what is due
    await this.payments.lockPayer(tx, slip);
    const due = await this.payments.dueFor(tx, slip.invoice);
    const amount = v.amount ? new Decimal(v.amount) : null;
    if (v.valid && amount) {
      if (amount.gt(due)) reasons.push('amount_above_due');
      else if (amount.lt(due) && !(await this.payments.allowPartial(slip.tenantId)))
        reasons.push('amount_below_due');
      // D-220 (review #2): the same transfer already booked through the QR → the owner decides, never booked twice
      const qrPaid = await this.payments.sameTransfer(
        tx,
        {
          tenantId: slip.tenantId,
          invoiceId: slip.invoiceId,
          payerPartyId: slip.payerPartyId,
          unitId: slip.unitId,
          amount: amount.toFixed(2),
          paidAt: v.paidAt ?? slip.uploadedAt,
        },
        ['qr'],
      );
      if (qrPaid) reasons.push('possible_qr_duplicate');
    } else if (v.valid) reasons.push('amount_unreadable');
    const status: SlipStatus = duplicateOf
      ? 'duplicate'
      : reasons.length
        ? 'pending_review'
        : 'auto_confirmed';
    await tx.slipReview.update({
      where: { id: slip.id },
      data: {
        status,
        reasons,
        verifier: this.verifier.provider,
        verifyResult: v.raw as Prisma.InputJsonValue,
        transRef: v.transRef,
        amountDetected: v.amount,
        receiverAccountMasked: receiver ? `xxx${receiver.slice(-4)}` : null,
        receiverBankCode: v.receiverBankCode,
        senderName: v.senderName,
        slipDatetime: v.paidAt,
        duplicateOfId: duplicateOf,
        version: { increment: 1 },
      },
    });
    if (status === 'auto_confirmed') {
      const { payment } = await this.payments.confirm(tx, {
        tenantId: slip.tenantId,
        buildingId: slip.buildingId,
        unitId: slip.unitId,
        invoiceId: slip.invoiceId,
        payerPartyId: slip.payerPartyId,
        leaseId: slip.invoice.leaseId,
        amount: amount!.toFixed(2),
        method: 'transfer_slip',
        confirmedVia: 'slip_verified',
        paidAt: v.paidAt ?? slip.uploadedAt,
        providerRef: null,
        slipDocumentId: slip.slipDocumentId,
        slipReviewId: slip.id,
        notes: v.transRef ? `slip ${v.transRef}` : null,
      });
      await tx.slipReview.update({ where: { id: slip.id }, data: { paymentId: payment.id } });
    } else {
      await this.events.record(tx, {
        type: 'slip.review_requested',
        aggregateType: 'slip_review',
        aggregateId: slip.id,
        tenantId: slip.tenantId,
        buildingId: slip.buildingId,
        payload: { slipReviewId: slip.id, invoiceId: slip.invoiceId, reasons, duplicateOf },
      });
    }
  }

  // ------------------------------------------------------------------------------------------- owner queue

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<SlipRow> {
    const s = this.found(
      await tx.slipReview.findFirst({ where: this.own(ctx, { id }), include: SLIP_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(s.buildingId))
      throw new DomainException('http.not_found');
    return s;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(ctx: TenantContext, q: { status?: SlipStatus; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.SlipReviewWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.status ? { status: q.status } : { status: { in: ['pending_review', 'duplicate'] } }),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.slipReview.findMany({
          where,
          include: SLIP_INCLUDE,
          orderBy: [{ uploadedAt: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.slipReview.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** The owner approves (the payment of the amount on the slip, or the corrected amount) or rejects with a reason. */
  async decide(
    ctx: TenantContext,
    id: string,
    input: { action: 'approve' | 'reject'; amount?: string | null; reason?: string | null },
  ): Promise<SlipRow> {
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.slip_review WHERE id = ${id}::uuid FOR UPDATE`;
      const slip = await this.load(tx, ctx, id);
      if (slip.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (!['pending_review', 'duplicate'].includes(slip.status))
        throw new DomainException('slip.invalid_state', { params: { status: slip.status } });
      const now = this.clock.now();
      if (input.action === 'reject') {
        if (!input.reason || input.reason.trim().length < 3)
          throw new DomainException('validation.failed', {
            errors: [{ path: 'reason', code: 'required', message: 'say why the slip is rejected' }],
          });
        await tx.slipReview.update({
          where: { id },
          data: {
            status: 'rejected',
            reviewedBy: by(),
            reviewedAt: now,
            rejectReason: input.reason,
            version: { increment: 1 },
          },
        });
      } else {
        const amount = input.amount ?? slip.amountDetected?.toFixed(2);
        if (!amount)
          throw new DomainException('validation.failed', {
            errors: [
              { path: 'amount', code: 'required', message: 'the slip amount could not be read: enter it' },
            ],
          });
        // one bank transfer pays once: a duplicate is approvable only after the earlier slip was rejected
        if (slip.transRef) {
          const standing = await tx.slipReview.findFirst({
            where: {
              tenantId: slip.tenantId,
              transRef: slip.transRef,
              id: { not: slip.id },
              status: { notIn: ['duplicate', 'rejected'] },
            },
          });
          if (standing)
            throw new DomainException('slip.invalid_state', {
              params: { status: slip.status, duplicateOf: standing.id },
            });
        }
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: slip.invoiceId } });
        await this.payments.assertAmount(tx, inv, amount);
        const { payment } = await this.payments.confirm(tx, {
          tenantId: slip.tenantId,
          buildingId: slip.buildingId,
          unitId: slip.unitId,
          invoiceId: slip.invoiceId,
          payerPartyId: slip.payerPartyId,
          leaseId: inv.leaseId,
          amount,
          method: 'transfer_slip',
          confirmedVia: 'slip_review',
          paidAt: slip.slipDatetime ?? slip.uploadedAt,
          slipDocumentId: slip.slipDocumentId,
          slipReviewId: slip.id,
          recordedBy: by(),
          notes: slip.transRef ? `slip ${slip.transRef}` : null,
        });
        await tx.slipReview.update({
          where: { id },
          data: {
            status: 'approved',
            reviewedBy: by(),
            reviewedAt: now,
            paymentId: payment.id,
            version: { increment: 1 },
          },
        });
      }
      await this.audit.record(tx, {
        action: 'slip.reviewed',
        tenantId: ctx.tenantId,
        buildingId: slip.buildingId,
        subjectType: 'ops.slip_review',
        subjectId: id,
        metadata: {
          action: input.action,
          reasons: slip.reasons,
          amount: input.amount ?? null,
          reason: input.reason ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'slip.reviewed',
        aggregateType: 'slip_review',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: slip.buildingId,
        payload: { slipReviewId: id, action: input.action, invoiceId: slip.invoiceId },
      });
    });
    return this.get(ctx, id);
  }

  /** A signed link to the slip image (owner review). */
  async slipLink(ctx: TenantContext, id: string) {
    const slip = await this.get(ctx, id);
    const doc = await this.db.tenant(ctx, (tx) =>
      tx.document.findUniqueOrThrow({ where: { id: slip.slipDocumentId } }),
    );
    return this.documents.signedUrl(doc);
  }
}
