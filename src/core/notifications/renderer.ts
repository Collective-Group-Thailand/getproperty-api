import { type TemplateFormat } from '@generated/prisma/client';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';

export interface RenderedMessage {
  format: TemplateFormat;
  subject: string | null;
  /** Plain text (SMS, LINE text, in-app, web push, email text part). */
  text: string;
  /** Email HTML (mjml / text formats rendered for email). */
  html?: string;
  /** LINE Flex `contents` for `line_flex_json`. */
  flex?: Record<string, unknown>;
}

export class TemplateRenderError extends Error {
  override name = 'TemplateRenderError';
}

const hb = Handlebars.create();
hb.registerHelper('money', (v: unknown) =>
  typeof v === 'string' || typeof v === 'number'
    ? Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '',
);
hb.registerHelper('date', (v: unknown) =>
  typeof v === 'string' ? new Date(v).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' }) : '',
);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlToText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A minimal, responsive wrapper for text templates sent by email. */
const textEmail = (subject: string, body: string) =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>` +
  `<body style="margin:0;padding:24px;font-family:Sarabun,Arial,sans-serif;color:#1f2933;background:#f5f7fa">` +
  `<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;line-height:1.6">${escapeHtml(body).replace(/\n/g, '<br>')}</div>` +
  `<p style="max-width:560px;margin:12px auto;font-size:12px;color:#7b8794">getproperty · Collective Group (Thailand)</p></body></html>`;

/**
 * Renders a template version (B1.3 notifications): Handlebars over the template data — text formats without HTML
 * escaping (SMS, LINE, in-app), `line_flex_json` rendered then parsed as the Flex `contents`, `mjml` rendered with
 * escaping and compiled to responsive HTML (email). Throws `TemplateRenderError` with the reason.
 */
export async function renderTemplate(
  template: { format: TemplateFormat; subject: string | null; body: string },
  data: Record<string, unknown>,
): Promise<RenderedMessage> {
  try {
    const subject = template.subject
      ? hb.compile(template.subject, { noEscape: true, strict: false })(data)
      : null;
    switch (template.format) {
      case 'plain':
        return { format: 'plain', subject, text: template.body };
      case 'handlebars_text': {
        const text = hb.compile(template.body, { noEscape: true })(data);
        return { format: 'handlebars_text', subject, text, html: textEmail(subject ?? 'getproperty', text) };
      }
      case 'line_flex_json': {
        const json = hb.compile(template.body, { noEscape: true })(data);
        const parsed = JSON.parse(json) as { altText?: string; contents?: Record<string, unknown> };
        if (!parsed.contents || typeof parsed.altText !== 'string')
          throw new TemplateRenderError('line_flex_json needs { altText, contents }');
        return { format: 'line_flex_json', subject, text: parsed.altText, flex: parsed.contents };
      }
      case 'mjml': {
        const markup = hb.compile(template.body)(data);
        const out = await mjml2html(markup, { validationLevel: 'strict', keepComments: false });
        if (out.errors.length)
          throw new TemplateRenderError(out.errors.map((e) => e.formattedMessage).join('; '));
        return { format: 'mjml', subject, text: htmlToText(out.html), html: out.html };
      }
    }
  } catch (error) {
    if (error instanceof TemplateRenderError) throw error;
    throw new TemplateRenderError((error as Error).message);
  }
}
