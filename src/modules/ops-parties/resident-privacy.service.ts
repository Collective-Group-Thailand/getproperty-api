import { DomainException } from '@common/errors/domain.exception';
import { ConsentService } from '@core/privacy/consent.service';
import { DsrService } from '@core/privacy/dsr.service';
import { TenantTx } from '@database/tenant-tx';
import { Injectable } from '@nestjs/common';

/** Personal-data categories a party row may hold (what the privacy page lists, never the values). */
export type HeldField =
  | 'name'
  | 'phone'
  | 'email'
  | 'line_id'
  | 'id_number'
  | 'id_document_image'
  | 'date_of_birth'
  | 'address'
  | 'emergency_contact'
  | 'tm30';

/**
 * `GET /v1/resident/me/privacy` (B2.2, D-025): what each controller tenant holds about the signed-in resident (the
 * categories, not the values), the consent purposes with their current versions, and the PDPA requests filed — the
 * entry point of the LIFF privacy page (requests themselves through `/v1/resident/data-subject-requests`). Reads the
 * resident's own links across tenants as gp_platform (identity scope, schema-design §4.5).
 */
@Injectable()
export class ResidentPrivacyService {
  constructor(
    private readonly db: TenantTx,
    private readonly consents: ConsentService,
    private readonly dsr: DsrService,
  ) {}

  async overview(userId: string, language: string) {
    const holdings = await this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUnique({
        where: { id: userId },
        select: { id: true, displayName: true },
      });
      if (!user) throw new DomainException('auth.unauthenticated');
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        include: {
          party: { include: { occupantProfileParty: true } },
          tenant: { select: { id: true, displayName: true, legalName: true } },
        },
        orderBy: { linkedAt: 'asc' },
      });
      const documents = links.length
        ? await tx.document.groupBy({
            by: ['scopeId'],
            where: {
              kind: 'id_document',
              scopeType: 'party',
              scopeId: { in: links.map((l) => l.partyId) },
              deletedAt: null,
            },
            _count: { _all: true },
          })
        : [];
      const docs = new Map(documents.map((d) => [d.scopeId, d._count._all]));
      return { user, links, docs };
    });
    const byTenant = new Map<
      string,
      {
        tenantId: string;
        tenantName: string;
        legalName: string;
        parties: { partyId: string; displayName: string; fieldsHeld: HeldField[] }[];
      }
    >();
    for (const l of holdings.links) {
      const p = l.party;
      const fields: HeldField[] = ['name'];
      if (p.phoneE164) fields.push('phone');
      if (p.email) fields.push('email');
      if (p.lineUserId) fields.push('line_id');
      if (p.idNumberEnc) fields.push('id_number');
      if ((holdings.docs.get(p.id) ?? 0) > 0) fields.push('id_document_image');
      if (p.dateOfBirth) fields.push('date_of_birth');
      if (p.address && Object.keys(p.address as object).length) fields.push('address');
      if (p.emergencyContact) fields.push('emergency_contact');
      if (p.occupantProfileParty) fields.push('tm30');
      const entry = byTenant.get(l.tenantId) ?? {
        tenantId: l.tenantId,
        tenantName: l.tenant.displayName,
        legalName: l.tenant.legalName,
        parties: [],
      };
      entry.parties.push({ partyId: p.id, displayName: p.displayName, fieldsHeld: fields });
      byTenant.set(l.tenantId, entry);
    }
    const purposes = await this.consents.purposes(['resident'], language, { type: 'user', id: userId }, null);
    const requests = await this.dsr.listForSubject(userId);
    return { user: holdings.user, controllers: [...byTenant.values()], purposes, requests };
  }
}
