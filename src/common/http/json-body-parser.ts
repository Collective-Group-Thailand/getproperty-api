import { type IncomingMessage } from 'node:http';

import { json, type RequestHandler } from 'express';

import { DomainException } from '../errors/domain.exception';

/** Webhook requests keep their exact bytes: providers sign the raw body (bank/QR gateways, LINE `x-line-signature`). */
export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };

/**
 * Routes whose bodies may be larger than the default. `POST /v1/device/readings/batch` (contract §7) carries
 * up to 200 readings — the same envelope as MQTT. Technical bounds, not business values.
 */
export const LARGE_BODY_ROUTES: readonly { pattern: RegExp; limit: string }[] = [
  { pattern: /^\/v1\/device\/readings\/batch(\/|\?|$)/, limit: '2mb' },
];

/**
 * JSON body parser registered before Nest's own (body-parser skips already-parsed requests), so that
 * parse failures become stable problem codes instead of Nest's generic 400 with the parser message.
 */
export function jsonBodyParser(options: { limit?: string } = {}): RequestHandler {
  const verify = (req: RawBodyRequest, _res: unknown, buf: Buffer) => {
    if (req.url?.startsWith('/webhooks/')) req.rawBody = Buffer.from(buf);
  };
  const standard = json({ limit: options.limit ?? '1mb', verify });
  const large = new Map(LARGE_BODY_ROUTES.map((r) => [r, json({ limit: r.limit, verify })]));
  return (req, res, next) => {
    const route = LARGE_BODY_ROUTES.find((r) => r.pattern.test(req.url ?? ''));
    const parse = route ? large.get(route)! : standard;
    parse(req, res, (error?: unknown) => {
      if (!error) return next();
      const type = (error as { type?: unknown }).type;
      if (type === 'entity.parse.failed')
        return next(new DomainException('http.malformed_json', { cause: error }));
      if (type === 'entity.too.large')
        return next(new DomainException('http.payload_too_large', { cause: error }));
      next(error);
    });
  };
}
