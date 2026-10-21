import { createHmac } from 'node:crypto';

import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type ProviderCredential, type ProviderCredentialKind } from '@generated/prisma/client';
import { SECRETS_PROVIDER, type SecretsProvider } from '@integrations/secrets/secrets.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { merchantRefHash } from '../tenancy/bank-account.service';
import { TenantDataKeys } from '../tenancy/data-keys.service';

/** Providers per kind (the adapters that exist; O-001, D-070, D-215). */
export const CREDENTIAL_PROVIDERS: Record<ProviderCredentialKind, readonly string[]> = {
  payment: ['kbank', 'scb', 'opn'],
  lock: ['ttlock', 'tuya'],
  etax: ['inet'],
};

/** Which merchant, lock-vendor account or e-Tax account (tenantId null = the platform's own merchant, payments only). */
export interface CredentialRef {
  tenantId: string | null;
  kind: ProviderCredentialKind;
  provider: string;
  /** payments: the merchant reference at the provider. */
  merchantRef?: string;
}

export type CredentialValues = Record<string, string>;

const TABLE = 'platform.provider_credential';
const CACHE_MS = 5 * 60_000;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Validates the write-only credential document: 1–20 string values, plain key names, ≤ 4 KB each. */
export function credentialProblems(values: unknown): string[] {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return ['values must be an object'];
  const entries = Object.entries(values as Record<string, unknown>);
  const problems: string[] = [];
  if (entries.length < 1 || entries.length > 20) problems.push('values must have 1–20 keys');
  for (const [k, v] of entries) {
    if (!KEY_NAME.test(k)) problems.push(`invalid key name ${k.slice(0, 64)}`);
    if (typeof v !== 'string' || v.length < 1 || v.length > 4096)
      problems.push(`${k.slice(0, 64)}: a non-empty string of at most 4096 characters`);
  }
  return problems;
}

/**
 * Per-merchant provider credentials in PostgreSQL (O-013 resolved → D-240; replaces the Secrets Manager sub-paths
 * `collective/<env>/getproperty/{payments,locks,etax}/…` so the product keeps one secret, D-233). A credential is a
 * small JSON document (API key, secret, webhook secret, account…), sealed with the tenant's data key (asset-core field
 * envelope, AAD = tenant | table | `secret` | row id) — the platform's own merchant with the platform field key —, never
 * returned by any API, decrypted only by the adapters that call the provider, and every decrypt is audited
 * (`provider_credential.decrypted`; the plaintext is cached in memory for 5 minutes, so one row per process and
 * credential per 5 minutes). Writes replace the live row (the old one is revoked), audited + outbox event, without the
 * values. During the migration `PROVIDER_CREDENTIALS_LEGACY_SECRETS=true` falls back to the old secret paths for a
 * credential that has no row yet; `importLegacy()` (`node dist/scripts/provider-credentials-import.js`) copies them.
 */
