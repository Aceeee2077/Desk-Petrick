// ============================================================================
// Build helper: copy the renderer's HTML/CSS and assets into dist/ (tsc only
// compiles .ts)
// ============================================================================

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(join(ROOT, 'dist', 'renderer'), { recursive: true });

const files = [
  'index.html',
  'settings.html',
  'screenshot.html',
  'settings-shot.html',
  'pet3d-test.html',
  'styles.css',
  'settings.css',
];
for (const f of files) {
  cpSync(join(ROOT, 'src', 'renderer', f), join(ROOT, 'dist', 'renderer', f));
}
cpSync(join(ROOT, 'src', 'assets'), join(ROOT, 'dist', 'assets'), { recursive: true });

console.log('✓ 已拷贝渲染层页面与资源到 dist/');
