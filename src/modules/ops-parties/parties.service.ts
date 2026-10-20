import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { normalisePhone } from '@core/identity/phone';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type IdDocumentType, type PartyType, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { isValidThaiId } from './thai-id';

const by = () => userIdOf(RequestContext.actor());
const normaliseId = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();

export interface EmergencyContactInput {
  name: string;
  relation: string;
  phone: string;
}

export interface OccupantProfileInput {
  visaType?: string | null;
  arrivalDate?: string | null;
  entryPort?: string | null;
  passportIssuedCountry?: string | null;
  occupation?: string | null;
  notes?: string | null;
}

export interface PartyWriteInput {
  type: PartyType;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  taxId?: string | null;
  phone?: string | null;
  email?: string | null;
  lineUserId?: string | null;
  language?: string;
  nationality?: string | null;
  idDocumentType?: IdDocumentType | null;
  idNumber?: string | null;
  idDocumentCountry?: string | null;
  idExpiresOn?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  address?: Prisma.InputJsonValue | null;
  emergencyContact?: EmergencyContactInput | null;
  notes?: string | null;
  occupantProfile?: OccupantProfileInput | null;
}

export interface PartyListQuery {
  q?: string;
  type?: PartyType;
  skip: number;
  take: number;
}

/** Stored shape of `core.party.emergency_contact` (§3.1.3): the phone is sealed with the tenant DEK. */
interface StoredEmergencyContact {
  name: string;
  relation: string;
  phoneEnc: string;
}

export const PARTY_INCLUDE = {
  occupantProfileParty: true,
  userLinks: {
    where: { state: 'active' },
    select: { id: true, userId: true, linkedVia: true, linkedAt: true },
  },
} as const satisfies Prisma.PartyInclude;
export type PartyRow = Prisma.PartyGetPayload<{ include: typeof PARTY_INCLUDE }>;

export type RevealField = 'idNumber' | 'emergencyContactPhone';

/**
 * Parties of the owner console and the staff PWA (B2.2, D-151): persons and companies with the minimum the tenant
 * needs; the ID/passport number and the emergency-contact phone are sealed with the tenant's data key (D-148,
 * §4.7), looked up by HMAC, shown only as "on file" in lists, and revealed one field at a time with
 * `party.pii.decrypt` (Owner/Manager, D-172) — each reveal writes `pii.decrypted`. ID document images are
 * `core.document` rows of kind `id_document` scoped to the party (retention class `id_document`, D-025);
 * listing and downloading them needs `party.id_document.read` and every download is audited.
 */
