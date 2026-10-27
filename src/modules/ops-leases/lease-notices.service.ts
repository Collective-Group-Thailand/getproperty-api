import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { billedParty, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type LeaseNotice } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { ContractLibraryService } from './contract-library.service';
import { type ContractLanguage, ContractRenderer } from './contract-renderer';
import { bahtTextEn, englishDate } from './english-text';
import { addressText, type LeaseRow, LeasesService } from './leases.service';
import {
  type LeaseNoticeKind,
  noticeBody,
  type NoticeData,
  noticeTitle,
  TERMINATION_REASONS,
  type TerminationReason,
} from './notice-templates';
import { ResidentLeasesService } from './resident-leases.service';
import { bahtText, formatThb, thaiDate } from './thai-text';

export interface NoticeInput {
  kind: LeaseNoticeKind;
  language?: ContractLanguage;
  effectiveDate?: string;
  newRent?: string;
  renewalMonths?: number;
  reasonCode?: string;
  message?: string | null;
  evidenceDocumentIds?: string[];
  acknowledgementIds?: string[];
}

const ISSUABLE: Record<LeaseNoticeKind, string[]> = {
  rent_increase: ['active', 'notice_given'],
  renewal_offer: ['active', 'notice_given'],
  non_renewal: ['active'],
  termination: ['active'],
  late_payment: ['active', 'notice_given', 'ending'],
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/**
 * Written notices to the lessee (B7.5, D-253): rent change at renewal, renewal offer, non-renewal, termination and
 * late payment — each a numbered letter (series `notice`) in the landlord's name and language, rendered as a PDF
 * (`pdf_notice`), stored with the unit and sent to the resident in LINE. Notice periods are settings
 * (`lease.notice.*`); a non-renewal or termination letter also records the lessor's notice on the lease through the
 * compliance rules of D-020 (`LeasesService.recordNotice`), so the letter and the lease never disagree. A late-payment
 * letter never terminates the lease nor cuts a service (D-024).
 */
@Injectable()
export class LeaseNoticesService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: LeasesService,
    private readonly residents: ResidentLeasesService,
    private readonly settings: SettingsService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    private readonly library: ContractLibraryService,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('lease.notice_issued', async (tx, e) => {
      const partyId = e.payload.lesseePartyId as string | undefined;
      if (!partyId || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          notice: {
            number: e.payload.number,
            titleTh: noticeTitle(e.payload.kind as LeaseNoticeKind, 'th'),
            titleEn: noticeTitle(e.payload.kind as LeaseNoticeKind, 'en'),
          },
          link: this.link(e.payload.leaseId as string, e.payload.noticeId as string),
        },
        consentPurpose: 'resident.service',
      };
    });
  }

  /** The resident app screen of a notice (LIFF). */
  link(leaseId: string, noticeId: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/lease/${leaseId}/notices/${noticeId}`;
  }

  list(ctx: TenantContext, leaseId: string): Promise<LeaseNotice[]> {
    return this.db.tenant(ctx, async (tx) => {
      await this.leaseOf(tx, ctx, leaseId);
      return tx.leaseNotice.findMany({
        where: { tenantId: ctx.tenantId, leaseId },
        orderBy: [{ issuedOn: 'desc' }, { createdAt: 'desc' }],
      });
    });
  }

  /** A signed link to the notice PDF (owner). */
  async document(ctx: TenantContext, noticeId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const notice = this.found(
        await tx.leaseNotice.findFirst({
          where: this.own(ctx, { id: noticeId }),
          include: { document: true },
        }),
      );
      if (ctx.buildingIds && !ctx.buildingIds.includes(notice.buildingId))
        throw new DomainException('http.not_found');
      if (!notice.document) throw new DomainException('http.not_found');
      return { notice, ...(await this.documents.signedUrl(notice.document)) };
    });
  }

  /** The notices of a lease the resident is on (LIFF), newest first. */
  async residentList(leaseId: string): Promise<LeaseNotice[]> {
    const { ctx } = await this.residents.access(leaseId);
    return this.db.tenant(ctx, (tx) =>
      tx.leaseNotice.findMany({ where: { leaseId }, orderBy: [{ issuedOn: 'desc' }, { createdAt: 'desc' }] }),
    );
  }

  /** A signed link to a notice of the resident's lease. */
  async residentDocument(leaseId: string, noticeId: string) {
    const { ctx } = await this.residents.access(leaseId);
    return this.db.tenant(ctx, async (tx) => {
      const notice = await tx.leaseNotice.findFirst({
        where: { id: noticeId, leaseId },
        include: { document: true },
      });
      if (!notice?.document) throw new DomainException('http.not_found');
      return { notice, ...(await this.documents.signedUrl(notice.document)) };
    });
  }

  private async leaseOf(tx: Tx, ctx: TenantContext, leaseId: string) {
    const lease = this.found(await tx.lease.findFirst({ where: this.own(ctx, { id: leaseId }) }));
    if (ctx.buildingIds && !ctx.buildingIds.includes(lease.buildingId))
      throw new DomainException('http.not_found');
    return lease;
  }

  /**
   * G3 (D-294): the tenant's own published library text for a letter kind (renewal offer → `notice_renewal`,
   * termination / non-renewal → `notice_termination`) replaces the built-in body; numbering, PDF and flow stay B7.5.
   */
  private async customBody(
    tenantId: string,
    kind: LeaseNoticeKind,
    language: ContractLanguage,
    data: NoticeData,
  ) {
    const libraryKind =
      kind === 'renewal_offer'
        ? 'notice_renewal'
        : kind === 'termination' || kind === 'non_renewal'
          ? 'notice_termination'
          : null;
    if (!libraryKind) return null;
    const own = await this.library.ownPublished(tenantId, libraryKind, language);
    return own ? this.renderer.body(own.bodyHtml, data) : null;
  }

  async issue(
    ctx: TenantContext,
    leaseId: string,
    input: NoticeInput,
    options: { within?: (tx: Tx, notice: LeaseNotice) => Promise<void> } = {},
  ): Promise<LeaseNotice> {
    const lease = await this.leases.get(ctx, leaseId);
    if (!ISSUABLE[input.kind].includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    const now = this.clock.now();
    const today = bangkokDate(now);
    const endDate = day(lease.endDate);
    const message = input.message?.trim() || null;
    const at = { tenantId: lease.tenantId };
    const terms: {
      effectiveDate: string | null;
      respondBy: string | null;
      noticeDays: number | null;
      newRent: string | null;
      renewalMonths: number | null;
      reasonCode: string | null;
      amountDue: string | null;
      items: { invoiceId: string; number: string; dueDate: string; balance: string }[];
    } = {
      effectiveDate: null,
      respondBy: null,
      noticeDays: null,
      newRent: null,
      renewalMonths: null,
      reasonCode: null,
      amountDue: null,
      items: [],
    };

    switch (input.kind) {
      case 'rent_increase': {
        const rent = this.money('newRent', input.newRent);
        if (!input.effectiveDate || !DAY.test(input.effectiveDate))
          throw invalid('effectiveDate', 'required', 'the date the new rent applies');
        if (input.effectiveDate <= endDate)
          throw invalid(
            'effectiveDate',
            'midterm',
            `after the current lease ends (${endDate}) — no mid-term increase (D-020)`,
          );
        const minDays = Number(
          await this.settings.valueAt<number>('lease.notice.rent_increase_days', now, at),
        );
        const days = daysBetween(today, input.effectiveDate);
        if (days < minDays)
          throw invalid('effectiveDate', 'noticePeriod', `at least ${minDays} days after today`);
        Object.assign(terms, { effectiveDate: input.effectiveDate, noticeDays: days, newRent: rent });
        break;
      }
      case 'renewal_offer': {
        const rent =
          input.newRent === undefined ? lease.rent.toFixed(2) : this.money('newRent', input.newRent);
        const months = input.renewalMonths ?? lease.months;
        if (!Number.isInteger(months) || months < 1 || months > 120)
          throw invalid('renewalMonths', 'range', 'between 1 and 120 months');
        const effectiveDate = addCalendarDays(endDate, 1);
        const responseDays = Number(
          await this.settings.valueAt<number>('lease.notice.renewal_response_days', now, at),
        );
        const respondBy = [addCalendarDays(today, responseDays), endDate].sort()[0]!;
        Object.assign(terms, {
          effectiveDate,
          respondBy,
          noticeDays: daysBetween(today, effectiveDate),
          newRent: rent,
          renewalMonths: months,
        });
        break;
      }
      case 'non_renewal':
      case 'termination': {
        const reason = input.kind === 'non_renewal' ? 'end_of_term' : (input.reasonCode ?? '');
        if (input.kind === 'termination' && !(TERMINATION_REASONS as readonly string[]).includes(reason))
          throw invalid('reasonCode', 'isIn', `one of ${TERMINATION_REASONS.join(', ')}`);
        const effectiveDate = input.kind === 'non_renewal' ? endDate : input.effectiveDate;
        if (!effectiveDate || !DAY.test(effectiveDate))
          throw invalid('effectiveDate', 'required', 'the date the lease ends');
        // the lessor's notice on the lease: legal ground, notice length and evidence checked by the D-020 rules
        await this.leases.recordNotice(ctx, leaseId, {
          by: 'lessor',
          noticeDate: today,
          effectiveDate,
          reasonCode: reason,
          evidenceDocumentIds: input.evidenceDocumentIds,
          acknowledgementIds: input.acknowledgementIds,
        });
        Object.assign(terms, {
          effectiveDate,
          noticeDays: daysBetween(today, effectiveDate),
          reasonCode: input.kind === 'termination' ? reason : null,
        });
        break;
      }
      case 'late_payment': {
        const overdue = await this.db.tenant(ctx, (tx) =>
          tx.invoice.findMany({
            where: { tenantId: ctx.tenantId, leaseId, status: 'overdue', balance: { gt: 0 } },
            orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
            select: { id: true, number: true, dueDate: true, balance: true },
          }),
        );
        if (!overdue.length) throw new DomainException('lease.notice_nothing_overdue');
        const total = overdue.reduce((sum, i) => sum.plus(i.balance.toString()), new Decimal(0));
        const payDays = Number(
          await this.settings.valueAt<number>('lease.notice.late_payment_days', now, at),
        );
        Object.assign(terms, {
          respondBy: addCalendarDays(today, payDays),
          noticeDays: payDays,
          amountDue: total.toFixed(2),
          items: overdue.map((i) => ({
            invoiceId: i.id,
            number: i.number ?? '—',
            dueDate: i.dueDate ? day(i.dueDate) : '',
            balance: i.balance.toFixed(2),
          })),
        });
        break;
      }
    }

    const language: ContractLanguage =
      input.language ?? (lease.templateVersion.language === 'en' ? 'en' : 'th');
    const base = await this.baseData(lease, language);
    const refundDays = Number(await this.settings.valueAt<number>('deposit.refund_days', now, at));

    return this.db.tenant(
      ctx,
      async (tx) => {
        const number = await this.numbering.next(tx, lease.tenantId, 'notice', now);
        const data = this.letterData(language, number, today, base, terms, refundDays, message);
        const title = noticeTitle(input.kind, language);
        const html = await this.renderer.brandedDocument(
          (await this.customBody(lease.tenantId, input.kind, language, data)) ??
            noticeBody(input.kind, language, data),
          title,
          language,
        );
        const body = await this.pdf.render(html, {
          title: `${title} ${number}`,
          footer: `${title} ${number}`,
        });
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: lease.tenantId,
          kind: 'pdf_notice',
          scopeType: 'unit',
          scopeId: lease.unitId,
          buildingId: lease.buildingId,
          title: `${title} ${number}.pdf`,
          mimeType: 'application/pdf',
          body,
        });
        const notice = await tx.leaseNotice.create({
          data: {
            tenantId: lease.tenantId,
            leaseId,
            buildingId: lease.buildingId,
            unitId: lease.unitId,
            kind: input.kind,
            number,
            language,
            issuedOn: new Date(today),
            effectiveDate: terms.effectiveDate ? new Date(terms.effectiveDate) : null,
            respondBy: terms.respondBy ? new Date(terms.respondBy) : null,
            noticeDays: terms.noticeDays,
            newRent: terms.newRent,
            renewalMonths: terms.renewalMonths,
            amountDue: terms.amountDue,
            reasonCode: terms.reasonCode,
            message,
            details: { items: terms.items },
            documentId: doc.id,
            sentAt: now,
            createdBy: userIdOf(RequestContext.actor()),
          },
        });
        await this.audit.record(tx, {
          action: 'lease.notice_issued',
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          subjectType: 'ops.lease',
          subjectId: leaseId,
          metadata: { noticeId: notice.id, kind: input.kind, number, effectiveDate: terms.effectiveDate },
        });
        await this.leases.history(
          tx,
          lease,
          'notice_issued',
          { noticeId: notice.id, kind: input.kind, number, lesseePartyId: lease.lesseePartyId },
          'lease.notice_issued',
        );
        if (options.within) await options.within(tx, notice);
        return notice;
      },
      { timeout: 60_000 },
    );
  }

  private money(path: string, value: string | undefined): string {
    if (!value || !/^\d{1,9}(\.\d{1,2})?$/.test(value) || new Decimal(value).lte(0))
      throw invalid(path, 'money', 'an amount like 15000.00');
    return new Decimal(value).toFixed(2);
  }

  /** Lessor, lessee, premises and lease facts for a letter (shared by notices and certificates). */
  async baseData(lease: LeaseRow, language: ContractLanguage) {
    const [tenant, party, unit] = await Promise.all([
      this.db.platform((tx) => tx.tenant.findUniqueOrThrow({ where: { id: lease.tenantId } })),
      this.db.platform((tx) => tx.party.findUniqueOrThrow({ where: { id: lease.lesseePartyId } })),
      this.db.platform((tx) =>
        tx.unit.findUniqueOrThrow({
          where: { id: lease.unitId },
          include: { building: { include: { property: true } } },
        }),
      ),
    ]);
    const premisesAddress = addressText(unit.building.address) || addressText(unit.building.property.address);
    return {
      language,
      lessor: {
        legalName: tenant.legalName,
        taxId: tenant.taxId,
        address: addressText(tenant.address) || premisesAddress,
      },
      lessee: {
        displayName: party.displayName,
        address: party.address ? addressText(party.address) || null : null,
      },
      premises: { unitNo: unit.unitNo, propertyName: unit.building.property.name, address: premisesAddress },
      lease: {
        number: lease.number,
        startDate: day(lease.startDate),
        endDate: day(lease.endDate),
        rent: lease.rent.toFixed(2),
      },
    };
  }

  private letterData(
    language: ContractLanguage,
    number: string,
    today: string,
    base: Awaited<ReturnType<LeaseNoticesService['baseData']>>,
    t: {
      effectiveDate: string | null;
      respondBy: string | null;
      noticeDays: number | null;
      newRent: string | null;
      renewalMonths: number | null;
      reasonCode: string | null;
      amountDue: string | null;
      items: { number: string; dueDate: string; balance: string }[];
    },
    refundDays: number,
    message: string | null,
  ): NoticeData {
    const date = (d: string | null) => (d ? (language === 'en' ? englishDate(d) : thaiDate(d)) : null);
    const words = (v: string | null) => (v ? (language === 'en' ? bahtTextEn(v) : bahtText(v)) : null);
    return {
      number,
      issuedOn: date(today)!,
      lessor: base.lessor,
      lessee: base.lessee,
      premises: base.premises,
      lease: {
        number: base.lease.number,
        startDate: date(base.lease.startDate)!,
        endDate: date(base.lease.endDate)!,
        rent: formatThb(base.lease.rent),
        rentText: words(base.lease.rent)!,
      },
      effectiveDate: date(t.effectiveDate),
      respondBy: date(t.respondBy),
      noticeDays: t.noticeDays,
      newRent: t.newRent ? formatThb(t.newRent) : null,
      newRentText: words(t.newRent),
      renewalMonths: t.renewalMonths,
      reasonCode: t.reasonCode as TerminationReason | null,
      amountDue: t.amountDue ? formatThb(t.amountDue) : null,
      amountDueText: words(t.amountDue),
      items: t.items.map((i) => ({
        number: i.number,
        dueDate: date(i.dueDate) ?? '',
        balance: formatThb(i.balance),
      })),
      refundDays,
      message,
    };
  }
}
