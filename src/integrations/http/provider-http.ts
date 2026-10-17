import { Logger } from '@nestjs/common';

/** A provider call failed (after retries) or its circuit is open. Mapped to 503 `provider.unavailable`. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

interface Breaker {
  failures: number;
  openUntil: number;
}

const breakers = new Map<string, Breaker>();
const logger = new Logger('ProviderHttp');

export interface ProviderRequest {
  provider: string;
  url: string;
  init: RequestInit;
  timeoutMs?: number;
  /** Retries after the first attempt, only for network errors, 429 and 5xx. */
  retries?: number;
  /** Consecutive failures that open the circuit, and for how long. */
  breakerThreshold?: number;
  breakerOpenMs?: number;
}

/**
 * fetch() for third-party providers (master plan §4 "Integrations"): per-call timeout, exponential backoff retries
 * on transient failures, and a per-provider circuit breaker so a dead provider fails fast instead of piling up
 * requests. Never logs request bodies (they carry phone numbers and message text).
 */
export async function providerFetch(request: ProviderRequest): Promise<Response> {
  const { provider, url, init } = request;
  const breaker = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  breakers.set(provider, breaker);
  if (breaker.openUntil > Date.now()) throw new ProviderError(provider, 'circuit open');

  const retries = request.retries ?? 2;
  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new ProviderError(provider, `HTTP ${response.status}`, response.status);
        continue;
      }
      breaker.failures = 0;
      return response;
    } catch (error) {
      lastError = new ProviderError(provider, (error as Error).message);
    }
  }
  breaker.failures += 1;
  if (breaker.failures >= (request.breakerThreshold ?? 5)) {
    breaker.openUntil = Date.now() + (request.breakerOpenMs ?? 30_000);
    logger.warn(`${provider}: circuit opened after ${breaker.failures} failures`);
  }
  throw lastError ?? new ProviderError(provider, 'request failed');
}

/** Test helper. */
export function resetProviderBreakers(): void {
  breakers.clear();
}
