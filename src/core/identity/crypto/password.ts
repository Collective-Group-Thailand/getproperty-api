import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with argon2id (contract §4, OWASP 2024 parameters: m = 19 MiB, t = 2, p = 1) on Node's built-in
 * `crypto.argon2`. Stored as the PHC string `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` (base64 without
 * padding), which the `user_credential_password_hash_check` constraint expects.
 */
export interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

export const ARGON2_DEFAULTS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: Buffer.from(password.normalize('NFKC'), 'utf8'),
        nonce: salt,
        parallelism: p.parallelism,
        tagLength: p.tagLength,
        memory: p.memory,
        passes: p.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

export async function hashPassword(
  password: string,
  params: Argon2Params = ARGON2_DEFAULTS,
): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const actual = await derive(password, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when the stored hash uses weaker parameters than today's defaults (rehash on the next login). */
export function needsRehash(phc: string, params: Argon2Params = ARGON2_DEFAULTS): boolean {
  const m = PHC.exec(phc);
  return !m || Number(m[1]) < params.memory || Number(m[2]) < params.passes;
}

/** Passwords: 12–128 characters, not all of one class (a deliberately simple, explainable rule). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('minLength');
  if (password.length > 128) problems.push('maxLength');
  if (/^(.)\1*$/.test(password)) problems.push('repeated');
  return problems;
}
