import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { isUniqueViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type RentCertificate, type RentCertificateState } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { certificateBody, certificateTitle, type RentCertificatePurpose } from './certificate-templates';
import { type ContractLanguage, ContractRenderer } from './contract-renderer';
import { bahtTextEn, englishDate } from './english-text';
import { LeaseNoticesService } from './lease-notices.service';
import { type LeaseRow, LeasesService } from './leases.service';
import { ResidentLeasesService } from './resident-leases.service';
import { bahtText, formatThb, thaiDate } from './thai-text';

export interface CertificateRequestInput {
  purpose: RentCertificatePurpose;
  periodFrom?: string;
  periodTo?: string;
  language?: ContractLanguage;
  note?: string | null;
}

export type RentCertificateRow = RentCertificate & {
  lease: { number: string | null };
  unit: { unitNo: string };
};

const CERTIFIABLE = ['active', 'notice_given', 'ending', 'ended'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONTHS = 24;
const day = (d: Date) => d.toISOString().slice(0, 10);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/**
 * Rent payment certificates (B7.5, D-253): the resident asks in LIFF (purpose, period, language) — one open request
 * per lease — the owner is told, then issues it (a numbered PDF letter in the landlord's name listing the receipts of
 * the period and whether anything is overdue, series `rent_certificate`) or declines it with a reason; the resident
 * gets either in LINE. An owner may also issue one directly. Only receipts issued through the platform are listed.
 */
@Injectable()
export class RentCertificatesService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: LeasesService,
    private readonly residents: ResidentLeasesService,
    private readonly letters: LeaseNoticesService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('lease.rent_certificate_requested', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              certificate: {
                unitNo: e.payload.unitNo,
                purposeTh: e.payload.purposeTh,
                purposeEn: e.payload.purposeEn,
              },
              lessee: { name: e.payload.lesseeName },
            },
          }
        : null,
    );
    const toResident = async (tx: Tx, e: { tenantId: string | null; payload: Record<string, unknown> }) => {
      const partyId = e.payload.partyId as string | undefined;
      if (!partyId || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          certificate: { number: e.payload.number ?? null, reason: e.payload.reason ?? null },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/lease/${e.payload.leaseId as string}/certificates`,
        },
        consentPurpose: 'resident.service' as const,
      };
    };
    registerNotifiable('lease.rent_certificate_issued', toResident);
    registerNotifiable('lease.rent_certificate_declined', toResident);
  }

  // ------------------------------------------------------------------------------------------- resident

  async residentRequest(leaseId: string, input: CertificateRequestInput): Promise<RentCertificate> {
    const { ctx, lease, partyIds } = await this.residents.access(leaseId);
    if (!CERTIFIABLE.includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    const period = this.period(lease, input);
    const party = lease.parties.find((p) => partyIds.includes(p.partyId) && p.role !== 'guarantor');
    const note = input.note?.trim() || null;
    if (note && note.length > 500) throw invalid('note', 'maxLength', 'at most 500 characters');
    try {
      return await this.db.tenant(ctx, async (tx) => {
        const row = await tx.rentCertificate.create({
          data: {
            tenantId: lease.tenantId,
            leaseId,
            buildingId: lease.buildingId,
            unitId: lease.unitId,
            requestedByPartyId: party?.partyId ?? partyIds[0]!,
            purpose: input.purpose,
            periodFrom: new Date(period.from),
            periodTo: new Date(period.to),
            language: input.language ?? 'th',
            note,
          },
        });
        await this.audit.record(tx, {
          action: 'lease.rent_certificate_requested',
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          subjectType: 'ops.lease',
          subjectId: leaseId,
          metadata: { certificateId: row.id, purpose: input.purpose, ...period },
        });
        await this.leases.history(
          tx,
          lease,
          'rent_certificate_requested',
          {
            certificateId: row.id,
            unitNo: lease.unit.unitNo,
            lesseeName: lease.lessee.displayName,
            purposeTh: PURPOSE_TH[input.purpose],
            purposeEn: input.purpose,
          },
          'lease.rent_certificate_requested',
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainException('rent_certificate.request_open');
      throw error;
    }
  }

  async residentList(leaseId: string): Promise<RentCertificate[]> {
    const { ctx } = await this.residents.access(leaseId);
    return this.db.tenant(ctx, (tx) =>
      tx.rentCertificate.findMany({ where: { leaseId }, orderBy: { requestedAt: 'desc' } }),
    );
  }

  async residentDocument(leaseId: string, id: string) {
    const { ctx } = await this.residents.access(leaseId);
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.rentCertificate.findFirst({ where: { id, leaseId }, include: { document: true } });
      if (!row?.document) throw new DomainException('http.not_found');
      return { row, ...(await this.documents.signedUrl(row.document)) };
    });
  }

  // ---------------------------------------------------------------------------------------------- owner

  list(
    ctx: TenantContext,
    q: { state?: RentCertificateState; leaseId?: string },
  ): Promise<RentCertificateRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.rentCertificate.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(q.state ? { state: q.state } : {}),
          ...(q.leaseId ? { leaseId: q.leaseId } : {}),
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
        include: { lease: { select: { number: true } }, unit: { select: { unitNo: true } } },
        orderBy: [{ requestedAt: 'desc' }],
        take: 200,
      }),
    );
  }

  async document(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(
        await tx.rentCertificate.findFirst({ where: this.own(ctx, { id }), include: { document: true } }),
      );
      if (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId))
        throw new DomainException('http.not_found');
      if (!row.document) throw new DomainException('http.not_found');
      return { row, ...(await this.documents.signedUrl(row.document)) };
    });
  }

  /** The owner issues a certificate without a request (e.g. asked by phone). */
  async issueDirect(
    ctx: TenantContext,
    leaseId: string,
    input: CertificateRequestInput,
  ): Promise<RentCertificate> {
    const lease = await this.leases.get(ctx, leaseId);
    if (!CERTIFIABLE.includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    const period = this.period(lease, input);
    return this.render(ctx, lease, null, {
      purpose: input.purpose,
      language: input.language ?? (lease.templateVersion.language === 'en' ? 'en' : 'th'),
      ...period,
    });
  }

  async issue(ctx: TenantContext, id: string): Promise<RentCertificate> {
    const row = await this.pending(ctx, id);
    const lease = await this.leases.get(ctx, row.leaseId);
    return this.render(ctx, lease, row, {
      purpose: row.purpose,
      language: row.language === 'en' ? 'en' : 'th',
      from: day(row.periodFrom),
      to: day(row.periodTo),
    });
  }

  async decline(ctx: TenantContext, id: string, reason: string): Promise<RentCertificate> {
    const text = reason.trim();
    if (!text || text.length > 500) throw invalid('reason', 'length', 'between 1 and 500 characters');
    const row = await this.pending(ctx, id);
    const lease = await this.leases.get(ctx, row.leaseId);
    return this.db.tenant(ctx, async (tx) => {
      const updated = await tx.rentCertificate.updateMany({
        where: { id, state: 'requested' },
        data: {
          state: 'declined',
          declineReason: text,
          decidedAt: this.clock.now(),
          decidedBy: userIdOf(RequestContext.actor()),
        },
      });
      if (updated.count !== 1) throw new DomainException('rent_certificate.invalid_state');
      await this.audit.record(tx, {
        action: 'lease.rent_certificate_declined',
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        subjectType: 'ops.lease',
        subjectId: lease.id,
        metadata: { certificateId: id },
      });
      await this.leases.history(
        tx,
        lease,
        'rent_certificate_declined',
        { certificateId: id, partyId: row.requestedByPartyId, reason: text },
        'lease.rent_certificate_declined',
      );
      return tx.rentCertificate.findUniqueOrThrow({ where: { id } });
    });
  }

  private async pending(ctx: TenantContext, id: string): Promise<RentCertificate> {
    const row = this.found(
      await this.db.tenant(ctx, (tx) => tx.rentCertificate.findFirst({ where: this.own(ctx, { id }) })),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId))
      throw new DomainException('http.not_found');
    if (row.state !== 'requested') throw new DomainException('rent_certificate.invalid_state');
    return row;
  }

  /** The period asked for: default the last 12 months up to today, inside the lease, at most 24 months. */
  private period(
    lease: LeaseRow,
    input: { periodFrom?: string; periodTo?: string },
  ): { from: string; to: string } {
    const today = bangkokDate(this.clock.now());
    const start = day(lease.startDate);
    const to = input.periodTo ?? (day(lease.endDate) < today ? day(lease.endDate) : today);
    const yearAgo = `${Number(to.slice(0, 4)) - 1}${to.slice(4, 8)}01`;
    const from = input.periodFrom ?? (yearAgo > start ? yearAgo : start);
    if (!DAY.test(from)) throw invalid('periodFrom', 'date', 'a date YYYY-MM-DD');
    if (!DAY.test(to)) throw invalid('periodTo', 'date', 'a date YYYY-MM-DD');
    if (to > today) throw invalid('periodTo', 'future', 'not after today');
    if (from > to) throw invalid('periodFrom', 'range', 'not after the end of the period');
    if (from < start) throw invalid('periodFrom', 'range', `not before the lease starts (${start})`);
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7));
    if (months > MAX_MONTHS) throw invalid('periodFrom', 'range', `at most ${MAX_MONTHS} months`);
    return { from, to };
  }

  private async render(
    ctx: TenantContext,
    lease: LeaseRow,
    request: RentCertificate | null,
    p: { purpose: RentCertificatePurpose; language: ContractLanguage; from: string; to: string },
  ): Promise<RentCertificate> {
    const now = this.clock.now();
    const partyIds = lease.parties.map((x) => x.partyId);
    const range = { gte: startOfBangkokDay(p.from), lt: startOfBangkokDay(addCalendarDays(p.to, 1)) };
    const [receipts, taxReceipts, overdue] = await this.db.tenant(ctx, (tx) =>
      Promise.all([
        tx.receipt.findMany({
          where: {
            tenantId: lease.tenantId,
            unitId: lease.unitId,
            kind: { in: ['payment', 'advance'] },
            voidedAt: null,
            payerPartyId: { in: partyIds },
            issuedAt: range,
          },
          select: { number: true, issuedAt: true, amount: true },
        }),
        tx.taxInvoice.findMany({
          where: {
            tenantId: lease.tenantId,
            unitId: lease.unitId,
            kind: 'receipt_tax_invoice',
            voidedAt: null,
            buyerPartyId: { in: partyIds },
            issuedAt: range,
          },
          select: { number: true, issuedAt: true, total: true },
        }),
        tx.invoice.aggregate({
          where: { tenantId: lease.tenantId, leaseId: lease.id, status: 'overdue' },
          _sum: { balance: true },
        }),
      ]),
    );
    const payments = [
      ...receipts.map((r) => ({ at: r.issuedAt, number: r.number, amount: r.amount.toString() })),
      ...taxReceipts.map((r) => ({ at: r.issuedAt, number: r.number, amount: r.total.toString() })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.number.localeCompare(b.number));
    const total = payments.reduce((sum, x) => sum.plus(x.amount), new Decimal(0));
    const outstanding = new Decimal(overdue._sum.balance?.toString() ?? 0);
    const base = await this.letters.baseData(lease, p.language);
    const en = p.language === 'en';
    const date = (d: string) => (en ? englishDate(d) : thaiDate(d));
    const today = bangkokDate(now);

    return this.db.tenant(
      ctx,
      async (tx) => {
        const number = await this.numbering.next(tx, lease.tenantId, 'rent_certificate', now);
        const title = certificateTitle(p.language);
        const body = certificateBody(p.language, {
          number,
          issuedOn: date(today),
          lessor: base.lessor,
          lessee: { displayName: base.lessee.displayName },
          premises: base.premises,
          lease: {
            number: base.lease.number,
            startDate: date(base.lease.startDate),
            endDate: date(base.lease.endDate),
            rent: formatThb(base.lease.rent),
          },
          period: { from: date(p.from), to: date(p.to) },
          purpose: p.purpose,
          payments: payments.map((x) => ({
            date: date(bangkokDate(x.at)),
            number: x.number,
            amount: formatThb(x.amount),
          })),
          total: formatThb(total),
          totalText: en ? bahtTextEn(total) : bahtText(total),
          outstanding: outstanding.gt(0) ? formatThb(outstanding) : null,
        });
        const html = await this.renderer.brandedDocument(body, title, p.language);
        const pdf = await this.pdf.render(html, {
          title: `${title} ${number}`,
          footer: `${title} ${number}`,
        });
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: lease.tenantId,
          kind: 'pdf_certificate',
          scopeType: 'unit',
          scopeId: lease.unitId,
          buildingId: lease.buildingId,
          title: `${title} ${number}.pdf`,
          mimeType: 'application/pdf',
          body: pdf,
        });
        const decided = {
          state: 'issued' as const,
          number,
          documentId: doc.id,
          totalPaid: total.toFixed(2),
          decidedAt: now,
          decidedBy: userIdOf(RequestContext.actor()),
        };
        let row: RentCertificate;
        if (request) {
          const updated = await tx.rentCertificate.updateMany({
            where: { id: request.id, state: 'requested' },
            data: decided,
          });
          if (updated.count !== 1) throw new DomainException('rent_certificate.invalid_state');
          row = await tx.rentCertificate.findUniqueOrThrow({ where: { id: request.id } });
        } else {
          row = await tx.rentCertificate.create({
            data: {
              tenantId: lease.tenantId,
              leaseId: lease.id,
              buildingId: lease.buildingId,
              unitId: lease.unitId,
              purpose: p.purpose,
              periodFrom: new Date(p.from),
              periodTo: new Date(p.to),
              language: p.language,
              ...decided,
            },
          });
        }
        await this.audit.record(tx, {
          action: 'lease.rent_certificate_issued',
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          subjectType: 'ops.lease',
          subjectId: lease.id,
          metadata: { certificateId: row.id, number, total: total.toFixed(2) },
        });
        await this.leases.history(
          tx,
          lease,
          'rent_certificate_issued',
          { certificateId: row.id, number, partyId: request?.requestedByPartyId ?? lease.lesseePartyId },
          'lease.rent_certificate_issued',
        );
        return row;
      },
      { timeout: 60_000 },
    );
  }
}

const PURPOSE_TH: Record<RentCertificatePurpose, string> = {
  visa: 'วีซ่า',
  bank: 'ธนาคาร',
  employer: 'นายจ้าง',
  other: 'อื่น ๆ',
};
