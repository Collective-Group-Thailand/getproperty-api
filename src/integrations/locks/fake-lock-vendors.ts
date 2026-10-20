import { randomUUID } from 'node:crypto';

import {
  type CreatedCredential,
  type CredentialInput,
  type LockRef,
  type LockStatus,
  type LockVendorAdapter,
  LockVendorError,
  type LockVendorKey,
  type LockVendorRegistry,
  type VendorUnlockEvent,
} from './lock-vendor.port';

interface FakeCredential {
  ref: string;
  lockId: string;
  type: CredentialInput['type'];
  holderName: string;
  pin: string;
  validFrom: Date;
  validTo: Date | null;
  revoked: boolean;
}

/** One in-memory vendor cloud: credentials per lock, an unlock log, battery levels; failures on demand. */
export class FakeLockVendor implements LockVendorAdapter {
  readonly mode = 'fake' as const;
  readonly credentials = new Map<string, FakeCredential>();
  private readonly logs = new Map<string, VendorUnlockEvent[]>();
  private readonly batteries = new Map<string, number>();
  /** Lock ids whose next calls fail (tests of retries). */
  readonly failing = new Set<string>();

  constructor(readonly vendor: LockVendorKey) {}

  private check(lock: LockRef): void {
    if (this.failing.has(lock.vendorLockId)) throw new LockVendorError(this.vendor, 'lock unreachable');
  }

  /** Milliseconds each createCredential takes (tests of concurrent syncs; a real vendor takes seconds). */
  latencyMs = 0;

  async createCredential(lock: LockRef, input: CredentialInput): Promise<CreatedCredential> {
    this.check(lock);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const ref = `${this.vendor}-${randomUUID()}`;
    this.credentials.set(ref, {
      ref,
      lockId: lock.vendorLockId,
      type: input.type,
      holderName: input.holderName,
      pin: input.pin,
      validFrom: input.validFrom,
      validTo: input.validTo,
      revoked: false,
    });
    return { vendorCredentialRef: ref };
  }

  revokeCredential(lock: LockRef, ref: string): Promise<void> {
    this.check(lock);
    const c = this.credentials.get(ref);
    if (c) c.revoked = true;
    return Promise.resolve();
  }

  unlockLog(lock: LockRef, since: Date, until: Date): Promise<VendorUnlockEvent[]> {
    this.check(lock);
    return Promise.resolve(
      (this.logs.get(lock.vendorLockId) ?? []).filter(
        (e) => e.at.getTime() > since.getTime() && e.at.getTime() <= until.getTime(),
      ),
    );
  }

  status(lock: LockRef): Promise<LockStatus> {
    this.check(lock);
    return Promise.resolve({ batteryPct: this.batteries.get(lock.vendorLockId) ?? 100, online: true });
  }

  // ------------------------------------------------------------------------------------------- test helpers

  /** Credentials of a lock that would open it now (not revoked, inside their window). */
  active(vendorLockId: string, at: Date): FakeCredential[] {
    return [...this.credentials.values()].filter(
      (c) =>
        c.lockId === vendorLockId &&
        !c.revoked &&
        c.validFrom.getTime() <= at.getTime() &&
        (!c.validTo || c.validTo.getTime() > at.getTime()),
    );
  }

  /** Simulates someone at the door: a PIN entry, logged as the vendor would. */
  enterPin(vendorLockId: string, pin: string, at: Date): VendorUnlockEvent {
    const match = this.active(vendorLockId, at).find((c) => c.pin === pin);
    const event: VendorUnlockEvent = {
      vendorEventId: `ev-${randomUUID()}`,
      at,
      result: match ? 'success' : 'denied',
      source: 'pin',
      vendorCredentialRef: match?.ref ?? null,
    };
    this.logs.set(vendorLockId, [...(this.logs.get(vendorLockId) ?? []), event]);
    return event;
  }

  setBattery(vendorLockId: string, pct: number): void {
    this.batteries.set(vendorLockId, pct);
  }

  reset(): void {
    this.credentials.clear();
    this.logs.clear();
    this.batteries.clear();
    this.failing.clear();
    this.latencyMs = 0;
  }
}

/** Fake vendor clouds for dev and tests (INTEGRATIONS_MODE=fake). */
export class FakeLockVendors implements LockVendorRegistry {
  readonly mode = 'fake' as const;
  private readonly vendors = new Map<LockVendorKey, FakeLockVendor>();

  adapter(vendor: LockVendorKey): FakeLockVendor {
    const existing = this.vendors.get(vendor);
    if (existing) return existing;
    const created = new FakeLockVendor(vendor);
    this.vendors.set(vendor, created);
    return created;
  }
}
