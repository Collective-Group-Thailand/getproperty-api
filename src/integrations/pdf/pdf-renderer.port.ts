export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface PdfRenderOptions {
  /** Document title (PDF metadata). */
  title: string;
  /** Text printed in the footer of every page, e.g. the contract number and the content hash. */
  footer: string;
  /** Paper: A4 (default) or the 80 mm thermal roll of receipt printers (invoices and receipts, B4.3). */
  paper?: PdfPaper;
}

export type PdfPaper = 'a4' | 'thermal_80mm';

/**
 * HTML → PDF (master plan §3: Puppeteer with embedded Thai fonts; D-236). `PDF_RENDERER_MODE`: `queue` renders through
 * the shared `pdf-render` queue of the Collective platform (getpack's Chromium, docs/pdf-render-queue.md); `real` drives
 * a headless Chromium in this process (development, and production only under ADR-0012 until the queue consumer is
 * deployed, O-015 → D-242); the fake writes a small deterministic PDF carrying the document's text, so tests and `pnpm dev` need no browser.
 * Output must be deterministic for the same input in the fake; the real adapter's bytes vary by Chromium build, so
 * hashes are always computed from the bytes actually stored.
 */
export interface PdfRendererPort {
  /** `fake` (tests, dev), `real` (in-process Chromium — dev and the O-015 interim, ADR-0012), `queue` (`pdf-render`). */
  readonly mode: 'fake' | 'real' | 'queue';
  render(html: string, options: PdfRenderOptions): Promise<Buffer>;
}
