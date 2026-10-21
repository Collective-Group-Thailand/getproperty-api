import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `platform.brand` (D-001, D-232): the getproperty brand where the platform itself appears — the "issued via
 * getproperty" line of tenant documents, Collective's own invoices to tenants, emails sent by the platform and the
 * header of the LINE messages sent from the getproperty Official Account. Tenant-issued documents keep the TENANT's
 * name, address, tax id and logo (CLAUDE.md); this setting never replaces them.
 *
 * Every image is a reference:
 * - `asset:<file>` — a file of `assets/brand/` shipped in the image (the founder's official vectors and their PNG
 *   fallbacks, `pnpm brand:png`), served publicly at `<PUBLIC_API_BASE_URL>/brand/<file>`;
 * - `https://…` — a replacement the platform admin hosts (a new setting version, no deploy). PDFs embed it (fetched
 *   once, ≤ 1 MB, image types only; the bundled default is used when it cannot be fetched); email and LINE link it.
 */
export interface PlatformBrandSetting {
  /** The brand name in copy (lower-case wordmark, D-001). */
  name: string;
  /** Alt text of every logo image. */
  altText: string;
  /** Colour logo for PDFs (SVG or PNG). */
  logo: string;
  /** Colour logo as PNG (raster fallback). */
  logoPng: string;
  /** Colour logo with a white halo for email (stays legible when a client darkens the background). */
  logoEmailPng: string;
  /** White logo on dark: dark-mode email, the LINE header. PNG. */
  logoWhitePng: string;
  /** The house mark alone (small placements: the 80 mm roll). */
  mark: string;
  /** The app icon (blue tile, white mark). PNG. */
  appIconPng: string;
  /** `ink` = the navy of the wordmark (#21365B), `primary` = the blue of the mark (#1A4BA3). */
  colors: { ink: string; primary: string };
}

export const DEFAULT_PLATFORM_BRAND: PlatformBrandSetting = {
  name: 'getproperty',
  altText: 'getproperty',
  logo: 'asset:getproperty-logo.svg',
  logoPng: 'asset:getproperty-logo.png',
  logoEmailPng: 'asset:getproperty-logo-email.png',
  logoWhitePng: 'asset:getproperty-logo-white.png',
  mark: 'asset:getproperty-mark.svg',
  appIconPng: 'asset:getproperty-app-icon.png',
  colors: { ink: '#21365B', primary: '#1A4BA3' },
};

/** Image keys and the file types each accepts (`raster`: email clients and LINE need PNG/JPEG). */
const IMAGE_KEYS = {
  logo: 'any',
  logoPng: 'raster',
  logoEmailPng: 'raster',
  logoWhitePng: 'raster',
  mark: 'any',
  appIconPng: 'raster',
} as const satisfies Partial<Record<keyof PlatformBrandSetting, 'any' | 'raster'>>;
type ImageKey = keyof typeof IMAGE_KEYS;
export const BRAND_IMAGE_KEYS = Object.keys(IMAGE_KEYS) as ImageKey[];

const ASSET = /^asset:([a-z0-9][a-z0-9-]*\.(svg|png|jpg|jpeg|webp))$/;
const HTTPS = /^https:\/\/[^\s"'<>]+$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * `assets/brand/` of this repository: three levels up from `src/core/brand` (ts-jest, swc) or four from
 * `dist/src/core/brand` (the image copies `assets/` next to `dist/`). `BRAND_ASSETS_DIR` overrides.
 */
export function brandAssetsDir(): string {
  if (process.env.BRAND_ASSETS_DIR) return process.env.BRAND_ASSETS_DIR;
  const candidates = [
    join(__dirname, '..', '..', '..', 'assets', 'brand'),
    join(__dirname, '..', '..', '..', '..', 'assets', 'brand'),
  ];
  return candidates.find((d) => existsSync(join(d, 'getproperty-logo.svg'))) ?? candidates[0]!;
}

/** The bundled file an `asset:` reference names, or null for anything else. */
export function assetFile(ref: string): string | null {
  return ASSET.exec(ref)?.[1] ?? null;
}

export const MIME_BY_EXT: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Validation of a `platform.brand` value (catalogue `check`): every key optional, unknown keys rejected. */
export function platformBrandProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['must be an object'];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(Object.keys(DEFAULT_PLATFORM_BRAND));
  for (const k of Object.keys(v)) if (!known.has(k)) problems.push(`${k}: unknown key`);
  for (const k of ['name', 'altText'] as const)
    if (k in v && (typeof v[k] !== 'string' || !v[k].trim() || v[k].length > 60))
      problems.push(`${k}: a text of 1–60 characters`);
  for (const k of BRAND_IMAGE_KEYS) {
    if (!(k in v)) continue;
    const ref = v[k];
    if (typeof ref !== 'string' || ref.length > 1000) {
      problems.push(`${k}: asset:<file> or an https URL`);
      continue;
    }
    const file = assetFile(ref);
    if (file) {
      if (IMAGE_KEYS[k] === 'raster' && file.endsWith('.svg'))
        problems.push(`${k}: email clients and LINE need a PNG or JPEG, not SVG`);
      else if (!existsSync(join(brandAssetsDir(), file)))
        problems.push(`${k}: ${file} is not in assets/brand`);
    } else if (!HTTPS.test(ref)) problems.push(`${k}: asset:<file> or an https URL`);
  }
  if ('colors' in v) {
    const c = v.colors as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) problems.push('colors: { ink, primary }');
    else
      for (const [k, hex] of Object.entries(c))
        if (!['ink', 'primary'].includes(k) || typeof hex !== 'string' || !HEX.test(hex))
          problems.push(`colors.${k}: #RRGGBB`);
  }
  return problems;
}

/** The setting value over the defaults (a version may set only some keys). */
export function resolveBrand(value: unknown): PlatformBrandSetting {
  if (!value || typeof value !== 'object' || platformBrandProblems(value).length)
    return DEFAULT_PLATFORM_BRAND;
  const v = value as Partial<PlatformBrandSetting>;
  return { ...DEFAULT_PLATFORM_BRAND, ...v, colors: { ...DEFAULT_PLATFORM_BRAND.colors, ...v.colors } };
}
