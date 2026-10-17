import { type WebPushPort, type WebPushTarget } from './web-push.port';

export class FakeWebPush implements WebPushPort {
  readonly mode = 'fake' as const;
  readonly publicKey =
    'BFakeVapidPublicKeyForDevelopmentOnly0000000000000000000000000000000000000000000000000';
  readonly sent: { target: WebPushTarget; payload: string }[] = [];
  readonly goneEndpoints = new Set<string>();

  send(target: WebPushTarget, payload: string): Promise<'sent' | 'gone'> {
    if (this.goneEndpoints.has(target.endpoint)) return Promise.resolve('gone');
    this.sent.push({ target, payload });
    return Promise.resolve('sent');
  }
}
