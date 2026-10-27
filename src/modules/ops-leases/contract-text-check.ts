import { htmlToText } from '@common/text/html-text';
import { type ContractKind } from '@generated/prisma/client';
import Handlebars from 'handlebars';

import { clausesOf, diffClauses } from './contract-diff';
import { CHECKED_KINDS, variableCatalogue } from './contract-kinds';
import { FORBIDDEN_CLAUSE_TYPES, type ForbiddenClauseType } from './contract-template';

/** A structural problem of a template text (422 `contract.template_invalid`). */
export interface TemplateProblem {
  path: string;
  code: string;
  message: string;
}

export interface TemplateCheck {
  problems: TemplateProblem[];
  unknownVariables: string[];
}

/** A forbidden clause type found in an edited text (D-020 ข้อ 5, D-158 scope, D-294). */
export interface ClauseFinding {
  clauseType: ForbiddenClauseType;
  clauseKey: string;
  clauseTitle: string;
  source: 'removed_protection' | 'added_wording';
  excerpt: string;
  legalRef: string;
  severity: 'block' | 'warn';
}

// ------------------------------------------------------------------------------------------------- structure

const TAGS = new Set([
  'article',
  'header',
  'footer',
  'section',
  'div',
  'span',
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'small',
  'sup',
  'sub',
  'ol',
  'ul',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'img',
  'hr',
]);
const ATTRS = new Set(['class', 'alt', 'colspan', 'rowspan', 'lang', 'src']);
const HELPERS = new Set(['if', 'unless', 'each', 'with']);
const DATA_VARS = new Set(['index', 'first', 'last', 'key']);
const MAX_BODY = 200_000;

