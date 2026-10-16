import { Logger } from '@nestjs/common';

import { type BeginResult, type IdempotencyStore, type StoredResponse } from './idempotency.store';

/**
 * Redis in front, `idempotency_keys` behind. The durable store is the source of truth: it decides
 * every claim the fast path lets through, and a completed response is written there first. When Redis
 * fails, requests carry on against the database alone.
 */
export class TieredIdempotencyStore implements IdempotencyStore {
  private readonly logger = new Logger(TieredIdempotencyStore.name);

  constructor(
    private readonly fast: IdempotencyStore,
    private readonly durable: IdempotencyStore,
  ) {}

  async begin(key: string, fingerprint: string, lockSeconds: number): Promise<BeginResult> {
    const fast = await this.tryFast(() => this.fast.begin(key, fingerprint, lockSeconds));
    if (fast && !fast.acquired) return fast;

    const durable = await this.durable.begin(key, fingerprint, lockSeconds);
    // Redis lost the record (eviction, restart) while the database still has it: the database wins.
    if (!durable.acquired && fast?.acquired) await this.tryFast(() => this.fast.release(key));
    return durable;
  }

  async complete(
    key: string,
    fingerprint: string,
    response: StoredResponse,
    ttlSeconds: number,
  ): Promise<void> {
    await this.durable.complete(key, fingerprint, response, ttlSeconds);
    await this.tryFast(() => this.fast.complete(key, fingerprint, response, ttlSeconds));
  }

  async release(key: string): Promise<void> {
    await this.durable.release(key);
    await this.tryFast(() => this.fast.release(key));
  }

  private async tryFast<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      this.logger.warn(
        `idempotency fast path unavailable, using the database only: ${(error as Error).message}`,
      );
      return undefined;
    }
  }
}