@Injectable()
export class ProviderCredentialsService {
  private readonly logger = new Logger(ProviderCredentialsService.name);
  private readonly cache = new Map<string, { at: number; values: CredentialValues }>();

  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly field: FieldEncryption,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private refHash(ref: CredentialRef): Uint8Array<ArrayBuffer> | null {
    if (ref.kind !== 'payment') return null;
    if (!ref.merchantRef?.trim())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'merchantRef', code: 'required', message: 'payments need the merchant reference' }],
      });
    return merchantRefHash(this.hasher, ref.provider, ref.merchantRef);
  }

  private validateRef(ref: CredentialRef): void {
    if (!CREDENTIAL_PROVIDERS[ref.kind]?.includes(ref.provider))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'provider', code: 'enum', message: `unknown ${ref.kind} provider ${ref.provider}` }],
      });
    if (ref.tenantId === null && ref.kind !== 'payment')
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'tenantId', code: 'required', message: 'only payment credentials exist for the platform' },
        ],
      });
  }

  private live(tx: Tx, ref: CredentialRef) {
    const hash = this.refHash(ref);
    return tx.providerCredential.findFirst({
      where: {
        tenantId: ref.tenantId,
        kind: ref.kind,
        provider: ref.provider,
        accountRefHash: hash ? { equals: hash } : null,
        revokedAt: null,
      },
    });
  }

  private aad(id: string): string {
    return `platform|${TABLE}|secret|${id}`;
  }

  private async seal(
    tx: Tx,
    tenantId: string | null,
    id: string,
    json: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (tenantId === null) return this.field.encrypt(json, this.aad(id));
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return this.keys.encrypt(tx, { tenantId, table: TABLE, column: 'secret', rowId: id }, json);
  }

  private async open(tx: Tx, row: ProviderCredential): Promise<CredentialValues> {
    if (row.tenantId === null)
      return JSON.parse(this.field.decrypt(row.secretEnc, this.aad(row.id))) as CredentialValues;
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${row.tenantId}, true)`;
    return JSON.parse(
      await this.keys.decrypt(
        tx,
        { tenantId: row.tenantId, table: TABLE, column: 'secret', rowId: row.id },
        row.secretEnc,
      ),
    ) as CredentialValues;
  }

  private fingerprint(json: string): string {
    return createHmac('sha256', 'provider-credential-fingerprint').update(json).digest('hex').slice(0, 12);
  }

  /**
   * The credentials an adapter needs, or null when none exist. `purpose` lands in the audit row (e.g. `qr.issue`,
   * `lock.sync`, `etax.submit`).
   */
  async get(ref: CredentialRef, purpose: string): Promise<CredentialValues | null> {
    if (!CREDENTIAL_PROVIDERS[ref.kind]?.includes(ref.provider)) return null;
    const row = await this.db.platform((tx) => this.live(tx, ref));
    if (row) {
      const hit = this.cache.get(row.id);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.values;
      const values = await this.db.platform(async (tx) => {
        const opened = await this.open(tx, row);
        await this.audit.record(tx, {
          action: 'provider_credential.decrypted',
          tenantId: row.tenantId,
          subjectType: TABLE,
          subjectId: row.id,
          metadata: { kind: row.kind, provider: row.provider, purpose },
        });
        return opened;
      });
      this.cache.set(row.id, { at: Date.now(), values });
      return values;
    }
    if (!this.config.get('PROVIDER_CREDENTIALS_LEGACY_SECRETS')) return null;
    return this.legacy(ref);
  }

  /** The former Secrets Manager path of a credential (D-230 compose prefixes; migration only). */
  legacyPath(ref: CredentialRef): string {
    switch (ref.kind) {
      case 'payment':
        return ref.tenantId === null
          ? `${this.config.get('PAYMENTS_SECRETS_PREFIX')}/platform/${ref.provider}/${ref.merchantRef}`
          : `${this.config.get('PAYMENTS_SECRETS_PREFIX')}/${ref.provider}/${ref.merchantRef}`;
      case 'lock':
        return `${this.config.get('LOCKS_SECRETS_PREFIX')}/${ref.provider}/${ref.tenantId}`;
      case 'etax':
        return `${this.config.get('ETAX_SECRETS_PREFIX')}/${ref.provider}/${ref.tenantId}`;
    }
  }

  private async legacy(ref: CredentialRef): Promise<CredentialValues | null> {
    try {
      const values = await this.secrets.getJsonSecret(this.legacyPath(ref));
      return credentialProblems(values).length === 0 ? values : null;
    } catch {
      return null;
    }
  }

  /** Platform admin: create or replace the live credential (write-only values). */
  async set(
    ref: CredentialRef,
    values: CredentialValues,
    reason: string,
    source: 'admin' | 'import' = 'admin',
  ): Promise<ProviderCredential> {
    this.validateRef(ref);
    const problems = credentialProblems(values);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((message) => ({ path: 'values', code: 'credential', message })),
      });
    const json = JSON.stringify(
      Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
    );
    const actorId = userIdOf(RequestContext.actor());
    const now = this.clock.now();
    const row = await this.db.platform(async (tx) => {
      if (ref.tenantId) {
        const tenant = await tx.tenant.findUnique({ where: { id: ref.tenantId }, select: { id: true } });
        if (!tenant) throw new DomainException('http.not_found');
      }
      const previous = await this.live(tx, ref);
      if (previous)
        await tx.providerCredential.update({
          where: { id: previous.id },
          data: { revokedAt: now, revokedBy: actorId, revokeReason: `replaced: ${reason}`.slice(0, 500) },
        });
      const id = uuidv7(now.getTime());
      const created = await tx.providerCredential.create({
        data: {
          id,
          tenantId: ref.tenantId,
          kind: ref.kind,
          provider: ref.provider,
          accountRefHash: this.refHash(ref),
          accountRefHint: ref.merchantRef ? ref.merchantRef.trim().slice(-4) : null,
          secretEnc: await this.seal(tx, ref.tenantId, id, json),
          keyNames: Object.keys(values).sort(),
          fingerprint: this.fingerprint(json),
          source,
          createdAt: now,
          createdBy: actorId,
        },
      });
      await this.audit.record(tx, {
        action: source === 'import' ? 'provider_credential.imported' : 'provider_credential.set',
        tenantId: ref.tenantId,
        subjectType: TABLE,
        subjectId: id,
        metadata: {
          kind: ref.kind,
          provider: ref.provider,
          keyNames: created.keyNames,
          fingerprint: created.fingerprint,
          replaced: previous?.id ?? null,
          reason: reason.slice(0, 500),
        },
      });
      await this.events.record(tx, {
        type: 'provider_credential.changed',
        aggregateType: 'provider_credential',
        aggregateId: id,
        tenantId: ref.tenantId,
        payload: {
          credentialId: id,
          kind: ref.kind,
          provider: ref.provider,
          change: 'set',
          replaced: previous?.id ?? null,
        },
      });
      return created;
    });
    this.cache.clear();
    return row;
  }

  /** Platform admin: revoke a live credential (the adapter then has none — e.g. a leaked key). */
  async revoke(id: string, reason: string): Promise<ProviderCredential> {
    const actorId = userIdOf(RequestContext.actor());
    const now = this.clock.now();
    const row = await this.db.platform(async (tx) => {
      const found = await tx.providerCredential.findUnique({ where: { id } });
      if (!found) throw new DomainException('http.not_found');
      if (found.revokedAt)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'credentialId', code: 'state', message: 'the credential is already revoked' }],
        });
      const updated = await tx.providerCredential.update({
        where: { id },
        data: { revokedAt: now, revokedBy: actorId, revokeReason: reason.slice(0, 500) },
      });
      await this.audit.record(tx, {
        action: 'provider_credential.revoked',
        tenantId: found.tenantId,
        subjectType: TABLE,
        subjectId: id,
        metadata: { kind: found.kind, provider: found.provider, reason: reason.slice(0, 500) },
      });
      await this.events.record(tx, {
        type: 'provider_credential.changed',
        aggregateType: 'provider_credential',
        aggregateId: id,
        tenantId: found.tenantId,
        payload: {
          credentialId: id,
          kind: found.kind,
          provider: found.provider,
          change: 'revoked',
          replaced: null,
        },
      });
      return updated;
    });
    this.cache.delete(id);
    return row;
  }

  /** Admin list: metadata only, never values. */
  list(filter: { tenantId?: string | null; kind?: ProviderCredentialKind; includeRevoked?: boolean }) {
    return this.db.platform((tx) =>
      tx.providerCredential.findMany({
        where: {
          ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 500,
      }),
    );
  }

  /**
   * Migration (D-240): copies every credential the legacy Secrets Manager paths still hold into the database — tenant
   * merchants of the bank accounts with a provider, the platform merchant, lock vendors of tenants with locks,
   * e-Tax providers of tenants with submissions. Idempotent: a credential with a live row is skipped.
   */
  async importLegacy(): Promise<{ imported: number; skipped: number; missing: string[] }> {
    return RequestContext.run({ actor: systemActor('provider-credentials-import') }, async () => {
      const refs: CredentialRef[] = await this.db.platform(async (tx) => {
        const out: CredentialRef[] = [];
        const accounts = await tx.tenantBankAccount.findMany({
          where: {
            paymentProvider: { in: ['kbank', 'scb', 'opn'] },
            providerMerchantRefEnc: { not: null },
            state: { in: ['active', 'replaced'] },
          },
        });
        for (const a of accounts) {
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          const merchantRef = await this.keys.decrypt(
            tx,
            {
              tenantId: a.tenantId,
              table: 'platform.tenant_bank_account',
              column: 'provider_merchant_ref',
              rowId: a.id,
            },
            a.providerMerchantRefEnc!,
          );
          out.push({ tenantId: a.tenantId, kind: 'payment', provider: a.paymentProvider, merchantRef });
        }
        const locks = await tx.lock.findMany({
          select: { tenantId: true, vendor: true },
          distinct: ['tenantId', 'vendor'],
        });
        for (const l of locks)
          if (CREDENTIAL_PROVIDERS.lock.includes(l.vendor))
            out.push({ tenantId: l.tenantId, kind: 'lock', provider: l.vendor });
        const etax = await tx.etaxSubmission.findMany({
          select: { tenantId: true, provider: true },
          distinct: ['tenantId', 'provider'],
        });
        for (const e of etax)
          if (CREDENTIAL_PROVIDERS.etax.includes(e.provider))
            out.push({ tenantId: e.tenantId, kind: 'etax', provider: e.provider });
        return out;
      });
      const platform = await this.platformMerchantRef();
      if (platform) refs.push(platform);
      let imported = 0;
      let skipped = 0;
      const missing: string[] = [];
      for (const ref of refs) {
        if (await this.db.platform((tx) => this.live(tx, ref))) {
          skipped += 1;
          continue;
        }
        const values = await this.legacy(ref);
        if (!values) {
          missing.push(`${ref.kind}/${ref.provider}/${ref.tenantId ?? 'platform'}`);
          continue;
        }
        await this.set(ref, values, 'imported from Secrets Manager (D-240)', 'import');
        imported += 1;
      }
      this.logger.log({ event: 'provider_credentials_imported', imported, skipped, missing: missing.length });
      return { imported, skipped, missing };
    });
  }

  private async platformMerchantRef(): Promise<CredentialRef | null> {
    const row = await this.db.platform((tx) =>
      tx.settingVersion.findFirst({
        where: { setting: { key: 'platform.payments.merchant' }, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
    const v = row?.value as { provider?: string; merchantRef?: string } | undefined;
    return v?.provider && v.merchantRef && CREDENTIAL_PROVIDERS.payment.includes(v.provider)
      ? { tenantId: null, kind: 'payment', provider: v.provider, merchantRef: v.merchantRef }
      : null;
  }
}
