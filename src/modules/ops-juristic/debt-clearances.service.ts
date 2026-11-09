import { createHash } from 'node:crypto';

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
import { type DebtClearance, type DebtClearanceState, type Prisma } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { englishDate } from '@modules/ops-leases/english-text';
import { newLetterCode, normaliseLetterCode } from '@modules/ops-leases/rent-record.service';
import { thaiDate } from '@modules/ops-leases/thai-text';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';
import QRCode from 'qrcode';

import { residentUnitAccess } from './resident-unit-access';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const hashCode = (code: string) => createHash('sha256').update(normaliseLetterCode(code)).digest();
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const esc = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Thai leading vowels that are written before the consonant they follow in speech (เ แ โ ใ ไ). */
const LEADING_VOWELS = new Set(['เ', 'แ', 'โ', 'ใ', 'ไ']);

/**
 * PDPA (D-025, D-306): a name reduced to initials for the public verification page — the first letter of each word
 * (Thai: the first consonant, skipping a leading vowel), each followed by a dot: "สมชาย ใจดี" → "ส. จ.",
 * "Somchai Jaidee" → "S. J.". Titles (นาย, นาง, นางสาว, Mr, Mrs, Ms) are dropped.
 */
export function nameInitials(name: string): string {
  const titles = new Set(['นาย', 'นาง', 'นางสาว', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss']);
  return name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !titles.has(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => {
      const chars = [...w];
      const first = chars.find((c) => !LEADING_VOWELS.has(c)) ?? chars[0]!;
      return `${first.toUpperCase()}.`;
    })
    .join(' ');
}

export const CLEARANCE_INCLUDE = {
  unit: { select: { id: true, unitNo: true } },
  party: { select: { id: true, displayName: true } },
} as const satisfies Prisma.DebtClearanceInclude;
export type DebtClearanceRow = Prisma.DebtClearanceGetPayload<{ include: typeof CLEARANCE_INCLUDE }>;

/** A request's row and — only on the response that issued it — the verification code printed on the PDF. */
export interface IssuedClearance {
  row: DebtClearanceRow;
  verifyCode: string | null;
}

export interface ClearanceInput {
  asOf?: string | null;
  language?: 'th' | 'en' | null;
}

/** What the public verification page may show (PDPA: unit number and initials only). */
export interface VerifiedDocument {
  documentType: 'debt_clearance';
  number: string;
  status: 'valid' | 'expired';
  issuedAt: Date;
  validUntil: string;
  asOf: string;
  issuer: string;
  unitNo: string;
  holderInitials: string;
}

/**
 * Debt clearance certificates (หนังสือรับรองการปลอดหนี้, D-306 = D-J05, D-325): a co-owner asks in LINE (or the
 * juristic office for them); the certificate is issued **only when the owner's receivable of the unit is 0 at issue
 * time** — issued invoices billed to the owner or the owner's bill-to payers, pending one-off charges / surcharges /
 * instalments and drafts whose period has started by `asOf`, less the owner's credit — else 409
 * `debt_clearance.outstanding` with the amount (nothing stored). Fee 0 (default) → issued at once; a fee → the
 * request waits with the fee charged and the office issues it once paid. Gapless number (series `DCL`), PDF in the
 * tenant's name with a verification QR; `GET /v1/public/documents/verify/{code}` shows unit number and initials only.
 */
@Injectable()
export class DebtClearancesService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    const toResident = async (tx: Tx, e: { tenantId: string | null; payload: Record<string, unknown> }) => {
      const partyId = e.payload.partyId as string | undefined;
      if (!partyId || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          clearance: {
            number: e.payload.number ?? null,
            unitNo: e.payload.unitNo ?? null,
            validUntil: e.payload.validUntil ?? null,
            reason: e.payload.reason ?? null,
          },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/units/${e.payload.unitId as string}/debt-clearances`,
        },
        consentPurpose: 'resident.service' as const,
      };
    };
    registerNotifiable('juristic.debt_clearance.issued', toResident);
    registerNotifiable('juristic.debt_clearance.refused', toResident);
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private asOfOf(input: ClearanceInput): string {
    const today = this.today();
    const asOf = input.asOf ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw invalid('asOf', 'date', 'a date YYYY-MM-DD');
    if (asOf < today) throw invalid('asOf', 'past', 'not before today');
    if (asOf > addCalendarDays(today, 60)) throw invalid('asOf', 'range', 'within 60 days from today');
    return asOf;
  }

  /**
   * What the owner still owes for the unit on `asOf` (≥ 0): open balances of issued invoices billed to the owner or
   * to a bill-to payer the owner named, + drafts whose period starts on or before `asOf`, + pending charges not yet on
   * a draft, − the credit of those payers on the unit.
   */
  async outstanding(
    tx: Tx,
    tenantId: string,
    unitId: string,
    partyId: string,
    asOf: string,
  ): Promise<Decimal> {
    const billTo = await tx.billTo.findMany({
      where: { tenantId, unitId, ownerPartyId: partyId },
      select: { billToPartyId: true },
    });
    const payers = [...new Set([partyId, ...billTo.map((b) => b.billToPartyId)])];
    const [row] = await tx.$queryRaw<{ issued: string; drafts: string; charges: string; credit: string }[]>`
      SELECT
        COALESCE((SELECT sum(i.balance) FROM ops.invoice i
                   WHERE i.tenant_id = ${tenantId}::uuid AND i.unit_id = ${unitId}::uuid
                     AND i.billed_party_id = ANY(${payers}::uuid[])
                     AND i.status IN ('issued', 'partially_paid', 'overdue')), 0)::text AS issued,
        COALESCE((SELECT sum(i.total) FROM ops.invoice i
                   WHERE i.tenant_id = ${tenantId}::uuid AND i.unit_id = ${unitId}::uuid
                     AND i.billed_party_id = ANY(${payers}::uuid[])
                     AND i.status = 'draft' AND i.period_start <= ${asOf}::date), 0)::text AS drafts,
        COALESCE((SELECT sum(c.amount) FROM ops.invoice_charge c
                   WHERE c.tenant_id = ${tenantId}::uuid AND c.unit_id = ${unitId}::uuid
                     AND c.party_id = ANY(${payers}::uuid[]) AND c.status = 'pending'
                     AND NOT EXISTS (SELECT 1 FROM ops.invoice_line l JOIN ops.invoice i ON i.id = l.invoice_id
                                      WHERE l.source_id = c.id AND i.status = 'draft'
                                        AND i.period_start <= ${asOf}::date)), 0)::text AS charges,
        COALESCE((SELECT sum(pc.amount) FROM ops.payer_credit pc
                   WHERE pc.tenant_id = ${tenantId}::uuid AND pc.unit_id = ${unitId}::uuid
                     AND pc.party_id = ANY(${payers}::uuid[])), 0)::text AS credit`;
    const owed = D(row!.issued).plus(row!.drafts).plus(row!.charges).minus(row!.credit);
    return Decimal.max(0, owed);
  }

  private async ownerOf(tx: Tx, unitId: string, partyId: string, on: string): Promise<boolean> {
    const n = await tx.unitOwnership.count({
      where: {
        unitId,
        partyId,
        validFrom: { lte: asDate(on) },
        OR: [{ validTo: null }, { validTo: { gt: asDate(on) } }],
      },
    });
    return n > 0;
  }

  // ------------------------------------------------------------------------------------------- create

  /**
   * One request (resident or office): outstanding > 0 → 409 with the amount, nothing stored; else issued at once
   * (fee 0) or stored `requested` with the fee charged.
   */
  private async request(
    ctx: TenantContext,
    input: {
      unitId: string;
      buildingId: string;
      partyId: string;
      via: 'liff' | 'web';
      requestedBy: string | null;
      asOf: string;
      language: 'th' | 'en';
    },
  ): Promise<{ id: string; code: string | null }> {
    const fee = D(
      await this.settings.valueAt<string>('juristic.debt_clearance.fee', this.clock.now(), {
        tenantId: ctx.tenantId,
      }),
    );
    return this.db.tenant(
      ctx,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`debt-clearance:${input.unitId}:${input.partyId}`}))`;
        const owed = await this.outstanding(tx, ctx.tenantId, input.unitId, input.partyId, input.asOf);
        if (owed.gt(0))
          throw new DomainException('debt_clearance.outstanding', {
            params: { amount: owed.toFixed(2) },
            extensions: { outstanding: owed.toFixed(2) },
          });
        const row = await tx.debtClearance.create({
          data: {
            tenantId: ctx.tenantId,
            buildingId: input.buildingId,
            unitId: input.unitId,
            partyId: input.partyId,
            requestedVia: input.via,
            requestedBy: input.requestedBy,
            asOf: asDate(input.asOf),
            language: input.language,
            fee: fee.toFixed(2),
            createdBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.debt_clearance_requested',
          tenantId: ctx.tenantId,
          buildingId: input.buildingId,
          subjectType: 'juristic.debt_clearance',
          subjectId: row.id,
          metadata: { via: input.via, asOf: input.asOf, fee: fee.toFixed(2) },
        });
        if (fee.gt(0)) {
          const charge = await tx.invoiceCharge.create({
            data: {
              tenantId: ctx.tenantId,
              buildingId: input.buildingId,
              unitId: input.unitId,
              partyId: input.partyId,
              sourceType: 'adjustment',
              lineKind: 'one_off',
              sourceId: row.id,
              description: 'ค่าธรรมเนียมหนังสือรับรองการปลอดหนี้',
              quantity: '1.000',
              unitPrice: fee.toFixed(4),
              amount: fee.toFixed(2),
              createdBy: by(),
            },
          });
          await tx.debtClearance.update({ where: { id: row.id }, data: { feeChargeId: charge.id } });
          await this.events.record(tx, {
            type: 'invoice_charge.queued',
            aggregateType: 'invoice_charge',
            aggregateId: charge.id,
            tenantId: ctx.tenantId,
            buildingId: input.buildingId,
            payload: {
              chargeId: charge.id,
              unitId: input.unitId,
              partyId: input.partyId,
              amount: fee.toFixed(2),
            },
          });
          await this.events.record(tx, {
            type: 'juristic.debt_clearance.requested',
            aggregateType: 'debt_clearance',
            aggregateId: row.id,
            tenantId: ctx.tenantId,
            buildingId: input.buildingId,
            payload: {
              debtClearanceId: row.id,
              unitId: input.unitId,
              partyId: input.partyId,
              fee: fee.toFixed(2),
            },
          });
          return { id: row.id, code: null };
        }
        return { id: row.id, code: (await this.issueIn(tx, row.id)).code };
      },
      { timeout: 60_000 },
    );
  }

  /** `POST /v1/resident/units/{unitId}/debt-clearance-requests` (co-owners of the unit today). */
  async residentRequest(unitId: string, input: ClearanceInput): Promise<IssuedClearance> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner'], this.clock.now()),
    );
    const asOf = this.asOfOf(input);
    // the co-owner party of mine on this unit (an owner-occupier's occupancy role also maps to co_owner)
    let partyId: string | null = null;
    await this.db.tenant(access.ctx, async (tx) => {
      for (const p of access.partyIds)
        if (await this.ownerOf(tx, unitId, p, this.today())) {
          partyId = p;
          break;
        }
    });
    if (!partyId) throw new DomainException('http.not_found');
    const { id, code } = await this.request(access.ctx, {
      unitId,
      buildingId: access.buildingId,
      partyId,
      via: 'liff',
      requestedBy: access.userId,
      asOf,
      language: input.language ?? 'th',
    });
    const row = await this.db.tenant(access.ctx, (tx) =>
      tx.debtClearance.findUniqueOrThrow({ where: { id }, include: CLEARANCE_INCLUDE }),
    );
    return { row, verifyCode: code };
  }

  async residentList(unitId: string): Promise<DebtClearanceRow[]> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner'], this.clock.now()),
    );
    return this.db.tenant(access.ctx, (tx) =>
      tx.debtClearance.findMany({
        where: { tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
        include: CLEARANCE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  /** `GET /v1/resident/units/{unitId}/debt-clearances/{id}` (J-CR): one of mine on the unit, else 404. */
  async residentGet(unitId: string, id: string): Promise<DebtClearanceRow> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner'], this.clock.now()),
    );
    const row = await this.db.tenant(access.ctx, (tx) =>
      tx.debtClearance.findFirst({
        where: { id, tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
        include: CLEARANCE_INCLUDE,
      }),
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  async residentDocument(unitId: string, id: string) {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner'], this.clock.now()),
    );
    return this.db.tenant(access.ctx, async (tx) => {
      const row = await tx.debtClearance.findFirst({
        where: { id, tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
        include: { document: true },
      });
      if (!row?.document) throw new DomainException('http.not_found');
      return { row, ...(await this.documents.signedUrl(row.document)) };
    });
  }

  /** `POST /v1/owner/juristic/debt-clearances`: the office asks for a co-owner of the unit (e.g. at the counter). */
  async create(
    ctx: TenantContext,
    input: ClearanceInput & { unitId: string; partyId: string },
  ): Promise<IssuedClearance> {
    const asOf = this.asOfOf(input);
    const unit = await this.db.tenant(ctx, async (tx) => {
      const u = await tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null } });
      if (!u || (ctx.buildingIds && !ctx.buildingIds.includes(u.buildingId)))
        throw new DomainException('http.not_found');
      const b = await tx.building.findFirst({ where: { id: u.buildingId, deletedAt: null } });
      if (!b || (b.operatorTenantId !== ctx.tenantId && b.ownerTenantId !== ctx.tenantId))
        throw new DomainException('http.not_found');
      if (!(await this.ownerOf(tx, u.id, input.partyId, this.today())))
        throw invalid('partyId', 'not_owner', 'the party does not own the unit today');
      return u;
    });
    const { id, code } = await this.request(ctx, {
      unitId: unit.id,
      buildingId: unit.buildingId,
      partyId: input.partyId,
      via: 'web',
      requestedBy: null,
      asOf,
      language: input.language ?? 'th',
    });
    return { row: await this.get(ctx, id), verifyCode: code };
  }

  // ------------------------------------------------------------------------------------------- office

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<DebtClearanceRow> {
    const row = this.found(
      await tx.debtClearance.findFirst({ where: this.own(ctx, { id }), include: CLEARANCE_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId))
      throw new DomainException('http.not_found');
    return row;
  }

  get(ctx: TenantContext, id: string): Promise<DebtClearanceRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: { state?: DebtClearanceState; unitId?: string; skip: number; take: number },
  ): Promise<{ rows: DebtClearanceRow[]; total: number }> {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.DebtClearanceWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.debtClearance.findMany({
          where,
          include: CLEARANCE_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.debtClearance.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** The office issues a waiting request (after its fee was paid) — re-checked: 409 while anything is due. */
  async issue(ctx: TenantContext, id: string): Promise<IssuedClearance> {
    const code = await this.db.tenant(
      ctx,
      async (tx) => {
        await this.load(tx, ctx, id);
        return (await this.issueIn(tx, id)).code;
      },
      { timeout: 60_000 },
    );
    return { row: await this.get(ctx, id), verifyCode: code };
  }

  async refuse(ctx: TenantContext, id: string, reason: string): Promise<DebtClearanceRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 500)
      throw invalid('reason', 'length', 'between 3 and 500 characters');
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM juristic.debt_clearance WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await this.load(tx, ctx, id);
      if (row.state !== 'requested')
        throw new DomainException('debt_clearance.invalid_state', { params: { state: row.state } });
      await tx.debtClearance.update({
        where: { id },
        data: {
          state: 'refused',
          refusedAt: this.clock.now(),
          refusedBy: by(),
          refuseReason: text,
          version: { increment: 1 },
        },
      });
      if (row.feeChargeId)
        await tx.invoiceCharge.updateMany({
          where: { id: row.feeChargeId, status: 'pending' },
          data: {
            status: 'cancelled',
            cancelledAt: this.clock.now(),
            cancelReason: 'debt clearance refused',
          },
        });
      await this.audit.record(tx, {
        action: 'juristic.debt_clearance_refused',
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: 'juristic.debt_clearance',
        subjectId: id,
        metadata: { reason: text },
      });
      await this.events.record(tx, {
        type: 'juristic.debt_clearance.refused',
        aggregateType: 'debt_clearance',
        aggregateId: id,
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        payload: {
          debtClearanceId: id,
          unitId: row.unitId,
          unitNo: row.unit.unitNo,
          partyId: row.partyId,
          reason: text,
        },
      });
    });
    return this.get(ctx, id);
  }

  async document(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.load(tx, ctx, id);
      const row = await tx.debtClearance.findUniqueOrThrow({ where: { id }, include: { document: true } });
      if (!row.document) throw new DomainException('http.not_found');
      return { row, ...(await this.documents.signedUrl(row.document)) };
    });
  }

  /** Issue inside the caller's transaction: 0 outstanding re-checked under the lock, number, PDF, code. */
  private async issueIn(tx: Tx, id: string): Promise<{ row: DebtClearance; code: string }> {
    await tx.$queryRaw`SELECT id FROM juristic.debt_clearance WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.debtClearance.findUniqueOrThrow({
      where: { id },
      include: {
        ...CLEARANCE_INCLUDE,
        unit: { select: { id: true, unitNo: true, building: { select: { name: true } } } },
        tenant: { select: { legalName: true, displayName: true, taxId: true } },
      },
    });
    if (row.state !== 'requested')
      throw new DomainException('debt_clearance.invalid_state', { params: { state: row.state } });
    const asOf = day(row.asOf) < this.today() ? this.today() : day(row.asOf);
    const owed = await this.outstanding(tx, row.tenantId, row.unitId, row.partyId, asOf);
    if (owed.gt(0))
      throw new DomainException('debt_clearance.outstanding', {
        params: { amount: owed.toFixed(2) },
        extensions: { outstanding: owed.toFixed(2) },
      });
    const now = this.clock.now();
    const validity = Number(
      await this.settings.valueAt<number>('juristic.debt_clearance.validity_days', now, {
        tenantId: row.tenantId,
      }),
    );
    const issuedOn = bangkokDate(now);
    const validUntil = addCalendarDays(issuedOn, validity);
    const number = await this.numbering.next(tx, row.tenantId, 'debt_clearance', now);
    const code = newLetterCode();
    const url = `${this.config.get('PUBLIC_WEB_APP_URL')}/verify/${code}`;
    const en = row.language === 'en';
    const date = (d: string) => (en ? englishDate(d) : thaiDate(d));
    const title = en ? 'Debt Clearance Certificate' : 'หนังสือรับรองการปลอดหนี้';
    const qr = await QRCode.toString(url, { type: 'svg', margin: 0, width: 120 });
    const body = en
      ? `<h1>${esc(title)}</h1><p>No. ${esc(number)} · issued ${esc(date(issuedOn))}</p>
<p>${esc(row.tenant.legalName)} certifies that, as of ${esc(date(asOf))}, <strong>${esc(row.party.displayName)}</strong>,
owner of unit <strong>${esc(row.unit.unitNo)}</strong> (${esc(row.unit.building.name)}), has no outstanding common charges,
fund contributions, surcharges or other amounts due to the juristic person for this unit.</p>
<p>This certificate is valid until ${esc(date(validUntil))}. Check it at ${esc(url)} (code ${esc(code)}).</p>
<div>${qr}</div>`
      : `<h1>${esc(title)}</h1><p>เลขที่ ${esc(number)} · ออกเมื่อ ${esc(date(issuedOn))}</p>
<p>${esc(row.tenant.legalName)} ขอรับรองว่า ณ วันที่ ${esc(date(asOf))} <strong>${esc(row.party.displayName)}</strong>
เจ้าของกรรมสิทธิ์ห้อง/แปลงเลขที่ <strong>${esc(row.unit.unitNo)}</strong> (${esc(row.unit.building.name)})
ไม่มีค่าส่วนกลาง เงินกองทุน เงินเพิ่ม หรือหนี้อื่นใดค้างชำระต่อนิติบุคคลสำหรับห้อง/แปลงนี้</p>
<p>หนังสือรับรองนี้มีผลถึงวันที่ ${esc(date(validUntil))} ตรวจสอบได้ที่ ${esc(url)} (รหัส ${esc(code)})</p>
<div>${qr}</div>`;
    const html = await this.renderer.brandedDocument(body, title, en ? 'en' : 'th');
    const pdf = await this.pdf.render(html, { title: `${title} ${number}`, footer: `${title} ${number}` });
    const doc = await this.documents.storeGenerated(tx, {
      tenantId: row.tenantId,
      kind: 'pdf_certificate',
      scopeType: 'unit',
      scopeId: row.unitId,
      buildingId: row.buildingId,
      title: `${title} ${number}.pdf`,
      mimeType: 'application/pdf',
      body: pdf,
    });
    const updated = await tx.debtClearance.update({
      where: { id },
      data: {
        state: 'issued',
        outstanding: '0.00',
        number,
        documentId: doc.id,
        verifyCodeHash: new Uint8Array(hashCode(code)),
        verifyCodeHint: code.slice(-4),
        validUntil: asDate(validUntil),
        issuedAt: now,
        issuedBy: by(),
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: 'juristic.debt_clearance_issued',
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: 'juristic.debt_clearance',
      subjectId: id,
      metadata: { number, asOf, validUntil },
    });
    await this.events.record(tx, {
      type: 'juristic.debt_clearance.issued',
      aggregateType: 'debt_clearance',
      aggregateId: id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: {
        debtClearanceId: id,
        unitId: row.unitId,
        unitNo: row.unit.unitNo,
        partyId: row.partyId,
        number,
        validUntil,
      },
    });
    // the code is shown once (the issuing response) and printed on the PDF; only its hash is stored
    return { row: updated, code };
  }

  // ------------------------------------------------------------------------------------------- public

  /** `GET /v1/public/documents/verify/{code}`: unknown codes are a 404; data minimal (PDPA). */
  async verify(code: string): Promise<VerifiedDocument> {
    const normalised = normaliseLetterCode(code);
    if (normalised.length !== 10) throw new DomainException('http.not_found');
    return this.db.platform(async (tx) => {
      const row = await tx.debtClearance.findFirst({
        where: { verifyCodeHash: new Uint8Array(hashCode(normalised)), state: 'issued' },
        include: {
          unit: { select: { unitNo: true } },
          party: { select: { displayName: true } },
          tenant: { select: { displayName: true } },
        },
      });
      if (!row?.number || !row.validUntil || !row.issuedAt) throw new DomainException('http.not_found');
      const validUntil = day(row.validUntil);
      return {
        documentType: 'debt_clearance' as const,
        number: row.number,
        status: validUntil >= this.today() ? ('valid' as const) : ('expired' as const),
        issuedAt: row.issuedAt,
        validUntil,
        asOf: day(row.asOf),
        issuer: row.tenant.displayName,
        unitNo: row.unit.unitNo,
        holderInitials: nameInitials(row.party.displayName),
      };
    });
  }
}
