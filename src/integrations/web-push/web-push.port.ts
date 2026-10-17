export const WEB_PUSH = Symbol('WEB_PUSH');

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushPort {
  readonly mode: 'fake' | 'real';
  readonly publicKey: string;
  /** `gone` = the subscription expired (404/410): delete it. */
  send(target: WebPushTarget, payload: string, ttlSeconds: number): Promise<'sent' | 'gone'>;
}
