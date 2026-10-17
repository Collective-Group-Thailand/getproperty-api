import { Logger } from '@nestjs/common';
import puppeteer, { type Browser } from 'puppeteer-core';

import { type PdfRendererPort, type PdfRenderOptions } from './pdf-renderer.port';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Headless Chromium through puppeteer-core (master plan §3). One browser per process, started lazily, restarted when
 * it disconnects; each render opens a fresh page with JavaScript disabled and no network (fonts are embedded in the
 * HTML as data URLs), prints A4 with the footer (`options.footer` + page x / y) and closes the page.
 * `PDF_CHROMIUM_EXECUTABLE` names the browser binary (the image installs Chromium in B4.3; locally any Chrome).
 */
export class PuppeteerPdfRenderer implements PdfRendererPort {
  readonly mode = 'real' as const;
  private readonly logger = new Logger(PuppeteerPdfRenderer.name);
  private browser: Promise<Browser> | null = null;

  constructor(private readonly options: { executablePath: string; timeoutMs: number }) {}

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = puppeteer
        .launch({
          executablePath: this.options.executablePath,
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
        })
        .then((b) => {
          b.on('disconnected', () => {
            this.browser = null;
          });
          return b;
        })
        .catch((error: unknown) => {
          this.browser = null;
          throw error;
        });
    }
    return this.browser;
  }

  async render(html: string, options: PdfRenderOptions): Promise<Buffer> {
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().startsWith('data:')) void req.continue();
        else void req.abort();
      });
      const thermal = options.paper === 'thermal_80mm';
      // 80 mm at 96 dpi less the margins: the layout width of the roll
      if (thermal) await page.setViewport({ width: 280, height: 800 });
      await page.setContent(html, { waitUntil: 'load', timeout: this.options.timeoutMs });
      // the content height through the DevTools protocol (page scripts stay disabled)
      const contentPx = thermal
        ? ((await (await page.createCDPSession()).send('Page.getLayoutMetrics')).cssContentSize.height ??
          1100)
        : 0;
      const pdf = await page.pdf({
        // the 80 mm roll: fixed width, the height of the content (one long page, no footer)
        ...(thermal
          ? {
              width: '80mm',
              height: `${Math.ceil(contentPx * 0.2646 + 8)}mm`,
              displayHeaderFooter: false,
              margin: { top: '3mm', bottom: '3mm', left: '3mm', right: '3mm' },
            }
          : {
              format: 'A4' as const,
              displayHeaderFooter: true,
              headerTemplate: '<span></span>',
              footerTemplate: `<div style="width:100%;font-size:7px;padding:0 12mm;color:#555;display:flex;justify-content:space-between">
          <span>${escape(options.footer)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
              margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
            }),
        printBackground: true,
        timeout: this.options.timeoutMs,
      });
      return Buffer.from(pdf);
    } finally {
      await page
        .close()
        .catch((error: unknown) => this.logger.warn(`page close: ${(error as Error).message}`));
    }
  }

  async close(): Promise<void> {
    const b = await this.browser?.catch(() => null);
    await b?.close();
  }
}
