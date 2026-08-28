// Copies the three.js UMD build and the UMD GLTFLoader from node_modules into
// src/assets/vendor so the renderer can use them via plain <script> tags
// (keeps the no-bundler architecture). three.js is MIT licensed.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'src', 'assets', 'vendor');
mkdirSync(VENDOR, { recursive: true });

const files = [
  ['node_modules/three/build/three.min.js', 'three.min.js'],
  ['node_modules/three/examples/js/loaders/GLTFLoader.js', 'GLTFLoader.js'],
];
for (const [from, to] of files) {
  copyFileSync(join(ROOT, from), join(VENDOR, to));
  console.log(`✓ vendor ${to}`);
}
console.log('three.js (MIT) vendored into src/assets/vendor/');
