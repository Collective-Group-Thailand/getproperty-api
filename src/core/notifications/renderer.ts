import { type EmailBrand } from '@core/brand/platform-brand.service';
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
/** `{{json value}}` — a JSON literal (Flex templates embed objects built by the modules, B4.3). */
hb.registerHelper('json', (v: unknown) => JSON.stringify(v ?? null));
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

/** The brand of emails when the caller passes none (previews without the platform setting). */
export const DEFAULT_EMAIL_BRAND: EmailBrand = {
  name: 'getproperty',
  altText: 'getproperty',
  logoUrl: 'http://localhost:3000/brand/getproperty-logo-email.png',
  logoDarkUrl: 'http://localhost:3000/brand/getproperty-logo-white.png',
  ink: '#21365B',
  primary: '#1A4BA3',
};

/** Logo width in the email header (CSS px); the PNGs are rendered at ~5.5× for high-density screens. */
const LOGO_WIDTH = 160;

/**
 * The getproperty header of platform emails (D-232): the colour logo with its white halo, swapped for the white
 * logo by clients that honour `prefers-color-scheme: dark` (Apple Mail, iOS Mail, Outlook for Mac, Thunderbird) or
 * mark dark mode with `[data-ogsc]` (Outlook.com, Outlook apps); clients that darken the page without either keep
 * the haloed colour logo, which stays legible on dark. Images carry width, alt text and styled alt (images off).
 */
export function emailHeader(brand: EmailBrand): string {
  const img = (cls: string, src: string, hidden: boolean) =>
    `<img class="${cls}" src="${escapeHtml(src)}" width="${LOGO_WIDTH}" alt="${escapeHtml(brand.altText)}" ` +
    `style="${hidden ? 'display:none;' : 'display:block;'}border:0;outline:none;text-decoration:none;height:auto;width:${LOGO_WIDTH}px;max-width:${LOGO_WIDTH}px;font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:${brand.ink}">`;
  return (
    `<div class="gp-head" style="padding:20px 24px 14px;border-bottom:3px solid ${brand.primary}">` +
    img('gp-logo-light', brand.logoUrl, false) +
    `<!--[if !mso]><!-->${img('gp-logo-dark', brand.logoDarkUrl, true)}<!--<![endif]-->` +
    `</div>`
  );
}

/** Dark-mode rules of the email layout (`emailHeader`). */
export const EMAIL_DARK_CSS =
  ':root{color-scheme:light dark;supported-color-schemes:light dark}' +
  '@media (prefers-color-scheme: dark){' +
  '.gp-bg{background:#0f1724 !important}.gp-card{background:#1b2433 !important;color:#e5e9f0 !important}' +
  '.gp-muted{color:#9aa5b1 !important}.gp-logo-light{display:none !important}' +
  '.gp-logo-dark{display:block !important}}' +
  '[data-ogsc] .gp-logo-light{display:none !important}[data-ogsc] .gp-logo-dark{display:block !important}';

/** A minimal, responsive wrapper for text templates sent by email: brand header, the text, the operator line. */
const textEmail = (subject: string, body: string, brand: EmailBrand) =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
  `<title>${escapeHtml(subject)}</title><style>${EMAIL_DARK_CSS}</style></head>` +
  `<body class="gp-bg" style="margin:0;padding:24px;font-family:Sarabun,Arial,sans-serif;color:#1f2933;background:#f5f7fa">` +
  `<div class="gp-card" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden">` +
  emailHeader(brand) +
  `<div style="padding:24px;line-height:1.6">${escapeHtml(body).replace(/\n/g, '<br>')}</div></div>` +
  `<p class="gp-muted" style="max-width:560px;margin:12px auto;font-size:12px;color:#7b8794">${escapeHtml(brand.name)} · Collective Group (Thailand)</p></body></html>`;

/**
 * Renders a template version (B1.3 notifications): Handlebars over the template data — text formats without HTML
 * escaping (SMS, LINE, in-app), `line_flex_json` rendered then parsed as the Flex `contents`, `mjml` rendered with
 * escaping and compiled to responsive HTML (email). Throws `TemplateRenderError` with the reason.
 * `brand` (D-232) heads the email of text templates and is in the data as `{{brand.*}}` (mjml templates use
 * `{{brand.logoUrl}}`, `{{brand.logoDarkUrl}}`, `{{brand.altText}}`).
 */
export async function renderTemplate(
  template: { format: TemplateFormat; subject: string | null; body: string },
  input: Record<string, unknown>,
  brand: EmailBrand = DEFAULT_EMAIL_BRAND,
): Promise<RenderedMessage> {
  const data = { brand, ...input };
  try {
    const subject = template.subject
      ? hb.compile(template.subject, { noEscape: true, strict: false })(data)
      : null;
    switch (template.format) {
      case 'plain':
        return { format: 'plain', subject, text: template.body };
      case 'handlebars_text': {
        const text = hb.compile(template.body, { noEscape: true })(data);
        return {
          format: 'handlebars_text',
          subject,
          text,
          html: textEmail(subject ?? brand.name, text, brand),
        };
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
