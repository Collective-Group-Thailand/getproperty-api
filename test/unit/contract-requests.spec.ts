import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  $ref?: string;
}

const contract = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'contract', 'openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, { operationId?: string; parameters?: Parameter[] }>>;
};

/** Consumer contract requests that are properties of the whole contract (D-203). */
describe('contract requests (committed contract)', () => {
  const operations = Object.values(contract.paths).flatMap((ops) => Object.values(ops));

  it('LIFF #13: no operation declares its own (required) accept-language header — the shared parameter covers it', () => {
    const offenders = operations
      .filter((op) =>
        (op.parameters ?? []).some((p) => p.in === 'header' && p.name?.toLowerCase() === 'accept-language'),
      )
      .map((op) => op.operationId);
    expect(offenders).toEqual([]);
  });

  it('LIFF #14: signing documents the OTP problems of the shared OTP service', () => {
    const sign = Object.values(contract.paths['/v1/resident/leases/{leaseId}/sign'] ?? {})[0] as {
      responses: Record<string, { content?: Record<string, { examples?: Record<string, unknown> }> }>;
    };
    const codes = Object.values(sign.responses).flatMap((r) =>
      Object.values(r.content ?? {}).flatMap((c) => Object.keys(c.examples ?? {})),
    );
    expect(codes).toEqual(
      expect.arrayContaining(['auth.otp_invalid', 'auth.otp_expired', 'auth.otp_attempts_exceeded']),
    );
  });
});
