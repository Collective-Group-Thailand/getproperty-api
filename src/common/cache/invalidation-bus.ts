import { Injectable, Logger } from '@nestjs/common';

type Handler = (key: string) => void;

/**
 * Cache invalidation for settings, tariffs and permissions (B1.3). Local caches expire on a short
 * TTL as well, so a missed message only delays a change by that TTL.
 * B1.1 ships the in-process bus; the Redis pub/sub fan-out between replicas is wired in B1.3 with
 * the settings module (it needs a dedicated subscriber connection, which `DATA_STORES_MODE=fake`
 * does not have).
 */
@Injectable()
export class InvalidationBus {
  private readonly logger = new Logger(InvalidationBus.name);
  private readonly handlers = new Map<string, Set<Handler>>();

  on(topic: string, handler: Handler): void {
    const set = this.handlers.get(topic) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(topic, set);
  }

  /** Invalidates locally at once. Never throws. */
  publish(topic: string, key: string): Promise<void> {
    try {
      for (const handler of this.handlers.get(topic) ?? []) handler(key);
    } catch (error) {
      this.logger.warn(`cache invalidation handler for ${topic} failed: ${(error as Error).message}`);
    }
    return Promise.resolve();
  }
}
