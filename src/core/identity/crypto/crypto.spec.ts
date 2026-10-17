import { generateKeyPairSync } from 'node:crypto';

import { decodeJwt, JwtError, signJwt, verifyJwt } from './jwt';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from './password';
import { numericCode, opaqueToken, readableCode, tokenHash } from './secrets';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, verifyTotp } from './totp';

describe('EdDSA JWT (contract §4)', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519').privateKey;
  const now = new Date('2026-11-01T00:00:00Z');
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { iss: 'getproperty', sub: 'u1', aud: 'operator', iat, exp: iat + 900, jti: 'j1' };
  const keys = new Map([['k1', privateKey]]);

  it('signs and verifies; the header names EdDSA and the kid', () => {
    const token = signJwt(claims, privateKey, 'k1');
    expect(decodeJwt(token).header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    expect(verifyJwt(token, { keys, issuer: 'getproperty', now })).toMatchObject({
      sub: 'u1',
      aud: 'operator',
    });
  });

  it.each([
    ['unknown_key', (): string => signJwt(claims, privateKey, 'k2'), now],
    ['signature', (): string => signJwt(claims, other, 'k1'), now],
    ['expired', (): string => signJwt(claims, privateKey, 'k1'), new Date(now.getTime() + 3_600_000)],
    ['issuer', (): string => signJwt({ ...claims, iss: 'evil' }, privateKey, 'k1'), now],
    ['malformed', (): string => 'a.b', now],
  ] as const)('rejects %s', (reason, make, at) => {
    expect(() => verifyJwt(make(), { keys, issuer: 'getproperty', now: at })).toThrow(new JwtError(reason));
  });

  it('rejects a token whose payload was altered', () => {
    const [h, , s] = signJwt(claims, privateKey, 'k1').split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, aud: 'platform' })).toString('base64url');
    expect(() => verifyJwt(`${h}.${forged}.${s}`, { keys, issuer: 'getproperty', now })).toThrow(JwtError);
  });
});

describe('argon2id passwords', () => {
  it('hashes in PHC format and verifies', async () => {
    const phc = await hashPassword('correct horse battery staple', {
      memory: 1024,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
    });
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(await verifyPassword('correct horse battery staple', phc)).toBe(true);
    expect(await verifyPassword('wrong', phc)).toBe(false);
    expect(needsRehash(phc)).toBe(true);
  });

  it('refuses weak passwords', () => {
    expect(passwordProblems('short')).not.toHaveLength(0);
    expect(passwordProblems('a-long-enough-pass-phrase')).toHaveLength(0);
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('base32 round-trips and secrets are 160 bits', () => {
    const s = generateTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  it('accepts the current and adjacent steps only, returning the step', () => {
    const s = generateTotpSecret();
    const at = new Date('2026-11-01T00:00:10Z');
    expect(verifyTotp(s, totpAt(s, at), at)).toBe(Math.floor(at.getTime() / 30_000));
    expect(verifyTotp(s, totpAt(s, new Date(at.getTime() - 30_000)), at)).not.toBeNull();
    expect(verifyTotp(s, totpAt(s, new Date(at.getTime() - 120_000)), at)).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'admin@example.invalid')).toMatch(
      /^otpauth:\/\/totp\/getproperty%3Aadmin%40example\.invalid\?secret=JBSWY3DPEHPK3PXP&issuer=getproperty/,
    );
  });
});

describe('secrets', () => {
  it('numeric OTPs, opaque tokens and readable codes have the right shape', () => {
    expect(numericCode()).toMatch(/^\d{6}$/);
    expect(opaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readableCode(3)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Buffer.from(tokenHash('x'))).toHaveLength(32);
    expect(Buffer.from(tokenHash('x')).equals(Buffer.from(tokenHash('x')))).toBe(true);
  });
});
