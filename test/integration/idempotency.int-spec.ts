import { PrismaIdempotencyStore } from '@common/idempotency/prisma-idempotency.store';

import { createIntDatabase, type IntDatabase } from '../support/int-db';

describe('PrismaIdempotencyStore on platform.idempotency_key (durable tier)', () => {
  let db: IntDatabase;
  let store: PrismaIdempotencyStore;
  const key = 'user:1|POST|/v1/owner/things|0199f2a0-4444-7000-8000-000000000001';
  const fp = 'a'.repeat(64);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_idem' });
    store = new PrismaIdempotencyStore(db.prisma());
  });
  afterAll(async () => {
    await db.drop();
  });

  it('claims, completes and replays a response; a second claim sees the stored one', async () => {
    expect(await store.begin(key, fp, 60)).toEqual({ acquired: true });
    expect(await store.begin(key, fp, 60)).toEqual({
      acquired: false,
      existing: { state: 'in_progress', fingerprint: fp },
    });
    await store.complete(
      key,
      fp,
      { status: 201, body: { id: 'x', total: '10.00' }, headers: { etag: '"1"' } },
      86_400,
    );
    expect(await store.begin(key, fp, 60)).toEqual({
      acquired: false,
      existing: {
        state: 'completed',
        fingerprint: fp,
        response: { status: 201, body: { id: 'x', total: '10.00' }, headers: { etag: '"1"' } },
      },
    });
  });

  it('releases an in-progress claim so the client can retry', async () => {
    const k = key.replace(/0001$/, '0002');
    await store.begin(k, fp, 60);
    await store.release(k);
    expect(await store.begin(k, fp, 60)).toEqual({ acquired: true });
  });

  it('takes over an expired claim and purges expired keys', async () => {
    const k = key.replace(/0001$/, '0003');
    await store.begin(k, fp, 60);
    await db.admin.query(
      `UPDATE platform.idempotency_key SET expires_at = now() - interval '1 second' WHERE key = $1`,
      [k.split('|').pop()],
    );
    expect(await store.begin(k, 'b'.repeat(64), 60)).toEqual({ acquired: true });
    await db.admin.query(`UPDATE platform.idempotency_key SET expires_at = now() - interval '1 second'`);
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(3);
  });
});
