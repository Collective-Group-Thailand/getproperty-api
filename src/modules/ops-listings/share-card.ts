import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { brandAssetsDir } from '@core/brand/brand-setting';
import QRCode from 'qrcode';
import sharp from 'sharp';

/** What the square card of a listing shows (D-268); every text is already in the card's language. */
export interface ShareCardInput {
  /** The cover photo (any format sharp reads), or null for a plain card. */
  photo: Buffer | null;
  /** `฿15,000` */
  rent: string;
  /** `/ เดือน`, `/ month` */
  perMonth: string;
  title: string;
  /** `พญาไท, กรุงเทพมหานคร · BTS อารีย์ 350 ม.` */
  place: string;
  /** `1 ห้องนอน · 30 ตร.ม.` */
  facts: string;
  /** `เจ้าของยืนยันแล้ว · ไม่มีค่านายหน้า` */
  badge: string;
  /** `สแกนดูห้อง` */
  scan: string;
  /** The short link the QR opens. */
  url: string;
}

export const SHARE_CARD_SIZE = 1080;
const PHOTO_HEIGHT = 640;
const MARGIN = 56;
const QR_SIZE = 248;
const INK = '#14213d';
const MUTED = '#5b6474';
const BRAND = '#0f7b5f';

let fontsReady: Promise<void> | null = null;

/**
 * Sarabun (OFL; Thai and Latin subsets, regular and bold) from `@fontsource/sarabun`, registered once with the text
 * renderer (Pango through fontconfig keeps every file passed as `fontfile` for the process), so the card never depends
 * on the fonts of the host.
 */
function fonts(): Promise<void> {
  fontsReady ??= (async () => {
    const dir = join(dirname(require.resolve('@fontsource/sarabun/package.json')), 'files');
    for (const subset of ['latin', 'thai'])
      for (const weight of [400, 700])
        await sharp({
          text: { text: 'ก A', fontfile: join(dir, `sarabun-${subset}-${weight}-normal.woff`), rgba: true },
        })
          .png()
          .toBuffer();
  })();
  return fontsReady;
}

const markup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line of text as an RGBA image no wider than `width` (cut with an ellipsis when it does not fit). */
async function line(
  text: string,
  opts: { size: number; bold?: boolean; color: string; width: number },
): Promise<{ input: Buffer; width: number; height: number }> {
  let value = text;
  for (;;) {
    const img = sharp({
      text: {
        text: `<span foreground="${opts.color}">${markup(value)}</span>`,
        font: `Sarabun${opts.bold ? ' Bold' : ''} ${opts.size}`,
        rgba: true,
        dpi: 72,
      },
    });
    const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
    const chars = [...value];
    if (info.width <= opts.width || chars.length <= 2)
      return { input: data, width: info.width, height: info.height };
    value = `${chars.slice(0, Math.max(1, Math.floor(chars.length * (opts.width / info.width)) - 2)).join('')}…`;
  }
}

/**
 * The 1080 × 1080 card an owner posts in Facebook groups, Marketplace or LINE (D-268): the cover photo, the rent,
 * the title, where it is, the facts, a QR of the listing's short link and the getproperty logo. PNG.
 */
