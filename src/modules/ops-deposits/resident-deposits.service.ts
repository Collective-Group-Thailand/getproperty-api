import { DomainException } from '@common/errors/domain.exception';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Injectable } from '@nestjs/common';

import { DEPOSIT_INCLUDE, type DepositRow, DepositsService } from './deposits.service';

/**
 * The resident side of deposits (`/v1/resident/deposits*`, D-023): the deposit and settlement of my leases (lease
 * scope + party link, like the lease views), the itemised deductions with 5-minute links to their evidence photos,
 * and my answer to a proposal — accept, or dispute with a reason (lessee or co-tenant only).
 */
@Injectable()
export class ResidentDepositsService {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    private readonly deposits: DepositsService,
    private readonly documents: DocumentsService,
  ) {}

  /** Deposits of every lease I can open (my leases list, D-061). */
  async list() {
    const { rows } = await this.leases.listWithParties();
    const leaseIds = rows.map((l) => l.id);
    if (!leaseIds.length) return [];
    return this.db.platform((tx) =>
      tx.deposit.findMany({
        where: { leaseId: { in: leaseIds } },
        include: DEPOSIT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private async access(depositId: string) {
    const found = await this.db.platform((tx) =>
      tx.deposit.findUnique({ where: { id: depositId }, select: { leaseId: true } }),
    );
    if (!found) throw new DomainException('http.not_found');
    return { ...(await this.leases.access(found.leaseId)), depositId };
  }

  /** One deposit with signed links to the evidence of each deduction. */
  async get(depositId: string): Promise<{ deposit: DepositRow; evidence: Map<string, string[]> }> {
    const a = await this.access(depositId);
    const deposit = await this.deposits.get(a.ctx, depositId);
    const ids = [...new Set((deposit.settlement?.items ?? []).flatMap((i) => i.evidenceDocumentIds))];
    const docs = ids.length
      ? await this.db.tenant(a.ctx, (tx) =>
          tx.document.findMany({ where: { id: { in: ids }, deletedAt: null } }),
        )
      : [];
    const urls = new Map<string, string>();
    for (const d of docs) urls.set(d.id, (await this.documents.signedUrl(d)).url);
    const evidence = new Map(
      (deposit.settlement?.items ?? []).map((i) => [
        i.id,
        i.evidenceDocumentIds.map((id) => urls.get(id)).filter((u): u is string => Boolean(u)),
      ]),
    );
    return { deposit, evidence };
  }

  async respond(depositId: string, input: { accept: boolean; reason?: string | null }) {
    const a = await this.access(depositId);
    const signer = a.lease.parties.find(
      (p) => ['lessee', 'co_tenant'].includes(p.role) && a.partyIds.includes(p.partyId),
    );
    if (!signer) throw new DomainException('lease.not_signer');
    if (!input.accept && !input.reason?.trim())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'reason', code: 'required', message: 'say what you dispute' }],
      });
    await this.deposits.respond(a.ctx, depositId, { ...input, partyId: signer.partyId });
    return this.get(depositId);
  }
}
