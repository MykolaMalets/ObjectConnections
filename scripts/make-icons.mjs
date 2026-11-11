// Draws the app icon (a small mind map on a blue rounded square) and writes
// PNG files into packages/app/public/icons. No dependencies: shapes are
// rasterised with 4x4 supersampling and encoded with node:zlib.
//
//   node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app', 'public', 'icons');

const BLUE = [47, 111, 237];
const WHITE = [255, 255, 255];
const LIGHT = [200, 218, 252];

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to the segment (ax, ay)–(bx, by). */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/**
 * Colour at a point of the unit square. `safe` shrinks the drawing into the
 * central 80% so maskable icons survive circular cropping.
 */
function shade(u, v, maskable) {
  const s = maskable ? 0.8 : 1;
  const x = (u - 0.5) / s + 0.5;
  const y = (v - 0.5) / s + 0.5;
  if (!maskable && roundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.2) > 0) return null;
  // Branches: centre to four topics.
  const topics = [
    [0.2, 0.28],
    [0.2, 0.72],
    [0.8, 0.28],
    [0.8, 0.72],
  ];
  if (roundRect(x, y, 0.5, 0.5, 0.15, 0.09, 0.05) <= 0) return WHITE;
  for (const [tx, ty] of topics) {
    if (roundRect(x, y, tx, ty, 0.11, 0.06, 0.04) <= 0) return LIGHT;
  }
  for (const [tx, ty] of topics) {
    const ex = tx < 0.5 ? tx + 0.11 : tx - 0.11;
    if (segment(x, y, 0.5, 0.5, ex, ty) <= 0.022) return LIGHT;
  }
  return BLUE;
}

function render(size, maskable) {
  const n = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = shade((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size, maskable);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (py * size + px) * 4;
      rgba[i] = a ? Math.round(r / a) : 0;
      rgba[i + 1] = a ? Math.round(g / a) : 0;
      rgba[i + 2] = a ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['favicon-32.png', 32, false],
]) {
  writeFileSync(join(out, name), png(size, render(size, maskable)));
  console.log(`${name} ${size}x${size}`);
}
