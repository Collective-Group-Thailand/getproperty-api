import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BRAND_IMAGE_KEYS,
  brandAssetsDir,
  DEFAULT_PLATFORM_BRAND,
  platformBrandProblems,
  resolveBrand,
} from '@core/brand/brand-setting';
import { PlatformBrand } from '@core/brand/platform-brand.service';
import { FakeClock } from '@core/clock/clock';
import { renderTemplate } from '@core/notifications/renderer';
import { SETTINGS } from '@core/settings/catalogue';
import { settingValueProblems } from '@core/settings/setting-values';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { BillingDocuments } from '@modules/ops-documents/billing-documents.service';
import { type InvoiceView } from '@modules/ops-documents/document-views';
import { flexMessage, invoiceBubble } from '@modules/ops-documents/flex';
import { sampleView } from '@modules/ops-documents/sample-documents';
import { ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { PlatformDocuments, type PlatformDocView } from '@modules/platform-subscriptions/platform-documents';
import sharp from 'sharp';

import { validateFlexMessage } from '../support/line-flex-schema';

const API = 'https://api.getproperty.example';

function brandService(value: unknown = null, base = API) {
  const settings = { at: jest.fn(() => Promise.resolve(value === null ? null : { value })) };
  const config = { get: (k: string) => (k === 'PUBLIC_API_BASE_URL' ? base : undefined) };
  return new PlatformBrand(settings as never, config as never, new FakeClock());
}

const PLATFORM_VIEW: PlatformDocView = {
  title: 'ใบแจ้งหนี้ค่าบริการ getproperty',
  number: 'PINV-2026-00001',
  issuedOn: '2026-11-01',
  dueOn: '2026-11-15',
  issuer: {
    legalName: 'Collective Group (Thailand) Co., Ltd.',
    taxId: null,
    branch: null,
    address: null,
    email: 'billing@getproperty.co',
    vatRegistered: true,
  },
  customer: { name: 'หอพักตัวอย่าง จำกัด', taxId: null, address: null },
  lines: [{ no: 1, description: 'Apartment Starter', quantity: '1', unitPrice: '990.00', amount: '990.00' }],
  total: '990.00',
};

/**
 * D-232: the official getproperty logo where the platform itself appears — bundled vectors + PNG fallbacks in
 * `assets/brand`, referenced by the `platform.brand` setting; tenant documents keep the tenant's identity and only
 * close with "issued via getproperty"; emails get a logo header that survives dark mode; LINE bubbles carry the
 * white logo on the brand navy.
 */
describe('platform brand (D-232)', () => {
  it('ships the founder vectors unchanged: navy, blue and the chimney gradient #62AEF9 → #2E69F5', () => {
    const logo = readFileSync(join(brandAssetsDir(), 'getproperty-logo.svg'), 'utf8');
    expect(logo).toContain('#21365B');
    expect(logo).toContain('#1A4BA3');
    expect(logo).toMatch(/<linearGradient id="gp-chimney"[\s\S]*#62AEF9[\s\S]*#2E69F5/);
    expect(logo).toContain('fill="url(#gp-chimney)"');
    expect(readFileSync(join(brandAssetsDir(), 'getproperty-mark.svg'), 'utf8')).toContain(
      'url(#gp-chimney)',
    );
  });

  it('the PNG fallbacks exist at the sizes `pnpm brand:png` writes', async () => {
    const sizes: Record<string, [number, number]> = {
      'getproperty-logo.png': [880, 188],
      'getproperty-logo-email.png': [900, 205],
      'getproperty-logo-white.png': [880, 188],
      'getproperty-mark.png': [256, 256],
      'getproperty-mark-white.png': [256, 256],
      'getproperty-app-icon.png': [512, 512],
    };
    for (const [file, [w, h]] of Object.entries(sizes)) {
      const meta = await sharp(join(brandAssetsDir(), file)).metadata();
      expect({ file, size: [meta.width, meta.height], alpha: meta.hasAlpha }).toEqual({
        file,
        size: [w, h],
        alpha: true,
      });
    }
  });

  it('the setting is in the catalogue, edited by the platform admin, and validated', () => {
    const def = SETTINGS.find((s) => s.key === 'platform.brand')!;
    expect(def).toMatchObject({
      valueType: 'json',
      scopeAllowed: ['platform'],
      editableBy: ['admin.setting.manage'],
    });
    expect(def.description).toContain('D-232');
    expect(settingValueProblems(def, def.value)).toEqual([]);
    for (const k of BRAND_IMAGE_KEYS) expect(DEFAULT_PLATFORM_BRAND[k]).toMatch(/^asset:getproperty-/);
    // partial replacement by an admin-hosted https image
    expect(platformBrandProblems({ logoWhitePng: 'https://cdn.example/brand/white.png' })).toEqual([]);
    expect(platformBrandProblems({ logoEmailPng: 'asset:getproperty-logo.svg' })).toEqual([
      'logoEmailPng: email clients and LINE need a PNG or JPEG, not SVG',
    ]);
    expect(platformBrandProblems({ logo: 'http://insecure.example/logo.svg' })).toEqual([
      'logo: asset:<file> or an https URL',
    ]);
    expect(platformBrandProblems({ logo: 'asset:missing.svg' })).toEqual([
      'logo: missing.svg is not in assets/brand',
    ]);
    expect(platformBrandProblems({ logo: 'asset:../secrets.svg' })).toEqual([
      'logo: asset:<file> or an https URL',
    ]);
    expect(platformBrandProblems({ colors: { ink: 'navy' } })).toEqual(['colors.ink: #RRGGBB']);
    expect(platformBrandProblems({ slogan: 'x' })).toEqual(['slogan: unknown key']);
    expect(settingValueProblems(def, { name: '' })).toEqual(['name: a text of 1–60 characters']);
    expect(resolveBrand({ colors: { primary: '#000000' } }).colors).toEqual({
      ink: '#21365B',
      primary: '#000000',
    });
    expect(resolveBrand({ bogus: true })).toEqual(DEFAULT_PLATFORM_BRAND);
  });

  it('PDFs embed the bundled logo as a data URL; email and LINE link the public /brand files', async () => {
    const brand = brandService();
    const pdf = await brand.pdf();
    expect(pdf.logoDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(pdf.logoDataUrl!.split(',')[1]!, 'base64').toString()).toContain('#62AEF9');
    expect(pdf.markDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await brand.email()).toEqual({
      name: 'getproperty',
      altText: 'getproperty',
      logoUrl: `${API}/brand/getproperty-logo-email.png`,
      logoDarkUrl: `${API}/brand/getproperty-logo-white.png`,
      ink: '#21365B',
      primary: '#1A4BA3',
    });
    expect((await brand.flex()).logoUrl).toBe(`${API}/brand/getproperty-logo-white.png`);
    // LINE refuses non-https images: a local http API sends no logo
    expect((await brandService(null, 'http://localhost:3000').flex()).logoUrl).toBeNull();
  });

  it('an admin replacement wins; an unreachable one falls back to the bundled logo in PDFs', async () => {
    const brand = brandService({
      logo: 'https://cdn.invalid/brand/logo.svg',
      logoWhitePng: 'https://cdn.invalid/w.png',
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    try {
      const pdf = await brand.pdf();
      expect(fetchSpy).toHaveBeenCalled();
      expect(Buffer.from(pdf.logoDataUrl!.split(',')[1]!, 'base64').toString()).toContain('#21365B');
      expect((await brand.flex()).logoUrl).toBe('https://cdn.invalid/w.png');
    } finally {
      fetchSpy.mockRestore();
    }
    const ok = brandService({ logo: 'https://cdn.example/brand/logo.png' });
    const png = readFileSync(join(brandAssetsDir(), 'getproperty-logo.png'));
    const served = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }));
    try {
      expect((await ok.pdf()).logoDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
      // a non-image answer is refused
      served.mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
      const other = brandService({ logo: 'https://cdn.example/not-an-image' });
      expect((await other.pdf()).logoDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    } finally {
      served.mockRestore();
    }
  });

  it('tenant documents: the tenant is the issuer; the platform closes the page with its logo', async () => {
    const fake = new FakePdfRenderer();
    const config = { get: () => 'https://liff.example.invalid' };
    const docs = new BillingDocuments(
      fake,
      {} as never,
      {} as never,
      config as never,
      {} as never,
      brandService(),
    );
    const view = sampleView('invoice') as InvoiceView;
    const pdf = await docs.pdf(view, 'a4');
    const text = FakePdfRenderer.textOf(pdf);
    expect(text.split('\n')[0]).toContain(view.issuer.name);
    expect(text).toContain('ออกเอกสารผ่านระบบ getproperty');
    const html = docs.html(view, 'a4', await brandService().pdf());
    expect(html).toMatch(
      /<footer class="platform"><img class="platform-logo" src="data:image\/svg\+xml;base64,[^"]+" alt="getproperty">/,
    );
    // the issuer header still shows only the tenant's own logo slot
    expect(html.indexOf('class="issuer"')).toBeLessThan(html.indexOf('class="platform"'));
    const roll = docs.html(view, 'thermal_80mm', await brandService().pdf());
    expect(roll).toContain('class="platform-mark"');
    expect(docs.text(view, 'thermal_80mm')).toContain('ออกผ่านระบบ getproperty');
  });

  it('platform documents (Collective → tenant) carry the getproperty logo on top', async () => {
    const fake = new FakePdfRenderer();
    const docs = new PlatformDocuments(
      fake,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      brandService(),
    );
    const body = docs.body(PLATFORM_VIEW, await brandService().pdf());
    expect(body.indexOf('class="brand-logo"')).toBeLessThan(body.indexOf('class="issuer"'));
    expect(body).toContain('alt="getproperty"');
    const pdf = await docs.pdf(PLATFORM_VIEW);
    expect(FakePdfRenderer.textOf(pdf)).toContain('getproperty · Collective Group (Thailand) Co., Ltd.');
    // without the service (pure preview) the name stands in for the logo
    expect(docs.text(PLATFORM_VIEW).split('\n')[0]).toBe('getproperty');
  });

  it('contracts: the platform line sits outside the hashed body', async () => {
    const fake = new FakePdfRenderer();
    const plain = new ContractRenderer(fake);
    const branded = new ContractRenderer(fake, brandService());
    const tpl = '<h1>สัญญาเช่า</h1><p>{{contract.number}}</p>';
    const data = { contract: { number: 'CTR-1' } } as never;
    const a = await plain.render(tpl, data);
    const b = await branded.render(tpl, data);
    expect(a.contentSha256).toBe(b.contentSha256);
    expect(b.text).not.toContain('getproperty');
    expect(FakePdfRenderer.textOf(b.pdf)).toContain('ออกเอกสารผ่านระบบ getproperty');
    expect(await branded.brandedDocument('<p>x</p>', 't')).toContain('class="platform-logo"');
  });

  it('emails: logo header with alt text, a dark-mode swap and the brand in the template data', async () => {
    const brand = await brandService().email();
    const r = await renderTemplate(
      { format: 'handlebars_text', subject: 'บัญชีรับเงินถูกเปลี่ยน', body: 'สวัสดี {{name}}' },
      { name: 'คุณเอ' },
      brand,
    );
    expect(r.text).toBe('สวัสดี คุณเอ');
    const html = r.html!;
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(`src="${API}/brand/getproperty-logo-email.png" width="160" alt="getproperty"`);
    expect(html).toContain(`src="${API}/brand/getproperty-logo-white.png" width="160" alt="getproperty"`);
    const dark = html.slice(
      html.indexOf('@media (prefers-color-scheme: dark){'),
      html.indexOf('[data-ogsc]'),
    );
    expect(dark).toContain('.gp-logo-light{display:none !important}');
    expect(dark).toContain('.gp-logo-dark{display:block !important}');
    expect(html).toContain('[data-ogsc] .gp-logo-dark{display:block !important}');
    expect(html).toContain('<!--[if !mso]><!-->');
    const mjml = await renderTemplate(
      {
        format: 'mjml',
        subject: 'x',
        body: '<mjml><mj-body><mj-section><mj-column><mj-image src="{{brand.logoUrl}}" alt="{{brand.altText}}" width="160px"></mj-image></mj-column></mj-section></mj-body></mjml>',
      },
      {},
      brand,
    );
    expect(mjml.html).toContain(`${API}/brand/getproperty-logo-email.png`);
  });

  it('LINE: the header shows the white logo on the brand navy and still validates', async () => {
    const view = sampleView('invoice') as InvoiceView;
    const style = await brandService().flex();
    const msg = flexMessage('x', [invoiceBubble(view, style)]);
    expect(validateFlexMessage(msg)).toEqual([]);
    const header = (
      msg.contents as unknown as { header: { backgroundColor: string; contents: Record<string, unknown>[] } }
    ).header;
    expect(header.backgroundColor).toBe('#21365B');
    expect(header.contents[0]).toMatchObject({
      type: 'image',
      url: `${API}/brand/getproperty-logo-white.png`,
      aspectRatio: '880:188',
    });
    expect(JSON.stringify(header)).toContain(view.issuer.displayName);
    // no https logo → no image, same layout otherwise
    const plain = invoiceBubble(view);
    expect((plain.header as { contents: { type: string }[] }).contents[0]!.type).toBe('text');
  });
});
