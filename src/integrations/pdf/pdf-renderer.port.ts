export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface PdfRenderOptions {
  /** Document title (PDF metadata). */
  title: string;
  /** Text printed in the footer of every page, e.g. the contract number and the content hash. */
  footer: string;
}

/**
 * HTML → PDF (master plan §3: Puppeteer with embedded Thai fonts). The real adapter drives a headless Chromium; the
 * fake writes a small deterministic PDF carrying the document's text, so tests and `pnpm dev` need no browser.
 * Output must be deterministic for the same input in the fake; the real adapter's bytes vary by Chromium build, so
 * hashes are always computed from the bytes actually stored.
 */
export interface PdfRendererPort {
  readonly mode: 'fake' | 'real';
  render(html: string, options: PdfRenderOptions): Promise<Buffer>;
}
