/* eslint-disable no-console -- runs before the logger exists */
// Loaded first by the entry points: OpenTelemetry and Sentry must patch modules before they are imported.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import * as Sentry from '@sentry/nestjs';
import { config } from 'dotenv';

// `.env` for local development; never overrides variables that are already set.
config({ quiet: true });

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const sentryDsn = process.env.SENTRY_DSN;

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'getproperty-api',
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Never record headers or bodies (tokens, PII — D-025).
        '@opentelemetry/instrumentation-http': { headersToSpanAttributes: undefined },
      }),
    ],
  });
  sdk.start();
  process.once('SIGTERM', () => {
    sdk.shutdown().catch((error: unknown) => console.error('OpenTelemetry shutdown failed', error));
  });
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.npm_package_version,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // When OTLP export is on, the NodeSDK above owns tracing; Sentry reports errors only.
    enableOpenTelemetrySetup: !otlpEndpoint,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
        delete event.request.query_string;
      }
      return event;
    },
  });
}
