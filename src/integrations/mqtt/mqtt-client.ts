import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';

import {
  type MqttClientPort,
  type MqttMessageHandler,
  type MqttPublishOptions,
  type MqttQoS,
} from './mqtt-client.port';

export interface MqttClientOptions {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  /** PEM file paths (TLS / mTLS, D-130). */
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

/**
 * EMQX connection over `mqtt` (MQTT 5, clean start, automatic reconnect). Connecting is
 * asynchronous and never throws: `connected` turns true once the broker accepts the session and
 * `/health` reports it; messages are queued by the library while offline.
 */
export class EmqxMqttClient implements MqttClientPort {
  readonly mode = 'real' as const;
  private readonly logger = new Logger(EmqxMqttClient.name);
  private readonly client: MqttClient;
  private handler?: MqttMessageHandler;

  constructor(options: MqttClientOptions) {
    const tls: Pick<IClientOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> = {};
    if (options.tlsCaPath) tls.ca = readFileSync(options.tlsCaPath);
    if (options.tlsCertPath) tls.cert = readFileSync(options.tlsCertPath);
    if (options.tlsKeyPath) tls.key = readFileSync(options.tlsKeyPath);
    this.client = connect(options.url, {
      protocolVersion: 5,
      clientId: options.clientId,
      username: options.username,
      password: options.password,
      clean: true,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
      keepalive: 60,
      ...tls,
    });
    this.client.on('connect', () => this.logger.log(`connected to ${options.url}`));
    this.client.on('reconnect', () => this.logger.warn('reconnecting to the broker'));
    this.client.on('error', (error: Error) => this.logger.error(`broker error: ${error.message}`));
    this.client.on('message', (topic: string, payload: Buffer) => {
      void this.handler?.({ topic, payload });
    });
  }

  get connected(): boolean {
    return this.client.connected;
  }

  async subscribe(filters: string[], options: { qos?: MqttQoS } = {}): Promise<void> {
    await this.client.subscribeAsync(filters, { qos: options.qos ?? 1 });
  }

  async publish(topic: string, payload: Buffer | string, options: MqttPublishOptions = {}): Promise<void> {
    await this.client.publishAsync(topic, payload, {
      qos: options.qos ?? 1,
      retain: options.retain ?? false,
    });
  }

  onMessage(handler: MqttMessageHandler): void {
    this.handler = handler;
  }

  async end(): Promise<void> {
    await this.client.endAsync();
  }
}
