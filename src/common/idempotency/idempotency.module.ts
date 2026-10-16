import { AppConfig } from '@config/app-config';
import { PrismaService } from '@database/prisma.service';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from './idempotency.store';
import { InMemoryIdempotencyStore } from './in-memory-idempotency.store';
import { PrismaIdempotencyStore } from './prisma-idempotency.store';
import { RedisIdempotencyStore } from './redis-idempotency.store';
import { TieredIdempotencyStore } from './tiered-idempotency.store';

/**
 * `DATA_STORES_MODE=fake`: one in-memory store. `real`: Redis as the fast path in front of the durable
 * store `platform.idempotency_key` (PrismaIdempotencyStore, B1.2) — the database decides every claim.
 */
@Global()
@Module({
  providers: [
    RedisIdempotencyStore,
    {
      provide: IDEMPOTENCY_STORE,
      inject: [AppConfig, RedisIdempotencyStore, PrismaService],
      useFactory: (
        config: AppConfig,
        fast: RedisIdempotencyStore,
        prisma: PrismaService,
      ): IdempotencyStore =>
        config.useFakeDataStores
          ? new InMemoryIdempotencyStore()
          : new TieredIdempotencyStore(fast, new PrismaIdempotencyStore(prisma)),
    },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IDEMPOTENCY_STORE],
})
export class IdempotencyModule {}
