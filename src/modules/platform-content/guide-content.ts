/**
 * The guide body of D-271 — the article of `@collective/content` (D-277): sections of blocks, FAQ and sources. The
 * rules mirror that package's `validateArticle` (the API does not depend on it while it pulls `@collective/web-kit`):
 * the web renders whatever is stored, so a block the page cannot draw is refused here.
 */
export type GuideBlock =
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { note: string; tone?: 'info' | 'warning' | 'product' }
  | { affiliate: { name: string; url: string; merchant: string; why: string; imageUrl?: string } };

export interface GuideSection {
  id: string;
  heading: string;
  blocks: GuideBlock[];
}

export interface GuideBody {
  sections: GuideSection[];
  faq: { q: string; a: string }[];
  sources: { label: string; url: string }[];
}

const SECTION_ID = /^[a-z0-9-]{1,40}$/;
const HTTPS = /^https:\/\/\S+$/;
const TEXT_MAX = 4000;

const isText = (v: unknown, max = TEXT_MAX): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= 30 && v.every((x) => isText(x));
const onlyKeys = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

function blockProblem(b: unknown, at: string): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return `${at}: not a block`;
  const o = b as Record<string, unknown>;
  if ('p' in o) return onlyKeys(o, ['p']) && isText(o.p) ? null : `${at}: p must be text`;
  if ('ul' in o) return onlyKeys(o, ['ul']) && isList(o.ul) ? null : `${at}: ul must be a list of text`;
  if ('ol' in o) return onlyKeys(o, ['ol']) && isList(o.ol) ? null : `${at}: ol must be a list of text`;
  if ('note' in o)
    return onlyKeys(o, ['note', 'tone']) &&
      isText(o.note) &&
      (o.tone === undefined || o.tone === 'info' || o.tone === 'warning' || o.tone === 'product')
      ? null
      : `${at}: note must be text with tone info | warning | product`;
  if ('affiliate' in o) {
    const a = o.affiliate as Record<string, unknown> | null;
    const ok =
      onlyKeys(o, ['affiliate']) &&
      a !== null &&
      typeof a === 'object' &&
      onlyKeys(a, ['name', 'url', 'merchant', 'why', 'imageUrl']) &&
      isText(a.name, 200) &&
      typeof a.url === 'string' &&
      HTTPS.test(a.url) &&
      isText(a.merchant, 100) &&
      isText(a.why, 500) &&
      (a.imageUrl === undefined || (typeof a.imageUrl === 'string' && HTTPS.test(a.imageUrl)));
    return ok ? null : `${at}: affiliate needs name, https url, merchant and why`;
  }
  return `${at}: unknown block`;
}

/** The problems of a guide body as readable lines (empty = valid). */
export function guideBodyProblems(body: { sections?: unknown; faq?: unknown; sources?: unknown }): string[] {
  const problems: string[] = [];
  const sections = body.sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 30) {
    problems.push('sections: 1 to 30 sections');
  } else {
    const ids = new Set<string>();
    sections.forEach((s: unknown, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || !SECTION_ID.test(o.id))
        problems.push(`sections.${i}.id: lowercase letters, digits, -`);
      else if (ids.has(o.id)) problems.push(`sections.${i}.id: duplicate`);
      else ids.add(o.id);
      if (!isText(o.heading, 200)) problems.push(`sections.${i}.heading: required`);
      if (!Array.isArray(o.blocks) || o.blocks.length === 0 || o.blocks.length > 40)
        problems.push(`sections.${i}.blocks: 1 to 40 blocks`);
      else
        o.blocks.forEach((b: unknown, j) => {
          const p = blockProblem(b, `sections.${i}.blocks.${j}`);
          if (p) problems.push(p);
        });
    });
  }
  if (!Array.isArray(body.faq) || body.faq.length > 30) problems.push('faq: at most 30 questions');
  else
    body.faq.forEach((f: unknown, i) => {
      const o = (f ?? {}) as Record<string, unknown>;
      if (!isText(o.q, 300) || !isText(o.a, 2000) || !onlyKeys(o, ['q', 'a']))
        problems.push(`faq.${i}: q and a`);
    });
  if (!Array.isArray(body.sources) || body.sources.length > 30) problems.push('sources: at most 30 sources');
  else
    body.sources.forEach((s: unknown, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      if (
        !isText(o.label, 200) ||
        typeof o.url !== 'string' ||
        !HTTPS.test(o.url) ||
        !onlyKeys(o, ['label', 'url'])
      )
        problems.push(`sources.${i}: label and an https url`);
    });
  return problems;
}
