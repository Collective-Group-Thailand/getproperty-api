import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { OtpService } from '@core/identity/otp.service';
import { maskPhone } from '@core/identity/phone';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ContractDocument,
  type ContractDocumentState,
  type ContractKind,
  type ContractSignature,
  type ContractSignerRole,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  type ContractDocData,
  INPUT_VARIABLES,
  isSignableKind,
  type PartyBlock,
  type PremisesBlock,
  type SignableKind,
} from './contract-kinds';
import { ContractLibraryService } from './contract-library.service';
import { type ContractLanguage, ContractRenderer } from './contract-renderer';
import { bahtTextEn, englishDate } from './english-text';
import { addressText, IN_FORCE } from './leases.service';
import { bahtText, formatThb, thaiDate } from './thai-text';

/** One signer of a contract document (`ops.contract_document.signers`). */
export interface SignerEntry {
  index: number;
  role: ContractSignerRole;
  partyId?: string;
  tenantId?: string;
  name: string;
}

export interface ContractCreateInput {
  kind: ContractKind;
  language?: ContractLanguage;
  templateVersionId?: string;
  title?: string;
  leaseId?: string;
  unitId?: string;
  partyId?: string;
  coBrokeAgreementId?: string;
  mandateId?: string;
  variables?: Record<string, unknown>;
}

export const CONTRACT_INCLUDE = {
  signatures: { orderBy: { signerIndex: 'asc' } },
  templateVersion: {
    select: {
      id: true,
      version: true,
      language: true,
      legalReviewState: true,
      legalRef: true,
      bodyHtml: true,
      template: { select: { id: true, key: true, name: true, kind: true, tenantId: true } },
    },
  },
} as const satisfies Prisma.ContractDocumentInclude;
export type ContractRow = Prisma.ContractDocumentGetPayload<{ include: typeof CONTRACT_INCLUDE }>;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_SIGNATURE_BYTES = 200_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const VISIBLE_TO_PARTIES: ContractDocumentState[] = ['pending_signature', 'signed'];
const by = () => userIdOf(RequestContext.actor());
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const hex = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString('hex') : null);

/**
 * Signable contract documents of the library's non-lease kinds (G3, D-294): reservation (owner ↔ a party), brokerage
 * mandate (owner ↔ agency), co-broke (listing agency ↔ co-agency) and lease addendum (lessor ↔ lessees). The template
 * version is pinned at creation; send-for-signature numbers the document (series `contract`), renders the PDF and
 * fixes its sha256; parties sign with SMS OTP + LINE + that hash (D-062), operators of a signing tenant with a drawn
 * signature; the last signature renders the signed PDF as a new version, stored as a legal-hold `contract` document
 * (D-286). A signed co-broke contract signs its proposed agreement (G2 fallback: in-app acceptance). Visible to the
 * writing tenant and the counterparty tenant (RLS pair); parties read only documents they sign.
 */
