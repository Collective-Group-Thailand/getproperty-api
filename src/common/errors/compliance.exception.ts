import { DomainException, type DomainExceptionOptions } from './domain.exception';
import { type ComplianceCode } from './error-codes';

export interface ComplianceRuleRef {
  /** Rule id in the compliance registry (B4.1); defaults to the code. */
  ruleId?: string;
  /** The legal text the rule implements, e.g. the สคบ. 2568 announcement clause (D-020). */
  legalRef: string;
}

/**
 * A refusal of the compliance engine (D-020–D-025; CLAUDE.md "Compliance before convenience").
 * Always a `compliance.*` code and always published with `legalRef` (contract §3), so a resident or
 * an owner can see which law the platform applied. The rule registry itself arrives in B4.1; this
 * class exists from B1.1 so every later module throws the same shape.
 */
export class ComplianceException extends DomainException {
  readonly legalRef: string;
  readonly ruleId: string;

  constructor(
    code: ComplianceCode,
    rule: ComplianceRuleRef,
    options: Omit<DomainExceptionOptions, 'extensions'> = {},
  ) {
    const ruleId = rule.ruleId ?? code;
    super(code, { ...options, extensions: { legalRef: rule.legalRef, ruleId } });
    this.name = 'ComplianceException';
    this.legalRef = rule.legalRef;
    this.ruleId = ruleId;
  }
}
