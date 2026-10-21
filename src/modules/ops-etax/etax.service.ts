import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';
import { DocumentsService } from '@core/documents/documents.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type EtaxStatus,
  type EtaxSubjectType,
  type EtaxSubmission,
  type Prisma,
} from '@generated/prisma/client';
import {
  ETAX_PROVIDERS,
  type EtaxAccount,
  type EtaxDocumentInput,
  EtaxProviderError,
  type EtaxProviderKey,
  type EtaxProviderRegistry,
} from '@integrations/etax/etax-provider.port';
import { formatAddress } from '@modules/ops-documents/document-views';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  backoffMinutes,
  ETAX_CLAIM_MINUTES,
  ETAX_MAX_ATTEMPTS,
  ETAX_POLL_MINUTES,
  etaxTypeCode,
  monthRange,
  previousMonth,
  vatLines,
} from './etax-rules';

const D = (v: { toString(): string } | Decimal.Value) => new Decimal(v.toString());
const MINUTE = 60_000;

export interface EtaxSummary {
  month: string;
  enabled: boolean;
  provider: string | null;
  counts: Record<EtaxStatus, number>;
  signed: { documents: number; subtotal: string; vatAmount: string; total: string };
  byType: { typeCode: string; documents: number; total: string }[];
}

/**
 * e-Tax Invoice & e-Receipt (B6.2, D-050, D-215). The platform is not a service provider: each VAT-registered tenant
 * that switched `etax.enabled` on has an account with an approved provider (`etax.provider`, secrets in the secret
 * store). `receipt.issued` / `tax_invoice.issued` queue one submission (in the subscriber's transaction); the
 * submission is sent after the commit and by the `etax-submissions` worker job: submit (our PDF + the document data)
 * → poll until signed or rejected → the signed XML and PDF are stored as documents (version 2 of the receipt PDF)
 * and the receipt gets the provider reference; `etax.signed` sends the signed PDF to the payer, `etax.rejected` tells
 * the owner. Transient failures retry with backoff (10 attempts). Monthly figures for the accountant: `summary()`,
 * the `etax_monthly_xlsx` export and the `etax.monthly_summary` notice on the 1st.
 */