export async function renderShareCard(input: ShareCardInput): Promise<Buffer> {
  await fonts();
  const layers: sharp.OverlayOptions[] = [];
  if (input.photo) {
    const photo = await sharp(input.photo)
      .rotate()
      .resize(SHARE_CARD_SIZE, PHOTO_HEIGHT, { fit: 'cover', position: 'attention' })
      .toBuffer();
    layers.push({ input: photo, left: 0, top: 0 });
  } else {
    layers.push({
      input: {
        create: { width: SHARE_CARD_SIZE, height: PHOTO_HEIGHT, channels: 3, background: '#e7efe9' },
      },
      left: 0,
      top: 0,
    });
  }

  const textWidth = SHARE_CARD_SIZE - MARGIN * 3 - QR_SIZE;
  let top = PHOTO_HEIGHT + 40;
  const rent = await line(input.rent, { size: 76, bold: true, color: INK, width: textWidth });
  const per = await line(input.perMonth, { size: 34, color: MUTED, width: 240 });
  layers.push({ input: rent.input, left: MARGIN, top });
  layers.push({ input: per.input, left: MARGIN + rent.width + 12, top: top + rent.height - per.height - 10 });
  top += rent.height + 8;
  for (const [text, size, bold, color] of [
    [input.title, 38, true, INK],
    [input.place, 30, false, MUTED],
    [input.facts, 30, false, MUTED],
  ] as const) {
    if (!text) continue;
    const l = await line(text, { size, bold, color, width: textWidth });
    layers.push({ input: l.input, left: MARGIN, top });
    top += l.height + 6;
  }
  if (input.badge) {
    const badge = await line(input.badge, { size: 28, bold: true, color: BRAND, width: textWidth });
    layers.push({ input: badge.input, left: MARGIN, top: SHARE_CARD_SIZE - MARGIN - badge.height });
  }

  const qr = await QRCode.toBuffer(input.url, {
    type: 'png',
    width: QR_SIZE,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: INK, light: '#ffffff' },
  });
  const qrLeft = SHARE_CARD_SIZE - MARGIN - QR_SIZE;
  const qrTop = PHOTO_HEIGHT + 40;
  layers.push({ input: qr, left: qrLeft, top: qrTop });
  const scan = await line(input.scan, { size: 26, color: MUTED, width: QR_SIZE });
  layers.push({
    input: scan.input,
    left: qrLeft + Math.round((QR_SIZE - scan.width) / 2),
    top: qrTop + QR_SIZE + 6,
  });

  const logoFile = join(brandAssetsDir(), 'getproperty-logo.png');
  if (existsSync(logoFile)) {
    const logo = await sharp(readFileSync(logoFile))
      .resize({ height: 40 })
      .toBuffer({ resolveWithObject: true });
    layers.push({
      input: logo.data,
      left: SHARE_CARD_SIZE - MARGIN - logo.info.width,
      top: SHARE_CARD_SIZE - MARGIN - logo.info.height,
    });
  }

  return sharp({
    create: { width: SHARE_CARD_SIZE, height: SHARE_CARD_SIZE, channels: 3, background: '#ffffff' },
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** What the Open Graph card of a public listing shows (G4, D-296); texts already in the card's language. */
export interface OgCardInput {
  photo: Buffer | null;
  rent: string;
  perMonth: string;
  title: string;
  place: string;
  facts: string;
  /** Badges in one line (`ว่างจริง ตรวจจากสัญญา · เจ้าของยืนยันแล้ว`), or empty. */
  badges: string;
}

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;
const OG_PHOTO_WIDTH = 630;

/**
 * The 1200 × 630 Open Graph card of a public listing (G4): the cover photo on the left, rent, title, place, facts and
 * the badges on the right, the getproperty logo at the bottom — what Facebook, LINE and search engines preview for the
 * page and for a Facebook Page post's link. PNG, same fonts and colours as the share card.
 */
export async function renderOgCard(input: OgCardInput): Promise<Buffer> {
  await fonts();
  const layers: sharp.OverlayOptions[] = [];
  if (input.photo) {
    const photo = await sharp(input.photo)
      .rotate()
      .resize(OG_PHOTO_WIDTH, OG_CARD_HEIGHT, { fit: 'cover', position: 'attention' })
      .toBuffer();
    layers.push({ input: photo, left: 0, top: 0 });
  } else {
    layers.push({
      input: {
        create: { width: OG_PHOTO_WIDTH, height: OG_CARD_HEIGHT, channels: 3, background: '#e7efe9' },
      },
      left: 0,
      top: 0,
    });
  }
  const left = OG_PHOTO_WIDTH + 48;
  const width = OG_CARD_WIDTH - left - 48;
  let top = 64;
  const rent = await line(input.rent, { size: 72, bold: true, color: INK, width: width - 140 });
  const per = await line(input.perMonth, { size: 30, color: MUTED, width: 140 });
  layers.push({ input: rent.input, left, top });
  layers.push({ input: per.input, left: left + rent.width + 10, top: top + rent.height - per.height - 10 });
  top += rent.height + 18;
  for (const [text, size, bold, color] of [
    [input.title, 36, true, INK],
    [input.place, 28, false, MUTED],
    [input.facts, 28, false, MUTED],
  ] as const) {
    if (!text) continue;
    const l = await line(text, { size, bold, color, width });
    layers.push({ input: l.input, left, top });
    top += l.height + 10;
  }
  if (input.badges) {
    const badges = await line(input.badges, { size: 26, bold: true, color: BRAND, width });
    layers.push({ input: badges.input, left, top: top + 14 });
  }
  const logoFile = join(brandAssetsDir(), 'getproperty-logo.png');
  if (existsSync(logoFile)) {
    const logo = await sharp(readFileSync(logoFile))
      .resize({ height: 44 })
      .toBuffer({ resolveWithObject: true });
    layers.push({ input: logo.data, left, top: OG_CARD_HEIGHT - 56 - logo.info.height });
  }
  return sharp({
    create: { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT, channels: 3, background: '#ffffff' },
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}
