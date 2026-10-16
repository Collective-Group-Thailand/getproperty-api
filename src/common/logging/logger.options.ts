import { type LogLevel } from '@config/env.schema';
import { type Params } from 'nestjs-pino';

import { resolveRequestId } from '../request-id/request-id';
import { REDACT_CENSOR, REDACT_PATHS } from './redaction';

export interface LoggerSettings {
  level: LogLevel;
  pretty: boolean;
  service: string;
}

export function buildLoggerParams(settings: LoggerSettings): Params {
  return {
    pinoHttp: {
      level: settings.level,
      base: { service: settings.service },
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
      genReqId: resolveRequestId,
      customAttributeKeys: { reqId: 'requestId' },
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: {
        // Path only: query strings can carry tokens (tracking links, OAuth callbacks).
        req: (req: { id: unknown; method: unknown; url: unknown }) => ({
          id: req.id,
          method: req.method,
          path: String(req.url).split('?')[0],
        }),
        res: (res: { statusCode: unknown }) => ({ statusCode: res.statusCode }),
      },
      transport: settings.pretty ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  };
}
