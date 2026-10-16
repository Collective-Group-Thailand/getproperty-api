import { AppConfig } from '@config/app-config';
import { BULLMQ_REDIS, type RedisClient } from '@database/redis.module';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

/**
 * Fails fast if Redis is unreachable (real mode), then keeps the process alive until SIGTERM/SIGINT.
 * BullMQ queues, the outbox relay and repeatable jobs register here from B1.3 on.
 */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private keepAlive?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    @Inject(BULLMQ_REDIS) private readonly bullmq: RedisClient | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.useFakeDataStores || !this.bullmq) {
      this.logger.warn('DATA_STORES_MODE=fake: no Redis, no queues — the worker idles');
    } else {
      await this.bullmq.ping();
      this.logger.log('connected to Redis (BullMQ connection ready; no queues registered yet — B1.3)');
    }
    this.keepAlive = setInterval(() => undefined, 60_000);
    this.logger.log('worker ready');
  }

  onApplicationShutdown(signal?: string): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.logger.log(`worker stopped${signal ? ` (${signal})` : ''}`);
  }
}
