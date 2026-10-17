import { DomainException } from '@common/errors/domain.exception';

import { decodeCursor, encodeCursor } from './cursor';

describe('signed cursors (schema-design §4.5)', () => {
  it('round-trips for the same binding', () => {
    const c = encodeCursor('tenant-a', { id: '0199' });
    expect(decodeCursor('tenant-a', c)).toEqual({ id: '0199' });
    expect(decodeCursor('tenant-a', undefined)).toBeNull();
  });
  it('a cursor of another tenant is a 404', () => {
    const c = encodeCursor('tenant-a', { id: '0199' });
    expect(() => decodeCursor('tenant-b', c)).toThrow(
      expect.objectContaining({ code: 'http.not_found' }) as DomainException,
    );
  });
  it('a damaged cursor is a 400', () => {
    expect(() => decodeCursor('tenant-a', 'garbage')).toThrow(
      expect.objectContaining({ code: 'pagination.cursor_invalid' }) as DomainException,
    );
  });
  it('a tampered position does not verify', () => {
    const [, mac] = encodeCursor('tenant-a', { id: '0199' }).split('.');
    const forged = `${Buffer.from(JSON.stringify({ id: '0001' })).toString('base64url')}.${mac}`;
    expect(() => decodeCursor('tenant-a', forged)).toThrow(DomainException);
  });
});
