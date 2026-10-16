import {
  type BeginResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.store';

/** Single-process store: unit tests, `DATA_STORES_MODE=fake`, and the durable tier until `idempotency_keys` lands (B1.2). */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(key: string, fingerprint: string, lockSeconds: number): Promise<BeginResult> {
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > this.now()) {
      return Promise.resolve({ acquired: false, existing: existing.record });
    }
    this.records.set(key, {
      record: { state: 'in_progress', fingerprint },
      expiresAt: this.now() + lockSeconds * 1000,
    });
    return Promise.resolve({ acquired: true });
  }

  complete(key: string, fingerprint: string, response: StoredResponse, ttlSeconds: number): Promise<void> {
    this.records.set(key, {
      record: { state: 'completed', fingerprint, response },
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}
