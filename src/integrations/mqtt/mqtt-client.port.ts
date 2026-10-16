export const MQTT_CLIENT = Symbol('MQTT_CLIENT');

export type MqttQoS = 0 | 1 | 2;

export interface MqttPublishOptions {
  qos?: MqttQoS;
  retain?: boolean;
}

export interface MqttMessage {
  /** The concrete topic the message was published on (never the shared-subscription prefix). */
  topic: string;
  payload: Buffer;
}

export type MqttMessageHandler = (message: MqttMessage) => void | Promise<void>;

/**
 * The broker connection (EMQX, MQTT 5, D-130) behind one port so the ingest process, the health
 * check and the tests see the same thing. `FakeMqttClient` keeps everything in memory; the real
 * client wraps `mqtt` with TLS / mTLS from the environment.
 */
export interface MqttClientPort {
  /** Live connection flag — `/health` reports it; fakes are always connected. */
  readonly connected: boolean;
  readonly mode: 'fake' | 'real';
  /** Subscribes (topic filters may use `+`, `#` and EMQX `$share/<group>/` prefixes). */
  subscribe(filters: string[], options?: { qos?: MqttQoS }): Promise<void>;
  publish(topic: string, payload: Buffer | string, options?: MqttPublishOptions): Promise<void>;
  /** Registers the message handler; one handler per process (the ingest subscriber). */
  onMessage(handler: MqttMessageHandler): void;
  end(): Promise<void>;
}

/** Strips an EMQX shared-subscription prefix: `$share/ingest/gp/v1/+/telemetry` → `gp/v1/+/telemetry`. */
export function stripSharedPrefix(filter: string): string {
  const match = /^\$share\/[^/]+\/(.+)$/.exec(filter);
  return match?.[1] ?? filter;
}

/** MQTT topic-filter matching (`+` one level, `#` the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = stripSharedPrefix(filter).split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    const level = f[i];
    if (level === '#') return true;
    if (i >= t.length) return false;
    if (level !== '+' && level !== t[i]) return false;
  }
  return f.length === t.length;
}
