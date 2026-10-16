import { fingerprintOf } from './idempotency.interceptor';
import { InMemoryIdempotencyStore } from './in-memory-idempotency.store';

describe('InMemoryIdempotencyStore', () => {
  let now = 1_000_000;
  const store = new InMemoryIdempotencyStore(() => now);
  const response = { status: 201, body: { id: 1 }, headers: { location: '/v1/owner/x/1' } };

  it('claims a key once, then returns the in-progress record', async () => {
    expect(await store.begin('k1', 'fp', 60)).toEqual({ acquired: true });
    expect(await store.begin('k1', 'fp', 60)).toEqual({
      acquired: false,
      existing: { state: 'in_progress', fingerprint: 'fp' },
    });
  });

  it('serves the completed response on replay and keeps the fingerprint', async () => {
    await store.complete('k1', 'fp', response, 24 * 3600);
    expect(await store.begin('k1', 'other', 60)).toEqual({
      acquired: false,
      existing: { state: 'completed', fingerprint: 'fp', response },
    });
  });

  it('releases a key after a failed attempt', async () => {
    await store.begin('k2', 'fp', 60);
    await store.release('k2');
    expect(await store.begin('k2', 'fp', 60)).toEqual({ acquired: true });
  });

  it('expires locks and retained responses', async () => {
    await store.begin('k3', 'fp', 60);
    now += 61_000;
    expect(await store.begin('k3', 'fp', 60)).toEqual({ acquired: true });
    await store.complete('k3', 'fp', response, 10);
    now += 11_000;
    expect(await store.begin('k3', 'fp', 60)).toEqual({ acquired: true });
  });

  it('fingerprints canonical JSON (key order does not matter)', () => {
    expect(fingerprintOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      fingerprintOf({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf(undefined)).toBe(fingerprintOf(null));
  });
});
