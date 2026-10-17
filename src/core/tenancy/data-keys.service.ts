import { randomBytes } from 'node:crypto';

import { decryptField, encryptField, envelopeKid, type FieldContext } from '@collective/asset-core';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { KEY_WRAP, type KeyWrapPort } from '@integrations/kms/key-wrap.port';
import { Inject, Injectable } from '@nestjs/common';

const CACHE_MS = 5 * 60_000;

interface DekRow {
  kid: number;
  wrapped_dek: Buffer;
  kek_ref: string;
  state: string;
}

/**
 * Per-tenant data-encryption keys (blueprint rule 5, schema-design §4.7, D-148): each tenant has an active 256-bit
 * DEK in `core.tenant_data_key`, wrapped by the KEK (`KEY_WRAP`). PII columns are sealed with the asset-core field
 * envelope (AES-256-GCM, AAD = tenant | table | column | row id). Unwrapped keys stay in memory for 5 minutes and
 * never reach logs or the database. The app reads wrapped keys only through `core.tenant_dek()` inside a tenant
 * transaction (RLS); creation runs as gp_platform at onboarding.
 */
@Injectable()
export class TenantDataKeys {
  private readonly cache = new Map<string, { at: number; dek: Buffer }>();

  constructor(
    @Inject(KEY_WRAP) private readonly wrap: KeyWrapPort,
    private readonly db: TenantTx,
  ) {}

  /** Onboarding (platform transaction): the tenant's first active key, kid 1 (idempotent). */
  async createFirst(tx: Tx, tenantId: string): Promise<void> {
    const dek = randomBytes(32);
    const wrapped = await this.wrap.wrap(dek, tenantId);
    await tx.$executeRaw`
      INSERT INTO core.tenant_data_key (tenant_id, kid, wrapped_dek, kek_ref, state)
      VALUES (${tenantId}::uuid, 1, ${wrapped}, ${this.wrap.kekRef}, 'active')
      ON CONFLICT DO NOTHING`;
  }

  /**
   * A tenant created before keys existed (or by a seed) gets its first key on first use: created in its own
   * platform transaction (committed at once, so the caller's READ COMMITTED transaction sees it next statement).
   */
  private async ensureFirst(tx: Tx, tenantId: string): Promise<DekRow | undefined> {
    await this.db.platform((p) => this.createFirst(p, tenantId));
    const rows = await tx.$queryRaw<DekRow[]>`
      SELECT kid, wrapped_dek, kek_ref, state::text AS state FROM core.tenant_dek(NULL::smallint)`;
    return rows[0];
  }

  private async dek(tx: Tx, tenantId: string, kid: number | null): Promise<{ kid: number; dek: Buffer }> {
    const rows = await tx.$queryRaw<DekRow[]>`
      SELECT kid, wrapped_dek, kek_ref, state::text AS state FROM core.tenant_dek(${kid}::smallint)`;
    const row = rows[0] ?? (kid === null ? await this.ensureFirst(tx, tenantId) : undefined);
    if (!row) throw new Error(`tenant ${tenantId} has no ${kid === null ? 'active' : `kid ${kid}`} data key`);
    const key = `${tenantId}|${row.kid}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { kid: row.kid, dek: hit.dek };
    const dek = await this.wrap.unwrap(Buffer.from(row.wrapped_dek), tenantId, row.kek_ref);
    this.cache.set(key, { at: Date.now(), dek });
    return { kid: row.kid, dek };
  }

  /** Seals a value inside a tenant transaction (`app.tenant_id` = ctx.tenantId). */
  async encrypt(tx: Tx, ctx: FieldContext, plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
    const { kid, dek } = await this.dek(tx, ctx.tenantId, null);
    const sealed = encryptField(plaintext, dek, kid, ctx);
    const out = new Uint8Array(new ArrayBuffer(sealed.length));
    out.set(sealed);
    return out;
  }

  /** Opens a value; callers audit `pii.decrypted` (D-148). */
  async decrypt(tx: Tx, ctx: FieldContext, envelope: Uint8Array): Promise<string> {
    const buffer = Buffer.from(envelope);
    const { dek } = await this.dek(tx, ctx.tenantId, envelopeKid(buffer));
    return decryptField(buffer, dek, ctx);
  }
}
