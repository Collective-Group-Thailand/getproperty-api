import { htmlToText } from '@common/text/html-text';

import { type PdfRendererPort, type PdfRenderOptions } from './pdf-renderer.port';

/**
 * A valid single-page PDF 1.4 whose content stream carries the document text (UTF-16BE hex strings, one line each)
 * and whose `/Subject` carries the footer. Deterministic: no dates, no ids. Tests read the text back with
 * `FakePdfRenderer.textOf()`.
 */
export class FakePdfRenderer implements PdfRendererPort {
  readonly mode = 'fake' as const;
  readonly rendered: { title: string; footer: string; text: string }[] = [];

  render(html: string, options: PdfRenderOptions): Promise<Buffer> {
    const text = htmlToText(html);
    this.rendered.push({ title: options.title, footer: options.footer, text });
    const hex = (s: string) => Buffer.from(`\uFEFF${s}`, 'utf16le').swap16().toString('hex').toUpperCase();
    const lines = [...text.split('\n'), '', options.footer];
    const content = lines.map((l, i) => `BT /F1 9 Tf 40 ${800 - i * 11} Td <${hex(l)}> Tj ET`).join('\n');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Title <${hex(options.title)}> /Subject <${hex(options.footer)}> /Producer (getproperty fake renderer) >>`,
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Promise.resolve(Buffer.from(out, 'latin1'));
  }

  /** The text lines a fake PDF carries (tests). */
  static textOf(pdf: Buffer): string {
    const lines = [...pdf.toString('latin1').matchAll(/<([0-9A-F]+)> Tj/g)].map((m) =>
      Buffer.from(m[1]!, 'hex')
        .swap16()
        .toString('utf16le')
        .replace(/^\uFEFF/, ''),
    );
    return lines.join('\n');
  }
}