function htmlProblems(body: string): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const bad = (code: string, message: string) => out.push({ path: 'bodyHtml', code, message });
  if (/<\s*[!?](?!--)/.test(body)) bad('tag', 'declarations and processing instructions are not allowed');
  for (const m of body.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const tag = m[1]!.toLowerCase();
    if (!TAGS.has(tag)) {
      bad('tag', `<${tag}> is not allowed in a contract text`);
      continue;
    }
    const attrs = m[2] ?? '';
    for (const a of attrs.matchAll(/([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const name = a[1]!.toLowerCase();
      const value = (a[2] ?? '').replace(/^["']|["']$/g, '');
      if (name.startsWith('{{') || name.endsWith('}}')) continue;
      if (!ATTRS.has(name)) bad('attribute', `attribute "${name}" is not allowed (<${tag}>)`);
      else if (name === 'src' && (tag !== 'img' || !/^\{\{[^{}]+\}\}$/.test(value.trim())))
        bad(
          'attribute',
          'an image source may only be a signature variable ({{signatures.<role>.imageDataUrl}})',
        );
      else if (/javascript:|url\s*\(|expression\s*\(/i.test(value))
        bad('attribute', `unsafe value of "${name}"`);
    }
  }
  return out;
}

type Node = hbs.AST.Node & Record<string, unknown>;

/**
 * Structure of a template text (D-294): an HTML whitelist (no scripts, styles, links, event handlers or remote
 * images — the text is rendered to PDF by a browser), valid Handlebars without unescaped output, partials or helpers
 * other than if / unless / each / with, and only variables of the kind's catalogue.
 */
export function checkTemplate(body: string, kind: ContractKind): TemplateCheck {
  const problems =
    body.length > MAX_BODY ? [{ path: 'bodyHtml', code: 'max', message: 'the text is too long' }] : [];
  problems.push(...htmlProblems(body));
  let program: hbs.AST.Program;
  try {
    program = Handlebars.parse(body);
  } catch (error) {
    problems.push({ path: 'bodyHtml', code: 'syntax', message: (error as Error).message.split('\n')[0]! });
    return { problems, unknownVariables: [] };
  }
  const catalogue = variableCatalogue(kind);
  const unknown = new Set<string>();
  const bad = (code: string, message: string) => problems.push({ path: 'bodyHtml', code, message });

  const resolve = (p: hbs.AST.PathExpression, stack: string[]): string | null => {
    if (p.data) {
      const [head, ...rest] = p.parts;
      if (head === 'root') return rest.join('.');
      if (DATA_VARS.has(String(head)) && rest.length === 0) return null;
      unknown.add(`@${p.parts.join('.')}`);
      return null;
    }
    const ctx = stack[Math.max(0, stack.length - 1 - p.depth)] ?? '';
    const parts = p.parts.join('.');
    if (!parts) return ctx;
    return ctx ? `${ctx}.${parts}` : parts;
  };
  const variable = (p: hbs.AST.Expression, stack: string[]): string | null => {
    if (p.type !== 'PathExpression') {
      if (p.type === 'SubExpression') bad('helper', 'sub-expressions are not allowed');
      return null;
    }
    const path = resolve(p as hbs.AST.PathExpression, stack);
    if (path !== null && path !== '' && !catalogue.has(path)) unknown.add(path);
    return path;
  };
  const walk = (node: Node | null | undefined, stack: string[]): void => {
    if (!node) return;
    switch (node.type) {
      case 'Program':
        for (const s of (node as unknown as hbs.AST.Program).body) walk(s as Node, stack);
        return;
      case 'MustacheStatement': {
        const m = node as unknown as hbs.AST.MustacheStatement;
        if (!m.escaped) bad('unescaped', 'unescaped output ({{{ }}} or {{& }}) is not allowed');
        if (m.params.length || (m.hash?.pairs.length ?? 0))
          bad('helper', 'helpers are not allowed in a value');
        variable(m.path, stack);
        return;
      }
      case 'BlockStatement': {
        const b = node as unknown as hbs.AST.BlockStatement;
        const name = b.path.type === 'PathExpression' ? b.path.original : '';
        if (!HELPERS.has(name) || b.params.length !== 1) {
          bad('helper', `block "${name}" is not allowed (if, unless, each, with)`);
          return;
        }
        const target = variable(b.params[0]!, stack);
        const inner =
          name === 'each' && target !== null
            ? [...stack, `${target}[]`]
            : name === 'with' && target
              ? [...stack, target]
              : stack;
        walk(b.program as unknown as Node, inner);
        walk(b.inverse as unknown as Node, stack);
        return;
      }
      case 'PartialStatement':
      case 'PartialBlockStatement':
        bad('partial', 'partials are not allowed');
        return;
      case 'DecoratorBlock':
      case 'Decorator':
        bad('helper', 'decorators are not allowed');
        return;
      default:
        return;
    }
  };
  walk(program as unknown as Node, ['']);
  return { problems, unknownVariables: [...unknown].sort() };
}

// ------------------------------------------------------------------------------------------------- forbidden clauses

interface Rule {
  type: ForbiddenClauseType;
  /** Protective wording a base text carries; removing it is a finding. */
  guard?: RegExp;
  /** Forbidden wording; adding it (not negated) is a finding. */
  wording?: RegExp;
}

/** ⚖ O-030: text rules per forbidden clause type of the announcement (ข้อ 5 (1)–(12)), Thai and English. */
const RULES: Rule[] = [
  {
    type: 'liability_exclusion',
    wording:
      /ไม่รับผิด(ชอบ)?\s*(ใดๆ|ใด ๆ|ทุกกรณี)|ยกเว้นความรับผิด|not (be )?(liable|responsible) (for|in) any|exclud\w* (all )?liability/i,
  },
  {
    type: 'excess_deposit',
    wording:
      /(เงินประกัน|มัดจำ)[^\n]{0,40}?(สี่|ห้า|หก|[4-9]|1\d)\s*เดือน|deposit[^\n]{0,40}?(four|five|six|[4-9]|1\d) months/i,
  },
  {
    type: 'midterm_increase',
    guard: /จะไม่เปลี่ยนแปลงอัตราค่าเช่า|ไม่ปรับค่าเช่าก่อนสัญญาสิ้นสุด|will not (change|increase) the rent/i,
    wording:
      /(ปรับ|ขึ้น)(อัตรา)?ค่าเช่า[^\n]{0,30}?(ระหว่างสัญญา|ได้ตลอด|ทุก\s*\d+\s*เดือน|ตามที่ผู้ให้เช่า)|(increase|change) the rent (at any time|during the (term|lease))/i,
  },
  {
    type: 'forfeiture_without_breach',
    guard: /ไม่ริบเงินประกัน|not forfeit/i,
    wording:
      /ริบ(เงินประกัน|เงินมัดจำ|มัดจำ|ค่าเช่าล่วงหน้า)\s*(ทั้งหมด|ทันที|ได้ทุกกรณี)|forfeit (the|all|any) deposit/i,
  },
  {
    type: 'entry_without_notice',
    guard: /ไม่เข้าไปในห้องเช่าโดยไม่แจ้ง|not enter[^\n]{0,40}without/i,
    wording:
      /เข้า(ไป|ตรวจ)?(ใน)?ห้อง(เช่า)?(ได้)?\s*(ตลอดเวลา|ทุกเวลา|โดยไม่ต้องแจ้ง)|enter the (premises|unit|room) (at any time|without (prior )?notice)/i,
  },
  {
    type: 'utility_above_tariff',
    guard: /ไม่เกินอัตราที่|not (exceed|above) the rates?/i,
    wording: /ค่าไฟ(ฟ้า)?\s*(หน่วยละ|ยูนิตละ)\s*\d|electricity (at|of) THB ?\d+(\.\d+)? per unit/i,
  },
  {
    type: 'normal_wear_liability',
    guard: /ไม่หักค่าเสื่อมสภาพ|not deduct[^\n]{0,30}wear/i,
    wording:
      /(รับผิด|ชดใช้|หัก)[^\n]{0,30}?(เสื่อมสภาพ|สึกหรอ)(ตามปกติ|จากการใช้งาน)|(liable|pay|charged?) for (normal |fair )?wear and tear/i,
  },
  {
    type: 'defect_liability',
    guard: /ผู้ให้เช่ารับผิดในความชำรุดบกพร่อง|lessor is liable for (the )?defects/i,
    wording:
      /ผู้เช่า(ต้อง)?(รับผิดชอบ|ซ่อม)[^\n]{0,30}?ความชำรุดบกพร่อง|(tenant|lessee) (shall|must) repair all defects/i,
  },
  {
    type: 'termination_without_breach',
    wording:
      /ผู้ให้เช่า[^\n]{0,20}?บอกเลิกสัญญา(ได้)?\s*(ทันที|ทุกเมื่อ|โดยไม่ต้อง(มี)?เหตุ)|lessor may terminate[^\n]{0,30}?(at any time|without cause)/i,
  },
  {
    type: 'lockout_or_removal',
    guard: /ไม่ตัดน้ำ|will not cut/i,
    wording:
      /ตัดน้ำ|ตัดไฟ|ล็อก(ห้อง|ประตู)|เปลี่ยนกุญแจ|ขนย้ายทรัพย์สิน|(cut|disconnect) (off )?(the )?(water|electricity|power)|lock (the )?(tenant|lessee) out|change the locks|remove the (tenant|lessee)'?s? (belongings|property)/i,
  },
  {
    type: 'renewal_fee',
    guard: /ไม่เรียกเก็บค่าต่อสัญญา|ไม่มีค่าต่อสัญญา|no renewal fee|not charge[^\n]{0,20}renewal/i,
    wording: /ค่า(ธรรมเนียม)?(การ)?ต่อสัญญา|renewal fee/i,
  },
  {
    type: 'future_terms',
    wording:
      /(ข้อกำหนด|ระเบียบ)ที่(จะ)?(ออก|กำหนด)(ภายหลัง|ในอนาคต)|rules (issued|made|set) (later|in the future)/i,
  },
];

const NEGATION = /(ไม่|มิได้|ห้าม|\bnot\b|\bnever\b|\bno\b|n't)/i;

/** The legal reference of a forbidden clause type: its item of ข้อ 5 (⚖ pending counsel, O-030). */
export function clauseLegalRef(type: ForbiddenClauseType): string {
  const n = FORBIDDEN_CLAUSE_TYPES.indexOf(type) + 1;
  return `ประกาศคณะกรรมการว่าด้วยสัญญา เรื่อง ให้ธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา พ.ศ. 2568 ข้อ 5 (${n}) ⚖`;
}

/** Non-negated matches of a rule in a text (the 40 characters before a match decide; a line break ends it). */
function hits(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const before =
      text
        .slice(Math.max(0, m.index - 40), m.index)
        .split('\n')
        .pop() ?? '';
    if (!NEGATION.test(before)) out.push(m[0]);
  }
  return out;
}

/**
 * Forbidden clause types in an edited text compared with its base (D-020, D-294): protective wording of the base
 * that is gone, and forbidden wording that is new (not negated, not already in the same clause of the base). Only for
 * residential lease texts, their addenda and notice texts; `inScope` (D-158) makes every finding blocking.
 */
export function forbiddenFindings(
  base: string,
  edited: string,
  kind: ContractKind,
  inScope: boolean,
): ClauseFinding[] {
  if (!CHECKED_KINDS.includes(kind)) return [];
  const severity = inScope ? 'block' : 'warn';
  const out: ClauseFinding[] = [];
  const baseText = htmlToText(base);
  const editedText = htmlToText(edited);
  for (const rule of RULES) {
    if (rule.guard && rule.guard.test(baseText) && !rule.guard.test(editedText)) {
      const clause = clausesOf(base).find((c) => rule.guard!.test(c.text));
      out.push({
        clauseType: rule.type,
        clauseKey: clause?.key ?? '_frame',
        clauseTitle: clause?.title ?? '',
        source: 'removed_protection',
        excerpt: (rule.guard.exec(baseText)?.[0] ?? '').slice(0, 200),
        legalRef: clauseLegalRef(rule.type),
        severity,
      });
    }
  }
  const baseClauses = new Map(clausesOf(base).map((c) => [c.key, c.text]));
  for (const d of diffClauses(base, edited)) {
    if (d.status !== 'added' && d.status !== 'changed') continue;
    for (const rule of RULES) {
      if (!rule.wording) continue;
      const known = new Set(hits(rule.wording, baseClauses.get(d.key) ?? ''));
      const found = hits(rule.wording, d.text ?? '').filter((h) => !known.has(h));
      if (found.length)
        out.push({
          clauseType: rule.type,
          clauseKey: d.key,
          clauseTitle: d.title,
          source: 'added_wording',
          excerpt: found[0]!.slice(0, 200),
          legalRef: clauseLegalRef(rule.type),
          severity,
        });
    }
  }
  return out;
}
