import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller's id (BFF, load balancer) only if it is a plain token; otherwise mint one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Returns the request id for this request, echoing it on the response. Used as pino-http `genReqId`. */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Reads the id assigned by pino-http (`req.id`). */
export function requestIdOf(req: unknown): string | undefined {
  const id = (req as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}
