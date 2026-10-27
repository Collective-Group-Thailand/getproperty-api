import { type ContractKind } from '@generated/prisma/client';

import { clausesOf, diffClauses } from './contract-diff';
import { variableCatalogue } from './contract-kinds';
import { libraryTemplates } from './contract-library-templates';
import { STANDARD_TEMPLATE_BODY } from './contract-template';
import { checkTemplate, forbiddenFindings } from './contract-text-check';
import { landlordTemplates } from './landlord-templates';

describe('contract library (G3, D-294)', () => {
  it('every seeded template passes the structure check with only catalogue variables', () => {
    const all: { kind: ContractKind; body: string; key: string }[] = [
      { kind: 'lease_apartment_ocpb', body: STANDARD_TEMPLATE_BODY, key: 'standard' },
      ...landlordTemplates().map((t): { kind: ContractKind; body: string; key: string } => ({
        kind:
          t.kind === 'condo_unit' ? 'lease_condo_private' : t.kind === 'house' ? 'lease_house' : 'lease_room',
        body: t.body,
        key: `${t.key}/${t.language}`,
      })),
      ...libraryTemplates().map((t) => ({ kind: t.kind, body: t.body, key: `${t.key}/${t.language}` })),
    ];
    for (const t of all)
      expect({ key: t.key, ...checkTemplate(t.body, t.kind) }).toEqual({
        key: t.key,
        problems: [],
        unknownVariables: [],
      });
  });

  it('refuses unsafe HTML, unescaped output, partials, helpers and unknown variables', () => {
    const r = checkTemplate(
      '<section><h2>x</h2><script>alert(1)</script><p onclick="x()">{{{premises.unitNo}}}</p>{{> p}}{{#foo premises}}{{/foo}}{{lessee.bankAccount}}<img src="https://evil.example/x.png"></section>',
      'lease_apartment_ocpb',
    );
    const codes = r.problems.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['tag', 'attribute', 'unescaped', 'partial', 'helper']));
    expect(r.unknownVariables).toEqual(['lessee.bankAccount']);
    expect(checkTemplate('{{#if}', 'addendum').problems[0]!.code).toBe('syntax');
    // each blocks resolve item paths; another kind's block is unknown
    expect(
      checkTemplate('{{#each addendum.clauses}}{{this.title}}{{text}}{{/each}}', 'addendum').unknownVariables,
    ).toEqual([]);
    expect(checkTemplate('{{mandate.scope}}', 'addendum').unknownVariables).toEqual(['mandate.scope']);
    expect(variableCatalogue('co_broke').has('signatures.co_agency.imageDataUrl')).toBe(true);
  });

  it('diffs clause by clause (keyed by heading)', () => {
    const base = '<h1>T</h1><section><h2>A</h2><p>one</p></section><section><h2>B</h2><p>two</p></section>';
    const edited =
      '<h1>T</h1><section><h2>A</h2><p>one!</p></section><section><h2>C</h2><p>new</p></section>';
    expect(clausesOf(base).map((c) => c.key)).toEqual(['_frame', 'a', 'b']);
    expect(diffClauses(base, edited).map((d) => [d.key, d.status])).toEqual([
      ['_frame', 'unchanged'],
      ['a', 'changed'],
      ['c', 'added'],
      ['b', 'removed'],
    ]);
  });

  it('flags removed protections and added forbidden wording; block in scope, warn outside (D-158)', () => {
    const edited = STANDARD_TEMPLATE_BODY.replace(
      '<li>ผู้ให้เช่าจะไม่เรียกเก็บค่าต่อสัญญาเช่าจากผู้เช่ารายเดิม</li>',
      '<li>ผู้เช่าชำระค่าต่อสัญญา 1,000 บาท</li>',
    ).replace('<p>— ไม่มี —</p>', '<p>ผู้ให้เช่าเข้าห้องได้ตลอดเวลา</p>');
    const inScope = forbiddenFindings(STANDARD_TEMPLATE_BODY, edited, 'lease_apartment_ocpb', true);
    expect(inScope.map((f) => [f.clauseType, f.source, f.severity])).toEqual(
      expect.arrayContaining([
        ['renewal_fee', 'removed_protection', 'block'],
        ['renewal_fee', 'added_wording', 'block'],
        ['entry_without_notice', 'added_wording', 'block'],
      ]),
    );
    expect(inScope[0]!.legalRef).toContain('ข้อ 5 (');
    expect(
      forbiddenFindings(STANDARD_TEMPLATE_BODY, edited, 'lease_apartment_ocpb', false).every(
        (f) => f.severity === 'warn',
      ),
    ).toBe(true);
    // the unchanged base, a negated sentence and non-lease kinds have no findings
    expect(
      forbiddenFindings(STANDARD_TEMPLATE_BODY, STANDARD_TEMPLATE_BODY, 'lease_apartment_ocpb', true),
    ).toEqual([]);
    const negated = STANDARD_TEMPLATE_BODY.replace(
      '<p>— ไม่มี —</p>',
      '<p>ผู้ให้เช่าจะไม่ตัดน้ำ ตัดไฟ หรือเปลี่ยนกุญแจ</p>',
    );
    expect(forbiddenFindings(STANDARD_TEMPLATE_BODY, negated, 'lease_apartment_ocpb', true)).toEqual([]);
    expect(
      forbiddenFindings('<p>a</p>', '<section><h2>x</h2><p>renewal fee</p></section>', 'co_broke', true),
    ).toEqual([]);
  });
});
