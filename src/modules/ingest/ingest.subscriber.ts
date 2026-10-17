import { AppConfig } from '@config/app-config';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { IngestPipeline } from '@modules/smart-ingest/ingest-pipeline.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { INGEST_TOPIC_KINDS, IngestService } from './ingest.service';

/** Gateways processed in parallel by one ingest replica (each gateway's messages stay ordered). */
export const MAX_PARALLEL = 4;

/**
 * The filters of one ingest replica: `$share/<group>/gp/v1/+/<kind>` (EMQX shared subscription), or the plain
 * `gp/v1/+/<kind>` when `shared` is off (a single replica, or a broker without shared subscriptions, e.g. tests).
 */
export function ingestFilters(group: string, shared = true): string[] {
  return INGEST_TOPIC_KINDS.map((kind) => (shared ? `$share/${group}/gp/v1/+/${kind}` : `gp/v1/+/${kind}`));
}

/**
 * Subscribes the ingest process to every gateway topic through an EMQX shared subscription, so
 * replicas split the load (master plan §2), and hands each message to the `IngestPipeline` (validate → authorise →
 * dedup → persist → events, B3.2).
 */
@Injectable()
export class IngestSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IngestSubscriber.name);
  private keepAlive?: NodeJS.Timeout;
  private report?: NodeJS.Timeout;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly ingest: IngestService,
    private readonly pipeline: IngestPipeline,
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const filters = ingestFilters(
      this.config.get('MQTT_SHARED_GROUP'),
      this.config.get('MQTT_SHARED_SUBSCRIPTION'),
    );
    this.mqtt.onMessage(({ topic, payload }) => this.enqueue(topic, payload));
    await this.mqtt.subscribe(filters, { qos: 1 });
    this.logger.log(`ingest ready (${this.mqtt.mode} broker): ${filters.join(', ')}`);
    this.keepAlive = setInterval(() => undefined, 60_000);
    this.report = setInterval(() => {
      const { accepted, rejected, lwt } = this.ingest.counters;
      const { points, duplicates, unbound, deadLetters, lastLagMs } = this.pipeline.counters;
      this.logger.log(
        {
          event: 'ingest_counters',
          accepted,
          rejected,
          lwt,
          points,
          duplicates,
          unbound,
          deadLetters,
          lastLagMs,
        },
        'ingest counters',
      );
    }, 60_000);
    this.report.unref();
  }

  /**
   * Messages of one gateway are processed in arrival order (its batches, health and LWT stay ordered); gateways run in
   * parallel up to `MAX_PARALLEL` so the database pool is never exhausted by a burst after a reconnect.
   */
  private enqueue(topic: string, payload: Buffer): Promise<void> {
    const key = this.ingest.parseTopic(topic)?.gatewayId ?? '_';
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.limited(() => this.pipeline.handleSafely(topic, payload)));
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return settled;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_PARALLEL) await new Promise<void>((r) => this.waiting.push(r));
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  /** Resolves when every message received so far is processed (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  onApplicationShutdown(signal?: string): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.report) clearInterval(this.report);
    this.logger.log(`ingest stopped${signal ? ` (${signal})` : ''}`);
  }
}
