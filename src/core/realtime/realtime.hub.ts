import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { DEV_FIELD_HASH_KEY } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { PUBSUB, type PubSub } from '@database/redis.module';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { interval, map, merge, Observable, Subject } from 'rxjs';

import { CLOCK, type Clock } from '../clock/clock';

/** What reaches a browser: the event type and ids only (contract §6) — clients refetch through the API. */
export interface RealtimeMessage {
  type: string;
  ids: Record<string, string>;
  channels: string[];
}

export interface StreamClaims {
  sub: string;
  aud: string;
  ch: string[];
  exp: number;
}

const CHANNEL = 'gp:realtime';
export const STREAM_TOKEN_TTL_SECONDS = 60;
const HEARTBEAT_MS = 25_000;

/**
 * Realtime fan-out (contract §6): every process subscribes to Redis pub/sub and pushes to its own server-sent-event
 * clients whose channels match. `POST /v1/{surface}/realtime/auth` hands out a 60-second stream token naming the
 * channels the caller may hear (tenant, buildings, units, user); the stream endpoint verifies it. Payloads carry ids
 * and the event type only.
 */
@Injectable()
export class RealtimeHub implements OnModuleInit {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly clients = new Map<string, { channels: Set<string>; out: Subject<RealtimeMessage> }>();
  private readonly key: Buffer;

  constructor(
    @Inject(PUBSUB) private readonly pubsub: PubSub,
    config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.key = createHmac('sha256', config.get('FIELD_HASH_KEY') ?? DEV_FIELD_HASH_KEY)
      .update('realtime-stream')
      .digest();
  }

  async onModuleInit(): Promise<void> {
    await this.pubsub
      .subscribe(CHANNEL, (raw) => {
        try {
          this.deliverLocal(JSON.parse(raw) as RealtimeMessage);
        } catch (error) {
          this.logger.warn(`bad realtime message: ${(error as Error).message}`);
        }
      })
      .catch((error: unknown) => this.logger.warn(`realtime subscribe failed: ${(error as Error).message}`));
  }

  async publish(message: RealtimeMessage): Promise<void> {
    await this.pubsub
      .publish(CHANNEL, JSON.stringify(message))
      .catch((error: unknown) => this.logger.warn(`realtime publish failed: ${(error as Error).message}`));
  }

  private deliverLocal(message: RealtimeMessage): void {
    for (const client of this.clients.values()) {
      if (message.channels.some((c) => client.channels.has(c))) client.out.next(message);
    }
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  issueStreamToken(sub: string, aud: string, channels: string[]): { token: string; expiresAt: Date } {
    const exp = Math.floor(this.clock.now().getTime() / 1000) + STREAM_TOKEN_TTL_SECONDS;
    const body = Buffer.from(JSON.stringify({ sub, aud, ch: channels, exp } satisfies StreamClaims)).toString(
      'base64url',
    );
    const sig = createHmac('sha256', this.key).update(body).digest('base64url');
    return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000) };
  }

  verifyStreamToken(token: string, aud: string): StreamClaims {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw new DomainException('realtime.token_invalid');
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DomainException('realtime.token_invalid');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StreamClaims;
    if (claims.aud !== aud || claims.exp * 1000 <= this.clock.now().getTime())
      throw new DomainException('realtime.token_invalid');
    return claims;
  }

  /** The SSE stream of one client: messages of its channels plus a heartbeat comment every 25 s. */
  stream(channels: string[]): Observable<{ data: string; type?: string }> {
    return new Observable((subscriber) => {
      const id = randomUUID();
      const out = new Subject<RealtimeMessage>();
      this.clients.set(id, { channels: new Set(channels), out });
      const sub = merge(
        out.pipe(map((m) => ({ type: m.type, data: JSON.stringify({ type: m.type, ids: m.ids }) }))),
        interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'heartbeat', data: '{}' }))),
      ).subscribe(subscriber);
      subscriber.next({ type: 'ready', data: JSON.stringify({ channels }) });
      return () => {
        sub.unsubscribe();
        out.complete();
        this.clients.delete(id);
      };
    });
  }
}
