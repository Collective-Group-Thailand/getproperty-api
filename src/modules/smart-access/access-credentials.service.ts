import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type AccessCredential,
  type AccessHolderKind,
  type CredentialType,
  type Lock,
  type Prisma,
} from '@generated/prisma/client';
import { LOCK_VENDORS, type LockRef, type LockVendorRegistry } from '@integrations/locks/lock-vendor.port';
import { SECRETS_PROVIDER, type SecretsProvider } from '@integrations/secrets/secrets.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { adapterVendor, generatePin, LIVE_STATUSES } from './access-rules';

export const CREDENTIAL_SUBJECT = 'smart.access_credential';

export const CREDENTIAL_INCLUDE = {
  lock: { select: { id: true, name: true, scope: true, unitId: true } },
  unit: { select: { id: true, unitNo: true } },
} satisfies Prisma.AccessCredentialInclude;
export type CredentialRow = Prisma.AccessCredentialGetPayload<{ include: typeof CREDENTIAL_INCLUDE }>;

export interface IssueInput {
  lock: Lock;
  holderKind: AccessHolderKind;
  holderPartyId?: string | null;
  holderUserId?: string | null;
  holderName: string;
  leaseId?: string | null;
  workOrderId?: string | null;
  type?: CredentialType;
  validFrom: Date;
  validTo: Date | null;
  pin?: string;
}

const by = () => userIdOf(RequestContext.actor());

/**
 * Access credentials (B5.2, D-070, D-071): issued in a business transaction as `pending` with an encrypted PIN
 * (tenant key, D-148), then created at the vendor **after the commit** (`access.credential_issued` subscriber →
 * `sync`), so a vendor outage never rolls back a lease activation; a sweep retries what failed. Revocation is
 * immediate in the database and pushed to the vendor the same way. There is no code path from billing or
 * receivables to here (D-024, D-071, D-157): only lease end / termination, an owner action with a reason, the end of
 * a time box or of a work order end a credential.
 */
/** How long one vendor sync may hold a credential (D-223); a crashed worker's claim lapses after it. */
const SYNC_CLAIM_MS = 120_000;

