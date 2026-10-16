/**
 * Release hygiene, run in CI (`pnpm release:check`). Fails when production code (`src/`, not tests) carries
 * a debug marker (`[Dev]` / `[DEV]`, the word `mock`, `TODO-REMOVE`), a real-looking Thai id or phone in a
 * literal (PDPA, D-025), or a `console.*` call outside the entry points (pino is the only logger).
 * Allow a reviewed line with `// release-hygiene: allow`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Run from the repository root (`pnpm release:check`), compiled into dist/scripts.
const ROOT = process.cwd();

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function files(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue;
    if (statSync(path).isDirectory()) out.push(...files(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}

const isSource = (p: string) => /\.(ts|json)$/.test(p) && !/\.(spec|int-spec|e2e-spec)\.ts$/.test(p);
const ENTRY_POINTS = new Set(['src/main.ts', 'src/worker.ts', 'src/ingest.ts', 'src/instrument.ts']);
const MARKERS: { rule: string; pattern: RegExp }[] = [
  { rule: 'dev marker', pattern: /\[dev\]/i },
  { rule: 'mock marker', pattern: /\bmock\b(?!-up)/i },
  { rule: 'TODO-REMOVE marker', pattern: /TODO-REMOVE/ },
  // A 13-digit id that does not start with 0000 (the fake series) in a literal.
  { rule: 'real-looking 13-digit id', pattern: /['"`](?!0000)\d{13}['"`]/ },
  { rule: 'real-looking Thai phone', pattern: /['"`]0[689]\d(?!000)\d-?\d{3}-?\d{4}['"`]/ },
];

const allowed = (line: string) => line.includes('release-hygiene: allow');

export function check(root = ROOT): Finding[] {
  const findings: Finding[] = [];
  for (const path of files(join(root, 'src'), isSource)) {
    const rel = relative(root, path);
    const rules = ENTRY_POINTS.has(rel)
      ? MARKERS
      : [...MARKERS, { rule: 'console call', pattern: /\bconsole\.(log|error|warn|info|debug)\(/ }];
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (allowed(text)) return;
      for (const r of rules)
        if (r.pattern.test(text)) findings.push({ file: rel, line: i + 1, rule: r.rule, text: text.trim() });
    });
  }
  return findings;
}

if (require.main === module) {
  const findings = check();
  for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  if (findings.length > 0) {
    console.error(`release hygiene: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log('release hygiene: clean');
}
