export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

/** Replays within 24 h return the original response (contract §3 "Idempotency"). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** How long a request may hold the key before another attempt may take it over (crashed process). */
export const IDEMPOTENCY_LOCK_SECONDS = 60;

export interface StoredResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export type IdempotencyRecord =
  | { state: 'in_progress'; fingerprint: string }
  | { state: 'completed'; fingerprint: string; response: StoredResponse };

export type BeginResult = { acquired: true } | { acquired: false; existing: IdempotencyRecord };

/**
 * Storage for idempotency keys. In the app this is `TieredIdempotencyStore`: Redis as the fast path,
 * the durable store (`idempotency_keys` from B1.2; in memory until then) as the source of truth.
 */
export interface IdempotencyStore {
  /** Atomically claims `key` for this fingerprint, or returns what is already stored. */
  begin(key: string, fingerprint: string, lockSeconds: number): Promise<BeginResult>;
  complete(key: string, fingerprint: string, response: StoredResponse, ttlSeconds: number): Promise<void>;
  /** Frees a claimed key after a failed attempt so the client can retry with the same key. */
  release(key: string): Promise<void>;
}