@Injectable()
export class AccessCredentialsService extends TenantScopedRepository {
  private readonly logger = new Logger(AccessCredentialsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly keys: TenantDataKeys,
    private readonly flags: FeatureFlagsService,
    private readonly config: AppConfig,
    @Inject(LOCK_VENDORS) private readonly vendors: LockVendorRegistry,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------------- issue / revoke

  /** Issues a credential inside the caller's transaction; returns it with the clear PIN (shown once to the caller). */
  async issueIn(tx: Tx, input: IssueInput): Promise<AccessCredential & { pin: string }> {
    const id = uuidv7(this.clock.now().getTime());
    const pin = input.pin ?? generatePin();
    const lock = input.lock;
    const pinEnc = await this.keys.encrypt(
      tx,
      { tenantId: lock.tenantId, table: CREDENTIAL_SUBJECT, column: 'pin', rowId: id },
      pin,
    );
    const row = await tx.accessCredential.create({
      data: {
        id,
        tenantId: lock.tenantId,
        buildingId: lock.buildingId,
        unitId: lock.unitId,
        lockId: lock.id,
        deviceId: lock.deviceId,
        holderKind: input.holderKind,
        holderPartyId: input.holderPartyId ?? null,
        holderUserId: input.holderUserId ?? null,
        holderName: input.holderName.slice(0, 200),
        leaseId: input.leaseId ?? null,
        workOrderId: input.workOrderId ?? null,
        type: input.type ?? 'pin',
        vendor: lock.vendor,
        pinEnc,
        validFrom: input.validFrom,
        validTo: input.validTo,
        createdAt: this.clock.now(),
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'access.credential_issued',
      tenantId: lock.tenantId,
      buildingId: lock.buildingId,
      subjectType: CREDENTIAL_SUBJECT,
      subjectId: row.id,
      metadata: {
        lockId: lock.id,
        holderKind: row.holderKind,
        leaseId: row.leaseId,
        workOrderId: row.workOrderId,
        validTo: row.validTo?.toISOString() ?? null,
      },
    });
    await this.events.record(tx, {
      type: 'access.credential_issued',
      aggregateType: 'access_credential',
      aggregateId: row.id,
      tenantId: lock.tenantId,
      buildingId: lock.buildingId,
      payload: this.payload(row),
    });
    return { ...row, pin };
  }

  /** Revokes a live credential (reason kept; the vendor is told after the commit). */
  async revokeIn(
    tx: Tx,
    cred: AccessCredential,
    reason: string,
    origin: 'owner' | 'lease_end' | 'work_order' | 'system',
  ): Promise<AccessCredential> {
    if (!LIVE_STATUSES.includes(cred.status))
      throw new DomainException('access.invalid_state', { params: { status: cred.status } });
    const now = this.clock.now();
    const updated = await tx.accessCredential.update({
      where: { id: cred.id },
      data: {
        status: 'revoked',
        revokedAt: now,
        revokedBy: by(),
        revokeReason: reason.slice(0, 500),
        // nothing to tell the vendor when it never had the credential
        vendorSyncedAt: cred.vendorCredentialRef ? null : now,
        version: { increment: 1 },
        updatedBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'access.credential_revoked',
      tenantId: cred.tenantId,
      buildingId: cred.buildingId,
      subjectType: CREDENTIAL_SUBJECT,
      subjectId: cred.id,
      metadata: { reason, origin, holderKind: cred.holderKind },
    });
    await this.events.record(tx, {
      type: 'access.credential_revoked',
      aggregateType: 'access_credential',
      aggregateId: cred.id,
      tenantId: cred.tenantId,
      buildingId: cred.buildingId,
      payload: { ...this.payload(updated), reason, origin },
    });
    return updated;
  }

  /** Owner revocation (D-071): a reason is required and the resident is notified (`origin = owner`). */
  async revoke(ctx: TenantContext, id: string, reason: string): Promise<CredentialRow> {
    await this.db.tenant(ctx, async (tx) => {
      const cred = await this.load(tx, ctx, id);
      await this.revokeIn(tx, cred, reason, 'owner');
    });
    return this.get(ctx, id);
  }

  get(ctx: TenantContext, id: string): Promise<CredentialRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<CredentialRow> {
    return this.found(
      await tx.accessCredential.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        include: CREDENTIAL_INCLUDE,
      }),
    );
  }

  /** The clear PIN of a credential for its holder or the issuing owner (audited, D-148). */
  async reveal(tx: Tx, cred: AccessCredential, purpose: string): Promise<string | null> {
    if (!cred.pinEnc || !LIVE_STATUSES.includes(cred.status)) return null;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${cred.tenantId}, true)`;
    const pin = await this.keys.decrypt(
      tx,
      { tenantId: cred.tenantId, table: CREDENTIAL_SUBJECT, column: 'pin', rowId: cred.id },
      cred.pinEnc,
    );
    await this.audit.record(tx, {
      action: 'access.credential_revealed',
      tenantId: cred.tenantId,
      buildingId: cred.buildingId,
      subjectType: CREDENTIAL_SUBJECT,
      subjectId: cred.id,
      metadata: { purpose },
    });
    return pin;
  }

  private payload(row: AccessCredential) {
    return {
      credentialId: row.id,
      lockId: row.lockId,
      unitId: row.unitId,
      holderKind: row.holderKind,
      holderPartyId: row.holderPartyId,
      holderUserId: row.holderUserId,
      leaseId: row.leaseId,
      workOrderId: row.workOrderId,
      status: row.status,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo?.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------------------------------------ vendor sync

  /** The vendor address of a lock (null when the vendor has no adapter or is not enabled for the tenant). */
  async lockRef(lock: Lock): Promise<{ ref: LockRef } | { error: string }> {
    const vendor = adapterVendor(lock.vendor);
    if (!vendor) return { error: `no adapter for vendor ${lock.vendor}` };
    if (
      this.vendors.mode === 'real' &&
      !(await this.flags.isEnabled(`locks.vendor.${vendor}`, lock.tenantId))
    )
      return { error: `locks.vendor.${vendor} is not enabled for this tenant` };
    let credentials: Record<string, string> = {};
    try {
      credentials = await this.secrets.getJsonSecret(
        `${this.config.get('LOCKS_SECRETS_PREFIX')}/${vendor}/${lock.tenantId}`,
      );
    } catch (error) {
      if (this.vendors.mode === 'real') return { error: `no ${vendor} credentials for the tenant` };
      void error;
    }
    return { ref: { vendor, vendorLockId: lock.vendorLockId, credentials } };
  }

  /**
   * Pushes one credential to its vendor: creates a pending one (→ active, or failed with the reason), deletes a
   * revoked / expired one the vendor still has. Idempotent; called after the commit and by the sweep.
   */
  async sync(credentialId: string): Promise<void> {
    // Review #8 (D-223): one owner per credential — the after-commit sync, the sweep and other replicas skip a row
    // whose vendor call is in progress, so the vendor never gets two codes for one credential.
    const now0 = this.clock.now();
    const claimed = await this.db.platform(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        UPDATE smart.access_credential SET sync_claimed_until = ${new Date(now0.getTime() + SYNC_CLAIM_MS)}
         WHERE id = ${credentialId}::uuid AND (sync_claimed_until IS NULL OR sync_claimed_until < ${now0})
        RETURNING id`,
    );
    if (!claimed.length) return;
    let again: boolean;
    try {
      again = await this.syncClaimed(credentialId);
    } finally {
      await this.db.platform((tx) =>
        tx.accessCredential.update({ where: { id: credentialId }, data: { syncClaimedUntil: null } }),
      );
    }
    // revoked while the vendor created it: the vendor copy is removed now, under a new claim
    if (again) await this.sync(credentialId);
  }

  /** The vendor call of a claimed credential; true when another pass is needed (revoked during the creation). */
  private async syncClaimed(credentialId: string): Promise<boolean> {
    return RequestContext.run({ actor: systemActor('access-sync') }, async () => {
      const cred = await this.db.platform((tx) =>
        tx.accessCredential.findUnique({ where: { id: credentialId }, include: { lock: true } }),
      );
      if (!cred) return false;
      const now = this.clock.now();
      const needsCreate = cred.status === 'pending';
      const needsRevoke =
        !LIVE_STATUSES.includes(cred.status) && !!cred.vendorCredentialRef && !cred.vendorSyncedAt;
      if (!needsCreate && !needsRevoke) return false;
      const resolved = await this.lockRef(cred.lock);
      if ('error' in resolved) {
        await this.db.platform((tx) =>
          tx.accessCredential.update({
            where: { id: cred.id },
            data: needsCreate
              ? { status: 'failed', vendorError: resolved.error }
              : { vendorError: resolved.error },
          }),
        );
        return false;
      }
      const adapter = this.vendors.adapter(resolved.ref.vendor);
      try {
        if (needsCreate) {
          const pin = await this.db.platform(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${cred.tenantId}, true)`;
            return this.keys.decrypt(
              tx,
              { tenantId: cred.tenantId, table: CREDENTIAL_SUBJECT, column: 'pin', rowId: cred.id },
              cred.pinEnc!,
            );
          });
          const created = await adapter.createCredential(resolved.ref, {
            type: cred.type === 'app' || cred.type === 'card' ? cred.type : 'pin',
            holderName: cred.holderName,
            pin,
            validFrom: cred.validFrom,
            validTo: cred.validTo,
          });
          await this.db.platform(async (tx) => {
            // revoked while the vendor call ran: the vendor copy is removed by the next sync
            const marked = await tx.accessCredential.updateMany({
              where: { id: cred.id, status: 'pending' },
              data: {
                status: 'active',
                vendorCredentialRef: created.vendorCredentialRef,
                vendorSyncedAt: now,
                vendorError: null,
              },
            });
            if (!marked.count)
              await tx.accessCredential.update({
                where: { id: cred.id },
                data: { vendorCredentialRef: created.vendorCredentialRef, vendorSyncedAt: null },
              });
          });
          return !(await this.db.platform((tx) =>
            tx.accessCredential.count({ where: { id: cred.id, status: 'active' } }),
          ));
        } else {
          await adapter.revokeCredential(
            resolved.ref,
            cred.vendorCredentialRef!,
            cred.type === 'pin' ? 'pin' : 'app',
          );
          await this.db.platform((tx) =>
            tx.accessCredential.update({
              where: { id: cred.id },
              data: { vendorSyncedAt: now, vendorError: null },
            }),
          );
        }
      } catch (error) {
        const message = (error as Error).message.slice(0, 500);
        this.logger.warn({ event: 'access_sync_failed', credentialId: cred.id, error: message });
        await this.db.platform((tx) =>
          tx.accessCredential.update({ where: { id: cred.id }, data: { vendorError: message } }),
        );
      }
      return false;
    });
  }

  /**
   * Worker job: time boxes that ended → `expired` (vendors expire their own codes; ours mirror it), then retries of
   * pending creations and of revocations the vendor has not confirmed.
   */
  async sweep(): Promise<{ expired: number; retried: number }> {
    const now = this.clock.now();
    const expired = await this.db.platform(async (tx) => {
      const due = await tx.accessCredential.findMany({
        where: { status: { in: [...LIVE_STATUSES] }, validTo: { lte: now } },
        select: { id: true, vendorCredentialRef: true },
        take: 500,
      });
      for (const c of due)
        await tx.accessCredential.update({
          where: { id: c.id },
          data: { status: 'expired', vendorSyncedAt: c.vendorCredentialRef ? null : now },
        });
      return due.length;
    });
    const retry = await this.db.platform((tx) =>
      tx.accessCredential.findMany({
        where: {
          OR: [
            { status: 'pending' },
            {
              status: { in: ['revoked', 'expired'] },
              vendorCredentialRef: { not: null },
              vendorSyncedAt: null,
            },
          ],
        },
        select: { id: true },
        take: 200,
        orderBy: { updatedAt: 'asc' },
      }),
    );
    for (const c of retry) await this.sync(c.id);
    return { expired, retried: retry.length };
  }
}
