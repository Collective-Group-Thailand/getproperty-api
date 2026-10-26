import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { DocumentsService } from '@core/documents/documents.service';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { INSPECTION_INCLUDE, type InspectionRow, InspectionsService } from './inspections.service';

export interface ResidentInspectionView {
  inspection: InspectionRow;
  photos: Map<string, string[]>;
  reportUrl: string | null;
  canCountersign: boolean;
}

/**
 * The resident side of move-in / move-out reports (`/v1/resident/inspections*`, L5 5.2, D-253): the completed reports
 * of my leases with every line, 5-minute links to its photos and to the report PDF; a report the owner completed
 * without my signature can be countersigned here (lessee or co-tenant).
 */
@Injectable()
export class ResidentInspectionsService implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    private readonly inspections: InspectionsService,
    private readonly documents: DocumentsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * LINE: the lessee is asked to check and countersign a report the owner completed without their signature; the
   * owner hears when they did (L5 5.2, D-253).
   */
  onModuleInit(): void {
    registerNotifiable('inspection.completed', async (tx, e) => {
      const inspectionId = e.payload.inspectionId as string | undefined;
      const leaseId = e.payload.leaseId as string | null | undefined;
      if (!inspectionId || !leaseId || !e.tenantId) return null;
      const [inspection, lease] = await Promise.all([
        tx.inspection.findUnique({ where: { id: inspectionId }, select: { status: true } }),
        tx.lease.findUnique({ where: { id: leaseId }, select: { lesseePartyId: true } }),
      ]);
      if (inspection?.status !== 'completed' || !lease) return null;
      return {
        recipients: await billedParty(tx, lease.lesseePartyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          inspection: {
            number: e.payload.number,
            typeTh: e.payload.type === 'move_out' ? 'ย้ายออก' : 'เข้าอยู่',
            typeEn: e.payload.type === 'move_out' ? 'move-out' : 'move-in',
          },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/lease/${leaseId}/inspections/${inspectionId}`,
        },
        consentPurpose: 'resident.service' as const,
      };
    });
    registerNotifiable('inspection.countersigned', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              inspection: { number: e.payload.number, unitNo: e.payload.unitNo },
            },
          }
        : null,
    );
  }

  /** Completed reports of every lease I can open, newest first. */
  async list(leaseId?: string): Promise<InspectionRow[]> {
    const { rows } = await this.leases.listWithParties();
    const leaseIds = rows.map((l) => l.id).filter((id) => !leaseId || id === leaseId);
    if (!leaseIds.length) return [];
    return this.db.platform((tx) =>
      tx.inspection.findMany({
        where: {
          leaseId: { in: leaseIds },
          status: { in: ['completed', 'signed'] },
          type: { not: 'periodic' },
        },
        include: INSPECTION_INCLUDE,
        orderBy: { completedAt: 'desc' },
      }),
    );
  }

  private async access(inspectionId: string) {
    const found = await this.db.platform((tx) =>
      tx.inspection.findUnique({ where: { id: inspectionId }, select: { leaseId: true, status: true } }),
    );
    if (!found?.leaseId || !['completed', 'signed'].includes(found.status))
      throw new DomainException('http.not_found');
    return this.leases.access(found.leaseId);
  }

  async get(inspectionId: string): Promise<ResidentInspectionView> {
    const a = await this.access(inspectionId);
    const inspection = await this.inspections.get(a.ctx, inspectionId);
    const ids = [...new Set(inspection.items.flatMap((i) => i.photoDocumentIds))];
    if (inspection.reportDocumentId) ids.push(inspection.reportDocumentId);
    const docs = ids.length
      ? await this.db.tenant(a.ctx, (tx) =>
          tx.document.findMany({ where: { id: { in: ids }, deletedAt: null } }),
        )
      : [];
    const urls = new Map<string, string>();
    for (const d of docs) urls.set(d.id, (await this.documents.signedUrl(d)).url);
    const signer = a.lease.parties.some(
      (p) => ['lessee', 'co_tenant'].includes(p.role) && a.partyIds.includes(p.partyId),
    );
    return {
      inspection,
      photos: new Map(
        inspection.items.map((i) => [
          i.id,
          i.photoDocumentIds.map((id) => urls.get(id)).filter((u): u is string => !!u),
        ]),
      ),
      reportUrl: inspection.reportDocumentId ? (urls.get(inspection.reportDocumentId) ?? null) : null,
      canCountersign: signer && inspection.status === 'completed' && !inspection.residentSignatureDocumentId,
    };
  }

  /** I sign the report the owner completed (lessee or co-tenant; once). */
  async countersign(inspectionId: string, signaturePng: string): Promise<ResidentInspectionView> {
    const png = this.inspections.signature(signaturePng);
    if (!png) throw new DomainException('lease.signature_invalid');
    const a = await this.access(inspectionId);
    const signer = a.lease.parties.find(
      (p) => ['lessee', 'co_tenant'].includes(p.role) && a.partyIds.includes(p.partyId),
    );
    if (!signer) throw new DomainException('lease.not_signer');
    await this.inspections.countersign(a.ctx, inspectionId, signer.partyId, png);
    return this.get(inspectionId);
  }
}
