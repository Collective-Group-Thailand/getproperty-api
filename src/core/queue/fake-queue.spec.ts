import { FakeClock } from '../clock/clock';
import { FakeQueue } from './fake-queue';

describe('FakeQueue (in-memory BullMQ stand-in)', () => {
  it('runs due jobs, dedupes job ids, retries with backoff on the fake clock, dead-letters after the attempts', async () => {
    const clock = new FakeClock('2026-11-01T00:00:00Z');
    const q = new FakeQueue(clock);
    const seen: string[] = [];
    let failures = 0;
    q.process<{ v: string }>('gp-events', (job) => {
      if (job.data.v === 'flaky' && failures++ < 1) throw new Error('boom');
      if (job.data.v === 'dead') throw new Error('always');
      seen.push(job.data.v);
      return Promise.resolve();
    });
    await q.add('gp-events', 'x', { v: 'a' }, { jobId: 'same' });
    await q.add('gp-events', 'x', { v: 'a-dup' }, { jobId: 'same' });
    await q.add('gp-events', 'x', { v: 'later' }, { delayMs: 60_000 });
    await q.add('gp-events', 'x', { v: 'flaky' }, { attempts: 3, backoffMs: 1_000 });
    await q.add('gp-events', 'x', { v: 'dead' }, { attempts: 2, backoffMs: 1_000 });
    await q.drain();
    expect(seen).toEqual(['a']);
    clock.advance(1_000);
    await q.drain();
    expect(seen).toEqual(['a', 'flaky']);
    clock.advance(60_000);
    await q.drain();
    expect(seen).toEqual(['a', 'flaky', 'later']);
    expect(q.failed.map((f) => f.data)).toEqual([{ v: 'dead' }]);
  });
});
