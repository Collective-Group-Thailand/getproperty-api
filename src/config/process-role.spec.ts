import { POOL_CEILINGS, POOL_DEFAULTS, poolMaxFor, processRole, setProcessRole } from './process-role';

describe('PostgreSQL pool per process (T-5)', () => {
  afterEach(() => setProcessRole('api'));

  it('defaults to api 10, worker 10, ingest 5 within the platform ceilings (api ≤ 15, worker ≤ 10)', () => {
    expect(POOL_DEFAULTS).toEqual({ api: 10, worker: 10, ingest: 5 });
    expect(POOL_CEILINGS).toEqual({ api: 15, worker: 10, ingest: 5 });
    expect(poolMaxFor('api')).toBe(10);
    expect(poolMaxFor('ingest')).toBe(5);
  });

  it('takes DATABASE_POOL_MAX within the ceiling and refuses more', () => {
    expect(poolMaxFor('api', 15)).toBe(15);
    expect(poolMaxFor('worker', 4)).toBe(4);
    expect(() => poolMaxFor('worker', 11)).toThrow(/1…10 for the worker/);
    expect(() => poolMaxFor('ingest', 6)).toThrow(/ingest/);
    expect(() => poolMaxFor('api', 0)).toThrow();
  });

  it('remembers the role an entry point set', () => {
    expect(processRole()).toBe('api');
    setProcessRole('worker');
    expect(processRole()).toBe('worker');
  });
});
