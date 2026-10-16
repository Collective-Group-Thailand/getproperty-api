import { DomainException } from '../errors/domain.exception';
import { assertIfMatch, etagOf } from './etag';

describe('etag helpers', () => {
  it('builds a strong, stable ETag from the version parts', () => {
    const tag = etagOf('0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11', 3);
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(etagOf('0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11', 3)).toBe(tag);
    expect(etagOf('0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11', 4)).not.toBe(tag);
    expect(etagOf('x', new Date('2026-11-01T00:00:00Z'))).toBe(etagOf('x', '2026-11-01T00:00:00.000Z'));
  });

  it('accepts a matching If-Match, a list containing it, or *', () => {
    const current = etagOf('lease', 7);
    expect(() => assertIfMatch(current, current)).not.toThrow();
    expect(() => assertIfMatch(`"other", ${current}`, current)).not.toThrow();
    expect(() => assertIfMatch(['*'], current)).not.toThrow();
  });

  it('refuses a stale tag with 412 concurrency.stale and a weak tag never matches', () => {
    const current = etagOf('lease', 7);
    expect(() => assertIfMatch(etagOf('lease', 6), current)).toThrow(DomainException);
    try {
      assertIfMatch(`W/${current}`, current);
    } catch (error) {
      expect((error as DomainException).code).toBe('concurrency.stale');
      expect((error as DomainException).status).toBe(412);
    }
  });

  it('requires the header unless told otherwise (428 concurrency.precondition_required)', () => {
    try {
      assertIfMatch(undefined, '"x"');
    } catch (error) {
      expect((error as DomainException).code).toBe('concurrency.precondition_required');
      expect((error as DomainException).status).toBe(428);
    }
    expect(() => assertIfMatch('', '"x"', { required: false })).not.toThrow();
  });
});