@Injectable()
export class EtaxService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'etax';
  readonly eventTypes = ['receipt.issued', 'tax_invoice.issued'] as const;
  private readonly logger = new Logger(EtaxService.name);
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    private readonly config: AppConfig,
    @Inject(ETAX_PROVIDERS) private readonly providers: EtaxProviderRegistry,
    private readonly credentialStore: ProviderCredentialsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------------------ queue

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const id = event.payload.receiptId as string;
    const row = await this.queue(tx, event.type === 'receipt.issued' ? 'receipt' : 'tax_invoice', id);
    if (row) this.pending.set(event.id, row.id);
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const id = this.pending.get(event.id);
    this.pending.delete(event.id);
    if (id)
      await this.process(id).catch((e: unknown) => this.logger.warn(`e-Tax ${id}: ${(e as Error).message}`));
  }

  /** Queues the submission of an issued receipt / tax invoice when its tenant uses e-Tax; idempotent. */
  async queue(tx: Tx, subjectType: 'receipt' | 'tax_invoice', subjectId: string) {
    const existing = await tx.etaxSubmission.findUnique({
      where: { subjectType_subjectId: { subjectType, subjectId } },
    });
    if (existing) return existing;
    const doc =
      subjectType === 'receipt'
        ? await tx.receipt.findUnique({ where: { id: subjectId } })
        : await tx.taxInvoice.findUnique({ where: { id: subjectId } });
    if (!doc || doc.voidedAt) return null;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: doc.tenantId } });
    if (!tenant.vatRegistered) return null;
    const scope = { tenantId: doc.tenantId };
    if ((await this.settings.at('etax.enabled', doc.issuedAt, scope))?.value !== true) return null;
    const configured = (await this.settings.at('etax.provider', doc.issuedAt, scope))?.value;
    const provider = typeof configured === 'string' ? configured : 'inet';
    const amounts =
      subjectType === 'receipt'
        ? { subtotal: D((doc as { amount: Decimal.Value }).amount), vat: new Decimal(0) }
        : {
            subtotal: D((doc as { subtotal: Decimal.Value }).subtotal),
            vat: D((doc as { vatAmount: Decimal.Value }).vatAmount),
          };
    const row = await tx.etaxSubmission.create({
      data: {
        tenantId: doc.tenantId,
        buildingId: doc.buildingId,
        subjectType,
        subjectId,
        number: doc.number,
        documentTypeCode: etaxTypeCode(subjectType, (doc as { kind?: string }).kind),
        issuedAt: doc.issuedAt,
        subtotal: amounts.subtotal.toFixed(2),
        vatAmount: amounts.vat.toFixed(2),
        total: amounts.subtotal.plus(amounts.vat).toFixed(2),
        provider,
        sourceDocumentId: doc.documentId,
        createdBy: userIdOf(RequestContext.actor()),
      },
    });
    await this.audit.record(tx, {
      action: 'etax.queued',
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: 'ops.etax_submission',
      subjectId: row.id,
      metadata: { subjectType, subjectId, number: row.number, provider },
    });
    await this.events.record(tx, {
      type: 'etax.queued',
      aggregateType: 'etax_submission',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: { submissionId: row.id, subjectType, subjectId, number: row.number },
    });
    return row;
  }

  // ---------------------------------------------------------------------------------------------- provider calls

  /** Worker job `etax-submissions`: every submission due (queued, failed with a retry due, submitted to poll). */
  async sweep(limit = 50): Promise<number> {
    const now = this.clock.now();
    const due = await this.db.platform((tx) =>
      tx.etaxSubmission.findMany({
        where: {
          OR: [
            { status: { in: ['queued', 'failed'] }, attempts: { lt: ETAX_MAX_ATTEMPTS } },
            { status: 'submitted' },
          ],
          AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
    );
    for (const s of due)
      await this.process(s.id).catch((e: unknown) =>
        this.logger.warn(`e-Tax ${s.id}: ${(e as Error).message}`),
      );
    return due.length;
  }

  /** Claims a submission for one worker (`next_attempt_at` moved ahead); false when another worker holds it. */
  private async claim(id: string): Promise<EtaxSubmission | null> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE ops.etax_submission SET next_attempt_at = ${new Date(now.getTime() + ETAX_CLAIM_MINUTES * MINUTE)}
         WHERE id = ${id}::uuid AND status IN ('queued', 'failed', 'submitted')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        RETURNING id`;
      return claimed.length ? tx.etaxSubmission.findUnique({ where: { id } }) : null;
    });
  }

  /** One step of a submission: submit, or poll and fetch the signed artefacts. Safe to call repeatedly. */
  async process(id: string): Promise<void> {
    await RequestContext.run({ actor: systemActor('etax') }, async () => {
      const s = await this.claim(id);
      if (!s) return;
      const account = await this.account(s);
      if ('error' in account) return this.fail(s, account.error, false);
      const adapter = this.providers.adapter(s.provider as EtaxProviderKey);
      try {
        if (s.status === 'submitted' && s.providerDocId) {
          const r = await adapter.status(account.account, s.providerDocId, this.meta(s));
          const meta = { ...this.meta(s), ...r.meta };
          if (r.status === 'signed') return this.signed(s, account.account, meta);
          if (r.status === 'rejected') return this.rejected(s, r.error ?? 'rejected', meta);
          await this.db.platform((tx) =>
            tx.etaxSubmission.update({
              where: { id: s.id },
              data: {
                providerMeta: meta as Prisma.InputJsonValue,
                nextAttemptAt: new Date(this.clock.now().getTime() + ETAX_POLL_MINUTES * MINUTE),
              },
            }),
          );
          return;
        }
        const input = await this.input(s);
        const r = await adapter.submit(account.account, input);
        const now = this.clock.now();
        await this.db.platform((tx) =>
          tx.etaxSubmission.update({
            where: { id: s.id },
            data: {
              status: r.status === 'rejected' ? 'rejected' : 'submitted',
              providerDocId: r.providerDocId,
              providerMeta: r.meta as Prisma.InputJsonValue,
              attempts: { increment: 1 },
              submittedAt: now,
              error: null,
              nextAttemptAt:
                r.status === 'submitted' ? new Date(now.getTime() + ETAX_POLL_MINUTES * MINUTE) : null,
              version: { increment: 1 },
            },
          }),
        );
        const fresh = await this.db.platform((tx) =>
          tx.etaxSubmission.findUniqueOrThrow({ where: { id: s.id } }),
        );
        if (r.status === 'signed') return this.signed(fresh, account.account, r.meta);
        if (r.status === 'rejected') return this.rejected(fresh, r.error ?? 'rejected', r.meta, true);
      } catch (error) {
        if (error instanceof EtaxProviderError || error instanceof DomainException)
          return this.fail(
            s,
            (error as Error).message,
            error instanceof EtaxProviderError && error.retryable,
          );
        throw error;
      }
    });
  }

  private meta(s: EtaxSubmission): Record<string, unknown> {
    return (s.providerMeta ?? {}) as Record<string, unknown>;
  }

  private async account(s: EtaxSubmission): Promise<{ account: EtaxAccount } | { error: string }> {
    const stored = await this.credentialStore.get(
      { tenantId: s.tenantId, kind: 'etax', provider: s.provider },
      'etax.submit',
    );
    if (!stored && this.providers.mode === 'real')
      return { error: `no ${s.provider} account credentials for the tenant` };
    const credentials: Record<string, string> = stored ?? {};
    return { account: { provider: s.provider as EtaxProviderKey, credentials } };
  }

  /** The document data the provider needs (seller, buyer, lines, totals, references, our PDF). */
  private async input(s: EtaxSubmission): Promise<EtaxDocumentInput> {
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: s.tenantId } });
      if (!tenant.taxId || !/^\d{13}$/.test(tenant.taxId))
        throw new EtaxProviderError(s.provider, 'the tenant has no 13-digit tax id', false);
      const branchSetting = (
        await this.settings.at('etax.seller_branch', s.issuedAt, { tenantId: s.tenantId })
      )?.value;
      const branch =
        typeof branchSetting === 'string' && /^\d{5}$/.test(branchSetting) ? branchSetting : '00000';
      const row =
        s.subjectType === 'receipt'
          ? await tx.receipt.findUniqueOrThrow({ where: { id: s.subjectId } })
          : await tx.taxInvoice.findUniqueOrThrow({ where: { id: s.subjectId } });
      const payerId = 'payerPartyId' in row ? row.payerPartyId : row.buyerPartyId;
      const payer = await tx.party.findUniqueOrThrow({ where: { id: payerId } });
      const payment = row.paymentId
        ? await tx.payment.findUnique({
            where: { id: row.paymentId },
            include: { allocations: { include: { invoice: true } } },
          })
        : null;
      const references = (payment?.allocations ?? [])
        .filter((a) => a.invoice.number)
        .map((a) => ({
          number: a.invoice.number!,
          issuedOn: a.invoice.issuedAt ? bangkokDate(a.invoice.issuedAt) : '',
          typeCode: '380',
        }));
      const lines =
        s.subjectType === 'receipt'
          ? (
              (row as { lines: unknown }).lines as {
                description: string;
                reference: string | null;
                amount: string;
              }[]
            ).map((l) => ({
              name: l.reference ? `${l.description} ${l.reference}` : l.description,
              quantity: '1',
              unitPrice: D(l.amount).toFixed(2),
              amount: D(l.amount).toFixed(2),
              vatRatePct: '0.00',
            }))
          : vatLines(
              (payment?.allocations ?? []).map((a) => ({
                name: `ชำระใบแจ้งหนี้ ${a.invoice.number ?? ''}`.trim(),
                amount: D(a.amount).toFixed(2),
              })),
              s.subtotal.toFixed(2),
              s.total.toFixed(2),
              '7.00',
            );
      const address = (payer.address ?? null) as Record<string, unknown> | null;
      const source = s.sourceDocumentId
        ? await tx.document.findUnique({ where: { id: s.sourceDocumentId } })
        : null;
      if (!source) throw new EtaxProviderError(s.provider, 'the document PDF is not ready', true);
      return {
        submissionRef: s.id,
        typeCode: s.documentTypeCode as EtaxDocumentInput['typeCode'],
        number: s.number,
        issuedAt: s.issuedAt,
        seller: {
          name: tenant.legalName,
          taxId: tenant.taxId,
          branch,
          address: formatAddress(tenant.address) || null,
          postcode: (() => {
            const pc = ((tenant.address ?? {}) as Record<string, unknown>).postcode;
            return typeof pc === 'string' ? pc : null;
          })(),
          email: null,
        },
        buyer: {
          name: payer.companyName ?? payer.displayName,
          taxId: payer.taxId && /^\d{13}$/.test(payer.taxId) ? payer.taxId : null,
          branch: payer.type === 'company' && payer.taxId ? '00000' : null,
          address: formatAddress(address) || null,
          postcode: typeof address?.postcode === 'string' ? address.postcode : null,
          email: payer.email ?? null,
        },
        lines,
        subtotal: s.subtotal.toFixed(2),
        vatAmount: s.vatAmount.toFixed(2),
        total: s.total.toFixed(2),
        currency: 'THB',
        references,
        pdf: await this.documents.bytesOf(source),
      };
    });
  }

  /** The provider signed: store the signed XML and PDF (version 2 of the PDF), link the receipt, tell the payer. */
  private async signed(s: EtaxSubmission, account: EtaxAccount, meta: Record<string, unknown>) {
    const artefacts = await this.providers
      .adapter(s.provider as EtaxProviderKey)
      .fetchSigned(account, s.providerDocId!, meta);
    await this.db.platform(async (tx) => {
      const source = s.sourceDocumentId
        ? await tx.document.findUnique({ where: { id: s.sourceDocumentId } })
        : null;
      const base = {
        tenantId: s.tenantId,
        scopeType: (source?.scopeType ?? 'building') as 'unit' | 'building',
        scopeId: source?.scopeId ?? s.buildingId,
        buildingId: s.buildingId,
        retentionClass: source?.retentionClass,
        sourceRef: `etax:${s.provider}:${s.providerDocId}`,
      };
      const pdf = await this.documents.storeGenerated(tx, {
        ...base,
        kind: s.subjectType === 'receipt' ? 'pdf_receipt' : 'pdf_tax_invoice',
        title: `${s.number} (e-Tax).pdf`,
        mimeType: 'application/pdf',
        body: artefacts.pdf,
        versionOfDocumentId: s.sourceDocumentId,
        versionNo: 2,
      });
      const xml = await this.documents.storeGenerated(tx, {
        ...base,
        kind: 'other',
        title: `${s.number} (e-Tax).xml`,
        mimeType: 'application/xml',
        body: artefacts.xml,
        versionOfDocumentId: s.sourceDocumentId,
        versionNo: 2,
      });
      const now = this.clock.now();
      await tx.etaxSubmission.update({
        where: { id: s.id },
        data: {
          status: 'signed',
          signedAt: now,
          signedPdfDocumentId: pdf.id,
          signedXmlDocumentId: xml.id,
          providerMeta: meta as Prisma.InputJsonValue,
          nextAttemptAt: null,
          error: null,
          version: { increment: 1 },
        },
      });
      if (s.subjectType === 'receipt')
        await tx.receipt.update({ where: { id: s.subjectId }, data: { eTaxRef: s.providerDocId } });
      else await tx.taxInvoice.update({ where: { id: s.subjectId }, data: { eTaxRef: s.providerDocId } });
      await this.audit.record(tx, {
        action: 'etax.signed',
        tenantId: s.tenantId,
        buildingId: s.buildingId,
        subjectType: 'ops.etax_submission',
        subjectId: s.id,
        metadata: { number: s.number, providerDocId: s.providerDocId, pdf: pdf.id, xml: xml.id },
      });
      const subject =
        s.subjectType === 'receipt'
          ? await tx.receipt.findUniqueOrThrow({ where: { id: s.subjectId } })
          : await tx.taxInvoice.findUniqueOrThrow({ where: { id: s.subjectId } });
      await this.events.record(tx, {
        type: 'etax.signed',
        aggregateType: 'etax_submission',
        aggregateId: s.id,
        tenantId: s.tenantId,
        buildingId: s.buildingId,
        payload: {
          submissionId: s.id,
          subjectType: s.subjectType,
          subjectId: s.subjectId,
          number: s.number,
          payerPartyId: 'payerPartyId' in subject ? subject.payerPartyId : subject.buyerPartyId,
          unitId: subject.unitId,
          signedPdfDocumentId: pdf.id,
        },
      });
    });
  }

  private async rejected(s: EtaxSubmission, error: string, meta: Record<string, unknown>, submitted = false) {
    await this.db.platform(async (tx) => {
      await tx.etaxSubmission.update({
        where: { id: s.id },
        data: {
          status: 'rejected',
          error: error.slice(0, 1000),
          providerMeta: meta as Prisma.InputJsonValue,
          nextAttemptAt: null,
          ...(submitted ? {} : { version: { increment: 1 } }),
        },
      });
      await this.announceRejected(tx, s, error);
    });
  }

  /** A failed call: retry later with backoff; after the last attempt (or a permanent error) the owner is told. */
  private async fail(s: EtaxSubmission, error: string, retryable: boolean) {
    const attempts = s.attempts + 1;
    const final = !retryable || attempts >= ETAX_MAX_ATTEMPTS;
    const now = this.clock.now();
    await this.db.platform(async (tx) => {
      await tx.etaxSubmission.update({
        where: { id: s.id },
        data: {
          status: s.status === 'submitted' && !final ? 'submitted' : 'failed',
          attempts,
          error: error.slice(0, 1000),
          nextAttemptAt: final ? null : new Date(now.getTime() + backoffMinutes(attempts) * MINUTE),
          version: { increment: 1 },
        },
      });
      if (final) await this.announceRejected(tx, s, error);
    });
  }

  private async announceRejected(tx: Tx, s: EtaxSubmission, error: string) {
    await this.audit.record(tx, {
      action: 'etax.rejected',
      tenantId: s.tenantId,
      buildingId: s.buildingId,
      subjectType: 'ops.etax_submission',
      subjectId: s.id,
      metadata: { number: s.number, error: error.slice(0, 500) },
    });
    await this.events.record(tx, {
      type: 'etax.rejected',
      aggregateType: 'etax_submission',
      aggregateId: s.id,
      tenantId: s.tenantId,
      buildingId: s.buildingId,
      payload: { submissionId: s.id, number: s.number, error: error.slice(0, 300) },
    });
  }

  // ------------------------------------------------------------------------------------------------- operators

  list(
    ctx: TenantContext,
    q: { status?: EtaxStatus; month?: string; subjectType?: EtaxSubjectType; skip: number; take: number },
  ) {
    const range = q.month ? monthRange(q.month) : null;
    const where: Prisma.EtaxSubmissionWhereInput = this.own(ctx, {
      ...(q.status ? { status: q.status } : {}),
      ...(q.subjectType ? { subjectType: q.subjectType } : {}),
      ...(range ? { issuedAt: { gte: range.from, lt: range.to } } : {}),
      ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
    });
    return this.db.tenant(ctx, async (tx) => ({
      rows: await tx.etaxSubmission.findMany({
        where,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.take,
      }),
      total: await tx.etaxSubmission.count({ where }),
    }));
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(
        await tx.etaxSubmission.findFirst({
          where: this.own(ctx, {
            id,
            ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] as string[] } } : {}),
          }),
        }),
      ),
    );
  }

  /** The owner sends a rejected / failed document again (after fixing the data); attempts start over. */
  async retry(ctx: TenantContext, id: string) {
    const row = await this.db.tenant(ctx, async (tx) => {
      const s = this.found(await tx.etaxSubmission.findFirst({ where: this.own(ctx, { id }) }));
      if (s.status !== 'rejected' && s.status !== 'failed')
        throw new DomainException('etax.invalid_state', { params: { status: s.status } });
      const updated = await tx.etaxSubmission.update({
        where: { id },
        data: {
          status: 'queued',
          attempts: 0,
          nextAttemptAt: null,
          error: null,
          providerDocId: null,
          providerMeta: {},
          updatedBy: userIdOf(RequestContext.actor()),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'etax.retried',
        tenantId: ctx.tenantId,
        buildingId: s.buildingId,
        subjectType: 'ops.etax_submission',
        subjectId: id,
        before: { status: s.status, error: s.error },
        after: { status: 'queued' },
      });
      return updated;
    });
    await this.process(row.id).catch((e: unknown) =>
      this.logger.warn(`e-Tax ${id}: ${(e as Error).message}`),
    );
    return this.get(ctx, id);
  }

  /** The e-Tax figures of a Bangkok month (`YYYY-MM`) for the accountant. */
  async summary(ctx: TenantContext, month: string): Promise<EtaxSummary> {
    const { from, to } = monthRange(month);
    const at = new Date(Math.min(to.getTime() - 1, this.clock.now().getTime()));
    const enabled = (await this.settings.at('etax.enabled', at, { tenantId: ctx.tenantId }))?.value === true;
    const provider = (await this.settings.at('etax.provider', at, { tenantId: ctx.tenantId }))?.value;
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.etaxSubmission.findMany({
        where: { tenantId: ctx.tenantId, issuedAt: { gte: from, lt: to } },
        select: { status: true, documentTypeCode: true, subtotal: true, vatAmount: true, total: true },
      });
      const counts = { queued: 0, submitted: 0, signed: 0, rejected: 0, failed: 0 } as Record<
        EtaxStatus,
        number
      >;
      const types = new Map<string, { documents: number; total: Decimal }>();
      let sub = new Decimal(0);
      let vat = new Decimal(0);
      let tot = new Decimal(0);
      for (const r of rows) {
        counts[r.status] += 1;
        if (r.status !== 'signed') continue;
        sub = sub.plus(D(r.subtotal));
        vat = vat.plus(D(r.vatAmount));
        tot = tot.plus(D(r.total));
        const t = types.get(r.documentTypeCode) ?? { documents: 0, total: new Decimal(0) };
        t.documents += 1;
        t.total = t.total.plus(D(r.total));
        types.set(r.documentTypeCode, t);
      }
      return {
        month,
        enabled,
        provider: enabled && typeof provider === 'string' ? provider : null,
        counts,
        signed: {
          documents: counts.signed,
          subtotal: sub.toFixed(2),
          vatAmount: vat.toFixed(2),
          total: tot.toFixed(2),
        },
        byType: [...types.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([typeCode, v]) => ({ typeCode, documents: v.documents, total: v.total.toFixed(2) })),
      };
    });
  }

  /**
   * Worker job `etax-monthly` (daily): on the 1st (Bangkok) every VAT-registered tenant that used e-Tax in the
   * previous month gets `etax.monthly_summary` (owner + accountant), once per month.
   */
  async monthly(): Promise<number> {
    const today = bangkokDate(this.clock.now());
    if (!today.endsWith('-01')) return 0;
    const month = previousMonth(today);
    const { from, to } = monthRange(month);
    const tenants = await this.db.platform((tx) =>
      tx.etaxSubmission.groupBy({ by: ['tenantId'], where: { issuedAt: { gte: from, lt: to } } }),
    );
    let sent = 0;
    for (const { tenantId } of tenants) {
      const done = await this.db.platform((tx) =>
        tx.domainEvent.count({
          where: { type: 'etax.monthly_summary', tenantId, payload: { path: ['month'], equals: month } },
        }),
      );
      if (done) continue;
      const summary = await this.summary({ tenantId, source: 'path' }, month);
      await RequestContext.run({ actor: systemActor('etax') }, () =>
        this.db.platform((tx) =>
          this.events.record(tx, {
            type: 'etax.monthly_summary',
            aggregateType: 'tenant',
            aggregateId: tenantId,
            tenantId,
            payload: { ...summary },
          }),
        ),
      );
      sent += 1;
    }
    return sent;
  }
}
