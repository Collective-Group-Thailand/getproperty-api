import { bangkokDate } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import { type DocumentKind } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { isEventBasis, LEGAL_HOLD_POLICY_KEY } from './storage-categories';
import { StorageLedger } from './storage-ledger';

export interface HoldInput {
  tenantId: string;
  documentId: string;
  kind: DocumentKind;
  /** Retention policy key when it differs from the kind's (TM30 export, e-Tax XML). */
  policyKey?: string;
  issuedAt: Date;
  sourceType?: string | null;
  sourceId?: string | null;
}

/**
 * Legal holds (D-286): documents the law requires to keep are counted in the quota and can never be deleted before
 * their retention date — the period of the document class in `platform.retention_policy` (⚖ O-025) counted from the
 * issue date; a basis that starts later (lease end) leaves the date open until that event. Holds are written in the
 * transaction that stores the document; the hold table's trigger refuses deleting, shortening or releasing early.
 */
@Injectable()
export class LegalHoldService {
  constructor(private readonly ledger: StorageLedger) {}

  /** The policy key a generated document of this kind is held under (null = not a legal document). */
  policyKeyOf(kind: DocumentKind, explicit?: string | null): string | null {
    return explicit ?? LEGAL_HOLD_POLICY_KEY[kind] ?? null;
  }

  /** Places the hold (idempotent per document) and moves the document to the `system_legal` category. */
  async hold(tx: Tx, input: HoldInput): Promise<void> {
    const key = this.policyKeyOf(input.kind, input.policyKey);
    if (!key) return;
    const day = bangkokDate(input.issuedAt);
    const policies = await tx.$queryRaw<{ id: string; basis: string; until: Date }[]>`
      SELECT id, basis, (${day}::date + retain_for)::date AS until
        FROM platform.retention_policy
       WHERE target = 'document_class' AND target_key = ${key} AND effective_from <= ${day}::date
       ORDER BY effective_from DESC LIMIT 1`;
    const policy = policies[0];
    // no policy for the class yet: held until a policy and the platform release it (conservative)
    const retainUntil = policy && !isEventBasis(policy.basis) ? policy.until : null;
    await tx.$executeRaw`
      INSERT INTO platform.document_legal_hold
        (tenant_id, document_id, document_kind, retention_policy_id, retain_until, source_type, source_id)
      VALUES (${input.tenantId}::uuid, ${input.documentId}::uuid, ${key}, ${policy?.id ?? null}::uuid,
              ${retainUntil}::date, ${input.sourceType ?? null}, ${input.sourceId ?? null}::uuid)
      ON CONFLICT (document_id) DO NOTHING`;
    await this.ledger.moveCategory(tx, input.documentId, 'system_legal');
  }

  /** Document ids among `ids` that are still held at `at` (not released, retention date not passed or open). */
  async heldAmong(tx: Tx, ids: string[], at: Date): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.$queryRaw<{ document_id: string }[]>`
      SELECT document_id FROM platform.document_legal_hold
       WHERE document_id = ANY(${ids}::uuid[]) AND released_at IS NULL
         AND (retain_until IS NULL OR retain_until > ${bangkokDate(at)}::date)`;
    return rows.map((r) => r.document_id);
  }

  /** Sets the retention date of an open-ended hold once its basis event is known (e.g. the lease ended). */
  async settle(tx: Tx, documentId: string, basisDate: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE platform.document_legal_hold h
         SET retain_until = (${basisDate}::date + p.retain_for)::date
        FROM platform.retention_policy p
       WHERE h.document_id = ${documentId}::uuid AND h.retain_until IS NULL AND p.id = h.retention_policy_id`;
  }
}
