import { AppConfig } from '@config/app-config';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { INGEST_TOPIC_KINDS, IngestService } from './ingest.service';

/** The shared-subscription filters of one ingest replica (`$share/<group>/gp/v1/+/<kind>`). */
export function ingestFilters(group: string): string[] {
  return INGEST_TOPIC_KINDS.map((kind) => `$share/${group}/gp/v1/+/${kind}`);
}

/**
 * Subscribes the ingest process to every gateway topic through an EMQX shared subscription, so
 * replicas split the load (master plan §2), and hands each message to `IngestService`.
 */
@Injectable()
export class IngestSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IngestSubscriber.name);
  private keepAlive?: NodeJS.Timeout;
  private report?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly ingest: IngestService,
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const filters = ingestFilters(this.config.get('MQTT_SHARED_GROUP'));
    this.mqtt.onMessage(({ topic, payload }) => this.ingest.handle(topic, payload).then(() => undefined));
    await this.mqtt.subscribe(filters, { qos: 1 });
    this.logger.log(`ingest ready (${this.mqtt.mode} broker): ${filters.join(', ')}`);
    this.keepAlive = setInterval(() => undefined, 60_000);
    this.report = setInterval(() => {
      const { accepted, rejected, lwt } = this.ingest.counters;
      this.logger.log({ event: 'ingest_counters', accepted, rejected, lwt }, 'ingest counters');
    }, 60_000);
    this.report.unref();
  }

  onApplicationShutdown(signal?: string): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.report) clearInterval(this.report);
    this.logger.log(`ingest stopped${signal ? ` (${signal})` : ''}`);
  }
}
