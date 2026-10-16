import { REDIS, type RedisClient } from '@database/redis.module';
import { Inject, Injectable } from '@nestjs/common';

import {
  type BeginResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.store';

const PREFIX = 'getproperty:idem:';

@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  async begin(key: string, fingerprint: string, lockSeconds: number): Promise<BeginResult> {
    const record: IdempotencyRecord = { state: 'in_progress', fingerprint };
    const claimed = await this.redis.set(PREFIX + key, JSON.stringify(record), 'EX', lockSeconds, 'NX');
    if (claimed === 'OK') return { acquired: true };

    const raw = await this.redis.get(PREFIX + key);
    // Expired between SET and GET: try once more.
    if (raw === null) return this.begin(key, fingerprint, lockSeconds);
    return { acquired: false, existing: JSON.parse(raw) as IdempotencyRecord };
  }

  async complete(
    key: string,
    fingerprint: string,
    response: StoredResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const record: IdempotencyRecord = { state: 'completed', fingerprint, response };
    await this.redis.set(PREFIX + key, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(PREFIX + key);
  }
}
