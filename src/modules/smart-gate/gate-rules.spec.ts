import { DomainException } from '@common/errors/domain.exception';

import {
  checkIdLast4,
  deliverySkipsApproval,
  effectivePolicy,
  entryAllowed,
  inviteTokenHash,
  newInviteToken,
  normalisePlate,
  plateText,
  samePlate,
  unitsInArrears,
} from './gate-rules';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainException ? error.code : 'other';
  }
  return undefined;
};

describe('J4.1 gate rules (D-315, D-327)', () => {
  it('normalises a full Thai plate and refuses partial or malformed ones', () => {
    expect(normalisePlate({ category: '1 กข', number: '12-34', province: ' กรุงเทพมหานคร ' })).toEqual({
      category: '1กข',
      number: '1234',
      province: 'กรุงเทพมหานคร',
    });
    expect(normalisePlate(null)).toBeNull();
    expect(normalisePlate({ category: '', number: '', province: '' })).toBeNull();
    expect(code(() => normalisePlate({ category: 'กข', number: '12345', province: 'ชลบุรี' }))).toBe(
      'validation.failed',
    );
    expect(code(() => normalisePlate({ category: '12', number: '1', province: 'ชลบุรี' }))).toBe(
      'validation.failed',
    );
    expect(code(() => normalisePlate({ category: 'กข', number: '1', province: '' }))).toBe(
      'validation.failed',
    );
    expect(code(() => normalisePlate({ category: 'AB', number: '1', province: 'ชลบุรี' }))).toBe(
      'validation.failed',
    );
  });

  it('takes exactly the last 4 ID digits — never more, never fewer (D-315)', () => {
    expect(checkIdLast4('0123')).toBe('0123');
    expect(checkIdLast4(undefined)).toBeNull();
    expect(checkIdLast4('')).toBeNull();
    for (const bad of ['123', '12345', '1234567890123', 'abcd', '12 3'])
      expect(code(() => checkIdLast4(bad))).toBe('validation.failed');
  });

  it('resolves the house policy over the estate defaults (180 s, guard_calls)', () => {
    const defaults = { timeoutSeconds: 180, action: 'guard_calls' as const };
    expect(effectivePolicy(null, defaults)).toEqual({
      timeoutSeconds: 180,
      action: 'guard_calls',
      deliverySkipApproval: null,
      householdNote: null,
      custom: false,
    });
    expect(
      effectivePolicy({ timeoutSeconds: 60, action: 'deny', deliverySkipApproval: false }, defaults),
    ).toMatchObject({
      timeoutSeconds: 60,
      action: 'deny',
      deliverySkipApproval: false,
      custom: true,
    });
  });

  it('delivery skips the question by the house choice, else the estate drop point', () => {
    const p = effectivePolicy(null, { timeoutSeconds: 180, action: 'guard_calls' });
    expect(deliverySkipsApproval(p, true)).toBe(true);
    expect(deliverySkipsApproval(p, false)).toBe(false);
    expect(deliverySkipsApproval({ ...p, deliverySkipApproval: false }, true)).toBe(false);
    expect(deliverySkipsApproval({ ...p, deliverySkipApproval: true }, false)).toBe(true);
  });

  it('lets the guard stamp the entry only when the state allows it', () => {
    expect(entryAllowed('approved', null, null)).toEqual({ ok: true, override: false });
    expect(entryAllowed('timed_out', 'allow_and_log', null)).toEqual({ ok: true, override: false });
    expect(entryAllowed('timed_out', 'guard_calls', null)).toEqual({ ok: true, override: false });
    expect(entryAllowed('timed_out', 'deny', null)).toEqual({ ok: false, code: 'visit.denied' });
    expect(entryAllowed('denied', null, 'please')).toEqual({ ok: false, code: 'visit.denied' });
    expect(entryAllowed('requested', 'guard_calls', null)).toEqual({
      ok: false,
      code: 'visit.awaiting_answer',
    });
    expect(entryAllowed('requested', 'guard_calls', 'เจ้าของบ้านโทรมา')).toEqual({
      ok: true,
      override: true,
    });
    expect(entryAllowed('exited', null, null)).toEqual({ ok: false, code: 'visit.invalid_state' });
  });

  it('makes opaque invite tokens and hashes them stably', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).toMatch(/^gpv1\.[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(inviteTokenHash(a.token).equals(a.hash)).toBe(true);
    expect(inviteTokenHash(` ${a.token} `).equals(a.hash)).toBe(true);
  });

  it('compares and prints plates', () => {
    const p = { category: '1กข', number: '1234', province: 'กรุงเทพมหานคร' };
    expect(samePlate(p, { ...p })).toBe(true);
    expect(samePlate(p, { ...p, number: '1235' })).toBe(false);
    expect(samePlate(null, p)).toBe(false);
    expect(plateText({ category: '1กข', number: '1234', province: 'กรุงเทพมหานคร' })).toBe(
      '1กข 1234 กรุงเทพมหานคร',
    );
    expect(plateText({ number: null })).toBeNull();
  });

  it('J review A4 (D-336): arrears at the gate = overdue balances net of the payer credit, never a not-yet-due bill', () => {
    // a bill not yet due is not an arrear (it is not in the overdue rows at all)
    expect(unitsInArrears([], [])).toEqual(new Set());
    // overdue 1,500.00 with no credit → arrears
    expect(unitsInArrears([{ unitId: 'u1', partyId: 'p1', balance: '1500.00' }], [])).toEqual(
      new Set(['u1']),
    );
    // overdue fully covered by the payer's credit on that unit → none
    expect(
      unitsInArrears(
        [{ unitId: 'u1', partyId: 'p1', balance: '1500.00' }],
        [{ unitId: 'u1', partyId: 'p1', amount: '1500.00' }],
      ),
    ).toEqual(new Set());
    // credit of another payer of the unit does not settle this payer's overdue bill
    expect(
      unitsInArrears(
        [
          { unitId: 'u1', partyId: 'p1', balance: '100.00' },
          { unitId: 'u1', partyId: 'p1', balance: '0.50' },
        ],
        [
          { unitId: 'u1', partyId: 'p1', amount: '100.00' },
          { unitId: 'u1', partyId: 'p2', amount: '999.00' },
          { unitId: 'u2', partyId: 'p1', amount: '999.00' },
        ],
      ),
    ).toEqual(new Set(['u1']));
  });
});
