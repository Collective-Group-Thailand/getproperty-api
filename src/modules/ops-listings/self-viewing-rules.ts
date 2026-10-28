/**
 * Pure rules of G7 self-viewing (D-289 (1), D-295). A verified prospect views a vacant unit alone with a door code
 * that opens only inside a short window around the booked slot; the code is shown only inside that window and is
 * never stored in clear outside the encrypted credential. Every number is a setting (D-291).
 */

export const MINUTE_MS = 60_000;

export interface SelfViewingSettings {
  /** `viewing.self.code_minutes`: the code opens the door until slot start + this. */
  codeMinutes: number;
  /** `viewing.self.code_early_minutes`: the code opens the door from slot start − this. */
  earlyMinutes: number;
}

export interface VisitorTerms {
  version: number;
  th: string;
  en: string;
}

/** What a prospect still lacks for a self viewing (in this order). */
export type SelfViewingRequirement = 'identity' | 'phone' | 'terms';

/**
 * The door-code window of a slot: from `earlyMinutes` before the start to `codeMinutes` after it (the code is for
 * entering; a visitor already inside leaves without it).
 */
export function codeWindow(slotStart: Date, s: SelfViewingSettings): { validFrom: Date; validTo: Date } {
  return {
    validFrom: new Date(slotStart.getTime() - s.earlyMinutes * MINUTE_MS),
    validTo: new Date(slotStart.getTime() + s.codeMinutes * MINUTE_MS),
  };
}

/** Whether the code may be shown (and used) at `now`: inside [validFrom, validTo). */
export function insideWindow(window: { validFrom: Date; validTo: Date }, now: Date): boolean {
  return now.getTime() >= window.validFrom.getTime() && now.getTime() < window.validTo.getTime();
}

/** The requirements a prospect has not met yet (empty = may book a self viewing). */
export function missingRequirements(input: {
  identityVerified: boolean;
  phoneVerified: boolean;
  termsVersion: number | null | undefined;
  currentTermsVersion: number;
}): SelfViewingRequirement[] {
  const missing: SelfViewingRequirement[] = [];
  if (!input.identityVerified) missing.push('identity');
  if (!input.phoneVerified) missing.push('phone');
  if (input.termsVersion == null) missing.push('terms');
  return missing;
}

/** True when an accepted terms version is older than the one in force (a new acceptance is needed). */
export function termsOutdated(accepted: number | null | undefined, current: number): boolean {
  return accepted != null && accepted !== current;
}

/** A visitor who entered and did not confirm leaving is overstaying `overstayMinutes` after the window ended. */
export function overstaying(
  access: { enteredAt: Date | null; exitedAt: Date | null; validTo: Date },
  now: Date,
  overstayMinutes: number,
): boolean {
  if (!access.enteredAt || access.exitedAt) return false;
  return now.getTime() >= access.validTo.getTime() + overstayMinutes * MINUTE_MS;
}

/** How an access window that ended without leaving ends: entered → `expired`, never entered → `no_show`. */
export function endStateAfterWindow(access: { enteredAt: Date | null }): 'expired' | 'no_show' {
  return access.enteredAt ? 'expired' : 'no_show';
}

/** Parses the `viewing.self.visitor_terms` setting (null when it is malformed). */
export function visitorTerms(value: unknown): VisitorTerms | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  if (!Number.isInteger(v.version) || (v.version as number) <= 0) return null;
  if (typeof v.th !== 'string' || typeof v.en !== 'string') return null;
  return { version: v.version as number, th: v.th, en: v.en };
}
