import { DomainException } from '../errors/domain.exception';
import { type CursorPage, type Page, type PageQuery } from './pagination.dto';

/** `skip`/`take` (Prisma, B1.2) for a page query. */
export function toSkipTake(query: Pick<PageQuery, 'page' | 'perPage'>): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.perPage, take: query.perPage };
}

export function paginated<T>(data: T[], total: number, query: Pick<PageQuery, 'page' | 'perPage'>): Page<T> {
  return { data, meta: { page: query.page, perPage: query.perPage, total } };
}

/**
 * Builds a cursor page from `limit + 1` fetched rows: the extra row only signals that more exist.
 * `cursorOf` returns the position of a row (e.g. `{ createdAt, id }`), encoded opaquely.
 */
export function cursorPaginated<T>(
  rowsPlusOne: T[],
  limit: number,
  cursorOf: (row: T) => Record<string, string | number>,
): CursorPage<T> {
  const hasMore = rowsPlusOne.length > limit;
  const data = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const last = data.at(-1);
  return { data, meta: { nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null } };
}

export function encodeCursor(position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Decodes a cursor from `encodeCursor`; a tampered or malformed cursor is a 422 on `cursor`. */
export function decodeCursor(cursor: string): Record<string, string | number> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      if (entries.every(([, v]) => typeof v === 'string' || typeof v === 'number')) {
        return Object.fromEntries(entries);
      }
    }
  } catch {
    // fall through
  }
  throw new DomainException('validation.failed', {
    errors: [{ path: 'cursor', code: 'isCursor', message: 'cursor is invalid' }],
  });
}