@Injectable()
export class PartiesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private field(ctx: TenantContext, rowId: string, column: string) {
    return { tenantId: ctx.tenantId, table: 'core.party', column, rowId };
  }

  private async sealIdNumber(tx: Tx, ctx: TenantContext, id: string, idNumber: string) {
    const value = normaliseId(idNumber);
    return {
      idNumberEnc: await this.keys.encrypt(tx, this.field(ctx, id, 'id_number'), value),
      idNumberHash: this.hasher.tenantValue(ctx.tenantId, value),
    };
  }

  private async sealEmergency(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    contact: EmergencyContactInput,
  ): Promise<StoredEmergencyContact> {
    const phone = normalisePhone(contact.phone) ?? contact.phone;
    const sealed = await this.keys.encrypt(tx, this.field(ctx, id, 'emergency_contact.phone'), phone);
    return {
      name: contact.name,
      relation: contact.relation,
      phoneEnc: Buffer.from(sealed).toString('base64'),
    };
  }

  private occupantData(input: OccupantProfileInput) {
    return {
      visaType: input.visaType ?? null,
      arrivalDate: input.arrivalDate ? new Date(input.arrivalDate) : null,
      entryPort: input.entryPort ?? null,
      passportIssuedCountry: input.passportIssuedCountry ?? null,
      occupation: input.occupation ?? null,
      notes: input.notes ?? null,
    };
  }

  private checkIdNumber(type: IdDocumentType | null | undefined, idNumber: string | null | undefined) {
    if (idNumber && type === 'thai_national_id' && !isValidThaiId(idNumber))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'idNumber', code: 'thaiId', message: 'not a valid Thai national id (checksum)' }],
      });
  }

  create(ctx: TenantContext, input: PartyWriteInput): Promise<PartyRow> {
    this.checkIdNumber(input.idDocumentType, input.idNumber);
    return this.db.tenant(ctx, async (tx) => {
      const id = uuidv7(this.clock.now().getTime());
      await tx.party.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          type: input.type,
          displayName: input.displayName,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          companyName: input.companyName ?? null,
          taxId: input.taxId ?? null,
          phoneE164: input.phone ?? null,
          phoneHash: input.phone ? this.hasher.tenantValue(ctx.tenantId, input.phone) : null,
          email: input.email ?? null,
          lineUserId: input.lineUserId ?? null,
          language: input.language ?? 'th',
          nationality: input.nationality ?? null,
          idDocumentType: input.idDocumentType ?? null,
          idDocumentCountry: input.idDocumentCountry ?? null,
          idExpiresOn: input.idExpiresOn ? new Date(input.idExpiresOn) : null,
          dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
          gender: input.gender ?? null,
          address: input.address ?? undefined,
          notes: input.notes ?? null,
          ...(input.idNumber ? await this.sealIdNumber(tx, ctx, id, input.idNumber) : {}),
          ...(input.emergencyContact
            ? {
                emergencyContact: (await this.sealEmergency(
                  tx,
                  ctx,
                  id,
                  input.emergencyContact,
                )) as unknown as Prisma.InputJsonValue,
              }
            : {}),
          createdBy: by(),
        },
      });
      if (input.occupantProfile)
        await tx.occupantProfile.create({
          data: {
            partyId: id,
            tenantId: ctx.tenantId,
            ...this.occupantData(input.occupantProfile),
            createdBy: by(),
          },
        });
      await this.events.record(tx, {
        type: 'party.changed',
        aggregateType: 'party',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { partyId: id, change: 'created' },
      });
      return this.load(tx, ctx, id);
    });
  }

  update(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: Partial<PartyWriteInput>,
  ): Promise<PartyRow> {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(
        await tx.party.findFirst({ where: this.own(ctx, { id, deletedAt: null, anonymisedAt: null }) }),
      );
      if (current.version !== version) throw new DomainException('concurrency.stale');
      this.checkIdNumber(patch.idDocumentType ?? current.idDocumentType, patch.idNumber);
      const data: Prisma.PartyUncheckedUpdateInput = { updatedBy: by(), version: { increment: 1 } };
      const plain = [
        'type',
        'displayName',
        'firstName',
        'lastName',
        'companyName',
        'taxId',
        'email',
        'lineUserId',
        'language',
        'nationality',
        'idDocumentType',
        'idDocumentCountry',
        'gender',
        'notes',
      ] as const;
      for (const k of plain) if (patch[k] !== undefined) (data as Record<string, unknown>)[k] = patch[k];
      if (patch.phone !== undefined) {
        data.phoneE164 = patch.phone;
        data.phoneHash = patch.phone ? this.hasher.tenantValue(ctx.tenantId, patch.phone) : null;
      }
      if (patch.idExpiresOn !== undefined)
        data.idExpiresOn = patch.idExpiresOn ? new Date(patch.idExpiresOn) : null;
      if (patch.dateOfBirth !== undefined)
        data.dateOfBirth = patch.dateOfBirth ? new Date(patch.dateOfBirth) : null;
      if (patch.address !== undefined) data.address = patch.address ?? undefined;
      if (patch.idNumber !== undefined) {
        if (patch.idNumber) Object.assign(data, await this.sealIdNumber(tx, ctx, id, patch.idNumber));
        else Object.assign(data, { idNumberEnc: null, idNumberHash: null });
      }
      if (patch.emergencyContact !== undefined)
        data.emergencyContact = patch.emergencyContact
          ? ((await this.sealEmergency(
              tx,
              ctx,
              id,
              patch.emergencyContact,
            )) as unknown as Prisma.InputJsonValue)
          : undefined;
      await tx.party.update({ where: { id }, data });
      if (patch.occupantProfile) {
        const occ = this.occupantData(patch.occupantProfile);
        await tx.occupantProfile.upsert({
          where: { partyId: id },
          create: { partyId: id, tenantId: ctx.tenantId, ...occ, createdBy: by() },
          update: { ...occ, updatedBy: by() },
        });
      }
      await this.events.record(tx, {
        type: 'party.changed',
        aggregateType: 'party',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { partyId: id, change: 'updated', fields: Object.keys(patch) },
      });
      return this.load(tx, ctx, id);
    });
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<PartyRow> {
    return this.found(
      await tx.party.findFirst({ where: this.own(ctx, { id, deletedAt: null }), include: PARTY_INCLUDE }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<PartyRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  /** Search by name (`q`), exact phone or exact ID number (both through their lookup hashes, D-148). */
  list(ctx: TenantContext, query: PartyListQuery) {
    return this.db.tenant(ctx, async (tx) => {
      const phone = query.q ? normalisePhone(query.q) : null;
      const looksLikeId = query.q ? /^[0-9A-Z-]{6,20}$/i.test(query.q.replace(/\s/g, '')) && !phone : false;
      const where: Prisma.PartyWhereInput = {
        tenantId: ctx.tenantId,
        deletedAt: null,
        anonymisedAt: null,
        ...(query.type ? { type: query.type } : {}),
        ...(query.q
          ? {
              OR: [
                { displayName: { contains: query.q, mode: 'insensitive' } },
                ...(phone ? [{ phoneHash: Buffer.from(this.hasher.tenantValue(ctx.tenantId, phone)) }] : []),
                ...(looksLikeId
                  ? [
                      {
                        idNumberHash: Buffer.from(
                          this.hasher.tenantValue(ctx.tenantId, normaliseId(query.q)),
                        ),
                      },
                    ]
                  : []),
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.party.findMany({
          where,
          include: PARTY_INCLUDE,
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          skip: query.skip,
          take: query.take,
        }),
        tx.party.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** Reveals sealed fields (caller checked `party.pii.decrypt`); one `pii.decrypted` audit row per field. */
  reveal(ctx: TenantContext, id: string, fields: RevealField[], purpose: string) {
    return this.db.tenant(ctx, async (tx) => {
      const party = this.found(await tx.party.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }));
      const out: { idNumber: string | null; emergencyContactPhone: string | null } = {
        idNumber: null,
        emergencyContactPhone: null,
      };
      for (const f of [...new Set(fields)]) {
        if (f === 'idNumber' && party.idNumberEnc)
          out.idNumber = await this.keys.decrypt(tx, this.field(ctx, id, 'id_number'), party.idNumberEnc);
        const emergency = party.emergencyContact as StoredEmergencyContact | null;
        if (f === 'emergencyContactPhone' && emergency?.phoneEnc)
          out.emergencyContactPhone = await this.keys.decrypt(
            tx,
            this.field(ctx, id, 'emergency_contact.phone'),
            Buffer.from(emergency.phoneEnc, 'base64'),
          );
        await this.audit.record(tx, {
          action: 'pii.decrypted',
          tenantId: ctx.tenantId,
          subjectType: 'core.party',
          subjectId: id,
          metadata: { field: f === 'idNumber' ? 'id_number' : 'emergency_contact.phone', purpose },
        });
      }
      return out;
    });
  }

  /** ID document images of a party (kind `id_document`); the caller checked `party.id_document.read`. */
  idDocuments(ctx: TenantContext, partyId: string) {
    return this.db.tenant(ctx, async (tx) => {
      this.found(await tx.party.findFirst({ where: this.own(ctx, { id: partyId, deletedAt: null }) }));
      return tx.document.findMany({
        where: this.own(ctx, { scopeType: 'party', scopeId: partyId, kind: 'id_document', deletedAt: null }),
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  /** Signed download of one ID document image (audited `document.downloaded` by DocumentsService, D-025). */
  async downloadIdDocument(ctx: TenantContext, partyId: string, documentId: string, purpose: string) {
    const docs = await this.idDocuments(ctx, partyId);
    if (!docs.some((d) => d.id === documentId)) throw new DomainException('http.not_found');
    return this.documents.download(ctx, documentId, purpose);
  }

  /**
   * Logins linked to the party (active and unlinked). User accounts are identity rows (RLS: self only), so their
   * display name and LINE flag are read in a platform transaction, for the linked users only (§4.5 call site).
   */
  async links(ctx: TenantContext, partyId: string) {
    const links = await this.db.tenant(ctx, async (tx) => {
      this.found(await tx.party.findFirst({ where: this.own(ctx, { id: partyId, deletedAt: null }) }));
      return tx.partyUserLink.findMany({ where: this.own(ctx, { partyId }), orderBy: { linkedAt: 'desc' } });
    });
    const users = links.length
      ? await this.db.platform((tx) =>
          tx.userAccount.findMany({
            where: { id: { in: [...new Set(links.map((l) => l.userId))] } },
            select: { id: true, displayName: true, lineUserId: true, phoneE164: true },
          }),
        )
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return links.map((l) => ({ link: l, user: byId.get(l.userId) ?? null }));
  }

  /**
   * Unlinks a login from the party (Owner only, `party.link.manage`, D-172): the resident loses this tenant's leases
   * at the next token refresh (scopes are recomputed). Audited `party.unlinked`.
   */
  unlink(ctx: TenantContext, partyId: string, linkId: string, reason: string) {
    return this.db.tenant(ctx, async (tx) => {
      const link = this.found(
        await tx.partyUserLink.findFirst({ where: this.own(ctx, { id: linkId, partyId }) }),
      );
      if (link.state !== 'active') throw new DomainException('party.link_not_active');
      const now = this.clock.now();
      const updated = await tx.partyUserLink.update({
        where: { id: linkId },
        data: { state: 'unlinked', unlinkedAt: now, unlinkedBy: by(), unlinkReason: reason, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'party.unlinked',
        tenantId: ctx.tenantId,
        subjectType: 'core.party_user_link',
        subjectId: linkId,
        metadata: { partyId, userId: link.userId, reason },
      });
      await this.events.record(tx, {
        type: 'party.link_changed',
        aggregateType: 'party',
        aggregateId: partyId,
        tenantId: ctx.tenantId,
        payload: { partyId, linkId, userId: link.userId, change: 'unlinked' },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------- link requests

  /**
   * D-226 (review #6): SMS-OTP logins whose verified phone matches one of my parties, waiting for the Owner. The
   * login's display name and LINE flag come from the identity rows (platform transaction, these users only).
   */
  async linkRequests(
    ctx: TenantContext,
    q: { state?: 'pending' | 'confirmed' | 'rejected'; partyId?: string; skip: number; take: number },
  ) {
    const { rows, total } = await this.db.tenant(ctx, async (tx) => {
      const where: Prisma.PartyLinkRequestWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
      };
      const [list, count] = await Promise.all([
        tx.partyLinkRequest.findMany({
          where,
          include: { party: { select: { id: true, displayName: true, phoneE164: true } } },
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.partyLinkRequest.count({ where }),
      ]);
      return { rows: list, total: count };
    });
    const users = rows.length
      ? await this.db.platform((tx) =>
          tx.userAccount.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
            select: { id: true, displayName: true, lineUserId: true },
          }),
        )
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return { rows: rows.map((r) => ({ request: r, user: byId.get(r.userId) ?? null })), total };
  }

  /**
   * The Owner confirms a phone-match link request (D-226): the login is linked to the party (`linked_via admin` —
   * linked by the tenant after checking who signed in); the new scopes arrive with the next token refresh. Audited
   * `party.linked`, event `party.link_changed`.
   */
  async decideLinkRequest(
    ctx: TenantContext,
    id: string,
    input: { action: 'confirm' } | { action: 'reject'; reason: string },
  ) {
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.party_link_request WHERE id = ${id}::uuid FOR UPDATE`;
      const req = this.found(await tx.partyLinkRequest.findFirst({ where: this.own(ctx, { id }) }));
      if (req.state !== 'pending')
        throw new DomainException('party.link_request_not_pending', { params: { state: req.state } });
      const now = this.clock.now();
      if (input.action === 'reject') {
        await tx.partyLinkRequest.update({
          where: { id },
          data: { state: 'rejected', decidedAt: now, decidedBy: by(), rejectReason: input.reason },
        });
        await this.audit.record(tx, {
          action: 'party.link_rejected',
          tenantId: ctx.tenantId,
          subjectType: 'ops.party_link_request',
          subjectId: id,
          metadata: { partyId: req.partyId, userId: req.userId, reason: input.reason },
        });
        return;
      }
      const existing = await tx.partyUserLink.findFirst({
        where: { partyId: req.partyId, userId: req.userId, state: 'active' },
      });
      const link =
        existing ??
        (await tx.partyUserLink.create({
          data: {
            tenantId: req.tenantId,
            partyId: req.partyId,
            userId: req.userId,
            linkedAt: now,
            linkedVia: 'admin',
            createdBy: by(),
          },
        }));
      await tx.partyLinkRequest.update({
        where: { id },
        data: { state: 'confirmed', decidedAt: now, decidedBy: by(), linkId: link.id },
      });
      await this.audit.record(tx, {
        action: 'party.linked',
        tenantId: ctx.tenantId,
        subjectType: 'core.party_user_link',
        subjectId: link.id,
        metadata: { partyId: req.partyId, userId: req.userId, via: 'phone_match_confirmed', requestId: id },
      });
      await this.events.record(tx, {
        type: 'party.link_changed',
        aggregateType: 'party',
        aggregateId: req.partyId,
        tenantId: ctx.tenantId,
        payload: { partyId: req.partyId, linkId: link.id, userId: req.userId, change: 'linked' },
      });
    });
    return this.db.tenant(ctx, async (tx) =>
      tx.partyLinkRequest.findFirstOrThrow({
        where: this.own(ctx, { id }),
        include: { party: { select: { id: true, displayName: true, phoneE164: true } } },
      }),
    );
  }
}
