import { AppConfig } from '@config/app-config';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from './idempotency.store';
import { InMemoryIdempotencyStore } from './in-memory-idempotency.store';
import { RedisIdempotencyStore } from './redis-idempotency.store';
import { TieredIdempotencyStore } from './tiered-idempotency.store';

/**
 * `DATA_STORES_MODE=fake`: one in-memory store. `real`: Redis as the fast path in front of the
 * durable store — the in-memory store stands in for `idempotency_keys` until the schema lands (B1.2),
 * so until then replays survive only within one process.
 */
@Global()
@Module({
  providers: [
    RedisIdempotencyStore,
    {
      provide: IDEMPOTENCY_STORE,
      inject: [AppConfig, RedisIdempotencyStore],
      useFactory: (config: AppConfig, fast: RedisIdempotencyStore): IdempotencyStore =>
        config.useFakeDataStores
          ? new InMemoryIdempotencyStore()
          : new TieredIdempotencyStore(fast, new InMemoryIdempotencyStore()),
    },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IDEMPOTENCY_STORE],
})
export class IdempotencyModule {}
