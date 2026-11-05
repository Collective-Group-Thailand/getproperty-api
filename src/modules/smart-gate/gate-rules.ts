import { createHash, randomBytes } from 'node:crypto';

import { DomainException } from '@common/errors/domain.exception';

/**
 * Pure rules of the gate (D-315, D-327, J4.1): plate and ID-digit validation, the house-policy defaults, visit state
 * transitions and the invite QR token. No I/O — unit-tested in `gate-rules.spec.ts`.
 */

export type VisitKindName = 'guest' | 'delivery' | 'contractor' | 'resident_vehicle' | 'other';
export type VisitStateName =
  'requested' | 'approved' | 'denied' | 'timed_out' | 'entered' | 'exited' | 'cancelled';
export type PolicyActionName = 'allow_and_log' | 'deny' | 'guard_calls';

export interface PlateInput {
  category?: string | null;
  number?: string | null;
  province?: string | null;
}

export interface Plate {
  category: string;
  number: string;
  province: string;
}

const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** Thai plate category: up to 4 characters of digits and Thai consonants with at least one consonant ("1กข", "กข"). */
const CATEGORY = /^[0-9ก-ฮ]{1,4}$/;
const HAS_CONSONANT = /[ก-ฮ]/;

/**
 * A full plate (category + number + province) or none at all. Spaces and dashes are dropped; the number is 1–4
 * digits; the province 1–60 characters (the web picks it from its list). A partial plate is refused.
 */
export function normalisePlate(input: PlateInput | null | undefined, path = 'plate'): Plate | null {
  if (!input) return null;
  const category = (input.category ?? '').replace(/[\s-]/g, '');
  const number = (input.number ?? '').replace(/[\s-]/g, '');
  const province = (input.province ?? '').trim().replace(/\s+/g, ' ');
  if (!category && !number && !province) return null;
  if (!CATEGORY.test(category) || !HAS_CONSONANT.test(category))
    throw invalid(`${path}.category`, 'plate', 'Thai plate category: 1–4 digits / Thai consonants');
  if (!/^[0-9]{1,4}$/.test(number)) throw invalid(`${path}.number`, 'plate', 'plate number: 1–4 digits');
  if (province.length < 1 || province.length > 60)
    throw invalid(`${path}.province`, 'plate', 'province: 1–60 characters');
  return { category, number, province };
}

/** D-315: the last 4 digits of an ID document — exactly four digits, never more (the full number is never taken). */
export function checkIdLast4(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^[0-9]{4}$/.test(value)) throw invalid('idLast4', 'id_last4', 'exactly the last 4 digits');
  return value;
}

export interface HousePolicy {
  timeoutSeconds: number;
  action: PolicyActionName;
  deliverySkipApproval: boolean | null;
  householdNote: string | null;
}

/** The unit's policy, or the estate defaults (`gate.policy.timeout_seconds`, `gate.policy.action`). */
export function effectivePolicy(
  row: Partial<HousePolicy> | null | undefined,
  defaults: { timeoutSeconds: number; action: PolicyActionName },
): HousePolicy & { custom: boolean } {
  return {
    timeoutSeconds: row?.timeoutSeconds ?? defaults.timeoutSeconds,
    action: row?.action ?? defaults.action,
    deliverySkipApproval: row?.deliverySkipApproval ?? null,
    householdNote: row?.householdNote ?? null,
    custom: Boolean(row),
  };
}

/** A delivery skips the approval when the house says so, else when the estate has a drop point. */
export function deliverySkipsApproval(policy: HousePolicy, estateDropPoint: boolean): boolean {
  return policy.deliverySkipApproval ?? estateDropPoint;
}

/**
 * May the guard record the entry now? approved → yes; timed_out with `allow_and_log` or `guard_calls` → yes (the guard
 * called, or the house lets visitors in and logs); timed_out with `deny`, denied, exited, cancelled → no; requested →
 * only as a guard override with a reason (D-315: never force every visit to wait for the owner).
 */
export function entryAllowed(
  state: VisitStateName,
  timeoutAction: PolicyActionName | null,
  overrideReason: string | null,
): { ok: true; override: boolean } | { ok: false; code: string } {
  if (state === 'approved') return { ok: true, override: false };
  if (state === 'timed_out')
    return timeoutAction === 'deny' ? { ok: false, code: 'visit.denied' } : { ok: true, override: false };
  if (state === 'requested')
    return overrideReason ? { ok: true, override: true } : { ok: false, code: 'visit.awaiting_answer' };
  if (state === 'denied') return { ok: false, code: 'visit.denied' };
  return { ok: false, code: 'visit.invalid_state' };
}

/** States a visit can be cancelled from (the visitor left before entering). */
export const CANCELLABLE: readonly VisitStateName[] = ['requested', 'approved', 'timed_out', 'denied'];

/** The state a timed-out visit gets and whether the guard is asked to call. */
export function timeoutOutcome(action: PolicyActionName): { state: 'timed_out'; guardCalls: boolean } {
  return { state: 'timed_out', guardCalls: action === 'guard_calls' };
}

export const INVITE_TOKEN_PREFIX = 'gpv1.';

/** A new invite QR token (`gpv1.<43 base64url chars>`) and its sha256. */
export function newInviteToken(): { token: string; hash: Buffer } {
  const token = `${INVITE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: inviteTokenHash(token) };
}

export function inviteTokenHash(token: string): Buffer {
  return createHash('sha256').update(token.trim()).digest();
}

/** Plates equal ignoring spaces and dashes. */
export function samePlate(a: Plate | null, b: Plate | null): boolean {
  return Boolean(a && b && a.category === b.category && a.number === b.number && a.province === b.province);
}

/** The plate on one line for the guard and the LINE message ("1กข 1234 กรุงเทพมหานคร"). */
export function plateText(p: PlateInput | null | undefined): string | null {
  if (!p?.number) return null;
  return [p.category, p.number, p.province].filter(Boolean).join(' ');
}
