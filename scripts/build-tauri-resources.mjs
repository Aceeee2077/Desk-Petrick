// ============================================================================
// Generates the JSON resources the Rust backend embeds.
//
// src/shared/i18n.ts stays the single source of truth; this script compiles it
// (tsc already emitted dist/) into src-tauri/resources/i18n.json so Rust can
// `include_str!` it for the tray / native dialogs.
// ============================================================================

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { zhDict, enDict } = require(join(ROOT, 'dist', 'shared', 'i18n.js'));

const outDir = join(ROOT, 'src-tauri', 'resources');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'i18n.json'),
  JSON.stringify({ zh: zhDict, en: enDict }, null, 2),
  'utf8',
);

console.log('✓ src-tauri/resources/i18n.json（来自 src/shared/i18n.ts）');
