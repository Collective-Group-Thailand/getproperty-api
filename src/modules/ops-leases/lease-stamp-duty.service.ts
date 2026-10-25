import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { E_STAMP, type EStampPort } from '@integrations/e-stamp/e-stamp.port';
import { Inject, Injectable } from '@nestjs/common';

import { addDays } from './lease-dates';
import { type LeaseRow, LeasesService } from './leases.service';
import { type StampDutyPayer } from './stamp-duty';

export interface StampDutyView {
  leaseId: string;
  amount: string;
  /** true once fixed at send-for-signature; before that `amount` is an estimate from the current terms. */
  fixed: boolean;
  payer: StampDutyPayer;
  /** Bangkok date by which the duty is due (`lease.stamp_duty.due_days` after both signatures); null before. */
  dueDate: string | null;
  paid: {
    channel: 'e_stamp' | 'manual';
    reference: string | null;
    paidAt: Date;
    documentId: string | null;
  } | null;
  /** The e-Stamp adapter is configured and the signed lease can be stamped online now. */
  eStampAvailable: boolean;
}

/**
 * Stamp duty on leases (B7.5, D-253, O-019): the duty is fixed when the lease is sent for signature (from the rent over
 * the term), shown with its due date once both parties signed, and paid either through the e-Stamp adapter (when one
 * is configured — the receipt is stored with the lease) or recorded by the owner with the receipt they uploaded.
 */
@Injectable()
export class LeaseStampDutyService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: LeasesService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    @Inject(E_STAMP) private readonly eStamp: EStampPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async view(ctx: TenantContext, leaseId: string): Promise<StampDutyView> {
    return this.viewOf(await this.leases.get(ctx, leaseId));
  }

  private async viewOf(lease: LeaseRow): Promise<StampDutyView> {
    const signedOn = lease.signedDocumentId && lease.activatedAt ? bangkokDate(lease.activatedAt) : null;
    const dueDays = signedOn
      ? await this.settings.valueAt<number>('lease.stamp_duty.due_days', this.clock.now(), {
          tenantId: lease.tenantId,
        })
      : null;
    const paid =
      lease.stampDutyPaidAt && lease.stampDutyChannel
        ? {
            channel: lease.stampDutyChannel,
            reference: lease.stampDutyReference,
            paidAt: lease.stampDutyPaidAt,
            documentId: lease.stampDutyDocumentId,
          }
        : null;
    return {
      leaseId: lease.id,
      amount: await this.leases.stampDutyAmount(lease),
      fixed: lease.stampDutyAmount !== null,
      payer: lease.stampDutyPayer,
      dueDate: signedOn && dueDays !== null ? addDays(signedOn, Number(dueDays)) : null,
      paid,
      eStampAvailable: this.eStamp.configured && Boolean(signedOn) && !paid,
    };
  }

  /** The owner paid at the Revenue Department (or elsewhere) and records it, optionally with the receipt file. */
  async record(
    ctx: TenantContext,
    leaseId: string,
    input: { reference?: string | null; paidOn?: string; documentId?: string | null },
  ): Promise<StampDutyView> {
    const lease = await this.payable(ctx, leaseId);
    if (input.documentId) await this.documents.get(ctx, input.documentId);
    const paidAt = input.paidOn ? new Date(`${input.paidOn}T12:00:00+07:00`) : this.clock.now();
    if (input.paidOn && input.paidOn > bangkokDate(this.clock.now()))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'paidOn', code: 'future', message: 'the payment date cannot be in the future' }],
      });
    return this.markPaid(ctx, lease, {
      channel: 'manual',
      reference: input.reference?.trim() || null,
      paidAt,
      documentId: input.documentId ?? null,
    });
  }

  /** Pays through the e-Stamp adapter (O-019) and stores the Revenue Department receipt with the lease. */
  async payOnline(ctx: TenantContext, leaseId: string): Promise<StampDutyView> {
    const lease = await this.payable(ctx, leaseId);
    if (!this.eStamp.configured || !lease.signedDocumentId || !lease.activatedAt)
      throw new DomainException('lease.e_stamp_unavailable');
    const tenant = await this.db.tenant(ctx, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { taxId: true } }),
    );
    const receipt = await this.eStamp.pay({
      instrumentRef: lease.number!,
      lessorTaxId: tenant.taxId,
      amount: lease.stampDutyAmount!.toFixed(2),
      madeOn: bangkokDate(lease.activatedAt),
    });
    const uploaded = await this.documents.uploadGenerated({
      tenantId: lease.tenantId,
      kind: 'other',
      scopeType: 'unit',
      scopeId: lease.unitId,
      buildingId: lease.buildingId,
      title: `ใบเสร็จอากรแสตมป์ ${lease.number} (${receipt.reference}).pdf`,
      mimeType: 'application/pdf',
      body: receipt.receiptPdf,
      sourceRef: `e-stamp:${receipt.reference}`,
    });
    return this.markPaid(
      ctx,
      lease,
      { channel: 'e_stamp', reference: receipt.reference, paidAt: receipt.paidAt, documentId: uploaded.id },
      uploaded,
    );
  }

  private async payable(ctx: TenantContext, leaseId: string): Promise<LeaseRow> {
    const lease = await this.leases.get(ctx, leaseId);
    if (lease.stampDutyAmount === null || !lease.number)
      throw new DomainException('lease.stamp_duty_not_fixed');
    if (lease.stampDutyPaidAt) throw new DomainException('lease.stamp_duty_paid');
    if (lease.status === 'cancelled')
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    return lease;
  }

  private async markPaid(
    ctx: TenantContext,
    lease: LeaseRow,
    paid: {
      channel: 'e_stamp' | 'manual';
      reference: string | null;
      paidAt: Date;
      documentId: string | null;
    },
    uploaded?: Awaited<ReturnType<DocumentsService['uploadGenerated']>>,
  ): Promise<StampDutyView> {
    await this.db.tenant(ctx, async (tx) => {
      if (uploaded) await this.documents.recordGenerated(tx, uploaded);
      const updated = await tx.lease.updateMany({
        where: { id: lease.id, tenantId: ctx.tenantId, stampDutyPaidAt: null },
        data: {
          stampDutyChannel: paid.channel,
          stampDutyReference: paid.reference,
          stampDutyPaidAt: paid.paidAt,
          stampDutyDocumentId: paid.documentId,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new DomainException('lease.stamp_duty_paid');
      const data = {
        channel: paid.channel,
        amount: lease.stampDutyAmount!.toFixed(2),
        payer: lease.stampDutyPayer,
        reference: paid.reference,
        documentId: paid.documentId,
      };
      await this.audit.record(tx, {
        action: 'lease.stamp_duty_paid',
        tenantId: lease.tenantId,
        subjectType: 'ops.lease',
        subjectId: lease.id,
        metadata: data,
      });
      await this.leases.history(tx, lease, 'stamp_duty_paid', data, 'lease.stamp_duty_paid');
    });
    return this.view(ctx, lease.id);
  }
}
