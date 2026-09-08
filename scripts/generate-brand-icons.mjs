// Prismoo brand icons: renders the candy-chrome cat once and writes all icon
// sizes/formats the app needs. Run after `npm run sprites` so the deterministic
// pixel-pet generator never overwrites the brand icon.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'src', 'assets', 'brand', 'prismoo-icon.svg');
const ASSET_DIR = path.join(ROOT, 'src', 'assets');

function makeIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

function makeIcns(pngBuf) {
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + 8 + pngBuf.length, 4);
  const chunk = Buffer.alloc(8);
  chunk.write('ic09', 0, 'ascii');
  chunk.writeUInt32BE(8 + pngBuf.length, 4);
  return Buffer.concat([header, chunk, pngBuf]);
}

const svg = readFileSync(SVG, 'utf8');
const p512 = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
const p256 = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
const p32 = await sharp(Buffer.from(svg)).resize(32, 32).png().toBuffer();

writeFileSync(path.join(ASSET_DIR, 'icon.png'), p512);
writeFileSync(path.join(ASSET_DIR, 'icon.ico'), makeIco(p256));
writeFileSync(path.join(ASSET_DIR, 'icon.icns'), makeIcns(p512));
writeFileSync(path.join(ASSET_DIR, 'tray.png'), p32);
console.log('✓ Prismoo 品牌图标 icon.png / icon.ico / icon.icns / tray.png 已生成');
