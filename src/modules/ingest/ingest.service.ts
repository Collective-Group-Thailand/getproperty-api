import { DomainException } from '@common/errors/domain.exception';
import { validateAs } from '@common/validation/validation';
import { Injectable, Logger, type Type } from '@nestjs/common';

import { CommandAck } from './protocol/command.dto';
import { MeterHealthStatus } from './protocol/enums';
import { DeviceEvent } from './protocol/events.dto';
import { MAX_READINGS_PER_BATCH } from './protocol/formats';
import { Health, isLwtPayload } from './protocol/health.dto';
import { TelemetryBatch } from './protocol/telemetry.dto';

/** The gateway → cloud topics the ingest process subscribes to (device-protocol.md §2). */
export const INGEST_TOPIC_KINDS = ['telemetry', 'health', 'events', 'cmd/ack'] as const;
export type IngestTopicKind = (typeof INGEST_TOPIC_KINDS)[number];

const PAYLOAD_BY_KIND: Record<IngestTopicKind, Type<object>> = {
  telemetry: TelemetryBatch,
  health: Health,
  events: DeviceEvent,
  'cmd/ack': CommandAck,
};

const TOPIC = /^gp\/v1\/([0-9a-f-]{36})\/(telemetry|health|events|cmd\/ack)$/i;

export interface ParsedTopic {
  gatewayId: string;
  kind: IngestTopicKind;
}

export type IngestOutcome =
  | { status: 'accepted'; kind: IngestTopicKind; gatewayId: string; payload: object; summary: string }
  | { status: 'lwt'; gatewayId: string }
  | {
      status: 'rejected';
      reason: 'unknown_topic' | 'malformed_json' | 'invalid_payload' | 'gateway_mismatch' | 'batch_too_large';
      detail?: string;
    };

export interface IngestCounters {
  accepted: number;
  rejected: number;
  lwt: number;
  byReason: Record<string, number>;
}

/**
 * Validates every MQTT envelope against the protocol DTOs (device-protocol.md §5) and reports the outcome; a
 * telemetry batch above 200 readings is refused as `batch_too_large` (backpressure). Stateless: authorisation,
 * dedup and persistence are the `IngestPipeline`'s (B3.2).
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  readonly counters: IngestCounters = { accepted: 0, rejected: 0, lwt: 0, byReason: {} };

  parseTopic(topic: string): ParsedTopic | undefined {
    const match = TOPIC.exec(topic);
    if (!match) return undefined;
    return { gatewayId: match[1]!.toLowerCase(), kind: match[2]!.toLowerCase() as IngestTopicKind };
  }

  async handle(topic: string, payload: Buffer | string): Promise<IngestOutcome> {
    const parsed = this.parseTopic(topic);
    if (!parsed) return this.reject('unknown_topic', topic);

    let json: unknown;
    try {
      json = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      return this.reject('malformed_json', topic);
    }

    if (parsed.kind === 'health' && isLwtPayload(json)) {
      this.counters.lwt += 1;
      this.logger.warn({ event: 'gateway_lwt', gatewayId: parsed.gatewayId }, 'gateway offline (LWT)');
      return { status: 'lwt', gatewayId: parsed.gatewayId };
    }

    // Backpressure (protocol §2: ≤ 200 readings per batch): refused before validation, with its own reason.
    const readings = (json as { readings?: unknown } | null)?.readings;
    if (parsed.kind === 'telemetry' && Array.isArray(readings) && readings.length > MAX_READINGS_PER_BATCH)
      return this.reject('batch_too_large', topic, `${readings.length} readings`);

    let instance: object;
    try {
      instance = await validateAs(PAYLOAD_BY_KIND[parsed.kind], json);
    } catch (error) {
      const detail =
        error instanceof DomainException
          ? error.errors?.map((e) => `${e.path}:${e.code}`).join(',')
          : undefined;
      return this.reject('invalid_payload', topic, detail);
    }

    const bodyGateway = (instance as { gatewayId?: string }).gatewayId;
    if (bodyGateway && bodyGateway.toLowerCase() !== parsed.gatewayId)
      return this.reject('gateway_mismatch', topic);

    const summary = this.summarise(parsed, instance);
    this.counters.accepted += 1;
    this.logger.log({ event: 'envelope_accepted', kind: parsed.kind, gatewayId: parsed.gatewayId }, summary);
    return { status: 'accepted', kind: parsed.kind, gatewayId: parsed.gatewayId, payload: instance, summary };
  }

  private summarise({ kind, gatewayId }: ParsedTopic, payload: object): string {
    switch (kind) {
      case 'telemetry': {
        const batch = payload as TelemetryBatch;
        const meters = new Set(batch.readings.map((r) => r.meterId)).size;
        return `telemetry gw=${gatewayId} cfg=${batch.configVersion} readings=${batch.readings.length} meters=${meters}`;
      }
      case 'health': {
        const health = payload as Health;
        const notOk = health.meters.filter((m) => m.status !== MeterHealthStatus.Ok).length;
        return `health gw=${gatewayId} agent=${health.agentVersion} cfg=${health.configVersion} buffered=${health.bufferedReadings} meters=${health.meters.length} notOk=${notOk}`;
      }
      case 'events': {
        const event = payload as DeviceEvent;
        return `event gw=${gatewayId} type=${event.type} severity=${event.severity}${event.meterId ? ` meter=${event.meterId}` : ''}`;
      }
      case 'cmd/ack': {
        const ack = payload as CommandAck;
        return `ack gw=${gatewayId} cmd=${ack.cmdId} status=${ack.status}`;
      }
    }
  }

  private reject(
    reason: Exclude<IngestOutcome, { status: 'accepted' | 'lwt' }>['reason'],
    topic: string,
    detail?: string,
  ): IngestOutcome {
    this.counters.rejected += 1;
    this.counters.byReason[reason] = (this.counters.byReason[reason] ?? 0) + 1;
    this.logger.warn({ event: 'envelope_rejected', reason, topic, detail }, `rejected ${reason} on ${topic}`);
    return { status: 'rejected', reason, detail };
  }
}
