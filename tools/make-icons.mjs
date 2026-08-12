/*
 * make-icons.mjs — regenerates icons/icon{16,32,48,128}.png.
 *
 *   node tools/make-icons.mjs
 *
 * Run this only when the icon changes; the PNGs are committed, so a normal
 * install still needs no build step. Node's zlib is the only dependency, which
 * is why the PNG encoder below is hand-rolled rather than pulled from npm —
 * this project has no package.json and is not about to grow one for four
 * small images.
 *
 * The mark is drawn from geometry rather than traced from a font, so it stays
 * crisp at 16 px where hinting would otherwise mangle it. Every shape is
 * defined once in a 100x100 design space and sampled 4x4 per output pixel.
 *
 * THE MARK: Content Daddy's camera — a rounded body with the lens barrel
 * flaring off its right side — reversed in white on a Navy plate, which is
 * the lockup the brand guidelines approve for navy grounds.
 *
 * It replaces the LinkedIn "in" glyph this generator used to draw. That glyph
 * is LinkedIn Corporation's trademark, and shipping it implied an affiliation
 * that does not exist — with the company whose User Agreement this tool
 * already contravenes.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- *
 * PNG encoding
 * ---------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `rgba` is a width*height*4 Uint8Array. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte per scanline. Filter 0 (None) — these images are tiny and
  // mostly flat, so a smarter filter would save bytes that do not matter.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4);
    raw[at] = 0;
    for (let x = 0; x < width * 4; x++) raw[at + 1 + x] = rgba[y * width * 4 + x];
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- *
 * The mark, in a 100x100 design space
 *
 * The camera is a rounded body (x 13..61) with the lens barrel flaring off
 * its right side to x 87 — so the glyph's bounding box is x 13..87, y 30..70,
 * centred horizontally and optically centred vertically.
 *
 * The barrel's left edge sits at x 59, two units *inside* the body, so the
 * two shapes union into one silhouette instead of meeting at a seam that
 * antialiasing would show as a hairline at 16 px.
 * ---------------------------------------------------------------- */
const NAVY = [0x1a, 0x1a, 0x64]; // Content Daddy Navy — #1A1A64
const WHITE = [0xff, 0xff, 0xff];

const G = {
  radius: 22, // background corner rounding
  body: { x0: 13, x1: 61, y0: 30, y1: 70, r: 11 },
  barrel: [
    [59, 45],
    [87, 31],
    [87, 69],
    [59, 55]
  ]
};

/** Rounded-rect coverage test for an arbitrary rect. */
function inRoundRect(x, y, r) {
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
  const cx = Math.min(Math.max(x, r.x0 + r.r), r.x1 - r.r);
  const cy = Math.min(Math.max(y, r.y0 + r.r), r.y1 - r.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r.r * r.r;
}

/** Crossing-number point-in-polygon. The barrel is convex, but this is cheap. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rounded-rect coverage test over the full 0..100 square. */
function inBackground(x, y, r) {
  if (x < 0 || y < 0 || x > 100 || y > 100) return false;
  const cx = Math.min(Math.max(x, r), 100 - r);
  const cy = Math.min(Math.max(y, r), 100 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const inGlyph = (x, y) => inRoundRect(x, y, G.body) || inPolygon(x, y, G.barrel);

/* ---------------------------------------------------------------- *
 * Rasteriser
 * ---------------------------------------------------------------- */
const SS = 4; // supersampling factor per axis

function render(size) {
  const out = new Uint8Array(size * size * 4);
  const scale = 100 / size;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (!inBackground(x, y, G.radius)) continue;
          bg++;
          if (inGlyph(x, y)) fg++;
        }
      }
      const total = SS * SS;
      const at = (py * size + px) * 4;
      if (!bg) continue; // fully transparent outside the rounded square

      // Composite the white glyph over the navy plate, then the plate over
      // transparency. Doing it in that order keeps the glyph's edges clean
      // against the plate instead of against the page behind it.
      const glyphRatio = fg / bg;
      for (let c = 0; c < 3; c++) {
        out[at + c] = Math.round(NAVY[c] * (1 - glyphRatio) + WHITE[c] * glyphRatio);
      }
      out[at + 3] = Math.round((bg / total) * 255);
    }
  }
  return out;
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, render(size));
  writeFileSync(join(root, 'icons', `icon${size}.png`), png);
  process.stdout.write(`icons/icon${size}.png  ${String(png.length).padStart(6)} bytes\n`);
}
