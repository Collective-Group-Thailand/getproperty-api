import { htmlToText } from '@common/text/html-text';

/** One clause of a template text: a `<section>` keyed by its `<h2>` heading (D-294). */
export interface Clause {
  key: string;
  title: string;
  html: string;
  text: string;
}

export type ClauseStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export interface ClauseDiff {
  key: string;
  title: string;
  status: ClauseStatus;
  baseText: string | null;
  text: string | null;
}

const SECTION = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
const HEADING = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i;

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Splits a template body into clauses. A clause is a `<section>` (the contract templates are written that way); its
 * key is the normalised text of its `<h2>`, else `section-<n>`; repeated keys get `#2`, `#3`. Text outside every
 * section (title, meta table, footer) is one clause `_frame` so an edit there shows up too.
 */
export function clausesOf(body: string): Clause[] {
  const out: Clause[] = [];
  const seen = new Map<string, number>();
  let frame = body;
  let n = 0;
  for (const m of body.matchAll(SECTION)) {
    n += 1;
    frame = frame.replace(m[0], '');
    const heading = HEADING.exec(m[1]!)?.[1];
    const title = heading ? htmlToText(heading) : `section ${n}`;
    let key = heading ? normalise(title) : `section-${n}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) key = `${key}#${count}`;
    out.push({ key, title, html: m[0], text: htmlToText(m[1]!) });
  }
  const frameText = htmlToText(frame);
  if (frameText) out.unshift({ key: '_frame', title: '', html: frame, text: frameText });
  return out;
}

/** Clause-level diff of an edited text against its base (order of the edited text, removed clauses after). */
export function diffClauses(base: string, edited: string): ClauseDiff[] {
  const before = new Map(clausesOf(base).map((c) => [c.key, c]));
  const after = clausesOf(edited);
  const out: ClauseDiff[] = after.map((c) => {
    const b = before.get(c.key);
    if (!b) return { key: c.key, title: c.title, status: 'added', baseText: null, text: c.text };
    return {
      key: c.key,
      title: c.title,
      status: normalise(b.html) === normalise(c.html) ? 'unchanged' : 'changed',
      baseText: b.text,
      text: c.text,
    };
  });
  const keys = new Set(after.map((c) => c.key));
  for (const b of before.values())
    if (!keys.has(b.key))
      out.push({ key: b.key, title: b.title, status: 'removed', baseText: b.text, text: null });
  return out;
}
