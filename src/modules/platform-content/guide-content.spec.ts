import { GUIDES } from '../../../prisma/seed/data/guides';
import { guideBodyProblems } from './guide-content';

const body = (sections: unknown, extra: Record<string, unknown> = {}) => ({
  sections,
  faq: [],
  sources: [],
  ...extra,
});

describe('guide body (D-271, the shared article shape of D-277)', () => {
  it('accepts every seeded guide', () => {
    for (const g of GUIDES) expect(guideBodyProblems(g)).toEqual([]);
    expect(GUIDES).toHaveLength(10);
    // both languages of a guide have the same sections and FAQ count
    for (const th of GUIDES.filter((g) => g.locale === 'th')) {
      const en = GUIDES.find((g) => g.locale === 'en' && g.slug === th.slug)!;
      expect(en.sections.map((s) => s.id)).toEqual(th.sections.map((s) => s.id));
      expect(en.faq).toHaveLength(th.faq.length);
    }
  });

  it('refuses blocks the page cannot draw, duplicate section ids and non-https sources', () => {
    expect(guideBodyProblems(body([]))).toEqual(['sections: 1 to 30 sections']);
    expect(
      guideBodyProblems(
        body([
          { id: 'a', heading: 'A', blocks: [{ p: 'x' }, { html: '<b>x</b>' }, { note: 'y', tone: 'loud' }] },
          { id: 'a', heading: 'B', blocks: [{ ul: [] }] },
        ]),
      ),
    ).toEqual([
      'sections.0.blocks.1: unknown block',
      'sections.0.blocks.2: note must be text with tone info | warning | product',
      'sections.1.id: duplicate',
      'sections.1.blocks.0: ul must be a list of text',
    ]);
    expect(
      guideBodyProblems(
        body([{ id: 'a', heading: 'A', blocks: [{ p: 'x' }] }], {
          sources: [{ label: 'x', url: 'http://x.example' }],
        }),
      ),
    ).toEqual(['sources.0: label and an https url']);
  });
});
