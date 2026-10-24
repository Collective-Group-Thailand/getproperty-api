import { ProviderError } from '@collective/integrations/http';
import webpush from 'web-push';

import { type WebPushPort, type WebPushTarget } from './web-push.port';

/**
 * Web Push with VAPID (RFC 8291/8292) through the `web-push` library.
 * // UNVERIFIED against live provider: not sent to a real push service (FCM/Mozilla/Apple) from the sandbox.
 */
export class VapidWebPushAdapter implements WebPushPort {
  readonly mode = 'real' as const;

  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(target: WebPushTarget, payload: string, ttlSeconds: number): Promise<'sent' | 'gone'> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        payload,
        {
          TTL: ttlSeconds,
          timeout: 10_000,
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
        },
      );
      return 'sent';
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      throw new ProviderError('web-push', (error as Error).message, status);
    }
  }
}
