/** Addendum clause types that are building rules the resident acknowledges (LIFF #8, D-203). */
export const RULE_CLAUSE_TYPES = [
  'house_rules',
  'pets',
  'smoking',
  'guests',
  'quiet_hours',
  'parking_rules',
  'waste',
] as const;

/** Lease states in which the resident may acknowledge the building rules. */
export const RULES_ACK_STATES = ['pending_signature', 'active', 'notice_given', 'ending'] as const;

/** The lease's addendum has at least one building-rules clause. */
export function hasRuleClauses(l: { addendum: unknown }): boolean {
  const clauses = (Array.isArray(l.addendum) ? l.addendum : []) as { type?: string }[];
  return clauses.some((c) => (RULE_CLAUSE_TYPES as readonly string[]).includes(c.type ?? ''));
}
