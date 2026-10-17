import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { Injectable } from '@nestjs/common';

export type SearchHitType = 'building' | 'unit' | 'party' | 'lease' | 'device';

export interface SearchHit {
  type: SearchHitType;
  id: string;
  label: string;
  sublabel: string | null;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_HITS = 20;

/**
 * The owner console's global search (top bar): buildings, units, parties, leases and devices of the current tenant
 * whose name, number or serial contains the query (case-insensitive, trigram indexes). Runs in the tenant
 * transaction, so RLS and the Staff building limit apply; party hits show the display name only (never PII). At
 * most 20 hits, exact-prefix matches first. Invoices join when B4 lands.
 */
@Injectable()
export class SearchService extends TenantScopedRepository {
  constructor(private readonly db: TenantTx) {
    super();
  }

  async search(ctx: TenantContext, raw: string): Promise<SearchHit[]> {
    const q = raw.trim();
    if (q.length < SEARCH_MIN_CHARS)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'q', code: 'min_length', message: `at least ${SEARCH_MIN_CHARS} characters` }],
      });
    const contains = { contains: q, mode: 'insensitive' as const };
    const buildingScope = this.buildingScope(ctx);
    const take = SEARCH_MAX_HITS;
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await tx.building.findMany({
        where: {
          deletedAt: null,
          ...(buildingScope ? { id: buildingScope } : {}),
          OR: [{ name: contains }, { code: contains }],
        },
        select: { id: true, name: true, code: true },
        take,
      });
      const units = await tx.unit.findMany({
        where: { deletedAt: null, unitNo: contains, ...(buildingScope ? { buildingId: buildingScope } : {}) },
        select: { id: true, unitNo: true, building: { select: { name: true } } },
        take,
      });
      const parties = await tx.party.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, anonymisedAt: null, displayName: contains },
        select: { id: true, displayName: true, type: true },
        take,
      });
      const leases = await tx.lease.findMany({
        where: {
          tenantId: ctx.tenantId,
          number: contains,
          ...(buildingScope ? { buildingId: buildingScope } : {}),
        },
        select: { id: true, number: true, status: true, unit: { select: { unitNo: true } } },
        take,
      });
      const devices = await tx.device.findMany({
        where: {
          tenantId: ctx.tenantId,
          serial: contains,
          ...(buildingScope ? { buildingId: buildingScope } : {}),
        },
        select: { id: true, serial: true, kind: true, model: true },
        take,
      });
      const hits: SearchHit[] = [
        ...buildings.map((b) => ({ type: 'building' as const, id: b.id, label: b.name, sublabel: b.code })),
        ...units.map((u) => ({
          type: 'unit' as const,
          id: u.id,
          label: u.unitNo,
          sublabel: u.building.name,
        })),
        ...parties.map((p) => ({ type: 'party' as const, id: p.id, label: p.displayName, sublabel: null })),
        ...leases.map((l) => ({
          type: 'lease' as const,
          id: l.id,
          label: l.number ?? '',
          sublabel: l.unit.unitNo,
        })),
        ...devices.map((d) => ({ type: 'device' as const, id: d.id, label: d.serial, sublabel: d.model })),
      ];
      const lower = q.toLowerCase();
      const rank = (h: SearchHit) => (h.label.toLowerCase().startsWith(lower) ? 0 : 1);
      return hits
        .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'th'))
        .slice(0, SEARCH_MAX_HITS);
    });
  }
}
