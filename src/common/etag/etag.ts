import { createHash } from 'node:crypto';

import { DomainException } from '../errors/domain.exception';

export type EtagSource = string | number | Date;

/**
 * Strong ETag for an aggregate version (contract §3 "Concurrency"). Pass what changes on every
 * update — typically `(publicId, version)` or `(publicId, updatedAt)`.
 */
export function etagOf(...parts: EtagSource[]): string {
  const raw = parts.map((part) => (part instanceof Date ? part.toISOString() : String(part))).join('|');
  return `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`;
}

/**
 * Checks an `If-Match` header against the current ETag:
 * missing → 428 `concurrency.precondition_required` (unless `required: false`);
 * no listed tag matches → 412 `concurrency.stale`. Weak tags (`W/`) never match (strong comparison).
 */
export function assertIfMatch(
  ifMatch: string | string[] | undefined,
  currentEtag: string,
  options: { required?: boolean } = {},
): void {
  const header = Array.isArray(ifMatch) ? ifMatch.join(',') : ifMatch;
  if (header === undefined || header.trim() === '') {
    if (options.required ?? true) throw new DomainException('concurrency.precondition_required');
    return;
  }
  const tags = header.split(',').map((tag) => tag.trim());
  if (tags.includes('*') || tags.includes(currentEtag)) return;
  throw new DomainException('concurrency.stale');
}