@Injectable()
export class ContractsService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly library: ContractLibraryService,
    private readonly renderer: ContractRenderer,
    private readonly documents: DocumentsService,
    private readonly numbering: DocumentNumbering,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('contract.sent_for_signature', async (tx, e) => {
      if (!e.tenantId) return null;
      const partyIds = (e.payload.partyIds as string[] | undefined) ?? [];
      const residents = (await Promise.all(partyIds.map((p) => billedParty(tx, p)))).flat();
      const counterparty = e.payload.counterpartyTenantId as string | null | undefined;
      const owners = counterparty ? await operators(tx, counterparty, ['owner'], 'owner') : [];
      if (!residents.length && !owners.length) return null;
      return {
        recipients: [...residents, ...owners],
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          contract: { number: e.payload.number, title: e.payload.title },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/contracts/${String(e.payload.contractId)}`,
        },
        consentPurpose: 'resident.service',
      };
    });
  }

  // ------------------------------------------------------------------------------------------- reads

  private where(ctx: TenantContext) {
    return { OR: [{ tenantId: ctx.tenantId }, { counterpartyTenantId: ctx.tenantId }] };
  }

  async list(
    ctx: TenantContext,
    filter: { kind?: ContractKind; state?: ContractDocumentState; leaseId?: string },
    page: { skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.ContractDocumentWhereInput = {
        ...this.where(ctx),
        kind: filter.kind,
        state: filter.state,
        leaseId: filter.leaseId,
      };
      const [rows, total] = await Promise.all([
        tx.contractDocument.findMany({
          where,
          include: CONTRACT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          ...page,
        }),
        tx.contractDocument.count({ where }),
      ]);
      return { rows, total };
    });
  }

  private async visible(tx: Tx, ctx: TenantContext, id: string): Promise<ContractRow> {
    return this.found(
      await tx.contractDocument.findFirst({ where: { id, ...this.where(ctx) }, include: CONTRACT_INCLUDE }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<ContractRow> {
    return this.db.tenant(ctx, (tx) => this.visible(tx, ctx, id));
  }

  static signers(row: Pick<ContractDocument, 'signers'>): SignerEntry[] {
    return (row.signers ?? []) as unknown as SignerEntry[];
  }

  /** What the caller may do next (operator view). */
  nextActions(row: ContractRow, tenantId: string): string[] {
    const own = row.tenantId === tenantId;
    if (row.state === 'draft') return own ? ['preview', 'send-for-signature', 'cancel'] : [];
    if (row.state === 'pending_signature') {
      const signed = new Set(row.signatures.map((s) => s.signerIndex));
      const mine = ContractsService.signers(row).some((s) => s.tenantId === tenantId && !signed.has(s.index));
      return [...(mine ? ['sign'] : []), 'download', ...(own ? ['cancel'] : [])];
    }
    if (row.state === 'signed') return ['download'];
    return [];
  }

  // ------------------------------------------------------------------------------------------- create

  private checkVariables(kind: SignableKind, vars: Record<string, unknown>): Record<string, unknown> {
    const allowed = INPUT_VARIABLES[kind];
    const unknown = Object.keys(vars).filter((k) => !(k in allowed));
    if (unknown.length)
      throw new DomainException('contract.unknown_variable', {
        errors: unknown.map((k) => ({ path: `variables.${k}`, code: 'unknown', message: k })),
      });
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (v === null || v === undefined || v === '') continue;
      const type = allowed[k]!;
      const path = `variables.${k}`;
      if (type === 'money') {
        if (typeof v !== 'string' || !MONEY.test(v) || new Decimal(v).lte(0))
          throw invalid(path, 'money', 'an amount like 5000.00');
        out[k] = new Decimal(v).toFixed(2);
      } else if (type === 'date') {
        if (typeof v !== 'string' || !DAY.test(v)) throw invalid(path, 'date', 'YYYY-MM-DD');
        out[k] = v;
      } else if (type === 'text') {
        if (typeof v !== 'string' || v.length > 2000)
          throw invalid(path, 'text', 'text up to 2000 characters');
        out[k] = v.trim();
      } else {
        if (!Array.isArray(v) || v.length < 1 || v.length > 20)
          throw invalid(path, 'clauses', '1–20 clauses of { title, text }');
        out[k] = v.map((c: unknown, i: number) => {
          const o = (c ?? {}) as Record<string, unknown>;
          if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 200)
            throw invalid(`${path}[${i}].title`, 'length', '1–200 characters');
          if (typeof o.text !== 'string' || !o.text.trim() || o.text.length > 2000)
            throw invalid(`${path}[${i}].text`, 'length', '1–2000 characters');
          return { title: o.title.trim(), text: o.text.trim() };
        });
      }
    }
    return out;
  }

  private async tenantLabel(tx: Tx, tenantId: string): Promise<string> {
    const t = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { legalName: true, displayName: true },
    });
    return t.legalName || t.displayName;
  }

  /** Drafts a document: links, signers and the user's values checked; the template version pinned (D-294). */
  async create(ctx: TenantContext, input: ContractCreateInput): Promise<ContractRow> {
    if (!isSignableKind(input.kind))
      throw invalid(
        'kind',
        'isIn',
        'reservation, brokerage_mandate, co_broke or addendum (leases sign as leases)',
      );
    const kind = input.kind;
    const vars = this.checkVariables(kind, input.variables ?? {});
    const today = bangkokDate(this.clock.now());
    const id = await this.db.tenant(ctx, async (tx) => {
      const facts: {
        unitId: string | null;
        buildingId: string | null;
        leaseId?: string;
        coBrokeAgreementId?: string;
        mandateId?: string;
        counterpartyTenantId?: string;
        signers: SignerEntry[];
      } = { unitId: null, buildingId: null, signers: [] };
      const me = await this.db.platform((p) => this.tenantLabel(p, ctx.tenantId));
      const tenantSigner = (index: number, role: ContractSignerRole, tenantId: string, name: string) => ({
        index,
        role,
        tenantId,
        name,
      });
      switch (kind) {
        case 'addendum': {
          if (!input.leaseId) throw invalid('leaseId', 'required', 'an addendum belongs to a lease');
          const lease = this.found(
            await tx.lease.findFirst({
              where: this.own(ctx, { id: input.leaseId }),
              include: { parties: { include: { party: { select: { displayName: true } } } } },
            }),
          );
          if (![...IN_FORCE, 'pending_signature'].includes(lease.status))
            throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
          if (!Array.isArray(vars.clauses))
            throw invalid('variables.clauses', 'required', 'at least one clause');
          vars.effectiveDate ??= today;
          Object.assign(facts, { unitId: lease.unitId, buildingId: lease.buildingId, leaseId: lease.id });
          facts.signers.push(tenantSigner(0, 'lessor', ctx.tenantId, me));
          for (const p of lease.parties.filter((x) => x.isSigner))
            facts.signers.push({
              index: facts.signers.length,
              role: p.role === 'co_tenant' ? 'co_tenant' : 'lessee',
              partyId: p.partyId,
              name: p.party.displayName,
            });
          break;
        }
        case 'reservation': {
          if (!input.unitId) throw invalid('unitId', 'required', 'the unit reserved');
          if (!input.partyId) throw invalid('partyId', 'required', 'the person reserving');
          const unit = this.found(
            await tx.unit.findFirst({
              where: { id: input.unitId, deletedAt: null },
              include: { unitDetailUnit: { include: { profile: true } } },
            }),
          );
          const party = this.found(
            await tx.party.findFirst({ where: this.own(ctx, { id: input.partyId, deletedAt: null }) }),
          );
          for (const k of ['fee', 'moveInDate', 'expiresOn'])
            if (!vars[k]) throw invalid(`variables.${k}`, 'required', `${k} is required`);
          const rent = unit.baseRent ?? unit.unitDetailUnit?.profile?.defaultRent ?? null;
          if (!vars.rent && !rent)
            throw invalid('variables.rent', 'required', 'the unit has no base rent; give rent');
          vars.rent ??= new Decimal(rent!.toString()).toFixed(2);
          Object.assign(facts, { unitId: unit.id, buildingId: unit.buildingId });
          facts.signers.push(tenantSigner(0, 'lessor', ctx.tenantId, me));
          facts.signers.push({ index: 1, role: 'prospect', partyId: party.id, name: party.displayName });
          break;
        }
        case 'co_broke': {
          if (!input.coBrokeAgreementId)
            throw invalid('coBrokeAgreementId', 'required', 'the co-broke agreement this contract records');
          const a = this.found(
            await tx.coBrokeAgreement.findFirst({
              where: { id: input.coBrokeAgreementId, tenantId: ctx.tenantId },
            }),
          );
          if (!['proposed', 'signed'].includes(a.state)) throw new DomainException('co_broke.invalid_state');
          const listing = await this.db.platform((p) =>
            p.listing.findUniqueOrThrow({ where: { id: a.listingId }, select: { buildingId: true } }),
          );
          const co = await this.db.platform((p) => this.tenantLabel(p, a.coAgencyTenantId));
          Object.assign(facts, {
            unitId: a.unitId,
            buildingId: listing.buildingId,
            coBrokeAgreementId: a.id,
            counterpartyTenantId: a.coAgencyTenantId,
          });
          facts.signers.push(tenantSigner(0, 'agency', ctx.tenantId, me));
          facts.signers.push(tenantSigner(1, 'co_agency', a.coAgencyTenantId, co));
          break;
        }
        case 'brokerage_mandate': {
          if (!input.mandateId) throw invalid('mandateId', 'required', 'the mandate this contract records');
          const m = this.found(
            await tx.listingMandate.findFirst({
              where: { id: input.mandateId, ownerTenantId: ctx.tenantId },
            }),
          );
          if (!['invited', 'accepted', 'active'].includes(m.state))
            throw new DomainException('mandate.invalid_state');
          const agency = await this.db.platform((p) => this.tenantLabel(p, m.tenantId));
          Object.assign(facts, {
            unitId: m.unitId,
            buildingId: m.buildingId,
            mandateId: m.id,
            counterpartyTenantId: m.tenantId,
          });
          facts.signers.push(tenantSigner(0, 'owner', ctx.tenantId, me));
          facts.signers.push(tenantSigner(1, 'agency', m.tenantId, agency));
          break;
        }
      }
      const version = await this.library.usableVersion(
        tx,
        ctx.tenantId,
        [kind],
        input.language ?? 'th',
        input.templateVersionId,
      );
      const unitNo = facts.unitId
        ? (
            await this.db.platform((p) =>
              p.unit.findUnique({ where: { id: facts.unitId! }, select: { unitNo: true } }),
            )
          )?.unitNo
        : null;
      const title = (input.title?.trim() || `${version.template.name}${unitNo ? ` ${unitNo}` : ''}`).slice(
        0,
        200,
      );
      const row = await tx.contractDocument.create({
        data: {
          tenantId: ctx.tenantId,
          kind,
          templateVersionId: version.id,
          language: version.language,
          title,
          buildingId: facts.buildingId,
          unitId: facts.unitId,
          leaseId: facts.leaseId ?? null,
          coBrokeAgreementId: facts.coBrokeAgreementId ?? null,
          mandateId: facts.mandateId ?? null,
          counterpartyTenantId: facts.counterpartyTenantId ?? null,
          signers: facts.signers as unknown as Prisma.InputJsonValue,
          variables: vars as Prisma.InputJsonValue,
          createdBy: by(),
        },
      });
      await this.record(tx, row, 'contract.created', ctx.tenantId, {
        kind,
        templateVersionId: version.id,
        signers: facts.signers.length,
      });
      return row.id;
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- rendering

  private async tenantBlock(tenantId: string): Promise<PartyBlock> {
    const t = await this.db.platform((tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
    return { legalName: t.legalName || t.displayName, taxId: t.taxId, address: addressText(t.address) };
  }

  private async premises(unitId: string | null): Promise<PremisesBlock> {
    if (!unitId) return { unitNo: '-', buildingName: '', propertyName: '', address: '', areaSqm: null };
    const u = await this.db.platform((tx) =>
      tx.unit.findUniqueOrThrow({
        where: { id: unitId },
        include: { building: { include: { property: true } } },
      }),
    );
    return {
      unitNo: u.unitNo,
      buildingName: u.building.name,
      propertyName: u.building.property.name,
      address: addressText(u.building.address) || addressText(u.building.property.address),
      areaSqm: u.areaSqm ? u.areaSqm.toFixed(2) : null,
    };
  }

  /** The data a document renders from: facts read now, the user's values, signatures when given. */
  async data(
    row: ContractDocument & { templateVersion: ContractRow['templateVersion'] },
    options: { draft: boolean; number: string | null; signatures?: ContractDocData['signatures'] },
  ): Promise<ContractDocData> {
    const en = row.language === 'en';
    const date = (d: string | null | undefined) => (d ? (en ? englishDate(d) : thaiDate(d)) : '');
    const words = (v: string) => (en ? bahtTextEn(v) : bahtText(v));
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const vars = (row.variables ?? {}) as Record<string, unknown>;
    const signers = ContractsService.signers(row);
    const disclaimer = await this.library.disclaimer();
    const premises = await this.premises(row.unitId);
    const v = row.templateVersion;
    const out: ContractDocData = {
      draft: options.draft,
      disclaimer: en ? disclaimer.en : disclaimer.th,
      contract: {
        number: options.number,
        madeAt: premises.propertyName,
        madeOn: date(bangkokDate(row.sentAt ?? this.clock.now())),
      },
      template: {
        key: v.template.key,
        version: v.version,
        legalRef: v.legalRef,
        legalReview: v.legalReviewState,
      },
      premises,
      signatures: options.signatures ?? {},
      signers: signers.map((s) => ({ role: s.role, name: s.name })),
    };
    const block = (role: ContractSignerRole) => {
      const s = signers.find((x) => x.role === role);
      return s?.tenantId ? this.tenantBlock(s.tenantId) : Promise.resolve(undefined);
    };
    switch (row.kind as SignableKind) {
      case 'reservation': {
        const prospect = signers.find((s) => s.role === 'prospect');
        const party = prospect?.partyId
          ? await this.db.platform((tx) => tx.party.findUnique({ where: { id: prospect.partyId! } }))
          : null;
        out.lessor = await block('lessor');
        out.prospect = {
          displayName: party?.displayName ?? prospect?.name ?? '',
          phone: party?.phoneE164 ?? null,
        };
        const fee = String(vars.fee);
        const rent = String(vars.rent);
        out.reservation = {
          fee: formatThb(fee),
          feeText: words(fee),
          rent: formatThb(rent),
          rentText: words(rent),
          moveInDate: date(vars.moveInDate as string),
          expiresOn: date(vars.expiresOn as string),
          refundTerms: (vars.refundTerms as string | undefined) ?? null,
        };
        break;
      }
      case 'brokerage_mandate': {
        const m = await this.db.platform((tx) =>
          tx.listingMandate.findUniqueOrThrow({ where: { id: row.mandateId! } }),
        );
        out.owner = await block('owner');
        out.agency = await block('agency');
        out.mandate = {
          scope: m.scope,
          exclusive: m.exclusive,
          commissionTerms: m.commissionTerms,
          commissionPercent: m.commissionPercent?.toFixed(4) ?? null,
          commissionAmount: m.commissionAmount ? formatThb(m.commissionAmount.toFixed(2)) : null,
          validFrom: date(day(m.validFrom)),
          validTo: m.validTo ? date(day(m.validTo)) : null,
          note: (vars.note as string | undefined) ?? null,
        };
        break;
      }
      case 'co_broke': {
        const a = await this.db.platform((tx) =>
          tx.coBrokeAgreement.findUniqueOrThrow({
            where: { id: row.coBrokeAgreementId! },
            include: { listing: { select: { titleTh: true, titleEn: true } } },
          }),
        );
        out.agency = await block('agency');
        out.coAgency = await block('co_agency');
        out.coBroke = {
          splitPercent: a.splitPercent.toFixed(4),
          validFrom: date(day(a.validFrom)),
          validTo: a.validTo ? date(day(a.validTo)) : null,
          listingTitle: (en ? a.listing.titleEn : null) ?? a.listing.titleTh,
          note: (vars.note as string | undefined) ?? null,
        };
        break;
      }
      case 'addendum': {
        const lease = await this.db.platform((tx) =>
          tx.lease.findUniqueOrThrow({ where: { id: row.leaseId! }, include: { lessee: true } }),
        );
        out.lessor = await block('lessor');
        out.lessee = { displayName: lease.lessee.displayName, phone: lease.lessee.phoneE164 };
        out.lease = {
          number: lease.number,
          startDate: date(day(lease.startDate)),
          endDate: date(day(lease.endDate)),
          rent: formatThb(lease.rent.toFixed(2)),
        };
        out.addendum = {
          effectiveDate: date(vars.effectiveDate as string),
          clauses: (vars.clauses as { title: string; text: string }[] | undefined) ?? [],
        };
        break;
      }
    }
    return out;
  }

  private async render(row: ContractRow, options: Parameters<ContractsService['data']>[1]) {
    const data = await this.data(row, options);
    const language: ContractLanguage = row.language === 'en' ? 'en' : 'th';
    const title = `${row.title}${options.number ? ` ${options.number}` : ''}`;
    return this.renderer.renderDocument(row.templateVersion.bodyHtml, data, { title, language });
  }

  /** Draft PDF (not stored, marked as a draft with the disclaimer). */
  async preview(ctx: TenantContext, id: string): Promise<Buffer> {
    const row = await this.get(ctx, id);
    return (await this.render(row, { draft: row.state === 'draft', number: row.number })).pdf;
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Numbered, rendered, hashed and stored; the signers are told (D-062). */
  async sendForSignature(ctx: TenantContext, id: string): Promise<ContractRow> {
    await this.db.tenant(
      ctx,
      async (tx) => {
        const row = await this.visible(tx, ctx, id);
        if (row.tenantId !== ctx.tenantId || row.state !== 'draft')
          throw new DomainException('contract.invalid_state');
        const now = this.clock.now();
        const number = await this.numbering.next(tx, row.tenantId, 'contract', now);
        const rendered = await this.render({ ...row, sentAt: now }, { draft: false, number });
        const doc = await this.documents.storeGenerated(tx, {
          tenantId: row.tenantId,
          kind: 'contract',
          scopeType: row.unitId ? 'unit' : 'tenant',
          scopeId: row.unitId ?? row.tenantId,
          buildingId: row.buildingId,
          title: `${row.title} ${number} (รอลงนาม).pdf`,
          mimeType: 'application/pdf',
          body: rendered.pdf,
        });
        await tx.contractDocument.update({
          where: { id },
          data: {
            state: 'pending_signature',
            number,
            sentAt: now,
            documentId: doc.id,
            sha256: new Uint8Array(rendered.sha256),
            contentSha256: rendered.contentSha256,
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        if (row.coBrokeAgreementId)
          await tx.coBrokeAgreement.update({
            where: { id: row.coBrokeAgreementId },
            data: { contractDocumentId: id, version: { increment: 1 } },
          });
        if (row.mandateId)
          await tx.listingMandate.update({
            where: { id: row.mandateId },
            data: { contractDocumentId: id, version: { increment: 1 } },
          });
        const signers = ContractsService.signers(row);
        await this.record(tx, row, 'contract.sent_for_signature', ctx.tenantId, {
          number,
          title: row.title,
          documentId: doc.id,
          sha256: rendered.sha256.toString('hex'),
          partyIds: signers.filter((s) => s.partyId).map((s) => s.partyId),
          counterpartyTenantId: row.counterpartyTenantId,
        });
      },
      { timeout: 60_000 },
    );
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string | null): Promise<ContractRow> {
    await this.db.tenant(ctx, async (tx) => {
      const row = await this.visible(tx, ctx, id);
      if (row.tenantId !== ctx.tenantId || !['draft', 'pending_signature'].includes(row.state))
        throw new DomainException('contract.invalid_state');
      await tx.contractDocument.update({
        where: { id },
        data: {
          state: 'cancelled',
          cancelledAt: this.clock.now(),
          cancelReason: reason?.trim().slice(0, 500) || null,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.record(tx, row, 'contract.cancelled', ctx.tenantId, { reason });
    });
    return this.get(ctx, id);
  }

  /** A 5-minute link to the signed PDF (else the unsigned one) with the hash to sign; audited. */
  async download(ctx: TenantContext | null, row: ContractRow, purpose: string) {
    const documentId = row.signedDocumentId ?? row.documentId;
    if (!documentId) throw new DomainException('contract.invalid_state');
    const doc = await this.db.platform((tx) => tx.document.findUniqueOrThrow({ where: { id: documentId } }));
    const link = await this.documents.signedUrl(doc);
    await this.db.platform((tx) =>
      this.audit.record(tx, {
        action: 'document.downloaded',
        tenantId: ctx?.tenantId ?? row.tenantId,
        subjectType: 'core.document',
        subjectId: documentId,
        metadata: { purpose, contractId: row.id },
      }),
    );
    return { document: doc, ...link, sha256: hex(row.sha256) ?? '', signed: Boolean(row.signedDocumentId) };
  }

  private png(body: Buffer): void {
    if (!body.subarray(0, 8).equals(PNG) || body.length > MAX_SIGNATURE_BYTES)
      throw new DomainException('contract.signature_invalid');
  }

  private expectHash(row: ContractRow, sha256: string): void {
    if (row.state !== 'pending_signature') throw new DomainException('contract.invalid_state');
    if (hex(row.sha256) !== sha256.toLowerCase()) throw new DomainException('contract.changed');
  }

  /** An operator of a signing tenant signs with a drawn signature (D-062, D-294). */
  async signAsTenant(
    ctx: TenantContext,
    id: string,
    input: { signaturePng: Buffer; contractSha256: string },
  ): Promise<ContractRow> {
    this.png(input.signaturePng);
    const userId = by();
    if (!userId) throw new DomainException('auth.unauthenticated');
    const row = await this.get(ctx, id);
    this.expectHash(row, input.contractSha256);
    const signed = new Set(row.signatures.map((s) => s.signerIndex));
    const mine = ContractsService.signers(row).filter((s) => s.tenantId === ctx.tenantId);
    if (!mine.length) throw new DomainException('contract.not_signer');
    const signer = mine.find((s) => !signed.has(s.index));
    if (!signer) throw new DomainException('contract.already_signed');
    const request = RequestContext.current();
    // the counterparty writes into the document tenant's rows: one platform transaction after the visibility check
    await this.db.platform(
      async (tx) => {
        const fresh = await tx.contractDocument.findUniqueOrThrow({
          where: { id },
          include: CONTRACT_INCLUDE,
        });
        this.expectHash(fresh, input.contractSha256);
        const image = await this.documents.storeGenerated(tx, {
          tenantId: row.tenantId,
          kind: 'signature',
          scopeType: 'tenant',
          scopeId: row.tenantId,
          buildingId: null,
          title: `ลายมือชื่อ ${signer.name} ${row.number}.png`,
          mimeType: 'image/png',
          body: input.signaturePng,
          retentionClass: 'contract',
        });
        const signature = await tx.contractSignature.create({
          data: {
            tenantId: row.tenantId,
            contractDocumentId: id,
            signerIndex: signer.index,
            signerRole: signer.role,
            signerTenantId: ctx.tenantId,
            userId,
            method: 'draw_web',
            signatureImageDocumentId: image.id,
            pdfSha256: new Uint8Array(fresh.sha256!),
            signedAt: this.clock.now(),
            ip: request?.ip ?? null,
            userAgent: request?.userAgent ?? null,
            createdBy: userId,
          },
        });
        await this.afterSignature(tx, fresh, signature, ctx.tenantId);
      },
      { timeout: 60_000, tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  /** Records the signature event; the last one renders the signed PDF and closes the document. */
  private async afterSignature(
    tx: Tx,
    row: ContractRow,
    signature: ContractSignature,
    actorTenantId: string,
  ) {
    await this.record(tx, row, 'contract.signed_by', actorTenantId, {
      signerIndex: signature.signerIndex,
      signerRole: signature.signerRole,
      partyId: signature.partyId,
      signerTenantId: signature.signerTenantId,
      sha256: hex(signature.pdfSha256),
    });
    const all = await tx.contractSignature.findMany({ where: { contractDocumentId: row.id } });
    const signers = ContractsService.signers(row);
    if (signers.some((s) => !all.some((a) => a.signerIndex === s.index))) return;
    const signatures: ContractDocData['signatures'] = {};
    const en = row.language === 'en';
    for (const s of all) {
      const doc = await tx.document.findUniqueOrThrow({ where: { id: s.signatureImageDocumentId } });
      const bytes = await this.documents.bytesOf(doc);
      const d = bangkokDate(s.signedAt);
      signatures[s.signerRole] = {
        signedAt: en ? englishDate(d) : thaiDate(d),
        imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    }
    const rendered = await this.render(row, { draft: false, number: row.number, signatures });
    const signedDoc = await this.documents.storeGenerated(tx, {
      tenantId: row.tenantId,
      kind: 'contract',
      scopeType: row.unitId ? 'unit' : 'tenant',
      scopeId: row.unitId ?? row.tenantId,
      buildingId: row.buildingId,
      title: `${row.title} ${row.number}.pdf`,
      mimeType: 'application/pdf',
      body: rendered.pdf,
      versionOfDocumentId: row.documentId,
    });
    const now = this.clock.now();
    await tx.contractDocument.update({
      where: { id: row.id },
      data: {
        state: 'signed',
        signedAt: now,
        signedDocumentId: signedDoc.id,
        sha256: new Uint8Array(rendered.sha256),
        version: { increment: 1 },
      },
    });
    await this.record(tx, row, 'contract.signed', row.tenantId, {
      signedDocumentId: signedDoc.id,
      sha256: rendered.sha256.toString('hex'),
      templateVersionId: row.templateVersionId,
    });
    // a fully signed co-broke contract signs its proposed agreement (G2's in-app acceptance stays the fallback)
    if (row.coBrokeAgreementId) {
      const a = await tx.coBrokeAgreement.findUnique({ where: { id: row.coBrokeAgreementId } });
      if (a?.state === 'proposed') {
        const updated = await tx.coBrokeAgreement.update({
          where: { id: a.id },
          data: {
            state: 'signed',
            signedAt: now,
            signedBy: all.find((s) => s.signerTenantId === a.coAgencyTenantId)?.userId ?? null,
            contractDocumentId: row.id,
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'co_broke.signed',
          tenantId: a.coAgencyTenantId,
          buildingId: row.buildingId,
          subjectType: 'ops.co_broke_agreement',
          subjectId: a.id,
          before: { state: a.state },
          after: { state: updated.state, contractDocumentId: row.id },
        });
        await this.events.record(tx, {
          type: 'co_broke.signed',
          aggregateType: 'co_broke_agreement',
          aggregateId: a.id,
          tenantId: a.coAgencyTenantId,
          buildingId: row.buildingId,
          payload: {
            agreementId: a.id,
            listingId: a.listingId,
            coAgencyTenantId: a.coAgencyTenantId,
            splitPercent: a.splitPercent.toFixed(4),
            state: updated.state,
            contractDocumentId: row.id,
          },
        });
      }
    }
  }

  // ------------------------------------------------------------------------------------------- parties (LIFF)

  /** Parties of a login: active party links (residents) and enquiry copies (prospects, D-281). */
  async partiesOf(tx: Tx, userId: string): Promise<string[]> {
    const [links, leads] = await Promise.all([
      tx.partyUserLink.findMany({ where: { userId, state: 'active' }, select: { partyId: true } }),
      tx.listingLead.findMany({ where: { userId }, select: { partyId: true } }),
    ]);
    return [...new Set([...links.map((l) => l.partyId), ...leads.map((l) => l.partyId)])];
  }

  /** Documents waiting for or carrying my signature (never drafts or cancelled ones). */
  async mine(userId: string): Promise<{ rows: ContractRow[]; partyIds: string[] }> {
    return this.db.platform(async (tx) => {
      const partyIds = await this.partiesOf(tx, userId);
      if (!partyIds.length) return { rows: [], partyIds };
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM ops.contract_document d
         WHERE d.state IN ('pending_signature', 'signed')
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.signers) s WHERE s->>'partyId' = ANY(${partyIds}::text[]))
         ORDER BY d.created_at DESC`;
      const rows = await tx.contractDocument.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        include: CONTRACT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
      return { rows, partyIds };
    });
  }

  /** One of my documents (404 when I am not one of its party signers). */
  async access(userId: string, id: string): Promise<{ row: ContractRow; partyIds: string[] }> {
    const found = await this.db.platform(async (tx) => {
      const row = await tx.contractDocument.findUnique({ where: { id }, include: CONTRACT_INCLUDE });
      if (!row || !VISIBLE_TO_PARTIES.includes(row.state)) return null;
      const partyIds = await this.partiesOf(tx, userId);
      const mineOnIt = ContractsService.signers(row).filter((s) => s.partyId && partyIds.includes(s.partyId));
      return mineOnIt.length ? { row, partyIds: mineOnIt.map((s) => s.partyId!) } : null;
    });
    if (!found) throw new DomainException('http.not_found');
    return found;
  }

  private partySigner(row: ContractRow, partyIds: string[]): SignerEntry {
    const signed = new Set(row.signatures.map((s) => s.signerIndex));
    const mine = ContractsService.signers(row).filter((s) => s.partyId && partyIds.includes(s.partyId));
    const next = mine.find((s) => !signed.has(s.index));
    if (!next) throw new DomainException('contract.already_signed');
    return next;
  }

  /** Step 1 of a party's e-signature: an SMS OTP to the phone the office recorded (D-062). */
  async requestOtp(userId: string, id: string, language?: string) {
    const { row, partyIds } = await this.access(userId, id);
    if (row.state !== 'pending_signature') throw new DomainException('contract.invalid_state');
    const signer = this.partySigner(row, partyIds);
    const party = await this.db.platform((tx) =>
      tx.party.findUniqueOrThrow({ where: { id: signer.partyId! } }),
    );
    if (!party.phoneE164) throw new DomainException('lease.lessee_identity_missing');
    const challenge = await this.otp.request({
      purpose: 'contract_signature',
      phone: party.phoneE164,
      send: true,
      subjectType: 'ops.contract_document',
      subjectId: id,
      language,
    });
    return { challenge, phoneMasked: maskPhone(party.phoneE164) };
  }

  /** Step 2: OTP + the sha256 of the PDF I read + my drawn signature; evidence kept (D-062). */
  async signAsParty(
    userId: string,
    id: string,
    input: { challengeId: string; code: string; contractSha256: string; signaturePng: Buffer },
  ): Promise<ContractRow> {
    this.png(input.signaturePng);
    const { row, partyIds } = await this.access(userId, id);
    this.expectHash(row, input.contractSha256);
    const signer = this.partySigner(row, partyIds);
    const challenge = await this.otp.verify({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'contract_signature',
    });
    if (challenge.subjectId !== id) throw new DomainException('auth.otp_invalid');
    const user = await this.db.platform((tx) =>
      tx.userAccount.findUniqueOrThrow({ where: { id: userId }, select: { lineUserId: true } }),
    );
    const request = RequestContext.current();
    const ctx: TenantContext = { tenantId: row.tenantId, source: 'path' };
    await this.db.tenant(
      ctx,
      async (tx) => {
        const fresh = await tx.contractDocument.findUniqueOrThrow({
          where: { id },
          include: CONTRACT_INCLUDE,
        });
        this.expectHash(fresh, input.contractSha256);
        const image = await this.documents.storeGenerated(tx, {
          tenantId: row.tenantId,
          kind: 'signature',
          scopeType: 'party',
          scopeId: signer.partyId!,
          buildingId: null,
          title: `ลายมือชื่อ ${signer.name} ${row.number}.png`,
          mimeType: 'image/png',
          body: input.signaturePng,
          retentionClass: 'contract',
        });
        const signature = await tx.contractSignature.create({
          data: {
            tenantId: row.tenantId,
            contractDocumentId: id,
            signerIndex: signer.index,
            signerRole: signer.role,
            partyId: signer.partyId!,
            userId,
            method: 'draw_liff',
            otpChallengeId: challenge.id,
            lineUserId: user.lineUserId,
            signatureImageDocumentId: image.id,
            pdfSha256: new Uint8Array(fresh.sha256!),
            signedAt: this.clock.now(),
            ip: request?.ip ?? null,
            userAgent: request?.userAgent ?? null,
            createdBy: userId,
          },
        });
        await this.afterSignature(tx, fresh, signature, row.tenantId);
      },
      { timeout: 60_000 },
    );
    return (await this.access(userId, id)).row;
  }

  private async record(
    tx: Tx,
    row: Pick<ContractDocument, 'id' | 'tenantId' | 'buildingId' | 'kind'>,
    type: Extract<DomainEventType, `contract.${string}`>,
    actorTenantId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record(tx, {
      action: type,
      tenantId: actorTenantId,
      buildingId: row.buildingId,
      subjectType: 'ops.contract_document',
      subjectId: row.id,
      metadata: { kind: row.kind, ...metadata },
    });
    await this.events.record(tx, {
      type,
      aggregateType: 'contract_document',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: { contractId: row.id, kind: row.kind, ...metadata },
    });
  }
}
