import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { PlatformBrand } from '@core/brand/platform-brand.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService, type UploadedGenerated } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { billedParty, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type Statement } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { planAllocation } from '@modules/ops-billing/engine/allocation';
import { flexMessage, statementBubble } from '@modules/ops-documents/flex';
import { ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { englishDate } from '@modules/ops-leases/english-text';
import { formatThb, thaiDate } from '@modules/ops-leases/thai-text';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const OPEN = ['issued', 'partially_paid', 'overdue'] as const;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const esc = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** First and last day of a Bangkok month `YYYY-MM`. */
export function monthBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}` };
}

/** The figures of a statement (D-326): closing = opening + charges − credits − payments. */
export interface StatementFigures {
  opening: string;
  charges: string;
  credits: string;
  payments: string;
  closing: string;
}

export function closingOf(f: Omit<StatementFigures, 'closing'>): string {
  return D(f.opening).plus(f.charges).minus(f.credits).minus(f.payments).toFixed(2);
}

export interface StatementSnapshot {
  tenant: { name: string; legalName: string };
  party: { name: string; address: string | null };
  units: { id: string; unitNo: string; building: string }[];
  openInvoices: {
    id: string;
    number: string | null;
    unitId: string | null;
    unitNo: string | null;
    periodStart: string;
    periodEnd: string;
    dueDate: string | null;
    balance: string;
  }[];
  credit: string;
  channels: string[];
  issuedOn: string;
}

export type StatementRow = Statement & { party: { id: string; displayName: string } };
const STATEMENT_INCLUDE = { party: { select: { id: true, displayName: true } } } as const;

/**
 * Parties' digital channels (LINE of the party or of its linked login, e-mail, phone); none → printed letter. Read as
 * gp_platform: the linked login (`core.user_account`) is not visible inside a tenant transaction.
 */
export async function partyChannels(
  db: TenantTx,
  partyIds: readonly string[],
): Promise<Map<string, string[]>> {
  const ids = [...new Set(partyIds)];
  if (!ids.length) return new Map();
  return db.platform(async (tx) => {
    const parties = await tx.party.findMany({
      where: { id: { in: ids } },
      select: { id: true, lineUserId: true, email: true, phoneE164: true },
    });
    const links = await tx.partyUserLink.findMany({
      where: { partyId: { in: ids }, state: 'active' },
      select: { partyId: true, user: { select: { lineUserId: true } } },
    });
    const out = new Map<string, string[]>();
    for (const p of parties) {
      const c: string[] = [];
      if (p.lineUserId || links.some((l) => l.partyId === p.id && l.user.lineUserId)) c.push('line');
      if (p.email) c.push('email');
      if (p.phoneE164) c.push('sms');
      out.set(p.id, c);
    }
    return out;
  });
}

function addressText(address: unknown): string | null {
  if (!address || typeof address !== 'object') return typeof address === 'string' ? address : null;
  const parts = Object.values(address as Record<string, unknown>).filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  return parts.length ? parts.join(' ') : null;
}

/**
 * Owner statements (D-307 = D-J06, D-326): one statement per owner (billed) party and Bangkok month across all their
 * units in the tenant — opening (before the month), charges (invoices and debit notes issued in the month), credits
 * (credit notes), payments (allocations paid in the month), closing, and what is due now (open balances − credit) with
 * the open invoices. Number series `STM` (gapless); the PDF is built by the worker (`juristic.statement.issued`), then
 * the party gets the LINE Flex summary / e-mail (`juristic.statement.ready`). A statement is paid as one payment over
 * its open invoices with the J1.2a allocator (booked per unit so receivables stay per party × unit). Owners without
 * LINE, e-mail or phone get printed letters (`juristic.letter_batch`, A4 with the address in the envelope window).
 */
@Injectable()
export class StatementsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'juristic-statements';
  readonly eventTypes = [
    'juristic.statement.issued',
    'juristic.letter_batch.requested',
    'juristic.collection.notice_letter',
    'juristic.collection.lawyer_letter',
  ] as const;
  readonly timeoutMs = 60_000;
  private readonly logger = new Logger(StatementsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly payments: PaymentsService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly brand: PlatformBrand,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    private readonly config: AppConfig,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('juristic.statement.ready', async (tx, e) => {
      const id = e.payload.statementId as string | undefined;
      if (!id || !e.tenantId) return null;
      const s = await tx.statement.findUnique({ where: { id } });
      if (!s) return null;
      const snap = s.snapshot as unknown as StatementSnapshot;
      const link = `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/statements/${s.id}`;
      const flex = flexMessage(
        `ใบแจ้งยอด ${s.number} ยอดที่ต้องชำระ ${formatThb(s.amountDue.toFixed(2))} บาท`,
        [
          statementBubble(
            {
              number: s.number,
              issuerName: snap.tenant.name,
              periodKey: s.periodKey,
              units: snap.units.map((u) => u.unitNo),
              charges: s.charges.toFixed(2),
              payments: s.payments.toFixed(2),
              amountDue: s.amountDue.toFixed(2),
              link,
            },
            await this.brand.flex(),
          ),
        ],
      );
      return {
        recipients: await billedParty(tx, s.partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          statement: {
            number: s.number,
            period: s.periodKey,
            units: snap.units.map((u) => u.unitNo).join(', '),
            amountDue: s.amountDue.toFixed(2),
            closing: s.closing.toFixed(2),
          },
          link,
          flex: { altText: flex.altText, contents: flex.contents },
        },
        consentPurpose: 'resident.service',
      };
    });
  }

  // ------------------------------------------------------------------------------------------- figures

  /** Opening, charges, credits, payments of a party in a tenant for [start, end] (Bangkok days). */
  async figures(
    tx: Tx,
    tenantId: string,
    partyId: string,
    start: string,
    end: string,
  ): Promise<StatementFigures> {
    const s = startOfBangkokDay(start).toISOString();
    const e = startOfBangkokDay(
      new Date(asDate(end).getTime() + 86_400_000).toISOString().slice(0, 10),
    ).toISOString();
    const [row] = await tx.$queryRaw<
      {
        inv_before: string;
        inv_in: string;
        pay_before: string;
        pay_in: string;
        cn_before: string;
        cn_in: string;
        dn_before: string;
        dn_in: string;
      }[]
    >`
      WITH inv AS (
        SELECT id, total, issued_at FROM ops.invoice
         WHERE tenant_id = ${tenantId}::uuid AND billed_party_id = ${partyId}::uuid
           AND issued_at IS NOT NULL AND status <> 'void' AND status <> 'draft')
      SELECT
        (SELECT COALESCE(sum(total), 0) FROM inv WHERE issued_at < ${s}::timestamptz)::text AS inv_before,
        (SELECT COALESCE(sum(total), 0) FROM inv WHERE issued_at >= ${s}::timestamptz AND issued_at < ${e}::timestamptz)::text AS inv_in,
        (SELECT COALESCE(sum(a.amount), 0) FROM ops.payment_allocation a JOIN ops.payment p ON p.id = a.payment_id
          WHERE a.invoice_id IN (SELECT id FROM inv) AND a.reversed_at IS NULL AND p.paid_at < ${s}::timestamptz)::text AS pay_before,
        (SELECT COALESCE(sum(a.amount), 0) FROM ops.payment_allocation a JOIN ops.payment p ON p.id = a.payment_id
          WHERE a.invoice_id IN (SELECT id FROM inv) AND a.reversed_at IS NULL
            AND p.paid_at >= ${s}::timestamptz AND p.paid_at < ${e}::timestamptz)::text AS pay_in,
        (SELECT COALESCE(sum(total), 0) FROM ops.credit_note
          WHERE invoice_id IN (SELECT id FROM inv) AND status <> 'void' AND issued_at < ${s}::timestamptz)::text AS cn_before,
        (SELECT COALESCE(sum(total), 0) FROM ops.credit_note
          WHERE invoice_id IN (SELECT id FROM inv) AND status <> 'void'
            AND issued_at >= ${s}::timestamptz AND issued_at < ${e}::timestamptz)::text AS cn_in,
        (SELECT COALESCE(sum(total), 0) FROM ops.debit_note
          WHERE invoice_id IN (SELECT id FROM inv) AND status <> 'void' AND issued_at < ${s}::timestamptz)::text AS dn_before,
        (SELECT COALESCE(sum(total), 0) FROM ops.debit_note
          WHERE invoice_id IN (SELECT id FROM inv) AND status <> 'void'
            AND issued_at >= ${s}::timestamptz AND issued_at < ${e}::timestamptz)::text AS dn_in`;
    const r = row!;
    const opening = D(r.inv_before).minus(r.pay_before).minus(r.cn_before).plus(r.dn_before);
    const f = {
      opening: opening.toFixed(2),
      charges: D(r.inv_in).plus(r.dn_in).toFixed(2),
      credits: D(r.cn_in).toFixed(2),
      payments: D(r.pay_in).toFixed(2),
    };
    return { ...f, closing: closingOf(f) };
  }

  /** Parties with something to state in the month: billed in it, paid in it, or owing at issue. */
  private async candidates(
    tx: Tx,
    tenantId: string,
    start: string,
    end: string,
    buildingId: string | null,
  ): Promise<string[]> {
    const s = startOfBangkokDay(start).toISOString();
    const e = startOfBangkokDay(
      new Date(asDate(end).getTime() + 86_400_000).toISOString().slice(0, 10),
    ).toISOString();
    const rows = await tx.$queryRaw<{ party_id: string }[]>`
      SELECT DISTINCT i.billed_party_id AS party_id FROM ops.invoice i
       WHERE i.tenant_id = ${tenantId}::uuid AND i.issued_at IS NOT NULL AND i.status <> 'void' AND i.status <> 'draft'
         AND (${buildingId}::uuid IS NULL OR i.building_id = ${buildingId}::uuid)
         AND ((i.issued_at >= ${s}::timestamptz AND i.issued_at < ${e}::timestamptz)
              OR (i.status IN ('issued', 'partially_paid', 'overdue') AND i.balance > 0)
              OR EXISTS (SELECT 1 FROM ops.payment_allocation a JOIN ops.payment p ON p.id = a.payment_id
                          WHERE a.invoice_id = i.id AND p.paid_at >= ${s}::timestamptz AND p.paid_at < ${e}::timestamptz))
       ORDER BY 1`;
    return rows.map((r) => r.party_id);
  }

  // ------------------------------------------------------------------------------------------- issue

  /**
   * `POST /v1/owner/juristic/statements/actions/issue`: statements of a month for every owner party (or the given
   * ones, or one building's) — one per party and month (a repeat skips the parties already stated).
   */
  async issue(
    ctx: TenantContext,
    input: { period: string; buildingId?: string | null; partyIds?: string[] | null; language?: 'th' | 'en' },
  ): Promise<{ issued: StatementRow[]; skipped: number }> {
    if (!MONTH.test(input.period)) throw invalid('period', 'month', 'a month YYYY-MM');
    const { start, end } = monthBounds(input.period);
    if (start > bangkokDate(this.clock.now())) throw invalid('period', 'future', 'not a future month');
    const ids = await this.db.tenant(
      ctx,
      async (tx) => {
        if (input.buildingId) {
          const b = await tx.building.findFirst({
            where: {
              id: input.buildingId,
              deletedAt: null,
              OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
            },
          });
          if (!b) throw new DomainException('http.not_found');
        }
        let parties = await this.candidates(tx, ctx.tenantId, start, end, input.buildingId ?? null);
        if (input.partyIds?.length) {
          const wanted = new Set(input.partyIds);
          const known = await tx.party.findMany({
            where: { id: { in: input.partyIds }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
          });
          if (known.length !== wanted.size) throw new DomainException('http.not_found');
          parties = input.partyIds;
        }
        const out: string[] = [];
        let skipped = 0;
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: ctx.tenantId },
          select: { displayName: true, legalName: true },
        });
        for (const partyId of parties) {
          const exists = await tx.statement.findFirst({
            where: { tenantId: ctx.tenantId, partyId, periodStart: asDate(start) },
            select: { id: true },
          });
          if (exists) {
            skipped += 1;
            continue;
          }
          out.push(
            await this.issueOne(tx, ctx.tenantId, partyId, input.period, start, end, input.language, tenant),
          );
        }
        return { out, skipped };
      },
      { timeout: 120_000 },
    );
    const issued = await this.db.tenant(ctx, (tx) =>
      tx.statement.findMany({
        where: { id: { in: ids.out } },
        include: STATEMENT_INCLUDE,
        orderBy: { number: 'asc' },
      }),
    );
    return { issued, skipped: ids.skipped };
  }

  private async issueOne(
    tx: Tx,
    tenantId: string,
    partyId: string,
    period: string,
    start: string,
    end: string,
    language: 'th' | 'en' | undefined,
    tenant: { displayName: string; legalName: string },
  ): Promise<string> {
    const now = this.clock.now();
    const party = await tx.party.findUniqueOrThrow({ where: { id: partyId } });
    const figures = await this.figures(tx, tenantId, partyId, start, end);
    const open = await tx.invoice.findMany({
      where: { tenantId, billedPartyId: partyId, status: { in: [...OPEN] }, balance: { gt: 0 } },
      include: { unit: { select: { id: true, unitNo: true } } },
      orderBy: [{ dueDate: 'asc' }, { issuedAt: 'asc' }, { id: 'asc' }],
    });
    // the owner's units: current ownerships in the tenant's buildings + the units of the invoices stated
    const today = bangkokDate(now);
    const owned = await tx.unitOwnership.findMany({
      where: {
        partyId,
        validFrom: { lte: asDate(today) },
        OR: [{ validTo: null }, { validTo: { gt: asDate(today) } }],
      },
      select: { unitId: true },
    });
    const billed = await tx.invoice.findMany({
      where: {
        tenantId,
        billedPartyId: partyId,
        issuedAt: { gte: startOfBangkokDay(start), lt: startOfBangkokDay(end) },
      },
      select: { unitId: true },
    });
    const unitIds = [
      ...new Set([
        ...owned.map((o) => o.unitId),
        ...billed.map((b) => b.unitId),
        ...open.map((i) => i.unitId),
      ]),
    ].filter((u): u is string => Boolean(u));
    const units = await tx.unit.findMany({
      where: { id: { in: unitIds } },
      select: { id: true, unitNo: true, building: { select: { name: true } } },
      orderBy: { unitNo: 'asc' },
    });
    const credit = await tx.payerCredit.aggregate({ where: { partyId, tenantId }, _sum: { amount: true } });
    const creditBalance = Decimal.max(0, D(credit._sum.amount ?? 0));
    const openTotal = open.reduce((s, i) => s.plus(D(i.balance)), D(0));
    const amountDue = Decimal.max(0, openTotal.minus(creditBalance));
    const channels = (await partyChannels(this.db, [partyId])).get(partyId) ?? [];
    const snapshot: StatementSnapshot = {
      tenant: { name: tenant.displayName, legalName: tenant.legalName },
      party: { name: party.displayName, address: addressText(party.address) },
      units: units.map((u) => ({ id: u.id, unitNo: u.unitNo, building: u.building.name })),
      openInvoices: open.map((i) => ({
        id: i.id,
        number: i.number,
        unitId: i.unitId,
        unitNo: i.unit?.unitNo ?? null,
        periodStart: day(i.periodStart),
        periodEnd: day(i.periodEnd),
        dueDate: i.dueDate ? day(i.dueDate) : null,
        balance: D(i.balance).toFixed(2),
      })),
      credit: creditBalance.toFixed(2),
      channels,
      issuedOn: today,
    };
    const number = await this.numbering.next(tx, tenantId, 'owner_statement', now);
    const row = await tx.statement.create({
      data: {
        tenantId,
        partyId,
        number,
        periodKey: period,
        periodStart: asDate(start),
        periodEnd: asDate(end),
        language: language ?? (party.language === 'en' ? 'en' : 'th'),
        unitIds: units.map((u) => u.id),
        invoiceIds: open.map((i) => i.id),
        ...figures,
        amountDue: amountDue.toFixed(2),
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        deliveredVia: channels.length ? channels : ['letter'],
        issuedAt: now,
        issuedBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'juristic.statement_issued',
      tenantId,
      subjectType: 'juristic.statement',
      subjectId: row.id,
      metadata: { number, period, ...figures, amountDue: amountDue.toFixed(2), units: units.length },
    });
    await this.events.record(tx, {
      type: 'juristic.statement.issued',
      aggregateType: 'statement',
      aggregateId: row.id,
      tenantId,
      payload: { statementId: row.id, partyId, number, period, amountDue: amountDue.toFixed(2) },
    });
    return row.id;
  }

  // ------------------------------------------------------------------------------------------- reads

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<StatementRow> {
    return this.found(
      await tx.statement.findFirst({ where: this.own(ctx, { id }), include: STATEMENT_INCLUDE }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<StatementRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(ctx: TenantContext, q: { period?: string; partyId?: string; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.StatementWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.period ? { periodKey: q.period } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.statement.findMany({
          where,
          include: STATEMENT_INCLUDE,
          orderBy: [{ periodStart: 'desc' }, { number: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.statement.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async document(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const s = await this.load(tx, ctx, id);
      if (!s.documentId) throw new DomainException('statement.document_pending');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: s.documentId } });
      return { row: s, ...(await this.documents.signedUrl(doc)) };
    });
  }

  private residentUserId(): string {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return actor.publicId;
  }

  private async myParties(): Promise<string[]> {
    const userId = this.residentUserId();
    const links = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({ where: { userId, state: 'active' }, select: { partyId: true } }),
    );
    return links.map((l) => l.partyId);
  }

  /** `GET /v1/resident/statements`: statements of parties linked to my login, across tenants, newest first. */
  async residentList(q: { skip: number; take: number }) {
    const parties = await this.myParties();
    if (!parties.length) return { rows: [] as StatementRow[], total: 0 };
    return this.db.platform(async (tx) => {
      const where: Prisma.StatementWhereInput = { partyId: { in: parties } };
      const [rows, total] = await Promise.all([
        tx.statement.findMany({
          where,
          include: STATEMENT_INCLUDE,
          orderBy: [{ periodStart: 'desc' }, { number: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.statement.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async residentDocument(id: string) {
    const parties = await this.myParties();
    return this.db.platform(async (tx) => {
      const s = await tx.statement.findFirst({
        where: { id, partyId: { in: parties } },
        include: STATEMENT_INCLUDE,
      });
      if (!s) throw new DomainException('http.not_found');
      if (!s.documentId) throw new DomainException('statement.document_pending');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: s.documentId } });
      return { row: s, ...(await this.documents.signedUrl(doc)) };
    });
  }

  // ------------------------------------------------------------------------------------------- pay

  /**
   * `POST /v1/owner/juristic/statements/{id}/payments`: money received for a statement (manual channel: evidence + note
   * for juristic tenants, J1.2a) spread over the statement's invoices still open, across units, by the tenant's
   * allocation policy (J1.2a allocator); booked as one payment per unit, the excess credited on the unit of the oldest
   * invoice. A partial amount needs `payments.allow_partial`.
   */
  async pay(
    ctx: TenantContext,
    id: string,
    input: {
      amount: string;
      method: 'cash' | 'bank_transfer_manual';
      paidAt: Date;
      evidenceDocumentId?: string | null;
      reference?: string | null;
      notes?: string | null;
    },
  ): Promise<{ statement: StatementRow; payments: { id: string; unitId: string | null; amount: string }[] }> {
    const amount = D(input.amount);
    if (amount.lte(0) || amount.decimalPlaces() > 2) throw invalid('amount', 'money', 'a positive amount');
    if (input.method === 'bank_transfer_manual' && !input.evidenceDocumentId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'evidenceDocumentId', code: 'required', message: 'a transfer needs its evidence' }],
      });
    const created = await this.db.tenant(
      ctx,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM juristic.statement WHERE id = ${id}::uuid FOR UPDATE`;
        const s = await this.load(tx, ctx, id);
        await this.payments.assertManualEvidence(tx, s.tenantId, input);
        if (input.evidenceDocumentId) {
          const doc = await tx.document.findFirst({
            where: { id: input.evidenceDocumentId, tenantId: ctx.tenantId, deletedAt: null },
          });
          if (!doc) throw new DomainException('http.not_found');
        }
        await this.payments.lockCredit(tx, s.partyId, null);
        const open = await tx.invoice.findMany({
          where: {
            id: { in: s.invoiceIds },
            billedPartyId: s.partyId,
            status: { in: [...OPEN] },
            balance: { gt: 0 },
          },
          orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
        });
        if (!open.length) throw new DomainException('statement.nothing_due');
        const due = open.reduce((sum, i) => sum.plus(D(i.balance)), D(0));
        if (amount.lt(due) && !(await this.payments.allowPartial(s.tenantId)))
          throw new DomainException('payment.partial_not_allowed', { params: { due: due.toFixed(2) } });
        const surcharge = await this.payments.surchargeOpen(
          tx,
          open.map((i) => i.id),
        );
        const plan = planAllocation(
          amount,
          open.map((i) => ({
            invoiceId: i.id,
            issuedAt: i.issuedAt ?? new Date(0),
            balance: D(i.balance).toFixed(2),
            surchargeOpen: (surcharge.get(i.id) ?? D(0)).toFixed(2),
          })),
          await this.payments.allocationPolicy(s.tenantId),
        );
        // one payment per unit (receivables are per party × unit); the remainder on the oldest invoice's unit
        const byUnit = new Map<string, { amount: Decimal; invoiceIds: string[] }>();
        for (const slice of plan.slices) {
          const inv = open.find((i) => i.id === slice.invoiceId)!;
          const key = inv.unitId ?? '-';
          const g = byUnit.get(key) ?? { amount: D(0), invoiceIds: [] };
          g.amount = g.amount.plus(slice.amount);
          g.invoiceIds.push(inv.id);
          byUnit.set(key, g);
        }
        const oldestUnit = open[0]!.unitId ?? '-';
        if (D(plan.remainder).gt(0)) {
          const g = byUnit.get(oldestUnit) ?? {
            amount: D(0),
            invoiceIds: open.filter((i) => (i.unitId ?? '-') === oldestUnit).map((i) => i.id),
          };
          g.amount = g.amount.plus(plan.remainder);
          byUnit.set(oldestUnit, g);
        }
        const booked: { id: string; unitId: string | null; amount: string }[] = [];
        for (const [unitKey, g] of byUnit) {
          if (g.amount.lte(0)) continue;
          const first = open.find((i) => i.id === g.invoiceIds[0])!;
          const { payment } = await this.payments.confirm(tx, {
            tenantId: s.tenantId,
            buildingId: first.buildingId,
            unitId: unitKey === '-' ? null : unitKey,
            invoiceId: first.id,
            payerPartyId: s.partyId,
            leaseId: null,
            amount: g.amount.toFixed(2),
            method: input.method,
            confirmedVia: 'manual',
            paidAt: input.paidAt,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
            recordedBy: by(),
            notes: [`ใบแจ้งยอด ${s.number}`, input.reference, input.notes].filter(Boolean).join(' · '),
            targetInvoiceIds: g.invoiceIds,
          });
          booked.push({ id: payment.id, unitId: payment.unitId, amount: payment.amount.toFixed(2) });
        }
        await tx.statement.update({
          where: { id },
          data: { paymentIds: [...s.paymentIds, ...booked.map((b) => b.id)] },
        });
        await this.audit.record(tx, {
          action: 'juristic.statement_paid',
          tenantId: s.tenantId,
          subjectType: 'juristic.statement',
          subjectId: id,
          metadata: {
            number: s.number,
            amount: amount.toFixed(2),
            payments: booked,
            remainder: plan.remainder,
          },
        });
        await this.events.record(tx, {
          type: 'juristic.statement.paid',
          aggregateType: 'statement',
          aggregateId: id,
          tenantId: s.tenantId,
          payload: { statementId: id, partyId: s.partyId, amount: amount.toFixed(2), payments: booked },
        });
        return booked;
      },
      { timeout: 60_000 },
    );
    return { statement: await this.get(ctx, id), payments: created };
  }

  // ------------------------------------------------------------------------------------------- letters

  /**
   * `POST /v1/owner/juristic/letter-batches`: the month's statements of owners with no LINE, e-mail or phone, as one
   * printable PDF built by the worker (A4, name and address in the window of a DL envelope).
   */
  async requestLetters(ctx: TenantContext, period: string) {
    if (!MONTH.test(period)) throw invalid('period', 'month', 'a month YYYY-MM');
    return this.db.tenant(ctx, async (tx) => {
      const statements = await tx.statement.findMany({
        where: { tenantId: ctx.tenantId, periodKey: period },
        orderBy: { number: 'asc' },
      });
      const channels = await partyChannels(
        this.db,
        statements.map((s) => s.partyId),
      );
      const offline = statements.filter((s) => !(channels.get(s.partyId) ?? []).length).map((s) => s.id);
      const batch = await tx.letterBatch.create({
        data: {
          tenantId: ctx.tenantId,
          periodKey: period,
          statementIds: offline,
          requestedBy: by(),
          ...(offline.length ? {} : { state: 'failed', error: 'no statement of the month needs a letter' }),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.letter_batch_requested',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.letter_batch',
        subjectId: batch.id,
        metadata: { period, statements: offline.length },
      });
      if (offline.length)
        await this.events.record(tx, {
          type: 'juristic.letter_batch.requested',
          aggregateType: 'letter_batch',
          aggregateId: batch.id,
          tenantId: ctx.tenantId,
          payload: { letterBatchId: batch.id, period, statements: offline.length },
        });
      return batch;
    });
  }

  letterBatch(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.letterBatch.findFirst({ where: this.own(ctx, { id }) })),
    );
  }

  listLetterBatches(ctx: TenantContext, q: { skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId };
      const [rows, total] = await Promise.all([
        tx.letterBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.take }),
        tx.letterBatch.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async letterBatchDocument(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const b = this.found(await tx.letterBatch.findFirst({ where: this.own(ctx, { id }) }));
      if (!b.documentId) throw new DomainException('statement.document_pending');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: b.documentId } });
      return { row: b, ...(await this.documents.signedUrl(doc)) };
    });
  }

  // ------------------------------------------------------------------------------------------- rendering

  private statementBody(s: Statement, snap: StatementSnapshot, letter: boolean): string {
    const en = s.language === 'en';
    const date = (d: string) => (en ? englishDate(d) : thaiDate(d));
    const money = (v: Decimal.Value) => esc(formatThb(D(v).toFixed(2)));
    const t = en
      ? {
          title: 'Statement of account',
          no: 'No.',
          period: 'Period',
          to: 'To',
          units: 'Units',
          opening: 'Brought forward',
          charges: 'Charges this month',
          credits: 'Credits',
          payments: 'Payments received',
          closing: 'Balance at month end',
          due: 'Amount to pay now',
          open: 'Open invoices',
          inv: 'Invoice',
          unit: 'Unit',
          dueOn: 'Due',
          bal: 'To pay',
          note: 'If you have already paid, thank you — please ignore this statement.',
        }
      : {
          title: 'ใบแจ้งยอด',
          no: 'เลขที่',
          period: 'ประจำเดือน',
          to: 'เรียน',
          units: 'ห้อง / แปลง',
          opening: 'ยอดยกมา',
          charges: 'ยอดเรียกเก็บเดือนนี้',
          credits: 'ลดหนี้',
          payments: 'รับชำระแล้ว',
          closing: 'ยอดคงเหลือสิ้นเดือน',
          due: 'ยอดที่ต้องชำระ',
          open: 'ใบแจ้งหนี้ที่ยังไม่ได้ชำระ',
          inv: 'ใบแจ้งหนี้',
          unit: 'ห้อง',
          dueOn: 'ครบกำหนด',
          bal: 'ยอดที่ต้องชำระ',
          note: 'หากท่านชำระแล้ว ขอขอบคุณและขออภัยมา ณ ที่นี้',
        };
    const window = letter
      ? `<div style="position:absolute;left:22mm;top:47mm;width:90mm;height:35mm;font-size:11pt;line-height:1.4">
<strong>${esc(snap.party.name)}</strong><br>${esc(snap.party.address ?? '')}</div><div style="height:95mm"></div>`
      : `<p>${esc(t.to)} <strong>${esc(snap.party.name)}</strong></p>`;
    const rows = snap.openInvoices
      .map(
        (i) =>
          `<tr><td>${esc(i.number ?? '-')}</td><td>${esc(i.unitNo ?? '-')}</td><td>${esc(i.dueDate ? date(i.dueDate) : '-')}</td><td style="text-align:right">${money(i.balance)}</td></tr>`,
      )
      .join('');
    return `<div style="position:relative${letter ? ';page-break-after:always;min-height:270mm' : ''}">
${window}
<h1>${esc(t.title)}</h1>
<p>${esc(t.no)} ${esc(s.number)} · ${esc(t.period)} ${esc(s.periodKey)} · ${esc(snap.tenant.legalName)}</p>
<p>${esc(t.units)}: ${esc(snap.units.map((u) => u.unitNo).join(', ') || '-')}</p>
<table style="width:100%;border-collapse:collapse">
<tr><td>${esc(t.opening)}</td><td style="text-align:right">${money(s.opening)}</td></tr>
<tr><td>${esc(t.charges)}</td><td style="text-align:right">${money(s.charges)}</td></tr>
<tr><td>${esc(t.credits)}</td><td style="text-align:right">−${money(s.credits)}</td></tr>
<tr><td>${esc(t.payments)}</td><td style="text-align:right">−${money(s.payments)}</td></tr>
<tr><td><strong>${esc(t.closing)}</strong></td><td style="text-align:right"><strong>${money(s.closing)}</strong></td></tr>
<tr><td><strong>${esc(t.due)}</strong></td><td style="text-align:right"><strong>${money(s.amountDue)}</strong></td></tr>
</table>
${rows ? `<h2>${esc(t.open)}</h2><table style="width:100%;border-collapse:collapse"><tr><th>${esc(t.inv)}</th><th>${esc(t.unit)}</th><th>${esc(t.dueOn)}</th><th style="text-align:right">${esc(t.bal)}</th></tr>${rows}</table>` : ''}
<p style="font-size:9pt">${esc(t.note)}</p>
</div>`;
  }

  private async statementPdf(id: string): Promise<UploadedGenerated | null> {
    const s = await this.db.platform((tx) => tx.statement.findUnique({ where: { id } }));
    if (!s || s.documentId) return null;
    const snap = s.snapshot as unknown as StatementSnapshot;
    const title = s.language === 'en' ? 'Statement' : 'ใบแจ้งยอด';
    const html = await this.renderer.brandedDocument(
      this.statementBody(s, snap, false),
      title,
      s.language === 'en' ? 'en' : 'th',
    );
    return this.documents.uploadGenerated({
      tenantId: s.tenantId,
      kind: 'pdf_statement',
      scopeType: 'tenant',
      scopeId: s.tenantId,
      buildingId: null,
      title: `${title} ${s.number}.pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf.render(html, { title: `${title} ${s.number}`, footer: `${title} ${s.number}` }),
    });
  }

  private async letterBatchPdf(id: string): Promise<UploadedGenerated | null> {
    const found = await this.db.platform(async (tx) => {
      const b = await tx.letterBatch.findUnique({ where: { id } });
      if (!b || b.documentId || !b.statementIds.length) return null;
      const statements = await tx.statement.findMany({
        where: { id: { in: b.statementIds } },
        orderBy: { number: 'asc' },
      });
      return { b, statements };
    });
    if (!found) return null;
    const body = found.statements
      .map((s) => this.statementBody(s, s.snapshot as unknown as StatementSnapshot, true))
      .join('\n');
    const title = `จดหมายใบแจ้งยอด ${found.b.periodKey}`;
    const html = await this.renderer.brandedDocument(body, title, 'th');
    return this.documents.uploadGenerated({
      tenantId: found.b.tenantId,
      kind: 'pdf_statement',
      scopeType: 'tenant',
      scopeId: found.b.tenantId,
      buildingId: null,
      title: `${title}.pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf.render(html, { title, footer: title }),
    });
  }

  /** A ladder letter (notice / lawyer letter) of a case step, counsel-approved wording version on it (O-038). */
  private async collectionLetterPdf(e: DomainEventEnvelope): Promise<UploadedGenerated | null> {
    const caseId = e.payload.caseId as string;
    const found = await this.db.platform(async (tx) => {
      const c = await tx.collectionCase.findUnique({
        where: { id: caseId },
        include: {
          tenant: { select: { legalName: true } },
          unit: { select: { unitNo: true, building: { select: { name: true } } } },
          party: true,
        },
      });
      return c;
    });
    if (!found) return null;
    const lawyer = e.type === 'juristic.collection.lawyer_letter';
    const title = lawyer ? 'หนังสือแจ้งจากทนายความ' : 'หนังสือแจ้งเตือนการชำระ';
    const today = bangkokDate(this.clock.now());
    const body = `<div style="position:relative">
<div style="position:absolute;left:22mm;top:47mm;width:90mm;height:35mm;font-size:11pt;line-height:1.4">
<strong>${esc(found.party.displayName)}</strong><br>${esc(addressText(found.party.address) ?? '')}</div>
<div style="height:95mm"></div>
<h1>${esc(title)}</h1>
<p>${esc(found.tenant.legalName)} · ${esc(thaiDate(today))}</p>
<p>เรื่อง ยอดที่ต้องชำระของห้อง / แปลง ${esc(found.unit.unitNo)} (${esc(found.unit.building.name)})</p>
<p>ยอดที่ต้องชำระ ณ วันที่ ${esc(thaiDate(today))} จำนวน <strong>${esc(formatThb(str(e.payload.amountDue) || '0.00'))}</strong> บาท
ครบกำหนดตั้งแต่ ${esc(str(e.payload.oldestDueOn) ? thaiDate(str(e.payload.oldestDueOn)) : '-')}</p>
<p style="font-size:9pt">แบบหนังสือฉบับ ${esc(str(e.payload.templateVersion) || '-')}</p>
</div>`;
    const html = await this.renderer.brandedDocument(body, title, 'th');
    return this.documents.uploadGenerated({
      tenantId: found.tenantId,
      kind: 'pdf_notice',
      scopeType: 'unit',
      scopeId: found.unitId,
      buildingId: found.buildingId,
      title: `${title} ${found.unit.unitNo}.pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf.render(html, { title, footer: title }),
    });
  }

  prepare(event: DomainEventEnvelope): Promise<UploadedGenerated | null> {
    switch (event.type) {
      case 'juristic.statement.issued':
        return this.statementPdf(event.payload.statementId as string);
      case 'juristic.letter_batch.requested':
        return this.letterBatchPdf(event.payload.letterBatchId as string);
      default:
        return this.collectionLetterPdf(event);
    }
  }

  async handle(event: DomainEventEnvelope, tx: Tx, prepared?: unknown): Promise<void> {
    const uploaded = (prepared as UploadedGenerated | null | undefined) ?? null;
    switch (event.type) {
      case 'juristic.statement.issued': {
        const id = event.payload.statementId as string;
        await tx.$queryRaw`SELECT id FROM juristic.statement WHERE id = ${id}::uuid FOR UPDATE`;
        const s = await tx.statement.findUnique({ where: { id } });
        if (!s || s.documentId || !uploaded) return;
        const doc = await this.documents.recordGenerated(tx, uploaded);
        await tx.statement.update({ where: { id }, data: { documentId: doc.id } });
        await this.events.record(tx, {
          type: 'juristic.statement.ready',
          aggregateType: 'statement',
          aggregateId: id,
          tenantId: s.tenantId,
          payload: { statementId: id, partyId: s.partyId, number: s.number, documentId: doc.id },
        });
        return;
      }
      case 'juristic.letter_batch.requested': {
        const id = event.payload.letterBatchId as string;
        await tx.$queryRaw`SELECT id FROM juristic.letter_batch WHERE id = ${id}::uuid FOR UPDATE`;
        const b = await tx.letterBatch.findUnique({ where: { id } });
        if (!b || b.documentId) return;
        if (!uploaded) {
          await tx.letterBatch.update({
            where: { id },
            data: { state: 'failed', error: 'nothing to print', finishedAt: this.clock.now() },
          });
          return;
        }
        const doc = await this.documents.recordGenerated(tx, uploaded);
        await tx.letterBatch.update({
          where: { id },
          data: { state: 'ready', documentId: doc.id, finishedAt: this.clock.now() },
        });
        await tx.statement.updateMany({ where: { id: { in: b.statementIds } }, data: { letterBatchId: id } });
        await this.events.record(tx, {
          type: 'juristic.letter_batch.ready',
          aggregateType: 'letter_batch',
          aggregateId: id,
          tenantId: b.tenantId,
          payload: { letterBatchId: id, documentId: doc.id, statements: b.statementIds.length },
        });
        return;
      }
      default: {
        // a ladder letter: stored once on the step's timeline row (the only column that may still be set)
        if (!uploaded) return;
        const caseId = event.payload.caseId as string;
        const stepId = event.payload.stepId as string;
        const row = await tx.collectionEvent.findFirst({
          where: { caseId, stepId, kind: 'step', outcome: 'sent', documentId: null },
        });
        if (!row) return;
        const doc = await this.documents.recordGenerated(tx, uploaded);
        await tx.collectionEvent.update({ where: { id: row.id }, data: { documentId: doc.id } });
        return;
      }
    }
  }
}
