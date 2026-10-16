import { type NextActionDto } from './next-action.dto';

/**
 * A rule offering one action: `when` is the endpoint's own state check — `true` offers it, `false` hides
 * it, a string offers it disabled with that reason; `permissions` are the endpoint's `@Can` (all-of).
 */
export interface ActionRule<T> {
  key: string;
  permissions?: readonly string[];
  irreversible?: boolean;
  when: (entity: T) => boolean | string;
}

/** The actions an actor holding `permissions` may take on `entity`, in rule order. */
export function nextActions<T>(
  entity: T,
  rules: readonly ActionRule<T>[],
  permissions: ReadonlySet<string>,
): NextActionDto[] {
  const out: NextActionDto[] = [];
  for (const rule of rules) {
    if (!(rule.permissions ?? []).every((p) => permissions.has(p))) continue;
    const verdict = rule.when(entity);
    if (verdict === false) continue;
    out.push({
      key: rule.key,
      irreversible: rule.irreversible ?? false,
      disabledReason: typeof verdict === 'string' ? verdict : null,
    });
  }
  return out;
}

/** No permission at all (a resident's own records are scoped by the lease, not permissions). */
export const NO_PERMISSIONS: ReadonlySet<string> = new Set();
