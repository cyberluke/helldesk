#!/usr/bin/env node
/**
 * optimize-screenshot.mjs
 *
 * Scale + optimize a screenshot (PNG) for the web, then write it into assets/.
 *
 * The HELLDESK README embeds dashboard screenshots. Raw OS captures are
 * multi-megabyte and oversized for a web page; this script downscales to a
 * saner width and losslessly re-compresses to a modern-format PNG.
 *
 * Usage:
 *   node scripts/optimize-screenshot.mjs <source.png> [--name <out-name.png>] [--width 1600]
 *
 *   <source.png>  absolute or relative path to the raw screenshot.
 *   --name        output filename written to assets/ (default: basename).
 *   --width       max target width in px (default 1600). Height scales to keep
 *                 aspect ratio. Widths that are already smaller are kept as-is.
 *
 * Requires sharp. If sharp is not resolvable from this tree's node_modules,
 * point at an install via the SHARP_DIR env var:
 *   $env:SHARP_DIR='C:\Users\..\Temp\kilo\sharpimg'  # dir containing node_modules/sharp
 *
 * Examples:
 *   node scripts/optimize-screenshot.mjs "shot.png" --name dashboard-overview.png --width 1600
 *   $env:SHARP_DIR='...'; node scripts/optimize-screenshot.mjs "shot.png"
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharpDir = process.env.SHARP_DIR;
const sharp = sharpDir ? require(require.resolve('sharp', { paths: [sharpDir] })) : require('sharp');

const [, , source, ...rest] = process.argv;

function arg(k) {
  const i = rest.indexOf('--' + k);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : undefined;
}

if (!source) {
  console.error('usage: node scripts/optimize-screenshot.mjs <source.png> [--name out.png] [--width 1600]');
  process.exit(1);
}

const width = Number(arg('width') ?? '1600');
if (!Number.isFinite(width) || width <= 0) {
  console.error(`invalid --width: ${arg('width')}`);
  process.exit(1);
}

const outName = arg('name') ?? source.split(/[\\/]/).pop();
const outPath = `assets/${outName}`;

const input = sharp(source, { failOn: 'error' });
const meta = await input.metadata();

const targetWidth = meta.width && meta.width > width ? width : meta.width;

const out = await input
  .resize({ width: targetWidth, withoutEnlargement: true })
  .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
  .toFile(outPath);

console.log(
  JSON.stringify(
    {
      source,
      in: { width: meta.width, height: meta.height, bytes: meta.size },
      out: { path: outPath, width: out.width, height: out.height, bytes: out.size },
      ratio: meta.size ? ((out.size / meta.size).toFixed(2) + 'x (' + (100 * (1 - out.size / meta.size)).toFixed(1) + '% smaller)') : null,
    },
    null,
    2,
  ),
);