import { quietUntil } from './quiet-hours';
import { renderTemplate, TemplateRenderError } from './renderer';

const QUIET = { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' };

describe('quiet hours (default 21:00–08:00 Asia/Bangkok)', () => {
  it('holds a message sent at 22:30 until 08:00 the next morning', () => {
    expect(quietUntil(new Date('2026-11-01T15:30:00Z'), QUIET)?.toISOString()).toBe(
      '2026-11-02T01:00:00.000Z',
    );
  });
  it('holds at 06:15 until 08:00 the same morning', () => {
    expect(quietUntil(new Date('2026-11-01T23:15:00Z'), QUIET)?.toISOString()).toBe(
      '2026-11-02T01:00:00.000Z',
    );
  });
  it('sends at once during the day, and when the window is empty', () => {
    expect(quietUntil(new Date('2026-11-01T05:00:00Z'), QUIET)).toBeNull();
    expect(quietUntil(new Date('2026-11-01T15:30:00Z'), { ...QUIET, end: '21:00' })).toBeNull();
  });
});

describe('template renderer', () => {
  it('Handlebars text without HTML escaping, plus an HTML email wrapper', async () => {
    const r = await renderTemplate(
      { format: 'handlebars_text', subject: 'บิล {{n}}', body: 'ยอด {{amount}} <ตัวอย่าง>' },
      { n: 'INV-1', amount: '1,000.00' },
    );
    expect(r).toMatchObject({ subject: 'บิล INV-1', text: 'ยอด 1,000.00 <ตัวอย่าง>' });
    expect(r.html).toContain('&lt;ตัวอย่าง&gt;');
  });
  it('LINE Flex JSON needs altText and contents', async () => {
    const ok = await renderTemplate(
      {
        format: 'line_flex_json',
        subject: null,
        body: '{"altText":"บิล {{n}}","contents":{"type":"bubble"}}',
      },
      { n: 'INV-1' },
    );
    expect(ok).toMatchObject({ text: 'บิล INV-1', flex: { type: 'bubble' } });
    await expect(
      renderTemplate({ format: 'line_flex_json', subject: null, body: '{"x":1}' }, {}),
    ).rejects.toThrow(TemplateRenderError);
  });
  it('MJML compiles to responsive HTML and escapes data', async () => {
    const r = await renderTemplate(
      {
        format: 'mjml',
        subject: 'S',
        body: '<mjml><mj-body><mj-section><mj-column><mj-text>สวัสดี {{name}}</mj-text></mj-column></mj-section></mj-body></mjml>',
      },
      { name: '<b>x</b>' },
    );
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(r.text).toContain('สวัสดี');
  });
  it('a broken template is a render error', async () => {
    await expect(
      renderTemplate({ format: 'handlebars_text', subject: null, body: '{{#if}}' }, {}),
    ).rejects.toThrow(TemplateRenderError);
  });
});
