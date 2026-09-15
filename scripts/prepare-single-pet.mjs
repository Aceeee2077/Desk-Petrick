#!/usr/bin/env node
// ============================================================================
// Build a 4x4 illustrated-pet sheet from ONE transparent character image.
//
// The app renders illustrated pets as a 256x256 sheet: 4 columns x 4 rows of
// 64x64 cells, rows in the order idle / walking / sleeping / click (see
// src/renderer/app.ts). `scripts/prepare-animated-pet.mjs` turns a 4x4 AI pose
// board into that layout; this script does the same job for a single still by
// baking the state poses in as small transform passes (bob / sway / breathing /
// hop), which keeps a hand-drawn or photographed pet animated without needing
// generated pose rows.
//
// Usage:
//   node scripts/prepare-single-pet.mjs <input.png> <output.png> [--cell 128]
//
// Input: PNG/WebP with a transparent background (a solid background is not
// removed here — use the app's cutout or `npm run set-custom` first).
// Output: PNG with 16 pre-aligned cells (512x512 by default). The renderer scales
// illustrated sheets to a fixed 128x128 on-screen box, so a 128px cell is drawn
// 1:1 (crisp) while a 64px cell is upscaled 2x — use 128 for photos/painted art
// and 64 only when you specifically want the chunky pixel-art look.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const cellIdx = argv.indexOf('--cell');
const CELL = cellIdx >= 0 ? Number(argv[cellIdx + 1]) : 128;
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== cellIdx + 1);
const [input, output] = positional;
if (!input || !output) {
  console.error('Usage: node scripts/prepare-single-pet.mjs <input.png> <output.png> [--cell 64|128]');
  process.exit(1);
}
if (!Number.isFinite(CELL) || CELL < 32 || CELL > 512) {
  console.error('--cell must be a number between 32 and 512');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error('Input not found:', input);
  process.exit(1);
}

const COLS = 4;
const ROWS = 4;
const K = CELL / 64; // the frame plans below are authored in 64px cell units
const PAD = Math.round(3 * K); // keeps the sprite off the cell edge
const BOX = Math.round(54 * K); // max content box inside a cell (leaves headroom)

// Row order must match SHEET.states in src/renderer/app.ts:
// 0 idle (4 frames) / 1 walking (4) / 2 sleeping (2, last two cells empty) / 3 click (4).
//
// Offsets are authored in 64px-cell units and multiplied by K for larger cells:
//   dx: + shifts right, dy: - lifts the sprite, rot: degrees, sx/sy: scale.
//
// The walk cycle deliberately sways left/right instead of pumping up/down: the row
// plays at 12fps, so a two-level vertical bob reads as a 6Hz twitch. Here the body
// shifts right, passes through the middle (with a slight lift), shifts left, and
// passes again — one smooth side-to-side step per half loop.
const FRAME_PLANS = {
  idle: [
    { dy: 0, rot: 0, sx: 1, sy: 1 },
    { dy: -1, rot: 0, sx: 1.01, sy: 1.015 },
    { dy: 0, rot: 0, sx: 1, sy: 1 },
    { dy: -1, rot: 0, sx: 0.995, sy: 0.99 },
  ],
  walking: [
    { dx: 2, dy: 0, rot: 3, sx: 1, sy: 1 },
    { dx: 0, dy: -1, rot: 0, sx: 1, sy: 1.01 },
    { dx: -2, dy: 0, rot: -3, sx: 1, sy: 1 },
    { dx: 0, dy: -1, rot: 0, sx: 1, sy: 1.01 },
  ],
  sleeping: [
    { dy: 1, rot: 0, sx: 1.03, sy: 0.95 },
    { dy: 0, rot: 0, sx: 1.02, sy: 0.97 },
  ],
  click: [
    { dy: 0, rot: 0, sx: 1, sy: 0.97 },
    { dy: -3, rot: 0, sx: 1, sy: 1 },
    { dy: -6, rot: 0, sx: 1, sy: 1 },
    { dy: -1, rot: 0, sx: 1, sy: 0.98 },
  ],
};
const ROW_ORDER = ['idle', 'walking', 'sleeping', 'click'];

// Trim the source to its own alpha bounds so the subject fills the cell.
let subject;
try {
  subject = await sharp(input).ensureAlpha().trim({ threshold: 1 }).png().toBuffer();
} catch (err) {
  console.error('Failed to read/trim the input image:', err.message);
  console.error('Make sure the image has transparent padding around the subject.');
  process.exit(1);
}
const subjectMeta = await sharp(subject).metadata();
console.log(`subject: ${subjectMeta.width}x${subjectMeta.height}`);

/**
 * Render one cell: resize from the UNROTATED subject, then rotate, then place.
 * Sizing before rotating keeps the sprite's scale identical across frames — fitting
 * each rotated bounding box instead made the pet shrink and grow on every tilt,
 * which reads as a pulse on top of the pose change.
 */
async function renderFrame(plan) {
  const scale = Math.min(
    (BOX * (plan.sx ?? 1)) / subjectMeta.width,
    (BOX * (plan.sy ?? 1)) / subjectMeta.height,
  );
  const w = Math.max(1, Math.round(subjectMeta.width * scale));
  const h = Math.max(1, Math.round(subjectMeta.height * scale));
  const sized = await sharp(subject).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  const rotated = plan.rot
    ? await sharp(sized).rotate(plan.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    : sized;
  const meta = await sharp(rotated).metadata();
  const frameW = meta.width ?? w;
  const frameH = meta.height ?? h;
  const left = Math.round((CELL - frameW) / 2) + Math.round((plan.dx ?? 0) * K);
  const top = CELL - PAD - frameH + Math.round((plan.dy ?? 0) * K);
  if (top < 0 || left < 0 || left + frameW > CELL || top + frameH > CELL) {
    console.error(`Frame does not fit its cell (left=${left}, top=${top}, ${frameW}x${frameH}). Reduce BOX, dx/dy or rot.`);
    process.exit(1);
  }
  return { input: rotated, left, top };
}

const composites = [];
for (let row = 0; row < ROWS; row++) {
  const plans = FRAME_PLANS[ROW_ORDER[row]];
  for (let col = 0; col < COLS; col++) {
    const plan = plans[col];
    if (!plan) continue; // unused cell stays fully transparent
    const frame = await renderFrame(plan);
    composites.push({ input: frame.input, left: col * CELL + frame.left, top: row * CELL + frame.top });
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
