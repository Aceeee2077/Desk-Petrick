// ============================================================================
// Generates pixel-art badges for the Petric project (pure Node, no deps):
//   docs/petric-badge.png   512x128 banner  (cat head + "PETRIC" + "DESKTOP PET")
//   docs/petric-avatar.png  512x512 square  (repo avatar: cat head + "PETRIC")
// Uses the same pixel-art style as the built-in sprites (see generate-sprites.mjs).
// ============================================================================

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs');
mkdirSync(OUT_DIR, { recursive: true });

// ---------- minimal RGBA canvas + PNG encoder (same approach as generate-sprites) ----------
function makeCanvas(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}
function setPx(c, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.data[i] = r;
  c.data[i + 1] = g;
  c.data[i + 2] = b;
  c.data[i + 3] = a;
}
function getPx(c, x, y) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return [0, 0, 0, 0];
  const i = (y * c.w + x) * 4;
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
}
function fillEllipse(c, cx, cy, rx, ry, col) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(c, x, y, col);
    }
  }
}
function fillTriangle(c, pts, col) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const pt = [x + 0.5, y + 0.5];
      const d1 = sign(pt, pts[0], pts[1]);
      const d2 = sign(pt, pts[1], pts[2]);
      const d3 = sign(pt, pts[2], pts[0]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) setPx(c, x, y, col);
    }
  }
}
function outlinePass(c, col) {
  const { w, h, data } = c;
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) {
        const near =
          (x > 0 && data[(y * w + x - 1) * 4 + 3] > 0) ||
          (x < w - 1 && data[(y * w + x + 1) * 4 + 3] > 0) ||
          (y > 0 && data[((y - 1) * w + x) * 4 + 3] > 0) ||
          (y < h - 1 && data[((y + 1) * w + x) * 4 + 3] > 0);
        if (near) mark[y * w + x] = 1;
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (mark[i]) {
      data[i * 4] = col[0];
      data[i * 4 + 1] = col[1];
      data[i * 4 + 2] = col[2];
      data[i * 4 + 3] = col[3] ?? 255;
    }
  }
}
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
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- cat head (same shapes as the app icons, drawn at 32x32) ----------
const PAL = {
  body: [247, 155, 91, 255],
  light: [255, 241, 221, 255],
  pink: [247, 143, 176, 255],
  nose: [224, 93, 111, 255],
  whisker: [107, 74, 52, 255],
  outline: [67, 40, 31, 255],
};
function drawCatHead(c) {
  fillTriangle(c, [[8.5, 14.5], [11, 8], [14, 13.5]], PAL.body);
  fillTriangle(c, [[23.5, 14.5], [21, 8], [18, 13.5]], PAL.body);
  fillTriangle(c, [[9.8, 13.5], [11, 9.9], [12.5, 13.1]], PAL.pink);
  fillTriangle(c, [[22.2, 13.5], [21, 9.9], [19.5, 13.1]], PAL.pink);
  fillEllipse(c, 16, 18, 8.5, 7.5, PAL.body);
  outlinePass(c, PAL.outline);
  // eyes
  fillEllipse(c, 12.5, 17.8, 1.7, 1.7, [47, 42, 38, 255]);
  fillEllipse(c, 19.5, 17.8, 1.7, 1.7, [47, 42, 38, 255]);
  fillEllipse(c, 12.9, 17.2, 0.6, 0.6, [255, 255, 255, 255]);
  fillEllipse(c, 19.9, 17.2, 0.6, 0.6, [255, 255, 255, 255]);
  // nose + mouth
  fillEllipse(c, 16, 20.8, 3.2, 2.4, PAL.light);
  fillTriangle(c, [[15.2, 19.2], [16.8, 19.2], [16, 20.4]], PAL.nose);
  setPx(c, 15, 21, PAL.whisker);
  setPx(c, 17, 21, PAL.whisker);
  setPx(c, 14, 22, PAL.whisker);
  setPx(c, 18, 22, PAL.whisker);
  // whiskers
  for (const [x, y] of [[11, 20], [9, 19], [11, 21], [9, 22], [21, 20], [23, 19], [21, 21], [23, 22]]) {
    setPx(c, x, y, PAL.whisker);
  }
  // blush
  fillEllipse(c, 10.2, 22.6, 1.7, 1.2, PAL.pink);
  fillEllipse(c, 21.8, 22.6, 1.7, 1.2, PAL.pink);
}

// ---------- pixel fonts ----------
const FONT_5x7 = {
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
};
const FONT_3x5 = {
  D: [0b111, 0b101, 0b101, 0b101, 0b111],
  E: [0b111, 0b100, 0b111, 0b100, 0b111],
  S: [0b111, 0b100, 0b111, 0b001, 0b111],
  K: [0b101, 0b101, 0b110, 0b101, 0b101],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b111, 0b101, 0b111, 0b100, 0b100],
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
};

