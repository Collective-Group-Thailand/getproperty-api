import { settingValueProblems } from './setting-values';

describe('setting values are validated against the catalogue type', () => {
  it.each([
    ['int', 7, true],
    ['int', 7.5, false],
    ['money', '100.00', true],
    ['money', 100, false],
    ['decimal', '4.6189', true],
    ['bool', false, true],
    ['date', '2026-11-01', true],
    ['time', '21:00', true],
    ['time', '25:00', false],
    ['duration', 'P7D', true],
    ['duration', '7 days', false],
  ] as const)('%s %p → ok=%p', (valueType, value, ok) => {
    expect(settingValueProblems({ valueType }, value).length === 0).toBe(ok);
  });
  it('allowed values are a closed set', () => {
    expect(
      settingValueProblems({ valueType: 'string', allowedValues: ['warn', 'block'] } as never, 'off'),
    ).not.toHaveLength(0);
    expect(
      settingValueProblems({ valueType: 'string', allowedValues: ['warn', 'block'] } as never, 'warn'),
    ).toHaveLength(0);
  });
});
