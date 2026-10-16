import { REDACT_PATHS, redactDeep, REDACTED_FIELDS } from './redaction';

describe('log redaction (PDPA, D-025)', () => {
  it('covers every field CLAUDE.md names', () => {
    for (const field of [
      'authorization',
      'password',
      'otp',
      'token',
      'refreshToken',
      'idToken',
      'lineAccessToken',
      'nationalId',
      'passportNo',
      'bankAccount',
      'provisioningCode',
    ]) {
      expect(REDACTED_FIELDS).toContain(field);
      expect(REDACT_PATHS).toContain(field);
      expect(REDACT_PATHS).toContain(`*.*.${field}`);
    }
  });

  it('redacts deeply and case-insensitively without touching other values', () => {
    const out = redactDeep({
      tenant: { NationalId: '0000000000001', name: 'ผู้เช่า ทดสอบ', docs: [{ passportNo: 'X1' }] },
      headers: { Authorization: 'Bearer x', 'x-request-id': 'r' },
    });
    expect(out).toEqual({
      tenant: { NationalId: '[REDACTED]', name: 'ผู้เช่า ทดสอบ', docs: [{ passportNo: '[REDACTED]' }] },
      headers: { Authorization: '[REDACTED]', 'x-request-id': 'r' },
    });
  });
});
