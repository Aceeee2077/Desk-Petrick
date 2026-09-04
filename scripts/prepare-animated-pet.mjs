#!/usr/bin/env node
// Normalize an AI-generated 4x4 pose board into Petric's transparent 64px cells.
// Usage: node scripts/prepare-animated-pet.mjs input.png output.png [--blue-screen]

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const [, , input, output, mode] = process.argv;
if (!input || !output) {
  console.error('Usage: node scripts/prepare-animated-pet.mjs input.png output.png [--blue-screen]');
  process.exit(1);
}

const COLS = 4;
const ROWS = 4;
const CELL = 64;
const PAD = 3;

function keepLargestComponent(data, width, height) {
  const seen = new Uint8Array(width * height);
  let best = [];
  const queue = new Int32Array(width * height);

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || data[start * 4 + 3] < 24) continue;
    let head = 0;
    let tail = 0;
    const component = [];
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++];
      component.push(p);
      const x = p % width;
      const y = Math.floor(p / width);
      const visit = (n) => {
        if (!seen[n] && data[n * 4 + 3] >= 24) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      };
      if (x > 0) visit(p - 1);
      if (x + 1 < width) visit(p + 1);
      if (y > 0) visit(p - width);
      if (y + 1 < height) visit(p + width);
    }
    if (component.length > best.length) best = component;
  }

  const keep = new Uint8Array(width * height);
  for (const p of best) keep[p] = 1;
  // Restore two pixels of antialiased edge around the solid component.
  for (let pass = 0; pass < 2; pass++) {
    const next = keep.slice();
    for (let p = 0; p < width * height; p++) {
      if (!keep[p]) continue;
      const x = p % width;
      const y = Math.floor(p / width);
      if (x > 0) next[p - 1] = 1;
      if (x + 1 < width) next[p + 1] = 1;
      if (y > 0) next[p - width] = 1;
      if (y + 1 < height) next[p + width] = 1;
    }
    keep.set(next);
  }

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (!keep[p] || data[i + 3] === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
}

function alphaBounds(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('No sprite found in one of the 16 cells');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const source = sharp(input).ensureAlpha();
const meta = await source.metadata();
if (!meta.width || !meta.height) throw new Error('Invalid input image');

const frames = [];
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const left = Math.round((meta.width * col) / COLS);
    const top = Math.round((meta.height * row) / ROWS);
    const right = Math.round((meta.width * (col + 1)) / COLS);
    const bottom = Math.round((meta.height * (row + 1)) / ROWS);
    const { data, info } = await sharp(input)
      .extract({ left, top, width: right - left, height: bottom - top })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (mode === '--blue-screen') {
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (b > 105 && b - Math.max(r, g) > 24) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 0;
        }
      }
    }

    keepLargestComponent(data, info.width, info.height);
    const bounds = alphaBounds(data, info.width, info.height);
    const cropped = await sharp(data, { raw: info }).extract(bounds).png().toBuffer();
    frames.push({ row, col, width: bounds.width, height: bounds.height, cropped });
  }
}

const composites = [];
for (let row = 0; row < ROWS; row++) {
  const rowFrames = frames.filter((frame) => frame.row === row);
  const maxWidth = Math.max(...rowFrames.map((frame) => frame.width));
  const maxHeight = Math.max(...rowFrames.map((frame) => frame.height));
  const scale = Math.min((CELL - PAD * 2) / maxWidth, (CELL - PAD * 2) / maxHeight);
  for (const frame of rowFrames) {
    const width = Math.max(1, Math.round(frame.width * scale));
    const height = Math.max(1, Math.round(frame.height * scale));
    const input = await sharp(frame.cropped)
      .resize(width, height, { kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
    composites.push({
      input,
      left: frame.col * CELL + Math.round((CELL - width) / 2),
      top: frame.row * CELL + CELL - PAD - height,
    });
  }
}

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
await sharp({
  create: { width: CELL * COLS, height: CELL * ROWS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(composites)
  .png({ compressionLevel: 9, palette: false })
  .toFile(output);

console.log(`Prepared ${output} (${CELL * COLS}x${CELL * ROWS}, 16 frames)`);
