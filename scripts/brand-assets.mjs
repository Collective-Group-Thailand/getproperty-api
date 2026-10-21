#!/usr/bin/env node
/**
 * Raster fallbacks of the getproperty brand (D-232): PNGs rendered from the official vectors in `assets/brand/`
 * (the founder's files; never edit the SVGs by hand — the chimney gradient #62AEF9 → #2E69F5 must stay) for the
 * places that cannot use SVG: email clients (Gmail, Outlook strip SVG), LINE Flex images (PNG/JPEG over https) and
 * anything else that needs raster. Output is committed; re-run after replacing a vector:
 *
 *   pnpm brand:png            # writes assets/brand/*.png
 *   pnpm brand:png --check    # exits 1 when a PNG is missing or its size differs from the table below
 *
 * `getproperty-logo-email.png` is the colour logo with a 2-unit white halo: on a white email it looks exactly like the
 * logo; when a dark-mode client darkens the background without swapping images (Gmail apps, Outlook.com) the halo
 * keeps the navy letters legible. Clients that honour `prefers-color-scheme` get `getproperty-logo-white.png`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'brand');

/** Every raster the platform uses: source vector, output, width in px (height follows the aspect ratio). */
export const OUTPUTS = [
  { svg: 'getproperty-logo.svg', png: 'getproperty-logo.png', width: 880 },
  { svg: 'getproperty-logo.svg', png: 'getproperty-logo-email.png', width: 900, halo: 2 },
  { svg: 'getproperty-logo-white.svg', png: 'getproperty-logo-white.png', width: 880 },
  { svg: 'getproperty-mark.svg', png: 'getproperty-mark.png', width: 256 },
  { svg: 'getproperty-mark-white.svg', png: 'getproperty-mark-white.png', width: 256 },
  { svg: 'getproperty-app-icon.svg', png: 'getproperty-app-icon.png', width: 512 },
];

/** The vector with a white outline under it (feMorphology dilate of the alpha), `pad` units of room on each side. */
function withHalo(svg, radius) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) throw new Error('the vector has no viewBox');
  const [x, y, w, h] = viewBox.split(/[\s,]+/).map(Number);
  const pad = radius * 2;
  const inner = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}">` +
    `<defs><filter id="gp-halo" x="-10%" y="-10%" width="120%" height="120%">` +
    `<feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="grown"/>` +
    `<feFlood flood-color="#FFFFFF"/><feComposite in2="grown" operator="in" result="halo"/>` +
    `<feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    `<g filter="url(#gp-halo)">${inner}</g></svg>`
  );
}

async function render(o) {
  let svg = readFileSync(join(DIR, o.svg), 'utf8');
  if (o.halo) svg = withHalo(svg, o.halo);
  return sharp(Buffer.from(svg), { density: 600 })
    .resize({ width: o.width })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
}

async function main() {
  const check = process.argv.includes('--check');
  let problems = 0;
  for (const o of OUTPUTS) {
    const file = join(DIR, o.png);
    const { data, info } = await render(o);
    if (check) {
      if (!existsSync(file)) {
        console.error(`missing ${o.png} (pnpm brand:png)`);
        problems++;
        continue;
      }
      const meta = await sharp(readFileSync(file)).metadata();
      if (meta.width !== info.width || meta.height !== info.height) {
        console.error(`${o.png} is ${meta.width}×${meta.height}, expected ${info.width}×${info.height}`);
        problems++;
      }
      continue;
    }
    await sharp(data).toFile(file);
    console.log(`${o.png} ${info.width}×${info.height} ${data.length} bytes`);
  }
  if (problems) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
