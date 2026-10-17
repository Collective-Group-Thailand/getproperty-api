import { canSetStatusManually, expandUnitNo, patternProblems, UNIT_NO_PATTERN } from './unit-rules';

describe('unit rules (B2.1)', () => {
  it.each([
    ['vacant', 'inactive', true],
    ['vacant', 'maintenance', true],
    ['inactive', 'vacant', true],
    ['maintenance', 'vacant', true],
    ['inactive', 'maintenance', false],
    ['vacant', 'occupied', false],
    ['vacant', 'reserved', false],
    ['occupied', 'vacant', false],
    ['reserved', 'inactive', false],
  ] as const)('manual %s → %s allowed: %s', (from, to, ok) => {
    expect(canSetStatusManually(from, to)).toBe(ok);
  });

  it('expands unit number patterns', () => {
    expect(expandUnitNo('{building}-{floor}{nn}', { building: 'A', floor: 2, seq: 1 })).toBe('A-201');
    expect(expandUnitNo('A-{floor}{nn}', { building: 'X', floor: 12, seq: 7 })).toBe('A-1207');
    expect(expandUnitNo('{ff}{nnn}', { building: 'A', floor: 3, seq: 12 })).toBe('03012');
    expect(expandUnitNo('ห้อง {floor}/{n}', { building: 'A', floor: 1, seq: 9 })).toBe('ห้อง 1/9');
  });

  it('rejects patterns without sequence or floor, or with unknown tokens', () => {
    expect(patternProblems('{building}-{floor}{nn}')).toEqual([]);
    expect(patternProblems('{building}-{floor}')).toContain(
      'the pattern needs a sequence token such as {nn}',
    );
    expect(patternProblems('{building}-{nn}')).toContain('the pattern needs a floor token ({floor} or {ff})');
    expect(patternProblems('{floor}{nn}{x}')).toContain('unknown token in the pattern');
  });

  it('unit numbers allow Thai and Latin letters, digits and - _ . /', () => {
    for (const ok of ['A-201', 'ห้อง1', '12/3', 'B_1.2']) expect(UNIT_NO_PATTERN.test(ok)).toBe(true);
    for (const bad of ['', '-A', 'A;DROP', 'A'.repeat(21)]) expect(UNIT_NO_PATTERN.test(bad)).toBe(false);
  });
});
