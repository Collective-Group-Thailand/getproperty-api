import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level (arrays keep their order): stable bytes for hashes and snapshots. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object' && !(v instanceof Date))
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}

/** sha256 of the canonical JSON (e.g. `ops.invoice.snapshot_sha256`, schema-design §4.2.3). */
export function canonicalSha256(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value)).digest();
}
