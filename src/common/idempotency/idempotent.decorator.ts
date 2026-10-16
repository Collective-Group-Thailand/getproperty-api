import { applyDecorators, SetMetadata } from '@nestjs/common';

import { ApiIdempotent } from '../openapi/decorators';

export const IDEMPOTENT_METADATA = 'getproperty:idempotent';
export type IdempotentMode = 'required' | 'optional';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Marks an irreversible POST (bill issue, payment record, refund, lease signature, device provisioning…) as requiring an
 * `Idempotency-Key` (uuid) header. Replays within 24 h return the original response.
 * Documents the header and its problem codes (`@ApiIdempotent()`).
 * `{ optional: true }`: an operation published without the header — deduplicated when the key is
 * sent, passed through when it is not (additive).
 */
export function Idempotent(options: { optional?: boolean } = {}) {
  const mode: IdempotentMode = options.optional ? 'optional' : 'required';
  return applyDecorators(SetMetadata(IDEMPOTENT_METADATA, mode), ApiIdempotent(options));
}
