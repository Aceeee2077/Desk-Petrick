// ============================================================================
// Wipes dist/ before a build. Without this, files that a previous build copied
// in (removed 3D / ONNX assets, dropped pages) linger and get bundled again —
// `copy-assets` only adds, it never prunes.
// ============================================================================

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
console.log('✓ 已清理 dist/');
