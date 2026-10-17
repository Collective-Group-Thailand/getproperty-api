import { randomUUID } from 'node:crypto';

import { PUBSUB, type PubSub } from '@database/redis.module';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

type Handler = (key: string) => void;

const CHANNEL = 'gp:invalidate';

/**
 * Cache invalidation for settings, tariffs, feature flags and memberships (B1.3). A publish invalidates the local
 * caches at once and fans out to every other process through Redis pub/sub (`PUBSUB`); the settings change itself
 * reaches the bus through the outbox (`setting.changed` subscriber in the worker), so a replica that missed the
 * direct message still converges. Local caches also expire on a short TTL as a last resort.
 */
@Injectable()
export class InvalidationBus implements OnModuleInit {
  private readonly logger = new Logger(InvalidationBus.name);
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly origin = randomUUID();

  constructor(@Inject(PUBSUB) private readonly pubsub: PubSub) {}

  async onModuleInit(): Promise<void> {
    await this.pubsub
      .subscribe(CHANNEL, (raw) => {
        try {
          const { topic, key, origin } = JSON.parse(raw) as { topic: string; key: string; origin: string };
          if (origin !== this.origin) this.runLocal(topic, key);
        } catch (error) {
          this.logger.warn(`bad invalidation message: ${(error as Error).message}`);
        }
      })
      .catch((error: unknown) =>
        this.logger.warn(`invalidation subscribe failed: ${(error as Error).message}`),
      );
  }

  on(topic: string, handler: Handler): void {
    const set = this.handlers.get(topic) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(topic, set);
  }

  /** Invalidates locally at once and tells the other processes. Never throws. */
  async publish(topic: string, key: string): Promise<void> {
    this.runLocal(topic, key);
    await this.pubsub
      .publish(CHANNEL, JSON.stringify({ topic, key, origin: this.origin }))
      .catch((error: unknown) =>
        this.logger.warn(`invalidation publish failed: ${(error as Error).message}`),
      );
  }

  private runLocal(topic: string, key: string): void {
    for (const handler of this.handlers.get(topic) ?? []) {
      try {
        handler(key);
      } catch (error) {
        this.logger.warn(`cache invalidation handler for ${topic} failed: ${(error as Error).message}`);
      }
    }
  }
}
