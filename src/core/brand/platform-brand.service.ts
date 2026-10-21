import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppConfig } from '@config/app-config';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { SettingsService } from '../settings/settings.service';
import {
  assetFile,
  brandAssetsDir,
  DEFAULT_PLATFORM_BRAND,
  MIME_BY_EXT,
  type PlatformBrandSetting,
  resolveBrand,
} from './brand-setting';

/** What a PDF needs: images as data URLs (the renderer has no network, D-050). */
export interface PdfBrand {
  name: string;
  altText: string;
  logoDataUrl: string | null;
  markDataUrl: string | null;
}

/** What an email needs: absolute image URLs (clients block data URLs and strip SVG). */
export interface EmailBrand {
  name: string;
  altText: string;
  /** Colour logo with the white halo (light, and dark clients that do not swap images). */
  logoUrl: string;
  /** White logo for clients that honour `prefers-color-scheme: dark`. */
  logoDarkUrl: string;
  ink: string;
  primary: string;
}

/** What a LINE Flex bubble needs: an https image (the Messaging API refuses anything else) and the colours. */
export interface FlexBrand {
  name: string;
  altText: string;
  /** White logo on the header colour; null when no https URL exists (a local `http://` API). */
  logoUrl: string | null;
  ink: string;
  primary: string;
}

/** Brand text used where no service is wired (pure renderers, sample previews). */
export const DEFAULT_PDF_BRAND: PdfBrand = {
  name: DEFAULT_PLATFORM_BRAND.name,
  altText: DEFAULT_PLATFORM_BRAND.altText,
  logoDataUrl: null,
  markDataUrl: null,
};

const REMOTE_MAX_BYTES = 1024 * 1024;
const REMOTE_TTL_MS = 10 * 60_000;
const REMOTE_TIMEOUT_MS = 5_000;

/**
 * The platform brand (D-001, D-232) resolved from `platform.setting` `platform.brand`: data URLs for PDFs, public URLs
 * for email and LINE. Bundled files (`asset:`) are read once per process; an admin-hosted https image is fetched
 * for PDFs (≤ 1 MB, image types, 5 s) and cached for 10 minutes — on any failure the bundled default of that slot is
 * used and a warning logged, so a broken URL never stops a document. Bundled files are public at
 * `<PUBLIC_API_BASE_URL>/brand/<file>` (`configureApp`).
 */
@Injectable()
export class PlatformBrand {
  private readonly logger = new Logger(PlatformBrand.name);
  private readonly local = new Map<string, string>();
  private readonly remote = new Map<string, { dataUrl: string; at: number }>();

  constructor(
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The setting in force (defaults when the seed has not run yet). */
  async setting(): Promise<PlatformBrandSetting> {
    const found = await this.settings.at('platform.brand', this.clock.now()).catch((error: unknown) => {
      this.logger.warn(`platform.brand unreadable, using the bundled brand: ${(error as Error).message}`);
      return null;
    });
    return resolveBrand(found?.value);
  }

  async pdf(): Promise<PdfBrand> {
    const b = await this.setting();
    const [logoDataUrl, markDataUrl] = await Promise.all([
      this.dataUrl(b.logo, DEFAULT_PLATFORM_BRAND.logo),
      this.dataUrl(b.mark, DEFAULT_PLATFORM_BRAND.mark),
    ]);
    return { name: b.name, altText: b.altText, logoDataUrl, markDataUrl };
  }

  async email(): Promise<EmailBrand> {
    const b = await this.setting();
    return {
      name: b.name,
      altText: b.altText,
      logoUrl: this.publicUrl(b.logoEmailPng),
      logoDarkUrl: this.publicUrl(b.logoWhitePng),
      ink: b.colors.ink,
      primary: b.colors.primary,
    };
  }

  async flex(): Promise<FlexBrand> {
    const b = await this.setting();
    const url = this.publicUrl(b.logoWhitePng);
    return {
      name: b.name,
      altText: b.altText,
      logoUrl: url.startsWith('https://') ? url : null,
      ink: b.colors.ink,
      primary: b.colors.primary,
    };
  }

  /** `asset:<file>` → `<PUBLIC_API_BASE_URL>/brand/<file>`; an https reference as it is. */
  publicUrl(ref: string): string {
    const file = assetFile(ref);
    return file ? `${this.config.get('PUBLIC_API_BASE_URL')}/brand/${file}` : ref;
  }

  /** The bytes of a bundled brand file as a data URL (cached per process). */
  assetDataUrl(file: string): string {
    let hit = this.local.get(file);
    if (!hit) {
      const ext = file.split('.').pop()!.toLowerCase();
      hit = `data:${MIME_BY_EXT[ext]};base64,${readFileSync(join(brandAssetsDir(), file)).toString('base64')}`;
      this.local.set(file, hit);
    }
    return hit;
  }

  private async dataUrl(ref: string, fallback: string): Promise<string | null> {
    try {
      const file = assetFile(ref);
      if (file) return this.assetDataUrl(file);
      return await this.fetchRemote(ref);
    } catch (error) {
      this.logger.warn(`brand image ${ref} unavailable, using ${fallback}: ${(error as Error).message}`);
      const file = assetFile(fallback);
      try {
        return file ? this.assetDataUrl(file) : null;
      } catch {
        return null;
      }
    }
  }

  private async fetchRemote(url: string): Promise<string> {
    const hit = this.remote.get(url);
    if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.dataUrl;
    const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!Object.values(MIME_BY_EXT).includes(type)) throw new Error(`not an image (${type || 'no type'})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > REMOTE_MAX_BYTES) throw new Error('larger than 1 MB');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > REMOTE_MAX_BYTES) throw new Error('larger than 1 MB');
    const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
    this.remote.set(url, { dataUrl, at: Date.now() });
    return dataUrl;
  }
}
