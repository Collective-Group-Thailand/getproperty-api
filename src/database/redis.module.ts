import { EventEmitter } from 'node:events';

import { AppConfig } from '@config/app-config';
import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

export const REDIS = Symbol('REDIS');
/** Cross-process fan-out (cache invalidation, realtime): Redis pub/sub, or an in-process emitter in fake mode. */
export const PUBSUB = Symbol('PUBSUB');

export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  close(): Promise<void>;
}

/** In-process pub/sub (one process sees its own messages, like Redis delivers to the publisher's subscriber too). */
export class FakePubSub implements PubSub {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
    return Promise.resolve();
  }

  subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.emitter.on(channel, handler);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.emitter.removeAllListeners();
    return Promise.resolve();
  }
}

/** Redis pub/sub: a dedicated subscriber connection (a subscribed ioredis client cannot run other commands). */
export class RedisPubSub implements PubSub {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<(message: string) => void>>();

  constructor(url: string) {
    this.pub = new Redis(url, redisOptions());
    this.sub = new Redis(url, redisOptions({ maxRetriesPerRequest: null, enableAutoPipelining: false }));
    for (const c of [this.pub, this.sub])
      c.on('error', (e: Error) => redisLogger.error(`pubsub: ${e.message}`));
    this.sub.on('message', (channel: string, message: string) => {
      for (const h of this.handlers.get(channel) ?? []) h(message);
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
/** BullMQ's shared connection (blocking commands need `maxRetriesPerRequest: null`); `null` in fake mode. */
export const BULLMQ_REDIS = Symbol('BULLMQ_REDIS');

/**
 * The subset of ioredis the application uses, so `DATA_STORES_MODE=fake` can bind an in-memory
 * client under the same token. New commands are added here when a module needs them.
 */
export interface RedisClient {
  readonly status: string;
  readonly storeMode: 'fake' | 'real';
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx?: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

type ClientOptions = Omit<RedisOptions, 'replyMapping'> & { replyMapping?: 'legacy' };

/** Options shared by every Redis client. `lazyConnect` lets a process boot before Redis answers. */
export function redisOptions(overrides: ClientOptions = {}): ClientOptions {
  return {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    ...overrides,
  };
}

const redisLogger = new Logger('Redis');

/** ioredis tagged as the real store; connection errors are logged (ioredis would print them unhandled). */
export function realRedis(url: string, options: ClientOptions): RedisClient {
  const client = new Redis(url, options);
  client.on('error', (error: Error) => redisLogger.error(`redis error: ${error.message}`));
  return Object.assign(client, { storeMode: 'real' as const });
}

/** In-memory Redis for tests, `pnpm dev` without compose and the contract build. TTLs are honoured. */
export class FakeRedis implements RedisClient {
  readonly storeMode = 'fake' as const;
  status = 'ready';
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  ping(): Promise<string> {
    return Promise.resolve('PONG');
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  async set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX'): Promise<'OK' | null> {
    if (nx === 'NX' && (await this.get(key)) !== null) return null;
    this.store.set(key, { value, expiresAt: this.now() + seconds * 1000 });
    return 'OK';
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  quit(): Promise<unknown> {
    this.status = 'end';
    return Promise.resolve('OK');
  }

  disconnect(): void {
    this.status = 'end';
  }
}

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(BULLMQ_REDIS) private readonly bullmq: RedisClient | null,
    @Inject(PUBSUB) private readonly pubsub: PubSub,
  ) {}

  /** Runs after BullMQ workers closed (`onModuleDestroy`), so no job is cut off. */
  async onApplicationShutdown(): Promise<void> {
    await this.pubsub.close();
    await Promise.all(
      [this.redis, this.bullmq].map((client) => (client ? close(client) : Promise.resolve())),
    );
  }
}

async function close(client: RedisClient): Promise<void> {
  if (client.status === 'ready') await client.quit().catch(() => client.disconnect());
  else client.disconnect();
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): RedisClient =>
        config.useFakeRedis ? new FakeRedis() : realRedis(config.get('REDIS_URL')!, redisOptions()),
    },
    {
      provide: BULLMQ_REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): RedisClient | null =>
        config.useFakeRedis
          ? null
          : realRedis(
              config.get('REDIS_URL')!,
              redisOptions({ maxRetriesPerRequest: null, enableAutoPipelining: false }),
            ),
    },
    {
      provide: PUBSUB,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PubSub =>
        config.useFakeRedis ? new FakePubSub() : new RedisPubSub(config.get('REDIS_URL')!),
    },
    RedisShutdown,
  ],
  exports: [REDIS, BULLMQ_REDIS, PUBSUB],
})
export class RedisModule {}
