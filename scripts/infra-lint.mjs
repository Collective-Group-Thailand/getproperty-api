// `pnpm infra:lint` — structural lint of infra/terraform when no terraform binary is available (B6.5).
// It is not `terraform validate`: it checks that every file has balanced braces / brackets / quotes, that each
// module call points at an existing module whose variables it satisfies (no unknown argument, every variable
// without a default provided), that every `var.x` / `module.x` / `local.x` reference is declared, and that the
// dev / uat / prod var files exist and set every root variable without a default. CI runs
// `terraform fmt -check -recursive && terraform validate` on top of it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'infra/terraform');
const errors = [];
const fail = (file, msg) => errors.push(`${relative(process.cwd(), file)}: ${msg}`);

/** Strips comments and blanks brackets inside strings, so structure can be scanned. */
function strip(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  let depthInterp = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (!inStr && (c === '#' || (c === '/' && n === '/'))) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (!inStr && c === '/' && n === '*') {
      i = src.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '$' && n === '{') {
        depthInterp += 1;
        out += '${';
        i += 2;
        continue;
      }
      if (depthInterp > 0) {
        if (c === '}') depthInterp -= 1;
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') inStr = false;
      out += '{}[]()'.includes(c) ? ' ' : c;
      i += 1;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
    i += 1;
  }
  if (inStr) return { text: out, unterminated: true };
  return { text: out, unterminated: false };
}

function balanced(file, text) {
  const pairs = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  for (const c of text) {
    if ('{[('.includes(c)) stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) return fail(file, `unbalanced "${c}"`);
  }
  if (stack.length) fail(file, `unclosed "${stack.at(-1)}"`);
}

/** Top-level blocks: `type "label" "label" { body }`. */
function blocks(text) {
  const re = /^([a-z_]+)((?:\s+"[^"]*")*)\s*\{/gm;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let j = re.lastIndex;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({
      type: m[1],
      labels: [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]),
      body: text.slice(re.lastIndex, j - 1),
    });
    re.lastIndex = j;
  }
  return out;
}

/** Arguments set at the top level of a block body (depth 0). */
function topArgs(body) {
  const args = new Set();
  let depth = 0;
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = /^\s*([a-z_][a-z0-9_]*)\s*=/.exec(line);
      if (m) args.add(m[1]);
    }
    for (const c of line) {
      if ('{[('.includes(c)) depth += 1;
      else if ('}])'.includes(c)) depth -= 1;
    }
  }
  return args;
}

function readDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => join(dir, f));
  const parsed = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const { text, unterminated } = strip(raw);
    if (unterminated) fail(file, 'unterminated string');
    balanced(file, text);
    parsed.push({ file, raw, text, blocks: blocks(text) });
  }
  return parsed;
}

function lintModule(dir) {
  const files = readDir(dir);
  const all = files.flatMap((f) => f.blocks.map((b) => ({ ...b, file: f.file })));
  const variables = new Map(
    all
      .filter((b) => b.type === 'variable')
      .map((b) => [b.labels[0], { required: !topArgs(b.body).has('default') }]),
  );
  const modules = all.filter((b) => b.type === 'module');
  const locals = new Set(all.filter((b) => b.type === 'locals').flatMap((b) => [...topArgs(b.body)]));
  for (const f of files) {
    for (const m of f.raw.matchAll(/\bvar\.([a-z_][a-z0-9_]*)/g))
      if (!variables.has(m[1])) fail(f.file, `var.${m[1]} is not declared`);
    for (const m of f.raw.matchAll(/\bmodule\.([a-z_][a-z0-9_]*)/g))
      if (!modules.some((b) => b.labels[0] === m[1])) fail(f.file, `module.${m[1]} is not declared`);
    for (const m of f.raw.matchAll(/\blocal\.([a-z_][a-z0-9_]*)/g))
      if (!locals.has(m[1])) fail(f.file, `local.${m[1]} is not declared`);
  }
  for (const m of modules) {
    const source = /source\s*=\s*"([^"]+)"/.exec(m.body)?.[1];
    if (!source) {
      fail(m.file, `module ${m.labels[0]} has no source`);
      continue;
    }
    const target = resolve(dir, source);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      fail(m.file, `module ${m.labels[0]}: ${source} does not exist`);
      continue;
    }
    const child = lintModule(target);
    const args = topArgs(m.body);
    for (const a of args)
      if (
        !['source', 'depends_on', 'count', 'for_each', 'providers', 'version'].includes(a) &&
        !child.variables.has(a)
      )
        fail(m.file, `module ${m.labels[0]}: unknown argument ${a}`);
    for (const [name, v] of child.variables)
      if (v.required && !args.has(name)) fail(m.file, `module ${m.labels[0]}: missing required ${name}`);
  }
  // outputs referenced as module.<name>.<output> must exist in that module
  for (const f of files)
    for (const r of f.raw.matchAll(/\bmodule\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/g)) {
      const m = modules.find((b) => b.labels[0] === r[1]);
      const source = m && /source\s*=\s*"([^"]+)"/.exec(m.body)?.[1];
      if (!source) continue;
      const outputs = readDir(resolve(dir, source)).flatMap((x) =>
        x.blocks.filter((b) => b.type === 'output').map((b) => b.labels[0]),
      );
      if (!outputs.includes(r[2])) fail(f.file, `module.${r[1]}.${r[2]}: no such output`);
    }
  return { variables };
}

if (!existsSync(root)) {
  console.error(`infra:lint: ${root} not found`);
  process.exit(1);
}
const { variables } = lintModule(root);
for (const env of ['dev', 'uat', 'prod']) {
  const file = join(root, 'envs', `${env}.tfvars`);
  if (!existsSync(file)) {
    fail(file, 'missing workspace var file');
    continue;
  }
  const { text } = strip(readFileSync(file, 'utf8'));
  balanced(file, text);
  const set = topArgs(text);
  for (const [name, v] of variables) if (v.required && !set.has(name)) fail(file, `does not set ${name}`);
  for (const a of set) if (!variables.has(a)) fail(file, `sets undeclared ${a}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`infra:lint ok (${root})`);
