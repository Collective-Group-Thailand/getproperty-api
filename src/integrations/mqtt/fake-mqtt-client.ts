import {
  type MqttClientPort,
  type MqttMessageHandler,
  type MqttPublishOptions,
  type MqttQoS,
  topicMatches,
} from './mqtt-client.port';

/**
 * In-memory broker stand-in (`DATA_STORES_MODE=fake`): `publish()` delivers to every matching
 * subscription in the same process, so tests and `pnpm dev:ingest` can feed the ingest pipeline
 * without EMQX. Retained messages are kept so a late `/config` subscriber still receives them.
 */
export class FakeMqttClient implements MqttClientPort {
  readonly mode = 'fake' as const;
  connected = true;
  readonly subscriptions = new Set<string>();
  readonly published: { topic: string; payload: Buffer; options: MqttPublishOptions }[] = [];
  private readonly retained = new Map<string, Buffer>();
  private handler?: MqttMessageHandler;

  subscribe(filters: string[], _options?: { qos?: MqttQoS }): Promise<void> {
    for (const filter of filters) {
      this.subscriptions.add(filter);
      for (const [topic, payload] of this.retained) {
        if (topicMatches(filter, topic)) void this.handler?.({ topic, payload });
      }
    }
    return Promise.resolve();
  }

  async publish(topic: string, payload: Buffer | string, options: MqttPublishOptions = {}): Promise<void> {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    this.published.push({ topic, payload: bytes, options });
    if (options.retain) this.retained.set(topic, bytes);
    if (this.handler && [...this.subscriptions].some((filter) => topicMatches(filter, topic))) {
      await this.handler({ topic, payload: bytes });
    }
  }

  onMessage(handler: MqttMessageHandler): void {
    this.handler = handler;
  }

  end(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}