function drawText(c, x, y, text, font, cell, col, advance = null) {
  const adv = advance ?? font === FONT_3x5 ? 4 : 6;
  let cx = x;
  for (const ch of text) {
    if (ch === ' ') {
      cx += font === FONT_3x5 ? 2 : 3;
      continue;
    }
    const glyph = font[ch];
    if (!glyph) continue;
    const rows = font === FONT_3x5 ? 5 : 7;
    const cols = font === FONT_3x5 ? 3 : 5;
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        if ((glyph[ry] >> (cols - 1 - rx)) & 1) {
          setPx(c, cx + rx, y + ry, col);
        }
      }
    }
    cx += adv;
  }
}

// ---------- badge backgrounds ----------
function fillRoundedRect(c, x0, y0, x1, y1, radius, col) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const inX = x >= x0 + radius && x <= x1 - radius;
      const inY = y >= y0 + radius && y <= y1 - radius;
      if (inX || inY) {
        setPx(c, x, y, col);
        continue;
      }
      // corner check
      const cx = x < x0 + radius ? x0 + radius : x1 - radius;
      const cy = y < y0 + radius ? y0 + radius : y1 - radius;
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius) setPx(c, x, y, col);
    }
  }
}
function badgeBackground(c, w, h, radius) {
  // vertical gradient: #2b2540 -> #161023
  const top = [43, 37, 64];
  const bottom = [22, 16, 35];
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const col = [Math.round(top[0] + (bottom[0] - top[0]) * t), Math.round(top[1] + (bottom[1] - top[1]) * t), Math.round(top[2] + (bottom[2] - top[2]) * t), 255];
    fillRoundedRect(c, 1, y, w - 2, y, radius, col);
  }
  // border
  for (let x = 0; x < w; x++) {
    setPx(c, x, 0, [111, 95, 168, 255]);
    setPx(c, x, h - 1, [111, 95, 168, 255]);
  }
  for (let y = 0; y < h; y++) {
    setPx(c, 0, y, [111, 95, 168, 255]);
    setPx(c, w - 1, y, [111, 95, 168, 255]);
  }
}

// ---------- build the banner: 64x16 cells, scaled 8x => 512x128 ----------
function makeBanner() {
  const w = 64;
  const h = 16;
  const c = makeCanvas(w, h);
  badgeBackground(c, w, h, 4);

  // cat head: render 32x32, then sample every 2nd pixel into a 16x16 area
  const head = makeCanvas(32, 32);
  drawCatHead(head);
  const hx = 3;
  const hy = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const px = getPx(head, x * 2 + 1, y * 2 + 1);
      if (px[3] > 0) setPx(c, hx + x, hy + y, px);
    }
  }

  // "PETRIC" 5x7
  drawText(c, 23, 3, 'PETRIC', FONT_5x7, 1, [245, 237, 255, 255]);
  // "DESKTOP PET" 3x5
  drawText(c, 23, 12, 'DESKTOP PET', FONT_3x5, 1, [167, 139, 250, 255]);

  return upscale(c, 8);
}

// ---------- avatar: 64x64 cells (512x512): head + PETRIC ----------
function makeAvatar() {
  const w = 64;
  const h = 64;
  const c = makeCanvas(w, h);
  badgeBackground(c, w, h, 14);

  const head = makeCanvas(32, 32);
  drawCatHead(head);
  // head scaled 2x => 32 cells, centered at x, y 10..42
  const hx = 16;
  const hy = 10;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const px = getPx(head, x, y);
      if (px[3] > 0) {
        setPx(c, hx + x, hy + y, px);
        setPx(c, hx + x + 1, hy + y, px);
        setPx(c, hx + x, hy + y + 1, px);
        setPx(c, hx + x + 1, hy + y + 1, px);
      }
    }
  }
  drawText(c, 17, 46, 'PETRIC', FONT_5x7, 2, [245, 237, 255, 255]);
  drawText(c, 24, 56, 'PET', FONT_3x5, 2, [167, 139, 250, 255]);

  return upscale(c, 8);
}

function upscale(c, factor) {
  const out = makeCanvas(c.w * factor, c.h * factor);
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const px = getPx(c, x, y);
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) setPx(out, x * factor + dx, y * factor + dy, px);
      }
    }
  }
  return out;
}

function writePng(file, c) {
  writeFileSync(file, encodePng(c.w, c.h, c.data));
  console.log(`✓ ${file} (${c.w}x${c.h})`);
}

writePng(join(OUT_DIR, 'petric-badge.png'), makeBanner());
writePng(join(OUT_DIR, 'petric-avatar.png'), makeAvatar());
console.log('完成！');
